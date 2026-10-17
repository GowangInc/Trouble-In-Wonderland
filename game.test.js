import { describe, test, expect } from "bun:test";
import { createGame, TEAMS, encodePosition, entryAvailable, legalPieces, movePiece } from "./game.js";

const questions = [{ chapter: 1, prompt: "Who does Alice follow?", options: ["Rabbit", "Cat", "Hatter", "Queen"], answer: 0, explanation: "She follows the White Rabbit." }];
function fixture(humans = 1) {
  const game = createGame({ questions, random: () => 0.999 });
  for (let index = 0; index < humans; index++) game.join(TEAMS[index].id);
  host(game, "start", { chapters: [1] });
  return game;
}
function host(game, type, fields = {}) {
  game.dispatch({ host: true, playerIndex: null }, { type, version: game.snapshot().version, ...fields });
}
function act(game, type, fields = {}) {
  const state = game.snapshot();
  game.dispatch({ playerIndex: state.currentPlayer, bot: state.players[state.currentPlayer].isBot }, { type, version: state.version, ...fields });
}
function enter(game) {
  act(game, "roll");
  act(game, "choose", { action: "enter" });
  act(game, "continue");
}
function board(progress) {
  return createGame({ questions }).snapshot().players.map((player, team) => ({ ...player,
    progress: progress[team] ?? [-1, -1, -1, -1],
    pieces: (progress[team] ?? [-1, -1, -1, -1]).map(value => encodePosition(team, value)),
  }));
}

function controlledFixture(teamIds = TEAMS.map(team => team.id)) {
  let nextRandom = null;
  const game = createGame({ questions, random: () => {
    const value = nextRandom ?? 0.1;
    nextRandom = null;
    return value;
  } });
  teamIds.forEach(teamId => game.join(teamId));
  host(game, "start", { chapters: [1] });
  return { game, setRoll: roll => { nextRandom = (roll - 0.5) / 6; } };
}
function playMove(control, piece, roll, correct = true) {
  const { game, setRoll } = control;
  setRoll(roll);
  act(game, "roll");
  if (game.snapshot().awaiting === "choice") act(game, "choose", { action: "move" });
  act(game, "move", { piece });
  const answer = game.snapshot().pendingQuestion.options.indexOf("Rabbit");
  act(game, "answer", { index: correct ? answer : (answer + 1) % 4 });
}
function skipGardens(control, team) {
  const { game, setRoll } = control;
  for (let turns = 0; turns < 3 && game.snapshot().currentPlayer !== team; turns++) {
    setRoll(1);
    act(game, "roll");
    expect(game.snapshot().awaiting).toBe("continue");
    expect(game.snapshot().pendingQuestion).toBeNull();
    act(game, "continue");
  }
  expect(game.snapshot().currentPlayer).toBe(team);
}
function botAction(game) {
  const action = game.nextBotAction();
  const state = game.snapshot();
  game.dispatch({ playerIndex: state.currentPlayer, bot: true }, action);
  return action;
}

