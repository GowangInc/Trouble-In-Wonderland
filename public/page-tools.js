import { unlockAudio, playDiceRoll, playStepSound, playBumpSound, disposeDiceAudio } from '/dice-audio.js';

const PROJECT_URL = 'https://github.com/GowangInc/Trouble-In-Wonderland';
let qrEncoderPromise = null;

export function createPageTools({ root = document } = {}) {
  const $ = selector => root.querySelector(selector);
  const listeners = new AbortController();
  let disposed = false;
  let soundEnabled = false;
  let soundMuted = false;
  let soundGeneration = 0;
  let audioUnlock = null;
  let testingSound = false;
  let inviteLoading = false;
  let inviteLoaded = false;
  const listen = (selector, type, callback) => $(selector)?.addEventListener(type, callback, { signal: listeners.signal });
  const text = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  const hidden = (selector, value) => { const node = $(selector); if (node) node.hidden = value; };
  const disabled = (selector, value) => { const node = $(selector); if (node) node.disabled = value; };
  const soundStatus = message => text('#sound-status', message);

  function renderSound() {
    const toggle = $('#sound-toggle');
    if (toggle) {
      toggle.textContent = audioUnlock ? 'Enabling sound…' : soundEnabled ? 'Sound off' : 'Enable sound';
      toggle.setAttribute('aria-pressed', String(soundEnabled));
      toggle.setAttribute('aria-label', soundEnabled ? 'Turn game sound off' : 'Enable game sound');
      toggle.disabled = Boolean(audioUnlock);
    }
    disabled('#sound-test', testingSound);
  }
  function soundFailure(cause) {
    soundEnabled = false;
    soundStatus(`Sound could not play${cause?.message ? `: ${cause.message}` : '.'} Check this device’s volume, then try Enable sound or Test sound. The game still works without audio.`);
    renderSound();
  }
  function enableSound() {
    if (disposed) return Promise.resolve(false);
    if (audioUnlock) return audioUnlock;
    const generation = soundGeneration;
    // This must remain synchronous within the caller’s trusted click/submit.
    let unlocking;
    try { unlocking = unlockAudio(); }
    catch (cause) { soundFailure(cause); return Promise.resolve(false); }
    audioUnlock = Promise.resolve(unlocking).then(() => {
      if (generation !== soundGeneration || disposed) return false;
      soundEnabled = true;
      soundMuted = false;
      soundStatus('Sound enabled for every team. Use Test sound to check your speakers and device volume.');
      return true;
    }).catch(cause => {
      if (generation === soundGeneration) soundFailure(cause);
      return false;
    }).finally(() => {
      if (generation === soundGeneration) {
        audioUnlock = null;
        renderSound();
      }
    });
    renderSound();
    return audioUnlock;
  }
  function enable() {
    return soundMuted ? Promise.resolve(false) : enableSound();
  }
  function observeState(previous, next, { initial = false } = {}) {
    if (disposed || initial || !soundEnabled || previous?.phase !== 'playing' || next?.phase !== 'playing' ||
        previous.paused || next.paused || previous.currentPlayer !== next.currentPlayer ||
        previous.awaiting !== 'roll' || !['choice', 'piece', 'continue'].includes(next.awaiting) ||
        !Number.isInteger(next.roll) || next.version <= previous.version) return;
    const generation = soundGeneration;
    playDiceRoll().catch(cause => {
      if (soundEnabled && generation === soundGeneration) soundFailure(cause);
    });
  }
  function onStep() { if (!disposed && soundEnabled) playStepSound(); }
  function onBump() { if (!disposed && soundEnabled) playBumpSound(); }
  async function testSound(event) {
    if (!event.isTrusted || testingSound) return;
    testingSound = true;
    renderSound();
    const generation = soundGeneration;
    try {
      if (!await enableSound()) return;
      soundStatus('Testing: dice, movement steps, then a bump. If silent, check device volume or the browser’s mute setting.');
      await playDiceRoll();
      await new Promise(resolve => setTimeout(resolve, 500));
      if (generation !== soundGeneration || !soundEnabled) return;
      for (let step = 0; step < 4; step++) {
        await new Promise(resolve => setTimeout(resolve, 280));
        if (generation !== soundGeneration || !soundEnabled) return;
        onStep();
      }
      await new Promise(resolve => setTimeout(resolve, 280));
      if (generation === soundGeneration && soundEnabled) {
        onBump();
        soundStatus('Test sounds sent to the browser. If you heard nothing, check device volume, the output device and the browser’s mute setting.');
      }
    } catch (cause) {
      if (generation === soundGeneration) soundFailure(cause);
    } finally {
      testingSound = false;
      renderSound();
    }
  }

  async function renderQr(container, url, purpose) {
    if (!container || disposed) return false;
    container.dataset.url = url;
    qrEncoderPromise ||= import('/vendor/qrcode-generator.js').then(module => module.default).catch(cause => {
      qrEncoderPromise = null;
      throw cause;
    });
    const qrcode = await qrEncoderPromise;
    if (disposed || container.dataset.url !== url) return false;
    const code = qrcode(0, 'M');
    code.addData(url, 'Byte');
    code.make();
    const modules = code.getModuleCount();
    const size = modules + 8; // Four untouched light modules on every side.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size * 8));
    svg.setAttribute('height', String(size * 8));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${purpose}: ${url}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS(svg.namespaceURI, 'rect');
    background.setAttribute('width', String(size));
    background.setAttribute('height', String(size));
    background.setAttribute('fill', '#fff3d9');
    const ink = document.createElementNS(svg.namespaceURI, 'path');
    let path = '';
    for (let row = 0; row < modules; row++) {
      for (let column = 0; column < modules; column++) {
        if (code.isDark(row, column)) path += `M${column + 4},${row + 4}h1v1h-1z`;
      }
    }
    ink.setAttribute('d', path);
    ink.setAttribute('fill', '#183b3b');
    svg.append(background, ink);
    container.replaceChildren(svg);
    return true;
  }
  function classroomUrl(value) {
    try {
      const url = new URL(value);
      const parts = url.hostname.split('.').map(Number);
      const privateAddress = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
        (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
      return privateAddress && url.protocol === 'http:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
    } catch { return null; }
  }
  async function selectInviteAddress() {
    const url = $('#invite-select')?.value || '';
    if ($('#invite-url')) $('#invite-url').value = url;
    hidden('#invite-url', !url);
    hidden('#invite-url-label', !url);
    disabled('#invite-copy', !url);
    disabled('#invite-expand', true);
    hidden('#invite-code', true);
    if (!url) {
      const code = $('#invite-qr');
      if (code) { code.dataset.url = ''; code.replaceChildren(); }
      return;
    }
    text('#invite-status', 'Same-network student link. Students are automatically placed in the next available game. If unreachable, select another classroom network address.');
    try {
      if (await renderQr($('#invite-qr'), url, 'Classroom join QR')) {
        hidden('#invite-code', false);
        disabled('#invite-expand', false);
      }
    } catch {
      text('#invite-status', 'The classroom address is ready, but its QR could not load. Copy or type the student join URL instead.');
    }
  }
  async function loadInvite() {
    if (disposed || inviteLoading || !$('#invite-select')) return;
    inviteLoading = true;
    disabled('#invite-refresh', true);
    text('#invite-status', 'Finding the host’s classroom network address…');
    const selected = $('#invite-select').value;
    try {
      const response = await fetch('/join-info', { cache: 'no-store', signal: listeners.signal });
      if (!response.ok) throw new Error('Address lookup failed');
      const info = await response.json();
      if (!Array.isArray(info.urls)) throw new Error('Invalid address response');
      const urls = [...new Set(info.urls.filter(value => typeof value === 'string').map(classroomUrl).filter(Boolean))];
      const options = urls.map(url => {
        const option = document.createElement('option');
        option.textContent = url;
        option.value = url;
        return option;
      });
      $('#invite-select').replaceChildren(...options);
      if (urls.includes(selected)) $('#invite-select').value = selected;
      hidden('#invite-addresses', urls.length < 2);
      inviteLoaded = true;
      await selectInviteAddress();
      if (!urls.length) text('#invite-status', 'No classroom LAN address is available. Connect the host to classroom Wi-Fi or Ethernet, then refresh addresses. Localhost and private VPN links are not student join links.');
    } catch {
      if (disposed) return;
      $('#invite-select').replaceChildren();
      hidden('#invite-addresses', true);
      await selectInviteAddress();
      text('#invite-status', 'Classroom addresses could not be loaded. Check the host’s network and server, then refresh addresses.');
    } finally {
      inviteLoading = false;
      disabled('#invite-refresh', false);
    }
  }
  async function loadProjectQr() {
    if (!$('#project-qr') || $('#project-qr').childElementCount || disposed) return;
    try {
      if (await renderQr($('#project-qr'), PROJECT_URL, 'GitHub source project QR, not the classroom game')) disabled('#project-expand', false);
    } catch {
      text('#project-status', 'The project QR could not load. The GitHub project link above is still available.');
    }
  }
  function enlargeQr(kind) {
    const classroom = kind === 'invite';
    const source = $(`#${kind}-qr`)?.firstElementChild;
    const dialog = $('#qr-dialog');
    if (!source || !dialog || !$('#dialog-qr')) return;
    text('#qr-dialog-title', classroom ? 'Join a classroom game' : 'GitHub source project');
    text('#qr-dialog-description', classroom ? 'Students: use the same local network as the host. Scan to open the player screen and receive an available game place.' : 'Scan to open the game’s GitHub project. This is not a classroom join code.');
    text('#qr-dialog-url', classroom ? $('#invite-url')?.value || '' : PROJECT_URL);
    $('#dialog-qr').replaceChildren(source.cloneNode(true));
    if (!dialog.open) dialog.showModal();
  }

  listen('#sound-toggle', 'click', event => {
    if (!event.isTrusted) return;
    if (!soundEnabled) { void enableSound(); return; }
    soundGeneration++;
    soundEnabled = false;
    soundMuted = true;
    audioUnlock = null;
    disposeDiceAudio();
    soundStatus('Sound is off in this browser. Enable sound to hear every team again.');
    renderSound();
  });
  listen('#sound-test', 'click', testSound);
  hidden('#invite-panel', false);
  listen('#invite-panel', 'toggle', () => {
    if ($('#invite-panel').open && !inviteLoaded) void loadInvite();
  });
  listen('#invite-select', 'change', selectInviteAddress);
  listen('#invite-refresh', 'click', loadInvite);
  listen('#invite-copy', 'click', async () => {
    const address = $('#invite-url');
    if (!address?.value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address.value);
      text('#invite-status', 'Classroom join URL copied. Share it with students on the same local network.');
    } catch {
      address.focus();
      address.select();
      address.setSelectionRange(0, address.value.length);
      text('#invite-status', 'Automatic copy is unavailable on this connection. The join URL is selected; use your device’s Copy command, or type it manually.');
    }
  });
  listen('#project-panel', 'toggle', () => { if ($('#project-panel').open) void loadProjectQr(); });
  listen('#invite-expand', 'click', () => enlargeQr('invite'));
  listen('#project-expand', 'click', () => enlargeQr('project'));
  if ($('#invite-panel')?.open) void loadInvite();
  if ($('#project-panel')?.open) void loadProjectQr();
  renderSound();

  function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.abort();
    soundGeneration++;
    soundEnabled = false;
    audioUnlock = null;
    disposeDiceAudio();
    $('#qr-dialog')?.close();
  }
  return { enable, observeState, onStep, onBump, dispose };
}
