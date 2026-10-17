// Original locally synthesized game sounds: no recordings or dependencies.
// Call unlockAudio() directly in a trusted gesture BEFORE awaiting anything.
// Playback never creates/resumes a context; remote events require prior unlock.
// Promise APIs resolve when scheduled, not when the sound has finished, and
// reject with code "unsupported", "blocked", or "failed". Callers show errors.

const NOISE_SECONDS = 1;
const POP_LEAD = 0.015;
const ROLL_LENGTH = 0.6;
const UNLOCK_TIMEOUT_MS = 3000;
const CLACK_OFFSETS = [0, 0.03, 0.065, 0.1, 0.14, 0.185, 0.235, 0.29, 0.35, 0.42, 0.49];
const STEP_PITCHES = [480, 540, 600, 540];

let context = null;
let master = null;
let noiseBuffer = null;
let unlocked = false;
let pendingUnlock = null;
let activeRoll = null;
let stepIndex = 0;
const persistentNodes = new Set();
const voices = new Set();

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejected(error) {
  const promise = Promise.reject(error);
  // Errors remain observable by callers even if an event handler ignores them.
  promise.catch(() => {});
  return promise;
}

function blockedError() {
  return makeError('Sound is not running. Press Enable sound or Test sound to unlock it.', 'blocked');
}

function createNoiseBuffer(ctx) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let previous = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    previous = previous * 0.15 + white * 0.85;
    data[i] = previous;
  }
  return buffer;
}

function prepareGraph(ctx) {
  if (master) return;
  const gain = ctx.createGain();
  persistentNodes.add(gain);
  gain.gain.value = 0.85;
  const compressor = ctx.createDynamicsCompressor();
  persistentNodes.add(compressor);
  compressor.threshold.value = -10;
  compressor.knee.value = 12;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.12;
  // A bounded soft ceiling also protects the first transient and overlapping
  // capture/step tails, before the compressor has time to react.
  const ceiling = ctx.createWaveShaper();
  persistentNodes.add(ceiling);
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i += 1) {
    const x = i * 2 / (curve.length - 1) - 1;
    curve[i] = 0.9 * Math.tanh(1.4 * x) / Math.tanh(1.4);
  }
  ceiling.curve = curve;
  gain.connect(compressor).connect(ceiling).connect(ctx.destination);
  noiseBuffer = createNoiseBuffer(ctx);
  master = gain;
}

/**
 * Idempotent explicit activation. Construction AND resume happen in this
 * synchronous call stack, including retries while a WebKit resume is pending.
 * A bounded wait reports a blocked browser instead of hanging the UI forever.
 * @returns {Promise<void>}
 */
export function unlockAudio() {
  const AudioContextClass = typeof window !== 'undefined'
    ? window.AudioContext || window.webkitAudioContext
    : undefined;
  if (!AudioContextClass) {
    return rejected(makeError('Sound is unavailable: this browser does not support Web Audio.', 'unsupported'));
  }

  let resumed;
  try {
    if (!context || context.state === 'closed') {
      // An externally closed context cannot retain its old graph or unlock.
      disposeDiceAudio();
      try {
        context = new AudioContextClass({ latencyHint: 'interactive' });
      } catch {
        context = new AudioContextClass();
      }
    }
    if (context.state !== 'running') {
      unlocked = false;
      // Covers both "suspended" and Safari's "interrupted" state. Never move
      // this call into a Promise continuation: that loses the trusted gesture.
      resumed = context.resume();
    }
  } catch (error) {
    const code = error && error.name === 'NotAllowedError' ? 'blocked' : 'failed';
    return rejected(makeError('Sound could not start. Press Enable sound again and check browser permissions.', code));
  }

  const ctx = context;
  if (!pendingUnlock) {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    promise.catch(() => {});
    const pending = {
      promise,
      finish(error) {
        if (pendingUnlock !== pending) return;
        clearTimeout(pending.timer);
        pendingUnlock = null;
        if (error) {
          unlocked = false;
          reject(error);
          return;
        }
        try {
          prepareGraph(ctx);
          unlocked = true;
          resolve();
        } catch {
          disposeDiceAudio();
          reject(makeError('Sound resources could not be initialized in this browser.', 'failed'));
        }
      },
      timer: null,
    };
    pendingUnlock = pending;
    pending.timer = setTimeout(() => pending.finish(blockedError()), UNLOCK_TIMEOUT_MS);
  }

  const pending = pendingUnlock;
  // Even if an earlier gesture's resume is still pending, this gesture invokes
  // resume synchronously above and can complete that same activation request.
  Promise.resolve(resumed).then(() => {
    if (context !== ctx || pendingUnlock !== pending) return;
    pending.finish(ctx.state === 'running' ? null : blockedError());
  }, () => pending.finish(blockedError()));
  return pending.promise;
}

