export const TEAMS = Object.freeze([
  Object.freeze({ id: "alice", name: "Alice", color: "#4d9fce", symbol: "A" }),
  Object.freeze({ id: "rabbit", name: "White Rabbit", color: "#e4a847", symbol: "R" }),
  Object.freeze({ id: "cat", name: "Cheshire Cat", color: "#b27bd5", symbol: "C" }),
  Object.freeze({ id: "hatter", name: "Mad Hatter", color: "#58a98b", symbol: "H" }),
]);
export const STARTS = Object.freeze([0, 10, 20, 30]);
export const SAFE_START = 40;
export const SAFE_END = 43;

export function encodePosition(teamIndex, progress) {
  if (progress === -1) return -1;
  return progress < 40 ? (STARTS[teamIndex] + progress) % 40 : progress;
}

export function entryAvailable(players, teamIndex) {
  return players[teamIndex].progress.includes(-1) && !players[teamIndex].progress.includes(0);
}

export function legalPieces(players, teamIndex, roll) {
  if (!Number.isInteger(roll) || roll < 1 || roll > 6) return [];
  const player = players[teamIndex];
  return player.progress.flatMap((progress, piece) => {
    if (progress < 0 || progress >= SAFE_START) return [];
    const target = progress + roll;
    if (target > SAFE_END) return [];
    if (player.progress.some((other, index) => index !== piece && other === target)) return [];
    return [piece];
  });
}

// Sends every opponent on a shared-track square back to its garden. Callers sync pieces afterward.
function captureAt(players, teamIndex, square) {
  const captured = [];
  players.forEach((player, team) => {
    if (team === teamIndex) return;
    player.progress.forEach((progress, index) => {
      if (progress >= 0 && progress < 40 && encodePosition(team, progress) === square) {
        player.progress[index] = -1;
        captured.push({ teamIndex: team, piece: index });
      }
    });
  });
  return captured;
}

function syncPieces(players) {
  players.forEach((player, team) => { player.pieces = player.progress.map(progress => encodePosition(team, progress)); });
}

// Returns a new board; neither the input players nor their piece arrays are changed.
export function movePiece(players, teamIndex, piece, roll) {
  if (!legalPieces(players, teamIndex, roll).includes(piece)) throw new Error("That piece cannot make this move.");
  const next = players.map(player => ({ ...player, progress: [...player.progress], pieces: [...player.pieces] }));
  const target = next[teamIndex].progress[piece] + roll;
  next[teamIndex].progress[piece] = target;
  const captured = target < 40 ? captureAt(next, teamIndex, encodePosition(teamIndex, target)) : [];
  syncPieces(next);
  return { players: next, captured };
}

function emptyPlayer(team, teamIndex) {
  return { teamId: team.id, teamIndex, name: team.name, color: team.color, symbol: team.symbol,
    pieces: [-1, -1, -1, -1], progress: [-1, -1, -1, -1], occupied: false, connected: false, isBot: false };
}

