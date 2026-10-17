import { createPageTools } from '/page-tools.js';

const TEAMS = [
  { id: 'alice', name: 'Alice', color: '#4d9fce', portrait: '/assets/alice-nightmare-v2.png' },
  { id: 'rabbit', name: 'White Rabbit', color: '#e4a847', portrait: '/assets/rabbit-nightmare-v2.png' },
  { id: 'cat', name: 'Cheshire Cat', color: '#b27bd5', portrait: '/assets/cat-nightmare-v2.png' },
  { id: 'hatter', name: 'Mad Hatter', color: '#58a98b', portrait: '/assets/hatter-nightmare-v2.png' },
];
const CHAPTERS = ['Down the Rabbit-Hole', 'The Pool of Tears', 'A Caucus-Race and a Long Tale', 'The Rabbit Sends in a Little Bill', 'Advice from a Caterpillar', 'Pig and Pepper', 'A Mad Tea-Party', 'The Queen’s Croquet-Ground', 'The Mock Turtle’s Story', 'The Lobster Quadrille', 'Who Stole the Tarts?', 'Alice’s Evidence'];
const $ = (selector) => document.querySelector(selector);
const controls = $('#controls');
const teamSelect = $('#team-select');
const requestedHost = location.pathname.replace(/\/$/, '') === '/host';
const requestedGame = requestedHost ? new URLSearchParams(location.search).get('game') : null;
const pageTools = createPageTools();
let socket = null;
let state = null;
let you = null;
let isHost = false;
let hasSnapshot = false;
let reconnectTimer = null;
let reconnectDelay = 700;
let joining = null;
let pendingAction = null;
let board = null;
let boardUnavailable = false;
let announcement = '';
let game = null;
let serverOffset = 0;
let hostUnavailable = false;
let chapterDraft = null;
let boardNeedsSnapshot = true;
let dieTumble = null;
let tablePhase = null;
let waitingControlFocus = null;

function unlockFromGesture(event) {
  if (event.isTrusted) void pageTools.enable();
}