function runningContext() {
  return unlocked && context && context.state === 'running' && master ? context : null;
}

// Each effect owns only its own nodes. The final source ending releases its
// graph by audio time, not by a wall-clock timer that might cut a newer tail.
function createVoice(ctx) {
  const nodes = new Set();
  const sources = new Set();
  const voice = {
    track(node) {
      nodes.add(node);
      return node;
    },
    source(source, when, duration) {
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
        nodes.delete(source);
        if (sources.size === 0) voice.dispose();
      };
      source.start(when);
      source.stop(when + duration);
    },
    dispose() {
      for (const source of sources) {
        source.onended = null;
        try { source.stop(); } catch { /* already stopped or not yet started */ }
      }
      sources.clear();
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* already disconnected */ }
      }
      nodes.clear();
      voices.delete(voice);
    },
  };
  voices.add(voice);
  return voice;
}

function envelope(ctx, voice, when, amplitude, attack, decay) {
  const gain = voice.track(ctx.createGain());
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(amplitude, when + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  gain.gain.linearRampToValueAtTime(0, when + decay + 0.01);
  return gain;
}

function tone(ctx, voice, when, frequency, amplitude, decay, endFrequency = frequency) {
  const oscillator = voice.track(ctx.createOscillator());
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, when);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, when + decay);
  oscillator.connect(envelope(ctx, voice, when, amplitude, 0.004, decay)).connect(master);
  voice.source(oscillator, when, decay + 0.015);
}

function clack(ctx, voice, when, amplitude, brightness, decay = 0.055) {
  const source = voice.track(ctx.createBufferSource());
  source.buffer = noiseBuffer;
  const filter = voice.track(ctx.createBiquadFilter());
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(brightness, when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(350, brightness * 0.55), when + decay);
  filter.Q.value = 1.1;
  source.connect(filter).connect(envelope(ctx, voice, when, amplitude, 0.0025, decay)).connect(master);
  voice.source(source, when, decay + 0.015);
}

function scheduleRoll(ctx, voice) {
  const start = ctx.currentTime + POP_LEAD;
  // Audible cork-like pop and plastic tick, followed by settling dice impacts.
  tone(ctx, voice, start, 340, 0.43, 0.15, 125);
  clack(ctx, voice, start, 0.32, 2100, 0.035);
  const bed = voice.track(ctx.createBufferSource());
  bed.buffer = noiseBuffer;
  bed.loop = true;
  const filter = voice.track(ctx.createBiquadFilter());
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(1100, start);
  filter.frequency.exponentialRampToValueAtTime(450, start + ROLL_LENGTH);
  filter.Q.value = 0.8;
  bed.connect(filter).connect(envelope(ctx, voice, start + 0.06, 0.085, 0.025, ROLL_LENGTH)).connect(master);
  voice.source(bed, start + 0.06, ROLL_LENGTH + 0.02);
  for (const offset of CLACK_OFFSETS) {
    const when = start + 0.09 + offset;
    const energy = Math.exp(-2.4 * offset);
    clack(ctx, voice, when, 0.5 * energy, 1800 + Math.random() * 2000);
    tone(ctx, voice, when, 520 + Math.random() * 180, 0.13 * energy, 0.045, 340);
  }
}