describe("Wonderland rules", () => {
  test.each([[1, false], [2, true], [3, false], [4, true], [5, false], [6, true]])("entry eligibility and turn handoff on roll %i", (roll, canEnter) => {
    const game = createGame({ questions, random: () => (roll - 0.5) / 6 });
    game.join("alice");
    host(game, "start", { chapters: [1] });
    act(game, "roll");
    expect(game.snapshot().canEnter).toBe(canEnter);
    expect(game.snapshot().pendingQuestion).toBeNull();
    if (canEnter) {
      expect(game.snapshot().awaiting).toBe("choice");
      act(game, "choose", { action: "enter" });
      expect(game.snapshot().players[0].progress).toEqual([0, -1, -1, -1]);
    } else {
      expect(() => act(game, "choose", { action: "enter" })).toThrow();
      expect(game.snapshot().players[0].progress).toEqual([-1, -1, -1, -1]);
    }
    expect(game.snapshot().pendingQuestion).toBeNull();
    expect(game.snapshot().awaiting).toBe("continue");
    expect(game.snapshot().currentPlayer).toBe(0);
    act(game, "continue");
    expect(game.snapshot().currentPlayer).toBe(canEnter ? 0 : 1);
    expect(game.snapshot().awaiting).toBe("roll");
  });

  test("wrong answer moves only the locked piece backward and forfeits a six bonus", () => {
    const game = fixture();
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    act(game, "answer", { index: 0 });
    act(game, "continue");
    act(game, "roll");
    act(game, "choose", { action: "move" });
    act(game, "move", { piece: 0 });
    act(game, "answer", { index: 0 });
    act(game, "continue");
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    expect(game.snapshot().selectedPiece).toBe(0);
    expect(() => act(game, "move", { piece: 1 })).toThrow();
    act(game, "answer", { index: 1 });
    const state = game.snapshot();
    expect(state.players[0].progress).toEqual([6, 0, -1, -1]);
    expect(state.lastFeedback.movedBack).toBe(6);
    expect(state.lastFeedback.correct).toBe(false);
    expect(state.lastFeedback.captured).toEqual([]);
    expect(state.awaiting).toBe("continue");
    expect(state.currentPlayer).toBe(0);
    act(game, "continue");
    expect(game.snapshot().currentPlayer).toBe(1);
  });

  test("wrong answers at the start leave the piece in play", () => {
    const game = fixture();
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    act(game, "answer", { index: 1 });
    expect(game.snapshot().players[0].progress).toEqual([0, -1, -1, -1]);
    expect(game.snapshot().lastFeedback.movedBack).toBe(0);
    expect(game.snapshot().lastFeedback.captured).toEqual([]);
    act(game, "continue");
    expect(game.snapshot().currentPlayer).toBe(1);
  });

  test("a blocked retreat still grades the answer and ends the turn without stacking", () => {
    const game = fixture();
    enter(game);
    for (let moves = 0; moves < 2; moves++) {
      act(game, "roll");
      if (game.snapshot().awaiting === "choice") act(game, "choose", { action: "move" });
      act(game, "move", { piece: 0 });
      act(game, "answer", { index: 0 });
      act(game, "continue");
    }
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 1 });
    act(game, "answer", { index: 0 });
    act(game, "continue");
    act(game, "roll");
    act(game, "choose", { action: "move" });
    act(game, "move", { piece: 0 });
    act(game, "answer", { index: 1 });
    expect(game.snapshot().players[0].progress).toEqual([12, 6, -1, -1]);
    expect(game.snapshot().lastFeedback).toMatchObject({ correct: false, movedBack: 0, retreatBlocked: true, captured: [] });
    act(game, "continue");
    expect(game.snapshot().currentPlayer).toBe(1);
  });

  test("backward movement clamps at the start and obeys shared-track landing rules", () => {
    expect(movePiece(board([[2, -1, -1, -1]]), 0, 0, 6, -1).players[0].progress[0]).toBe(0);
    expect(movePiece(board([[], [1, -1, -1, -1]]), 1, 0, 4, -1).players[1].pieces[0]).toBe(10);
    const players = board([[8, -1, -1, -1], [35, -1, -1, -1]]);
    const result = movePiece(players, 0, 0, 3, -1);
    expect(result.players[0].progress[0]).toBe(5);
    expect(result.players[1].progress[0]).toBe(-1);
    expect(result.captured).toEqual([{ teamIndex: 1, piece: 0 }]);
    expect(players[0].progress[0]).toBe(8);
    expect(players[1].progress[0]).toBe(35);
    expect(legalPieces(board([[13, -1, -1, -1], [0, -1, -1, -1]]), 0, 3, -1)).toEqual([]);
    expect(legalPieces(board([[8, 5, -1, -1]]), 0, 3, -1)).not.toContain(0);
  });

  test("occupied protected starts block entry and landing, but not passing", () => {
    const players = board([[-1, -1, -1, -1], [30, -1, -1, -1]]);
    expect(entryAvailable(players, 0)).toBe(false);
    const landing = board([[8, -1, -1, -1], [0, -1, -1, -1]]);
    expect(legalPieces(landing, 0, 2)).toEqual([]);
    expect(legalPieces(landing, 0, 3)).toEqual([0]);
    const game = fixture();
    enter(game);
    act(game, "roll");
    expect(game.snapshot().canEnter).toBe(false);
    expect(game.snapshot().awaiting).toBe("piece");
    expect(() => act(game, "choose", { action: "enter" })).toThrow();
  });

  test("normal forward landings capture without mutating the previous board", () => {
    const players = board([[4, -1, -1, -1], [35, -1, -1, -1]]);
    const result = movePiece(players, 0, 0, 1);
    expect(result.players[0].pieces[0]).toBe(5);
    expect(result.players[1].progress[0]).toBe(-1);
    expect(result.captured).toEqual([{ teamIndex: 1, piece: 0 }]);
    expect(players[1].progress[0]).toBe(35);
  });

  test.each([40, 41, 42, 43])("landing at safe slot %i parks permanently with its exact public position", slot => {
    for (let team = 0; team < 4; team++) {
      const progress = Array.from({ length: 4 }, () => [-1, -1, -1, -1]);
      progress[team][0] = slot - 6;
      const result = movePiece(board(progress), team, 0, 6);
      expect(result.players[team].progress[0]).toBe(slot);
      expect(result.players[team].pieces[0]).toBe(slot);
      expect(result.captured).toEqual([]);
      for (const direction of [1, -1]) {
        expect(legalPieces(result.players, team, 1, direction)).toEqual([]);
        expect(() => movePiece(result.players, team, 0, 1, direction)).toThrow();
      }
    }
  });

  test("safe slots block landing, permit passing, and reject overshoot", () => {
    const players = board([[38, 40, 42, 43]]);
    expect(legalPieces(players, 0, 2)).toEqual([]);
    expect(legalPieces(players, 0, 3)).toEqual([0]);
    expect(movePiece(players, 0, 0, 3).players[0].progress).toEqual([41, 40, 42, 43]);
    expect(legalPieces(players, 0, 4)).toEqual([]);
    expect(legalPieces(players, 0, 5)).toEqual([]);
    expect(legalPieces(players, 0, 6)).toEqual([]);
    expect(() => movePiece(players, 0, 0, 6)).toThrow();
    expect(players[0].progress).toEqual([38, 40, 42, 43]);
  });

  test("each team's safe row is separate and cannot capture another team's parked piece", () => {
    const players = board([[38, -1, -1, -1], [40, -1, -1, -1]]);
    const result = movePiece(players, 0, 0, 2);
    expect(result.players[0].progress[0]).toBe(40);
    expect(result.players[1].progress[0]).toBe(40);
    expect(result.players[0].pieces[0]).toBe(40);
    expect(result.players[1].pieces[0]).toBe(40);
    expect(result.captured).toEqual([]);
  });

  test.each([2, 4, 6])("bots earn another roll on entry with %i, then respect their occupied start", roll => {
    const { game, setRoll } = controlledFixture(["rabbit"]);
    setRoll(roll);
    expect(botAction(game).type).toBe("roll");
    expect(game.nextBotAction()).toMatchObject({ type: "choose", action: "enter" });
    botAction(game);
    expect(game.snapshot().players[0].progress).toEqual([0, -1, -1, -1]);
    expect(game.snapshot().pendingQuestion).toBeNull();
    botAction(game);
    expect(game.snapshot().currentPlayer).toBe(0);
    setRoll(roll);
    botAction(game);
    expect(game.snapshot().canEnter).toBe(false);
    expect(() => act(game, "choose", { action: "enter" })).toThrow();
    expect(game.nextBotAction()).toMatchObject({ type: "move", piece: 0 });
  });

  test.each([2, 4, 6])("a rival on the protected first space blocks question-free entry on %i", roll => {
    const control = controlledFixture();
    const { game, setRoll } = control;
    setRoll(1);
    act(game, "roll");
    act(game, "continue");
    setRoll(6);
    enter(game);
    for (let moves = 0; moves < 5; moves++) {
      playMove(control, 0, 6);
      act(game, "continue");
    }
    setRoll(2);
    enter(game);
    playMove(control, 1, 1, false);
    act(game, "continue");
    skipGardens(control, 0);
    expect(game.snapshot().players[1].pieces[0]).toBe(0);
    setRoll(roll);
    act(game, "roll");
    expect(game.snapshot().canEnter).toBe(false);
    expect(game.snapshot().awaiting).toBe("continue");
    expect(game.snapshot().pendingQuestion).toBeNull();
    expect(() => act(game, "choose", { action: "enter" })).toThrow();
    expect(game.snapshot().players[0].progress).toEqual([-1, -1, -1, -1]);
    expect(game.snapshot().players[1].progress[0]).toBe(30);
  });

  test.each([true, false])("feedback identifies captures for correct=%s answers", correct => {
    const control = controlledFixture();
    const { game, setRoll } = control;
    setRoll(6);
    enter(game);
    for (const roll of [6, 6, 1]) {
      playMove(control, 0, roll);
      act(game, "continue");
    }
    setRoll(6);
    enter(game);
    for (const roll of [6, 1]) {
      playMove(control, 0, roll);
      act(game, "continue");
    }
    skipGardens(control, 0);
    if (!correct) {
      playMove(control, 0, 6);
      expect(game.snapshot().lastFeedback.captured).toEqual([]);
      act(game, "continue");
      expect(game.snapshot().currentPlayer).toBe(0);
    }
    const before = game.snapshot();
    playMove(control, 0, correct ? 4 : 2, correct);
    const state = game.snapshot();
    expect(state.lastFeedback).toMatchObject({ correct, piece: 0, captured: [{ teamIndex: 1, piece: 0 }] });
    expect(state.players[0].progress[0]).toBe(17);
    expect(state.players[1].progress[0]).toBe(-1);
    expect(state.players[1].pieces[0]).toBe(-1);
    expect(before.players[1].progress[0]).toBe(7);
    if (!correct) expect(state.lastFeedback.movedBack).toBe(2);
    act(game, "continue");
    expect(game.snapshot().currentPlayer).toBe(1);
  });

  test("bots skip parked pieces, safe pieces survive wrong answers, and four distinct safe slots win", () => {
    const control = controlledFixture(["rabbit"]);
    const { game, setRoll } = control;
    let triedWrongAnswer = false;
    for (let turns = 0; turns < 100 && game.snapshot().phase === "playing"; turns++) {
      skipGardens(control, 0);
      const before = game.snapshot().players[0].progress;
      const parked = before.filter(progress => progress >= 40);
      const leading = Math.max(...before.filter(progress => progress >= 0 && progress < 40));
      let roll = 6;
      if (leading === 36 && parked.includes(42)) {
        roll = !parked.includes(41) ? 5 : !parked.includes(40) ? 4 : 1;
      }
      setRoll(roll);
      botAction(game);
      if (game.snapshot().awaiting === "choice") {
        expect(botAction(game)).toMatchObject({ type: "choose", action: "enter" });
        expect(game.snapshot().pendingQuestion).toBeNull();
        botAction(game);
        expect(game.snapshot().currentPlayer).toBe(0);
        continue;
      }
      expect(game.snapshot().awaiting).toBe("piece");
      before.forEach((progress, piece) => {
        if (progress >= 40) {
          expect(game.snapshot().legalPieces).not.toContain(piece);
          expect(() => act(game, "move", { piece })).toThrow();
        }
      });
      const selection = botAction(game);
      expect(before[selection.piece]).toBeLessThan(40);
      if (parked.length && !triedWrongAnswer) {
        const answer = game.snapshot().pendingQuestion.options.indexOf("Rabbit");
        act(game, "answer", { index: (answer + 1) % 4 });
        expect(game.snapshot().lastFeedback).toMatchObject({ correct: false, captured: [] });
        triedWrongAnswer = true;
      } else {
        botAction(game);
        expect(game.snapshot().lastFeedback).toMatchObject({ correct: true, captured: [] });
      }
      const state = game.snapshot();
      before.forEach((progress, piece) => {
        if (progress >= 40) {
          expect(state.players[0].progress[piece]).toBe(progress);
          expect(state.players[0].pieces[piece]).toBe(progress);
        }
      });
      const safe = state.players[0].progress.filter(progress => progress >= 40);
      expect(new Set(safe).size).toBe(safe.length);
      expect(state.phase).toBe(safe.length === 4 ? "finished" : "playing");
      if (state.phase === "playing") {
        act(game, "continue");
        if (state.lastFeedback.correct === false) expect(game.snapshot().currentPlayer).toBe(1);
      }
    }
    const state = game.snapshot();
    expect(triedWrongAnswer).toBe(true);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(0);
    expect(state.awaiting).toBeNull();
    expect([...state.players[0].progress].sort((a, b) => a - b)).toEqual([40, 41, 42, 43]);
    expect(state.players[0].pieces).toEqual(state.players[0].progress);
    expect(game.nextBotAction()).toBeNull();
    expect(() => act(game, "roll")).toThrow();
  });

  test("one through four humans fill exactly four fixed team slots with bots", () => {
    for (let humans = 1; humans <= 4; humans++) {
      const state = fixture(humans).snapshot();
      expect(state.players).toHaveLength(4);
      expect(state.players.filter(player => player.isBot)).toHaveLength(4 - humans);
      expect(state.players.every(player => player.occupied)).toBe(true);
      expect(state.connected).toBe(humans);
      expect(state.players.map(player => player.teamId)).toEqual(TEAMS.map(team => team.id));
    }
  });

  test("teams are exclusive, fixed-index reservations survive disconnect and reset", () => {
    const game = createGame({ questions });
    expect(game.join("hatter")).toBe(3);
    expect(() => game.join("hatter")).toThrow();
    expect(() => game.join("invented")).toThrow();
    game.disconnect(3);
    expect(() => game.join("hatter")).toThrow();
    expect(game.join("hatter", { resume: true })).toBe(3);
    host(game, "start", { chapters: [1] });
    host(game, "reset");
    const state = game.snapshot();
    expect(state.phase).toBe("lobby");
    expect(state.players[3].occupied).toBe(true);
    expect(state.players[3].isBot).toBe(false);
    expect(state.players.filter(player => player.occupied)).toHaveLength(1);
    expect(state.players.every(player => player.progress.every(value => value === -1))).toBe(true);
  });

  test("no legal action skips the question; stale actions cannot mutate twice", () => {
    const game = createGame({ questions, random: () => 0 });
    game.join("alice");
    host(game, "start", { chapters: [1] });
    const version = game.snapshot().version;
    game.dispatch({ playerIndex: 0 }, { type: "roll", version });
    expect(game.snapshot().awaiting).toBe("continue");
    expect(game.snapshot().pendingQuestion).toBeNull();
    expect(() => game.dispatch({ playerIndex: 0 }, { type: "roll", version })).toThrow();
    expect(game.snapshot().version).toBe(version + 1);
  });

  test("host-only controls, pause and disconnect preserve locked questions", () => {
    const game = fixture();
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    const before = game.snapshot();
    expect(before.pendingQuestion).not.toHaveProperty("answer");
    expect(before.pendingQuestion).not.toHaveProperty("correctAnswer");
    expect(() => act(game, "pause")).toThrow();
    host(game, "pause");
    expect(() => act(game, "answer", { index: 0 })).toThrow();
    expect(game.nextBotAction()).toBeNull();
    expect(game.snapshot().pendingQuestion).toEqual(before.pendingQuestion);
    host(game, "resume");
    game.disconnect(0);
    expect(() => act(game, "answer", { index: 0 })).toThrow();
    game.join("alice", { resume: true });
    expect(game.snapshot().selectedPiece).toBe(before.selectedPiece);
    act(game, "answer", { index: 0 });
    expect(game.snapshot().players[0].progress[0]).toBe(6);
    host(game, "end");
    expect(game.snapshot().phase).toBe("finished");
    expect(game.snapshot().winner).toBeNull();
    expect(game.nextBotAction()).toBeNull();
  });

  test("chapter selection limits questions and bots expose one paced action at a time", () => {
    const bank = [...questions, { ...questions[0], chapter: 2, prompt: "Chapter two only" }];
    const game = createGame({ questions: bank, random: () => 0.999 });
    game.join("rabbit");
    host(game, "start", { chapters: [2] });
    expect(game.nextBotAction().type).toBe("roll");
    act(game, "roll");
    expect(game.nextBotAction()).toMatchObject({ type: "choose", action: "enter" });
    act(game, "choose", { action: "enter" });
    act(game, "continue");
    act(game, "roll");
    expect(game.nextBotAction()).toMatchObject({ type: "move", piece: 0 });
    act(game, "move", { piece: 0 });
    expect(game.snapshot().pendingQuestion.chapter).toBe(2);
    expect(game.snapshot().pendingQuestion.prompt).toBe("Chapter two only");
    expect(game.nextBotAction().type).toBe("answer");
    host(game, "pause");
    expect(game.nextBotAction()).toBeNull();
    host(game, "reset");
    expect(game.nextBotAction()).toBeNull();
  });
  test("configured chapters persist until start and require a current local-host lobby command", () => {
    const game = createGame({ questions: [...questions, { ...questions[0], chapter: 2 }] });
    game.join("alice");
    const version = game.snapshot().version;
    expect(() => game.dispatch({ playerIndex: 0 }, { type: "configure", version, chapters: [2] })).toThrow();
    host(game, "configure", { chapters: [2, 2] });
    expect(game.snapshot().chapters).toEqual([2]);
    expect(() => game.dispatch({ host: true }, { type: "configure", version, chapters: [1] })).toThrow();
    expect(() => host(game, "configure", { chapters: [] })).toThrow();
    expect(() => host(game, "configure", { chapters: [3] })).toThrow();
    host(game, "start");
    expect(game.snapshot().chapters).toEqual([2]);
    expect(() => host(game, "configure", { chapters: [1] })).toThrow();
  });

  test("reserved human AI cover and reclaim preserve a locked question and invalidate stale actions", () => {
    const game = fixture();
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    const before = game.snapshot();
    game.disconnect(0);
    game.setController(0, { bot: true, connected: false });
    expect(game.snapshot().players[0].isBot).toBe(true);
    const staleBotAction = game.nextBotAction();
    expect(staleBotAction.type).toBe("answer");
    game.setController(0, { bot: false, connected: true });
    const restored = game.snapshot();
    expect(restored.players[0].progress).toEqual(before.players[0].progress);
    expect(restored.pendingQuestion).toEqual(before.pendingQuestion);
    expect(restored.selectedPiece).toBe(before.selectedPiece);
    expect(restored.roll).toBe(before.roll);
    expect(game.nextBotAction()).toBeNull();
    expect(() => game.dispatch({ playerIndex: 0, bot: true }, staleBotAction)).toThrow();
    act(game, "answer", { index: restored.pendingQuestion.options.indexOf("Rabbit") });
    expect(game.snapshot().players[0].progress[0]).toBe(6);
    expect(() => game.setController(1, { connected: true })).toThrow();
  });

  test("reset keeps covered human reservations but removes genuinely unreserved AI", () => {
    const game = fixture();
    game.disconnect(0);
    game.setController(0, { bot: true });
    host(game, "reset");
    const state = game.snapshot();
    expect(state.players[0]).toMatchObject({ occupied: true, connected: false, isBot: false });
    expect(state.players.slice(1).every(player => !player.occupied)).toBe(true);
    expect(state.players[0].progress).toEqual([-1, -1, -1, -1]);
    game.setController(0, { connected: true });
    host(game, "start");
    expect(game.snapshot().connected).toBe(1);
  });

  test("source provenance, explanations and answer indices never appear in pending questions", () => {
    const game = createGame({ questions: [{ ...questions[0], sourceQuote: "Alice follows the White Rabbit." }], random: () => 0.999 });
    game.join("alice");
    host(game, "start");
    enter(game);
    act(game, "roll");
    act(game, "move", { piece: 0 });
    expect(Object.keys(game.snapshot().pendingQuestion).sort()).toEqual(["chapter", "id", "options", "prompt"]);
    expect(game.snapshot().lastFeedback).toBeNull();
  });
});