function rollDie(event) {
  if (!allowed('roll', {})) return;
  if (event.isTrusted) {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dieTumble?.cancel();
      dieTumble = $('#die').animate([
        { transform: 'translate(0, 0) rotate(0deg)' },
        { transform: 'translate(-5px, -8px) rotate(-24deg)', offset: .18 },
        { transform: 'translate(5px, -3px) rotate(28deg)', offset: .38 },
        { transform: 'translate(-3px, -5px) rotate(-16deg)', offset: .58 },
        { transform: 'translate(2px, -1px) rotate(8deg)', offset: .78 },
        { transform: 'translate(0, 0) rotate(0deg)' },
      ], { duration: 600, easing: 'ease-out' });
    }
    unlockFromGesture(event);
  }
  sendAction('roll');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function teamPortrait(team, className) {
  const image = element('img', className);
  image.src = team.portrait;
  image.alt = '';
  image.width = 96;
  image.height = 96;
  image.decoding = 'async';
  return image;
}
function online() { return socket?.readyState === WebSocket.OPEN && hasSnapshot; }
function busy() { return Boolean(joining || pendingAction); }
function activePlayer() { return state?.players?.[state.currentPlayer]; }
function myTurn() {
  const player = activePlayer();
  return online() && !busy() && state.phase === 'playing' && !state.paused && you === state.currentPlayer && player?.occupied && player.connected && !player.isBot;
}
function error(message) {
  $('#error-message').textContent = message;
  $('#error-message').hidden = !message;
}
function setConnection(label, kind = '') {
  $('#connection').className = `connection ${kind}`;
  $('#connection-label').textContent = label;
}
function positionLabel(position) {
  if (position === -1) return 'In the garden';
  if (position >= 40 && position <= 43) return `Safe spot ${position - 39} of 4 · 80 points`;
  return `Stone ${position + 1}${position % 10 === 0 ? ' · entry' : ''}`;
}
function chaptersSelected() {
  return Array.from(document.querySelectorAll('#chapter-options input:checked'), input => Number(input.value));
}
function syncChapters() {
  if (!Array.isArray(state?.chapters)) return;
  document.querySelectorAll('#chapter-options input').forEach(input => {
    input.checked = state.chapters.includes(Number(input.value));
  });
}
function configureChapters() {
  chapterDraft = chaptersSelected();
  if (JSON.stringify(chapterDraft) === JSON.stringify(state?.chapters)) {
    chapterDraft = null;
    renderHost();
  } else if (chapterDraft.length) sendAction('configure', { chapters: chapterDraft });
  else renderHost();
}
function allowed(type, data) {
  if (!online() || busy() || !Number.isInteger(state?.version)) return false;
  if (['configure', 'start', 'pause', 'resume', 'reset', 'end'].includes(type)) {
    if (!isHost) return false;
    if (type === 'configure') return state.phase === 'lobby' && Array.isArray(data.chapters) && data.chapters.length > 0;
    if (type === 'start') return state.phase === 'lobby' && chapterDraft === null && state.chapters?.length > 0 && state.players.some(player => player.occupied && player.connected && !player.isBot);
    if (type === 'reset') return state.phase !== 'lobby';
    if (type === 'end') return state.phase === 'playing';
    return state.phase === 'playing' && (type === 'resume' ? state.paused : !state.paused);
  }
  if (!myTurn()) return false;
  if (type === 'roll') return state.awaiting === 'roll';
  if (type === 'choose') return state.awaiting === 'choice' && (data.action === 'enter' ? state.canEnter : state.legalPieces.length > 0);
  if (type === 'move') return ['piece', 'answer'].includes(state.awaiting) && state.legalPieces.includes(data.piece);
  if (type === 'answer') return state.awaiting === 'answer' && state.pendingQuestion && Number.isInteger(data.index) && data.index >= 0 && data.index < state.pendingQuestion.options.length;
  return type === 'continue' && state.awaiting === 'continue';
}
function sendAction(type, data = {}) {
  if (!allowed(type, data)) return;
  error('');
  pendingAction = { type, version: state.version };
  socket.send(JSON.stringify({ ...data, type, version: state.version }));
  render();
}
function button(parent, label, key, callback, { disabled = false, className = 'button-primary' } = {}) {
  const node = element('button', `button ${className}`, label);
  node.type = 'button';
  node.dataset.control = key;
  node.disabled = disabled;
  node.addEventListener('click', callback);
  parent.append(node);
  return node;
}
function note(text, parent = controls, className = 'control-note') { parent.append(element('p', className, text)); }
function renderJoin() {
  const selected = teamSelect.value;
  const joined = Number.isInteger(you);
  const seatCard = $('#seat-card');
  if (seatCard.classList.contains('is-joined') !== joined) $('#seat-details').open = !joined;
  seatCard.classList.toggle('is-joined', joined);
  $('#join-form').hidden = joined;
  const own = joined ? TEAMS[you] : null;
  const options = [element('option', '', 'Choose your team…')];
  options[0].value = '';
  TEAMS.forEach((team, index) => {
    const player = state?.players?.[index];
    const available = Boolean(state && !player?.occupied);
    const status = index === you ? 'your team' : !player?.occupied ? 'available' : player.isBot ? 'computer' : player.connected ? 'taken' : 'reserved';
    const option = element('option', '', `${team.name} — ${state ? status : 'connecting'}`);
    option.value = team.id;
    option.disabled = !available && index !== you;
    options.push(option);
  });
  teamSelect.replaceChildren(...options);
  if (own) teamSelect.value = own.id;
  else if (options.some(option => option.value === selected && !option.disabled)) teamSelect.value = selected;
  const canJoin = online() && !busy() && !joined && state?.phase === 'lobby';
  teamSelect.disabled = !canJoin;
  $('#join-button').disabled = !canJoin || !teamSelect.value;
  $('#join-button').textContent = joining ? 'Choosing…' : joined ? 'Chosen' : 'Choose';
  $('#join-title').textContent = own ? `You are ${own.name}` : 'Choose your character';
  $('#seat-mark').replaceChildren(...(own ? [teamPortrait(own, 'seat-avatar')] : []));
  let text = isHost ? 'Watching does not reserve a place. You may join an available character in this game if your browser is not already assigned elsewhere.' : 'Your place is already reserved in this game. Choose an available character below.';
  if (!online()) text = state ? 'Connection lost. Your game and character restore automatically; actions stay disabled while reconnecting.' : 'Connecting to reserve your game place automatically. Available characters will appear here.';
  else if (joining) text = 'Choosing your character…';
  else if (own) text = 'This browser remembers your game and character automatically while the server is running. Reconnecting restores your progress; clearing browser data loses your place.';
  else if (state.phase !== 'lobby') text = 'You are watching this game. A character can be chosen when the teacher resets the table.';
  else if (state.players.every(player => player.occupied)) text = 'All four characters have been chosen in this game.';
  $('#join-note').textContent = text;
}
function renderAssignment() {
  $('#assigned-game').textContent = game ? game.name : requestedHost ? 'Opening selected game…' : 'Reserving your game place…';
  $('#game-members').textContent = game ? `${game.assignedHumans} / 4 places reserved · ${game.connectedHumans} connected${online() ? '' : ' · last known'}` : '';
  let message = '';
  if (game && state?.phase === 'lobby') {
    const seconds = game.fillDeadline == null ? null : Math.max(0, Math.ceil((game.fillDeadline - Date.now() - serverOffset) / 1000));
    message = seconds === null ? 'The 60-second countdown begins with the first reserved student place.' : seconds > 0 ? `Starts in ${seconds}s, or sooner when all four students choose characters.` : 'Ready to start when a reserved student is connected.';
    message += ' At timeout, any reserved student without a character receives an available one automatically; unreserved places become computer players.';
  }
  const player = activePlayer();
  let decision = 'Connecting…';
  if (!online()) decision = state ? 'Offline · reconnecting' : 'Connecting…';
  else if (state.phase === 'lobby') decision = 'Waiting to start';
  else if (state.phase === 'finished') decision = 'Game finished';
  else if (state.paused) decision = 'Paused';
  else if (player?.isBot) decision = 'Computer turn';
  else if (Number.isFinite(game?.actionDeadline)) {
    const seconds = Math.max(0, Math.ceil((game.actionDeadline - Date.now() - serverOffset) / 1000));
    const action = ({ roll: 'Auto-roll', choice: 'Random choice', piece: 'Random piece', answer: 'Random answer', continue: 'Auto-continue' })[state.awaiting] || 'Next action';
    decision = seconds > 0 ? `${action} in ${seconds}s` : 'Time up · waiting for server';
  } else decision = player?.connected ? 'Waiting for server' : 'Waiting for connection';
  const countdown = $('#action-countdown');
  if (countdown.textContent !== decision) countdown.textContent = decision;
  $('#game-countdown').textContent = message;
  $('#game-countdown').hidden = !message;
}
function renderPlayers() {
  const list = $('#players');
  const positions = $('#board-positions');
  list.replaceChildren();
  positions.replaceChildren();
  let humans = 0;
  TEAMS.forEach((team, index) => {
    const player = state?.players?.[index];
    const claimed = Boolean(player?.occupied);
    if (claimed && player.connected && !player.isBot) humans++;
    const current = state?.phase === 'playing' && state.currentPlayer === index;
    const row = element('li', `player-row${claimed ? '' : ' unclaimed'}`);
    row.style.setProperty('--team-color', team.color);
    const portrait = teamPortrait(team, 'team-avatar');
    const identity = element('div');
    identity.append(element('span', 'player-name', `${team.name}${you === index ? ' · you' : ''}`));
    const status = !claimed ? 'Available to join' : player.isBot ? 'Computer player' : player.connected ? 'Human · connected' : 'Human · disconnected, seat reserved';
    identity.append(element('span', 'player-status', status));
    const progress = element('div', 'player-stats', claimed ? `${player.pieces.filter(piece => piece >= 40 && piece <= 43).length} / 4 safe` : 'Open seat');
    if (claimed) progress.prepend(element('strong', 'player-score', `${player.score ?? 0} pts`));
    if (current) progress.append(element('span', 'player-turn', state.paused ? 'PAUSED' : 'TURN'));
    row.append(portrait, identity, progress);
    if (current) row.setAttribute('aria-current', 'step');
    list.append(row);
    const tableRow = element('tr');
    const label = element('th', '', `${team.name}${claimed ? '' : ' (available)'}`);
    label.scope = 'row';
    tableRow.append(label);
    (player?.pieces || [-1, -1, -1, -1]).forEach((position, piece) => {
      const selected = current && state.awaiting === 'answer' && state.selectedPiece === piece;
      tableRow.append(element('td', selected ? 'is-selected' : '', `${positionLabel(position)}${selected ? ' · selected; can change until answering' : ''}`));
    });
    positions.append(tableRow);
  });
  $('#player-count').textContent = `${game?.assignedHumans ?? humans} / 4 reserved`;
}
function renderPieceOptions(disabled) {
  const player = activePlayer();
  const team = TEAMS[state.currentPlayer];
  const answering = state.awaiting === 'answer';
  const grid = element('div', `piece-options${answering ? ' piece-options-answer' : ''}`);
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Choose a piece; selection can change until answering');
  for (let piece = 0; piece < 4; piece++) {
    const legal = state.legalPieces.includes(piece);
    const selected = state.awaiting === 'answer' && state.selectedPiece === piece;
    const choice = button(grid, '', `piece-${piece}`, () => sendAction('move', { piece }), { disabled: disabled || !legal, className: 'button-outline piece-button' });
    const label = element('span', 'piece-label');
    const title = element('span', '', answering ? String(piece + 1) : `Piece ${piece + 1}`);
    if (selected) {
      const mark = element('span', 'piece-selected-mark', ' ✓');
      mark.setAttribute('aria-hidden', 'true');
      title.append(mark);
    }
    label.append(title, element('small', '', positionLabel(player.pieces[piece])));
    choice.style.setProperty('--team-color', team.color);
    choice.append(teamPortrait(team, 'piece-avatar'), label);
    choice.setAttribute('aria-label', `Select piece ${piece + 1}, ${positionLabel(player.pieces[piece])}${legal ? '' : ', cannot move'}`);
    choice.setAttribute('aria-pressed', String(selected));
    const preview = () => { if (allowed('move', { piece })) board?.setPreviewPiece(piece); };
    const clearPreview = () => board?.setPreviewPiece(null);
    choice.addEventListener('mouseenter', preview);
    choice.addEventListener('focus', preview);
    choice.addEventListener('mouseleave', clearPreview);
    choice.addEventListener('blur', clearPreview);
  }
  controls.append(grid);
}
function renderQuestion(disabled) {
  const question = state.pendingQuestion;
  if (!question) { note('Waiting for the question from the server.'); return; }
  const metadata = element('div', 'question-meta');
  metadata.append(element('span', 'chapter-tag', `Chapter ${question.chapter}`));
  if (Number.isInteger(state.selectedPiece)) note(`Piece ${state.selectedPiece + 1} · switch before answering`, metadata, 'selected-piece');
  controls.append(metadata, element('h3', 'question-prompt', question.prompt));
  question.options.forEach((option, index) => {
    const answer = button(controls, '', `answer-${index}`, () => sendAction('answer', { index }), { disabled, className: 'button-answer' });
    const letter = element('span', 'answer-letter', String.fromCharCode(65 + index));
    letter.setAttribute('aria-hidden', 'true');
    answer.append(letter, element('span', 'answer-text', option));
    answer.setAttribute('aria-label', `${String.fromCharCode(65 + index)}. ${option}`);
  });
}
function renderFeedback() {
  const feedback = state.lastFeedback;
  if (!feedback) return;
  const box = element('div', `feedback${feedback.correct === false ? ' incorrect' : ''}`);
  const title = feedback.correct === true ? 'Well read. On you go!' : feedback.correct === false ? 'Not quite.' : 'A turn in the story';
  box.append(element('h3', 'feedback-title', title));
  if (feedback.selectedText) note(`Answer chosen: ${feedback.selectedText}`, box, 'answer-recap');
  if (feedback.correctText) note(`Correct answer: ${feedback.correctText}`, box, 'answer-recap');
  if (feedback.explanation) note(feedback.explanation, box, 'feedback-explanation');
  controls.append(box);
}
function renderControls() {
  board?.setPreviewPiece(null);
  controls.replaceChildren();
  if (!state) { note('The garden is opening. Connect to see the live game.'); return; }
  if (!online()) {
    note('Reconnecting to the game. No moves can be made while this connection is down.');
    button(controls, 'Reconnect now', 'reconnect', connect, { className: 'button-outline' });
    return;
  }
  if (state.phase === 'lobby') {
    note(isHost ? 'Chapter changes save automatically. Go starts now, or the table starts at its countdown deadline.' : Number.isInteger(you) ? 'Your character is chosen. Play starts when all four students choose, or when the countdown ends.' : 'Your place is reserved. Choose a character before the countdown ends, or one will be chosen for you.');
    return;
  }
  if (state.phase === 'finished') {
    renderFeedback();
    note(Number.isInteger(state.winner) ? `${TEAMS[state.winner].name} parked all four pieces in their safe spots. A wonderfully curious victory!` : 'The host ended this game. No winner was declared.');
    note('The host can reset the table for another game. Human team reservations are kept.');
    return;
  }
  const player = activePlayer();
  const canAct = myTurn();
  if (state.paused) note('The host has paused the table. Your roll, selected piece and question are saved.');
  else if (!player?.isBot && !player?.connected) note(`${player?.name || 'The active team'} is disconnected. Their seat stays reserved; the server handles timed decisions.`);
  else if (pendingAction) note('Waiting for the server…');
  else if (!canAct && state.awaiting !== 'answer') note(player?.isBot ? `${player.name} is a computer player. Watch their next move.` : `${player?.name || 'The current team'} is playing. ${Number.isInteger(you) ? 'Your turn will come around.' : 'Join the next game to play.'}`);
  if (state.awaiting === 'roll') {
    note(canAct ? 'Roll the die above to begin. Each human decision has 30 seconds before the server chooses automatically.' : 'The die is ready for the active team.');
  } else if (state.awaiting === 'choice') {
    note(`Rolled ${state.roll}. Enter without a question and roll again, or answer to move a piece already in play. An opponent on your start is bumped back; your own piece blocks entry.`);
    button(controls, 'Enter a piece · no question', 'enter', () => sendAction('choose', { action: 'enter' }), { disabled: !canAct || !state.canEnter });
    button(controls, 'Move an on-board piece', 'choose-move', () => sendAction('choose', { action: 'move' }), { disabled: !canAct || !state.legalPieces.length, className: 'button-outline' });
  } else if (state.awaiting === 'piece') {
    note('Choose a piece; you can change it until you answer. Hover or focus a piece to preview its destination.');
    renderPieceOptions(!canAct);
  } else if (state.awaiting === 'answer') {
    renderPieceOptions(!canAct);
    renderQuestion(!canAct);
  } else if (state.awaiting === 'continue') {
    button(controls, 'Continue', 'continue', () => sendAction('continue'), { disabled: !canAct });
    renderFeedback();
  }
}
function renderHost() {
  $('#host-panel').hidden = !isHost;
  $('#invite-panel').hidden = !isHost;
  $('#role-badge').textContent = isHost ? 'The host’s table' : 'The garden table';
  const lobby = state?.phase === 'lobby';
  const playing = state?.phase === 'playing';
  const enabled = online() && !busy() && isHost;
  const selected = chaptersSelected().length;
  const humans = state?.players?.filter(player => player.occupied && player.connected && !player.isBot).length || 0;
  $('#chapter-count').textContent = `${selected} selected`;
  $('#chapter-fieldset').disabled = !enabled || !lobby;
  $('#go-button').hidden = !lobby;
  $('#go-button').disabled = !enabled || !lobby || humans < 1 || selected < 1 || chapterDraft !== null;
  $('#pause-button').hidden = !playing;
  $('#pause-button').textContent = state?.paused ? 'Resume' : 'Pause';
  $('#pause-button').disabled = !enabled || !playing;
  $('#end-button').hidden = !playing;
  $('#end-button').disabled = !enabled || !playing;
  $('#reset-button').disabled = !enabled || lobby;
  $('#host-note').textContent = lobby ? selected < 1 ? 'Select at least one chapter to save changes. Automatic start still uses the last saved chapter selection.' : pendingAction?.type === 'configure' ? 'Saving chapters for this game…' : humans < 1 ? 'A connected student must choose a character before Go. Chapter changes are saved automatically for the countdown start.' : 'Chapters are saved automatically. Go starts now, assigning unchosen characters and filling unreserved places with computer players.' : playing ? 'Pause keeps the current turn intact. End stops this game; Reset returns everyone to the lobby.' : 'Reset for a new race. Human reservations stay at the table.';
}
function render() {
  const layout = $('.game-layout');
  layout.dataset.phase = online() ? state.phase : 'connecting';
  layout.dataset.awaiting = state?.awaiting || '';
  const nextTablePhase = state?.phase;
  if (nextTablePhase && nextTablePhase !== tablePhase) {
    const tableDetails = $('#table-details');
    const closingFocusedTable = nextTablePhase !== 'lobby' && tableDetails.contains(document.activeElement);
    tableDetails.open = nextTablePhase === 'lobby' || boardUnavailable;
    tablePhase = nextTablePhase;
    if (nextTablePhase === 'playing') $('.play-column').scrollTop = 0;
    if (closingFocusedTable) $('#turn-title').focus({ preventScroll: true });
  }
  $('#table-summary').textContent = state?.phase === 'lobby' ? 'Join & table settings' : `Table & settings${Number.isInteger(you) ? ` · ${TEAMS[you].name}` : ''}`;
  $('.skip-link').setAttribute('href', online() && state.phase === 'lobby' ? '#join-title' : '#turn-title');
  const focus = document.activeElement;
  const focusedControl = controls.contains(focus) ? focus.dataset.control : focus === $('#turn-title') ? waitingControlFocus : null;
  waitingControlFocus = null;
  const player = activePlayer();
  let title = 'A seat at the table';
  let step = 'The adventure awaits';
  let badge = 'LOBBY';
  if (state?.phase === 'playing') {
    title = you === state.currentPlayer ? 'Your turn' : `${player?.name || 'A curious team'}’s turn`;
    step = ({ roll: '01 · Roll the die', choice: '02 · Choose your way', piece: '02 · Choose a piece', answer: '03 · A question of Wonderland', continue: '04 · The story continues' })[state.awaiting] || 'The garden race';
    badge = state.paused ? 'PAUSED' : player?.isBot ? 'COMPUTER' : you === state.currentPlayer ? 'YOUR TURN' : 'IN PLAY';
  } else if (state?.phase === 'finished') {
    title = Number.isInteger(state.winner) ? `${TEAMS[state.winner].name} wins!` : 'The story pauses here';
    step = 'The end of this adventure';
    badge = 'FINISHED';
  }
  $('#turn-title').textContent = title;
  $('#turn-step').textContent = step;
  $('#turn-badge').textContent = badge;
  $('#game-message').textContent = state?.message || 'Connecting to the shared garden…';
  $('#die').textContent = state?.roll ?? '—';
  $('#die').setAttribute('aria-label', state?.roll == null ? 'No roll yet' : `Die shows ${state.roll}`);
  $('#die-caption').textContent = state?.roll == null ? 'The die rests.' : `A roll of ${state.roll}.`;
  $('#roll-button').disabled = !allowed('roll', {});
  renderJoin();
  renderPlayers();
  renderControls();
  renderHost();
  renderAssignment();
  if (state && board && hasSnapshot) {
    board.update(state, you, { animate: !boardNeedsSnapshot });
    boardNeedsSnapshot = false;
  }
  const nextAnnouncement = `${title}. ${state?.paused ? 'Game paused. ' : ''}${state?.message || ''}`;
  if (nextAnnouncement !== announcement) {
    announcement = nextAnnouncement;
    $('#turn-announcement').textContent = nextAnnouncement;
  }
  if (focusedControl) {
    const replacement = Array.from(controls.querySelectorAll('button')).find(node => node.dataset.control === focusedControl && !node.disabled);
    if (!replacement && pendingAction) waitingControlFocus = focusedControl;
    (replacement || $('#turn-title')).focus({ preventScroll: true });
  }
  // Turn changes update this action area in place; never move the reader’s page.
}
function join(teamId) {
  if (!online() || busy() || you !== null || state?.phase !== 'lobby' || !TEAMS.some(team => team.id === teamId)) return;
  joining = { teamId };
  error('');
  socket.send(JSON.stringify({ type: 'join', teamId }));
  render();
}
function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(reconnectTimer);
  hasSnapshot = false;
  boardNeedsSnapshot = true;
  joining = null;
  pendingAction = null;
  chapterDraft = null;
  hostUnavailable = false;
  if (requestedHost && !requestedGame) {
    hostUnavailable = true;
    setConnection('Game not selected', 'disconnected');
    error('No game was selected. Use All games to choose an existing game.');
    render();
    return;
  }
  setConnection('Connecting…');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostQuery = requestedHost ? `?host=1&game=${encodeURIComponent(requestedGame)}` : '';
  const ws = new WebSocket(`${protocol}//${location.host}/ws${hostQuery}`);
  socket = ws;
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    reconnectDelay = 700;
    setConnection('Connected', 'connected');
  });
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    let message;
    try { message = JSON.parse(event.data); }
    catch { error('The server sent an unreadable message. Please reconnect.'); return; }
    if (message.type === 'state' && message.state) {
      const changedGame = game?.id !== message.game?.id;
      const previous = changedGame ? null : state;
      const initial = !hasSnapshot || changedGame;
      if (changedGame) {
        boardNeedsSnapshot = true;
        tablePhase = null;
        chapterDraft = null;
        dieTumble?.cancel();
        error('');
      }
      game = message.game;
      if (Number.isFinite(message.serverTime)) serverOffset = message.serverTime - Date.now();
      state = message.state;
      you = Number.isInteger(message.you) && message.you >= 0 && message.you < TEAMS.length ? message.you : null;
      isHost = Boolean(message.host);
      hasSnapshot = true;
      hostUnavailable = false;
      pageTools.observeState(previous, state, { initial });
      joining = null;
      if (pendingAction && state.version > pendingAction.version) {
        if (pendingAction.type === 'configure') chapterDraft = null;
        pendingAction = null;
      }
      if (state.phase !== 'lobby') chapterDraft = null;
      if (chapterDraft === null) syncChapters();
      render();
    } else if (message.type === 'joined') {
      // The subsequent state frame is authoritative, including restored/default characters.
      render();
    } else if (message.type === 'error') {
      joining = null;
      pendingAction = null;
      chapterDraft = null;
      syncChapters();
      if (requestedHost && !hasSnapshot) {
        hostUnavailable = true;
        setConnection('Game unavailable', 'disconnected');
        ws.close();
      }
      const detail = typeof message.message === 'string' ? message.message : 'That action could not be completed. Please try again.';
      error(hostUnavailable ? `${detail} Use All games to choose an existing game.` : detail);
      render();
    }
  });
  ws.addEventListener('close', async () => {
    if (socket !== ws) return;
    hasSnapshot = false;
    joining = null;
    pendingAction = null;
    setConnection(hostUnavailable ? 'Game unavailable' : 'Reconnecting…', 'disconnected');
    render();
    if (requestedHost && !hostUnavailable) {
      try {
        const response = await fetch(`/host?game=${encodeURIComponent(requestedGame)}`, { method: 'HEAD' });
        if (socket !== ws) return;
        if (response.status === 404) {
          hostUnavailable = true;
          setConnection('Game unavailable', 'disconnected');
          error('This game no longer exists. Use All games to choose an existing game.');
          render();
        }
      } catch { /* A stopped server still uses the normal reconnect path. */ }
    }
    if (socket !== ws) return;
    if (!hostUnavailable) {
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
    }
  });
  ws.addEventListener('error', () => {
    if (socket === ws) setConnection('Connection interrupted', 'disconnected');
  });
  render();
}