function scheduleStep(ctx, voice) {
  const when = ctx.currentTime + 0.008;
  const pitch = STEP_PITCHES[stepIndex++ % STEP_PITCHES.length];
  // Bright upward wooden/bell notes overlap naturally at the per-space hop pace.
  tone(ctx, voice, when, pitch * 0.86, 0.2, 0.085, pitch * 1.12);
  tone(ctx, voice, when, pitch * 2.76, 0.045, 0.12, pitch * 2.95);
  clack(ctx, voice, when, 0.16, 1400, 0.022);
}

function scheduleBump(ctx, voice) {
  const when = ctx.currentTime + 0.008;
  const spring = voice.track(ctx.createOscillator());
  spring.type = 'triangle';
  // An exaggerated falling spring: boi-oi-oi-oing, rather than a voice sample.
  spring.frequency.setValueAtTime(190, when);
  for (const [offset, pitch] of [[0.055, 660], [0.16, 220], [0.25, 500], [0.36, 180], [0.45, 370], [0.57, 145], [0.66, 260], [0.84, 100]]) {
    spring.frequency.exponentialRampToValueAtTime(pitch, when + offset);
  }
  const filter = voice.track(ctx.createBiquadFilter());
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2400, when);
  filter.frequency.exponentialRampToValueAtTime(700, when + 0.85);
  spring.connect(filter).connect(envelope(ctx, voice, when, 0.32, 0.008, 0.87)).connect(master);
  voice.source(spring, when, 0.89);
  tone(ctx, voice, when, 280, 0.16, 0.09, 90);
}

function playEffect(ctx, schedule) {
  const voice = createVoice(ctx);
  try {
    schedule(ctx, voice);
  } catch (error) {
    voice.dispose();
    throw error;
  }
}

/** @returns {Promise<void>} */
export function playDiceRoll() {
  const ctx = runningContext();
  if (!ctx) return rejected(blockedError());
  // Coalesce duplicate calls in one event turn, not distinct later rolls.
  if (activeRoll) return activeRoll;
  try {
    playEffect(ctx, scheduleRoll);
  } catch {
    return rejected(makeError('The dice sound could not be scheduled.', 'failed'));
  }
  const roll = Promise.resolve();
  activeRoll = roll;
  roll.then(() => { if (activeRoll === roll) activeRoll = null; });
  return roll;
}

/** One note per movement step. Silent unless already unlocked. */
export function playStepSound() {
  const ctx = runningContext();
  if (!ctx) return;
  try { playEffect(ctx, scheduleStep); } catch { /* animation must remain usable */ }
}

/** Already-unlocked contexts only; one call per authoritative capture arrival. */
export function playBumpSound() {
  const ctx = runningContext();
  if (!ctx) return;
  try { playEffect(ctx, scheduleBump); } catch { /* animation must remain usable */ }
}

/** Stop all scheduled/audible sources immediately. Re-enable via unlockAudio. */
export function disposeDiceAudio() {
  unlocked = false;
  if (pendingUnlock) pendingUnlock.finish(blockedError());
  activeRoll = null;
  stepIndex = 0;
  if (master && context && context.state !== 'closed') {
    try { master.gain.setValueAtTime(0, context.currentTime); } catch { /* context closed */ }
  }
  for (const voice of voices) voice.dispose();
  for (const node of persistentNodes) {
    try { node.disconnect(); } catch { /* already disconnected */ }
  }
  persistentNodes.clear();
  const ctx = context;
  context = null;
  master = null;
  noiseBuffer = null;
  if (ctx && ctx.state !== 'closed') {
    try {
      const closed = ctx.close();
      if (closed && typeof closed.catch === 'function') closed.catch(() => {});
    } catch { /* synchronous close failure must not break mute */ }
  }
}
