import { createBoard } from '/board.js';
import { createPageTools } from '/page-tools.js';

const TEAM_NAMES = ['Alice', 'White Rabbit', 'Cheshire Cat', 'Mad Hatter'];
const CHAPTERS = ['Down the Rabbit-Hole', 'The Pool of Tears', 'A Caucus-Race and a Long Tale', 'The Rabbit Sends in a Little Bill', 'Advice from a Caterpillar', 'Pig and Pepper', 'A Mad Tea-Party', 'The Queen’s Croquet-Ground', 'The Mock Turtle’s Story', 'The Lobster Quadrille', 'Who Stole the Tarts?', 'Alice’s Evidence'];
const $ = selector => document.querySelector(selector);
const grid = $('#games-grid');
const tools = createPageTools();
const listeners = new AbortController();
const cards = new Map();
let socket = null;
let fresh = false;
let disposed = false;
let pending = false;
let serverOffset = 0;
let reconnectTimer = null;
let reconnectDelay = 700;
let defaults = [];
let defaultsSignature = null;
let snapshotTime = null;
let cardSequence = 0;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function listen(node, type, callback) {
  node.addEventListener(type, callback, { signal: listeners.signal });
}
function showError(message) {
  $('#error-message').textContent = message;
  $('#error-message').hidden = !message;
}
function online() { return fresh && socket?.readyState === WebSocket.OPEN && !disposed; }
function selectedChapters() {
  return Array.from($('#defaults-options').querySelectorAll('input:checked'), input => Number(input.value));
}
function sameChapters(a, b) { return a.length === b.length && a.every(chapter => b.includes(chapter)); }
function refreshActions() {
  const enabled = online() && !pending;
  const chapters = selectedChapters();
  $('#defaults-fieldset').disabled = !enabled;
  $('#create-fieldset').disabled = !enabled;
  $('#save-defaults').disabled = !enabled || !chapters.length || sameChapters(chapters, defaults);
  $('#create-game').disabled = !enabled || !defaults.length;
  $('#defaults-count').textContent = defaultsSignature === null ? 'Waiting for the host…' : `${chapters.length} selected${sameChapters(chapters, defaults) ? '' : ' · unsaved'}`;
  for (const card of cards.values()) {
    card.close.disabled = !enabled || card.game.state.phase !== 'finished';
    card.root.classList.toggle('is-stale', !fresh);
    card.stale.hidden = fresh;
  }
}
function send(message) {
  if (!online() || pending) return false;
  try {
    socket.send(JSON.stringify(message));
    pending = true;
    showError('');
    $('#action-status').textContent = 'Request sent. Waiting for the host’s updated overview…';
    refreshActions();
    return true;
  } catch {
    markStale('Connection lost. Reconnecting…');
    socket.close();
    return false;
  }
}
function markStale(label) {
  fresh = false;
  pending = false;
  $('#connection').className = 'connection disconnected';
  $('#connection-label').textContent = label;
  $('#stale-notice').hidden = false;
  $('#stale-notice').textContent = snapshotTime
    ? `Live connection lost. Boards are stale, showing the last update from ${new Date(snapshotTime).toLocaleTimeString()}. Table actions are disabled until a fresh overview arrives.`
    : 'Connecting to the host. Controls are unavailable until a fresh overview arrives. This dashboard is available only on the host computer.';
  grid.setAttribute('aria-busy', 'true');
  $('#action-status').textContent = 'Offline · actions are unavailable.';
  refreshActions();
  updateCountdowns();
}
function gamePhase(state) {
  return state.phase === 'finished' ? 'Finished' : state.phase === 'lobby' ? 'Waiting' : state.paused ? 'Paused' : 'Playing';
}
function piecePosition(position) {
  if (position < 0) return 'home';
  if (position >= 40) return `safe spot ${position - 39}`;
  return `stone ${position + 1}`;
}
function makeCard(game) {
  const root = element('article', 'game-card');
  const title = element('h3');
  title.id = `table-title-${++cardSequence}`;
  root.setAttribute('aria-labelledby', title.id);
  const phase = element('span', 'game-state');
  const header = element('div', 'game-card-header');
  header.append(title, phase);
  const stale = element('p', 'game-stale', 'Stale · live connection lost');
  stale.hidden = true;
  const reservations = element('p', 'game-reservations');
  const selected = element('p', 'game-reservations');
  const countdown = element('p', 'game-countdown');
  const viewport = element('div', 'overview-board');
  const boardStatus = element('p', 'overview-board-status', 'Opening the painted board…');
  boardStatus.id = `table-art-${cardSequence}`;
  viewport.setAttribute('aria-describedby', boardStatus.id);
  const turnRow = element('div', 'game-turn-row');
  const turn = element('p', 'game-turn');
  const die = element('span', 'game-die', '—');
  die.setAttribute('role', 'img');
  turnRow.append(turn, die);
  const message = element('p', 'game-message');
  const teams = element('ol', 'overview-teams');
  teams.setAttribute('aria-label', 'Character controllers and piece progress');
  const teamRows = TEAM_NAMES.map(() => {
    const row = element('li', 'overview-team');
    const name = element('strong');
    const progress = element('span');
    const positions = element('span');
    row.append(name, progress, positions);
    teams.append(row);
    return { row, name, progress, positions };
  });
  const chapters = element('p', 'game-chapters');
  const actions = element('div', 'game-actions');
  const open = element('a', 'button button-primary', 'Open game');
  open.href = `/host?game=${encodeURIComponent(game.id)}`;
  const close = element('button', 'button button-outline', 'Close finished game');
  close.type = 'button';
  close.disabled = true;
  const events = new AbortController();
  const card = { root, title, phase, stale, reservations, selected, countdown, turn, die, message, teamRows, chapters, close, game, events, state: null, board: null };
  close.addEventListener('click', () => {
    if (!online() || pending || card.game.state.phase !== 'finished') return;
    if (window.confirm(`Close “${card.game.name}”? This removes the finished table. Its students will be able to join the automatic queue again.`)) {
      if (card.game.state.phase === 'finished') send({ type: 'close-game', gameId: card.game.id });
    }
  }, { signal: events.signal });
  actions.append(open, close);
  root.append(header, stale, reservations, selected, countdown, viewport, boardStatus, turnRow, message, teams, chapters, actions);
  grid.append(root);
  card.board = createBoard(viewport, {
    onStatus: status => {
      boardStatus.textContent = status.startsWith('Follow the garden path.')
        ? 'Live observer board. Open game for questions and teacher controls.'
        : status.replace('Use the HTML piece controls', 'Use the character progress summary below').replace('All HTML game controls remain available.', 'Character progress remains available below.').replace('All game controls remain available below.', 'Character progress remains available below.');
    },
    onStep: direction => { if (fresh) tools.onStep(direction); },
    onBump: () => { if (fresh) tools.onBump(); },
  });
  viewport.querySelector('canvas')?.setAttribute('aria-label', `Live observer board for ${game.name}. Character positions are listed below. Open game for questions and teacher controls.`);
  return card;
}
function updateCard(card, game, initial) {
  const state = game.state;
  const previous = card.state;
  const silent = initial || previous === null;
  card.game = game;
  card.title.textContent = game.name;
  const phase = gamePhase(state);
  card.phase.textContent = phase;
  card.root.dataset.phase = phase.toLowerCase();
  card.reservations.textContent = `${game.assignedHumans} / 4 student places reserved · ${game.connectedHumans} connected`;
  const occupied = state.players.filter(player => player.occupied).length;
  const computers = state.players.filter(player => player.occupied && player.isBot).length;
  card.selected.textContent = `${occupied} / 4 characters selected · ${computers} computer-controlled`;
  card.turn.textContent = state.phase === 'lobby' ? 'Choosing characters' : state.phase === 'finished'
    ? Number.isInteger(state.winner) ? `${TEAM_NAMES[state.winner]} wins` : 'Game ended without a winner'
    : `${TEAM_NAMES[state.currentPlayer]}’s turn${state.paused ? ' · paused' : ''}`;
  card.die.textContent = Number.isInteger(state.roll) ? String(state.roll) : '—';
  card.die.setAttribute('aria-label', Number.isInteger(state.roll) ? `Last die roll: ${state.roll}` : 'No die roll yet');
  card.message.textContent = state.message || '';
  TEAM_NAMES.forEach((name, index) => {
    const player = state.players[index];
    const team = card.teamRows[index];
    const positions = player?.pieces || [-1, -1, -1, -1];
    const safe = positions.filter(position => position >= 40 && position <= 43).length;
    const home = positions.filter(position => position < 0).length;
    const controller = !player?.occupied ? 'Available' : player.isBot ? 'Computer' : player.connected ? 'Student · connected' : 'Student · disconnected';
    team.name.textContent = `${name} · ${controller}`;
    team.progress.textContent = `${safe} / 4 safe · ${positions.length - safe - home} on path · ${home} at home`;
    team.positions.textContent = positions.map((position, piece) => `${piece + 1}: ${piecePosition(position)}`).join(' · ');
    if (state.phase === 'playing' && state.currentPlayer === index) team.row.setAttribute('aria-current', 'step');
    else team.row.removeAttribute('aria-current');
  });
  card.chapters.textContent = `Chapters: ${(state.chapters || []).join(', ') || 'none configured'}`;
  card.close.hidden = state.phase !== 'finished';
  if (silent || previous.version !== state.version) {
    tools.observeState(previous, state, { initial: silent });
    card.board.update(state, null, { animate: !silent });
  }
  card.state = state;
}
function updateCountdowns() {
  const now = Date.now() + serverOffset;
  for (const card of cards.values()) {
    const game = card.game;
    if (!fresh) card.countdown.textContent = 'Countdown unavailable while disconnected';
    else if (game.state.phase !== 'lobby') card.countdown.textContent = game.state.paused ? 'Play is paused' : game.state.phase === 'finished' ? 'This table may now be closed' : 'Game in progress';
    else if (game.fillDeadline === null) card.countdown.textContent = '60-second fill begins when the first student reserves a place';
    else {
      const seconds = Math.max(0, Math.ceil((game.fillDeadline - now) / 1000));
      card.countdown.textContent = seconds > 0 ? `Automatic start in ${seconds}s · fills remaining places with AI` : game.connectedHumans === 0 ? 'Fill time elapsed · waiting for a student to return' : 'Fill time elapsed · automatic start pending…';
    }
  }
}
function receiveGames(frame) {
  const initial = !fresh;
  serverOffset = frame.serverTime - Date.now();
  snapshotTime = frame.serverTime;
  fresh = true;
  reconnectDelay = 700;
  const signature = JSON.stringify(frame.defaults.chapters);
  if (signature !== defaultsSignature) {
    defaults = frame.defaults.chapters.slice();
    defaultsSignature = signature;
    $('#defaults-options').querySelectorAll('input').forEach(input => { input.checked = defaults.includes(Number(input.value)); });
  }
  const present = new Set();
  for (const game of frame.games) {
    present.add(game.id);
    let card = cards.get(game.id);
    if (!card) {
      card = makeCard(game);
      cards.set(game.id, card);
    }
    updateCard(card, game, initial);
  }
  for (const [id, card] of cards) {
    if (present.has(id)) continue;
    if (card.root.contains(document.activeElement)) $('#games-title').focus();
    card.events.abort();
    card.board.dispose();
    card.root.remove();
    cards.delete(id);
  }
  const waiting = frame.games.filter(game => game.state.phase === 'lobby').length;
  $('#games-summary').textContent = `${frame.games.length} ${frame.games.length === 1 ? 'table' : 'tables'} · ${waiting} waiting · ${frame.games.reduce((sum, game) => sum + game.connectedHumans, 0)} students connected`;
  $('#empty-games').hidden = frame.games.length !== 0;
  $('#connection').className = 'connection connected';
  $('#connection-label').textContent = 'Live · all games';
  $('#stale-notice').hidden = true;
  $('#action-status').textContent = pending ? 'Applying classroom changes…' : 'Connected. New games use the saved chapter defaults.';
  grid.setAttribute('aria-busy', 'false');
  refreshActions();
  updateCountdowns();
}
function connect() {
  if (disposed) return;
  const next = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/monitor`);
  socket = next;
  next.addEventListener('message', event => {
    if (disposed || socket !== next) return;
    let frame;
    try { frame = JSON.parse(event.data); }
    catch { showError('The host sent an unreadable overview. Reconnecting for a fresh snapshot.'); next.close(); return; }
    if (frame.type === 'games') receiveGames(frame);
    else if (frame.type === 'ack') {
      pending = false;
      $('#action-status').textContent = 'Classroom changes saved.';
      refreshActions();
    }
    else if (frame.type === 'error') {
      pending = false;
      showError(frame.message);
      $('#action-status').textContent = 'The request was not completed. See the host message above.';
      refreshActions();
    }
  });
  next.addEventListener('error', () => {
    if (disposed || socket !== next) return;
    markStale('Connection unavailable');
    next.close();
  });
  next.addEventListener('close', () => {
    if (disposed || socket !== next) return;
    markStale('Disconnected · reconnecting…');
    reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 1.6);
  });
}

CHAPTERS.forEach((title, index) => {
  const label = element('label', 'chapter-option');
  const input = element('input');
  input.type = 'checkbox';
  input.name = 'chapters';
  input.value = String(index + 1);
  label.append(input, element('span', '', `${index + 1}. ${title}`));
  $('#defaults-options').append(label);
});
listen($('#defaults-options'), 'change', refreshActions);
listen($('#defaults-all'), 'click', () => {
  $('#defaults-options').querySelectorAll('input').forEach(input => { input.checked = true; });
  refreshActions();
});
listen($('#defaults-none'), 'click', () => {
  $('#defaults-options').querySelectorAll('input').forEach(input => { input.checked = false; });
  refreshActions();
});
listen($('#defaults-form'), 'submit', event => {
  event.preventDefault();
  const chapters = selectedChapters();
  if (chapters.length) send({ type: 'defaults', chapters });
});
listen($('#create-form'), 'submit', event => {
  event.preventDefault();
  if (!defaults.length) return;
  const name = $('#game-name').value.trim();
  send({ type: 'create-game', ...(name ? { name } : {}), chapters: defaults.slice() });
});
const countdownTimer = window.setInterval(updateCountdowns, 1000);
function dispose() {
  if (disposed) return;
  disposed = true;
  fresh = false;
  listeners.abort();
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  window.clearInterval(countdownTimer);
  socket?.close();
  for (const card of cards.values()) {
    card.events.abort();
    card.board.dispose();
  }
  cards.clear();
  tools.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
refreshActions();
connect();