CHAPTERS.forEach((title, index) => {
  const label = element('label', 'chapter-option');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = String(index + 1);
  input.checked = true;
  input.addEventListener('change', configureChapters);
  label.append(input, element('span', '', `${index + 1}. ${title}`));
  $('#chapter-options').append(label);
});
$('.skip-link').addEventListener('click', () => {
  if ($('.skip-link').getAttribute('href') === '#join-title') {
    $('#table-details').open = true;
    $('#seat-details').open = true;
  }
});
$('#join-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state?.phase === 'lobby' && you === null && !busy() && teamSelect.value) {
    unlockFromGesture(event);
    join(teamSelect.value);
  }
});
teamSelect.addEventListener('change', () => { $('#join-button').disabled = !online() || busy() || you !== null || state.phase !== 'lobby' || !teamSelect.value; });
$('#roll-button').addEventListener('click', rollDie);
$('#go-button').addEventListener('click', event => {
  if (allowed('start', {})) unlockFromGesture(event);
  sendAction('start');
});
$('#pause-button').addEventListener('click', () => sendAction(state?.paused ? 'resume' : 'pause'));
$('#reset-button').addEventListener('click', () => {
  if (window.confirm('Reset the game to the lobby? All pieces and questions will be cleared. Human teams keep their seats.')) sendAction('reset');
});
$('#end-button').addEventListener('click', () => {
  if (window.confirm('End this game now without declaring a winner?')) sendAction('end');
});
$('#chapters-all').addEventListener('click', () => { document.querySelectorAll('#chapter-options input').forEach(input => { input.checked = true; }); configureChapters(); });
$('#chapters-none').addEventListener('click', () => { document.querySelectorAll('#chapter-options input').forEach(input => { input.checked = false; }); configureChapters(); });
$('#camera-reset').addEventListener('click', () => board?.resetCamera());
$('#all-games').hidden = !requestedHost;
const countdownTimer = setInterval(renderAssignment, 1000);
connect();
import('/board.js').then(({ createBoard }) => {
  board = createBoard($('#board-viewport'), {
    onPieceSelect: piece => sendAction('move', { piece }),
    onStatus: message => { $('#board-status').textContent = message; },
    onStep: pageTools.onStep,
    onBump: pageTools.onBump,
  });
  if (state && hasSnapshot) {
    board.update(state, you, { animate: false });
    boardNeedsSnapshot = false;
  }
}).catch(() => {
  $('#board-status').textContent = 'The illustrated board could not load. The text board and all turn controls remain available.';
  boardUnavailable = true;
  $('#table-details').open = true;
  $('#text-board').open = true;
});
window.addEventListener('pagehide', () => {
  dieTumble?.cancel();
  clearInterval(countdownTimer);
  clearTimeout(reconnectTimer);
  const closingSocket = socket;
  socket = null;
  closingSocket?.close();
  pageTools.dispose();
  board?.dispose();
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