export function createGame({ questions, random = Math.random } = {}) {
  if (!Array.isArray(questions) || !questions.length || questions.some(question =>
    !Number.isInteger(question.chapter) || question.chapter < 1 || question.chapter > 12 ||
    typeof question.prompt !== "string" || !Array.isArray(question.options) || question.options.length !== 4 ||
    question.options.some(option => typeof option !== "string") || !Number.isInteger(question.answer) ||
    question.answer < 0 || question.answer > 3 || typeof question.explanation !== "string")) {
    throw new Error("A valid four-option question bank is required.");
  }
  const bank = questions.map((question, id) => ({ ...question, options: [...question.options], id: question.id ?? id }));
  let state = {
    version: 0, decision: 0, phase: "lobby", paused: false, currentPlayer: 0,
    players: TEAMS.map(emptyPlayer), roll: null, awaiting: null, selectedPiece: null,
    pendingQuestion: null, lastFeedback: null, winner: null,
    message: "Choose an available Wonderland character. Your table starts automatically when ready.",
    connected: 0, canEnter: false, legalPieces: [], chapters: Array.from({ length: 12 }, (_, index) => index + 1),
  };
  let questionDeck = [];
  let activeQuestion = null;
  let correctAnswer = null;
  let bonusRoll = false;
  const humanTeams = new Set();

  function changed() {
    state.connected = state.players.filter(player => player.occupied && !player.isBot && player.connected).length;
    state.version += 1;
  }
  function snapshot() {
    const result = structuredClone(state);
    for (const player of result.players) {
      player.score = player.progress.reduce((score, progress) => score + (progress < 0 ? 0 : progress >= SAFE_START ? 80 : progress), 0);
    }
    if (state.phase === "playing" && !state.players[state.currentPlayer].isBot && !state.players[state.currentPlayer].connected) {
      result.message = `${state.players[state.currentPlayer].name} is disconnected. Their seat is reserved; timed decisions continue automatically.`;
    }
    if (state.paused) result.message = "The host paused the adventure. Your roll, question and selected piece are preserved.";
    return result;
  }
  function join(teamId, { resume = false } = {}) {
    const index = TEAMS.findIndex(team => team.id === teamId);
    if (index < 0) throw new Error("Choose one of the four listed teams.");
    const player = state.players[index];
    if (resume) {
      if (!player.occupied || player.isBot || player.connected) throw new Error("That team cannot be resumed on this connection.");
    } else if (state.phase !== "lobby" || player.occupied) {
      throw new Error("That team is already reserved or the adventure has started.");
    }
    player.occupied = true;
    humanTeams.add(index);
    player.connected = true;
    changed();
    return index;
  }
  function disconnect(index) {
    const player = state.players[index];
    if (!player || player.isBot || !player.connected) return false;
    player.connected = false;
    changed();
    return true;
  }
  function setController(index, { bot = false, connected = false } = {}) {
    const player = state.players[index];
    if (!player?.occupied || !humanTeams.has(index)) throw new Error("Only a reserved human team can change controller.");
    if (bot && connected) throw new Error("An AI controller cannot be connected as a human.");
    if (player.isBot === bot && player.connected === connected) return;
    player.isBot = bot;
    player.connected = connected;
    changed();
  }
  function selectedChapters(chapters) {
    if (!Array.isArray(chapters) || !chapters.length || chapters.some(chapter => !Number.isInteger(chapter) || chapter < 1 || chapter > 12)) throw new Error("Select at least one chapter from 1 to 12.");
    const selected = [...new Set(chapters)].sort((a, b) => a - b);
    if (!bank.some(question => selected.includes(question.chapter))) throw new Error("There are no questions in the selected chapters.");
    return selected;
  }
  function clearTurn() {
    state.roll = null;
    state.selectedPiece = null;
    state.pendingQuestion = null;
    state.lastFeedback = null;
    state.canEnter = false;
    state.legalPieces = [];
    activeQuestion = null;
    correctAnswer = null;
    bonusRoll = false;
  }
  function feedback(correct, explanation, details = {}) {
    state.lastFeedback = { correct, explanation, teamName: state.players[state.currentPlayer].name, ...details };
    state.awaiting = "continue";
    state.canEnter = false;
    state.legalPieces = [];
    state.message = explanation;
  }
  function drawQuestion() {
    if (!questionDeck.length) {
      questionDeck = bank.filter(question => state.chapters.includes(question.chapter));
      for (let index = questionDeck.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [questionDeck[index], questionDeck[other]] = [questionDeck[other], questionDeck[index]];
      }
    }
    activeQuestion = questionDeck.pop();
    const order = [0, 1, 2, 3];
    for (let index = order.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    correctAnswer = order.indexOf(activeQuestion.answer);
    state.pendingQuestion = { id: activeQuestion.id, prompt: activeQuestion.prompt,
      options: order.map(index => activeQuestion.options[index]), chapter: activeQuestion.chapter };
  }
  function beginPieceSelection() {
    state.canEnter = false;
    state.awaiting = "piece";
    state.message = `${state.players[state.currentPlayer].name}: select a highlighted piece before answering.`;
  }
  function dispatch(actor, message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid action.");
    if (!Number.isSafeInteger(message.version) || message.version !== state.version) throw new Error("The game changed. Use the latest board and try again.");
    const hostAction = ["configure", "start", "pause", "resume", "reset", "end"].includes(message.type);
    if (hostAction) {
      if (!actor?.host) throw new Error("Only the local host can use that control.");
      if (message.type === "configure") {
        if (state.phase !== "lobby") throw new Error("Chapter choices can only change before the adventure starts.");
        state.chapters = selectedChapters(message.chapters);
      } else if (message.type === "start") {
        if (state.phase !== "lobby") throw new Error("The adventure has already started.");
        if (!state.connected) throw new Error("At least one human team must be connected before Go.");
        state.chapters = selectedChapters(message.chapters ?? state.chapters);
        state.players.forEach(player => { if (!player.occupied) { player.occupied = true; player.isBot = true; } });
        state.phase = "playing";
        state.currentPlayer = 0;
        state.awaiting = "roll";
        state.message = `${state.players[0].name} goes first. Roll the die.`;
      } else if (message.type === "end") {
        if (state.phase !== "playing") throw new Error("There is no active adventure to end.");
        state.phase = "finished";
        state.paused = false;
        state.awaiting = null;
        state.canEnter = false;
        state.legalPieces = [];
        state.winner = null;
        state.message = "The teacher ended the game.";
      } else if (message.type === "reset") {
        clearTurn();
        questionDeck = [];
        state.players = state.players.map((player, index) => humanTeams.has(index) ?
          { ...player, isBot: false, pieces: [-1, -1, -1, -1], progress: [-1, -1, -1, -1] } : emptyPlayer(TEAMS[index], index));
        state.phase = "lobby";
        state.paused = false;
        state.currentPlayer = 0;
        state.awaiting = null;
        state.winner = null;
        state.message = "The board is reset. Human character reservations are kept; your table starts automatically when ready.";
      } else {
        if (state.phase !== "playing") throw new Error("Pause and resume are available during an adventure.");
        const paused = message.type === "pause";
        if (state.paused === paused) throw new Error(paused ? "The adventure is already paused." : "The adventure is not paused.");
        state.paused = paused;
      }
      if (message.type === "start" || message.type === "end" || message.type === "reset") state.decision += 1;
      changed();
      return;
    }
    if (state.phase !== "playing" || state.paused) throw new Error(state.paused ? "The adventure is paused." : "The adventure is not playing.");
    const team = state.currentPlayer;
    const player = state.players[team];
    if (!actor || actor.playerIndex !== team || (player.isBot ? !actor.bot : !player.connected && !actor.timeout)) throw new Error("Wait for your connected team's turn.");
    let keepsDecision = false;
    switch (message.type) {
      case "roll": {
        if (state.awaiting !== "roll") throw new Error("It is not time to roll.");
        state.roll = Math.floor(random() * 6) + 1;
        state.legalPieces = legalPieces(state.players, team, state.roll);
        state.canEnter = state.roll % 2 === 0 && entryAvailable(state.players, team);
        if (state.canEnter) {
          state.awaiting = "choice";
          state.message = `${player.name} rolled ${state.roll}. Enter without a question, or select a piece to move.`;
        } else if (state.legalPieces.length) beginPieceSelection();
        else feedback(null, `${player.name} rolled ${state.roll}. No piece has a legal move; no question is needed.`);
        break;
      }
      case "choose": {
        if (state.awaiting !== "choice") throw new Error("There is no action choice awaiting you.");
        if (message.action === "enter") {
          if (!state.canEnter || !entryAvailable(state.players, team)) throw new Error("Your own piece already occupies your start; entry is blocked.");
          const piece = player.progress.indexOf(-1);
          player.progress[piece] = 0;
          const captured = captureAt(state.players, team, STARTS[team]);
          syncPieces(state.players);
          bonusRoll = true;
          const captureText = captured.length ? ` Captured ${captured.map(capture => state.players[capture.teamIndex].name).join(" and ")}; their piece returns home.` : "";
          feedback(null, `${player.name} entered piece ${piece + 1} without a question.${captureText} Entry earns another roll.`, { piece, captured });
        } else if (message.action === "move" && state.legalPieces.length) beginPieceSelection();
        else throw new Error("Choose a legal entry or on-board move.");
        break;
      }
      case "move": {
        if ((state.awaiting !== "piece" && state.awaiting !== "answer") || !Number.isInteger(message.piece) || !state.legalPieces.includes(message.piece)) throw new Error("Select one of your legal highlighted pieces.");
        keepsDecision = state.awaiting === "answer";
        state.selectedPiece = message.piece;
        if (!keepsDecision) {
          drawQuestion();
          state.awaiting = "answer";
        }
        state.message = `${player.name}: piece ${message.piece + 1} is selected; you can change pieces until you answer. A correct answer moves it ${state.roll} spaces; a wrong answer leaves it in place.`;
        break;
      }
      case "answer": {
        if (state.awaiting !== "answer" || !Number.isInteger(message.index) || message.index < 0 || message.index > 3) throw new Error("Choose one of the four answers to the current question.");
        const piece = state.selectedPiece;
        const correct = message.index === correctAnswer;
        const details = { piece, captured: [], correctText: state.pendingQuestion.options[correctAnswer], selectedText: state.pendingQuestion.options[message.index] };
        if (!correct) {
          bonusRoll = false;
          feedback(false, `Not quite. Piece ${piece + 1} stays in place. ${activeQuestion.explanation} The turn ends, even on a six.`, details);
        } else {
          const result = movePiece(state.players, team, piece, state.roll);
          state.players = result.players;
          bonusRoll = state.roll === 6;
          const captureText = result.captured.length ? ` Captured ${result.captured.map(capture => state.players[capture.teamIndex].name).join(" and ")}; their piece returns home.` : "";
          feedback(true, `Correct! ${activeQuestion.explanation}${captureText}${bonusRoll ? " A six earns another roll." : ""}`, { ...details, captured: result.captured });
          if (state.players[team].progress.every(progress => progress >= SAFE_START && progress <= SAFE_END)) {
            state.phase = "finished";
            state.winner = team;
            state.awaiting = null;
            state.message = `${player.name} wins! All four pieces are safely parked. ${activeQuestion.explanation}`;
          }
        }
        break;
      }
      case "continue": {
        if (state.awaiting !== "continue") throw new Error("Finish the current action before continuing.");
        const keepTurn = bonusRoll;
        clearTurn();
        if (!keepTurn) state.currentPlayer = (team + 1) % TEAMS.length;
        state.awaiting = "roll";
        state.message = `${state.players[state.currentPlayer].name}: ${keepTurn ? "you earned another roll." : "roll the die."}`;
        break;
      }
      default: throw new Error("Unknown action.");
    }
    if (!keepsDecision) state.decision += 1;
    changed();
  }
  function nextBotAction() {
    const player = state.players[state.currentPlayer];
    if (state.phase !== "playing" || state.paused || !player.isBot) return null;
    const action = { version: state.version };
    switch (state.awaiting) {
      case "roll": return { ...action, type: "roll" };
      case "choice": return { ...action, type: "choose", action: "enter" };
      case "piece": return { ...action, type: "move", piece: state.legalPieces.reduce((best, piece) => player.progress[piece] > player.progress[best] ? piece : best) };
      case "answer": {
        const correct = random() < 0.75;
        return { ...action, type: "answer", index: correct ? correctAnswer : (correctAnswer + 1 + Math.floor(random() * 3)) % 4 };
      }
      case "continue": return { ...action, type: "continue" };
      default: return null;
    }
  }
  // Uniform random legal action for an idle human's pending decision; never peeks at the answer key.
  function nextTimeoutAction() {
    const player = state.players[state.currentPlayer];
    if (state.phase !== "playing" || state.paused || !player.occupied || player.isBot) return null;
    const action = { version: state.version };
    switch (state.awaiting) {
      case "roll": return { ...action, type: "roll" };
      case "choice": {
        const legal = [...(state.canEnter ? ["enter"] : []), ...(state.legalPieces.length ? ["move"] : [])];
        return legal.length ? { ...action, type: "choose", action: legal[Math.floor(random() * legal.length)] } : null;
      }
      case "piece": return state.legalPieces.length ?
        { ...action, type: "move", piece: state.legalPieces[Math.floor(random() * state.legalPieces.length)] } : null;
      case "answer": return { ...action, type: "answer", index: Math.floor(random() * 4) };
      case "continue": return { ...action, type: "continue" };
      default: return null;
    }
  }
  return { snapshot, join, disconnect, setController, dispatch, nextBotAction, nextTimeoutAction };
}
