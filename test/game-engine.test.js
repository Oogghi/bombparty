import test from "node:test";
import assert from "node:assert/strict";
import { createLexicon } from "../src/lexicon.js";
import { GameEngine } from "../src/game-engine.js";

const lexicon = createLexicon([
  "palace", "palais", "palmeraie", "paladin", "palette", "palmier",
  "bateau", "batterie", "battre", "bonjour", "bonheur", "bonbon",
  "orange", "orage", "organique", "ordinateur", "parler", "partager"
]);

function makeEngine(settings = {}) {
  let time = 1_000;
  const engine = new GameEngine({
    lexicon,
    code: "ABC123",
    now: () => time,
    random: () => 0
  });
  engine.setSettings({ ...settings });
  engine.addPlayer({ id: "a", name: "Alice" });
  engine.addPlayer({ id: "b", name: "Bob" });
  return { engine, advance: (ms) => { time += ms; } };
}

test("valide un mot accentué après normalisation et passe le tour", () => {
  const { engine } = makeEngine();
  assert.equal(engine.start().ok, true);
  const active = engine.activePlayerId;
  const word = [...lexicon.byFragment.get(engine.sequence)].find((candidate) => candidate === "palais")
    ?? [...lexicon.words][0];
  const result = engine.submit(active, word === "palais" ? "PALaïs" : word);
  assert.equal(result.type, "valid");
  assert.equal(engine.players.get(active).lastWord.sequence, result.sequence);
  assert.notEqual(engine.activePlayerId, active);
});

test("refuse le doublon, un mot inconnu et une séquence absente", () => {
  const { engine } = makeEngine();
  engine.start();
  const active = engine.activePlayerId;
  const answer = engine.lexicon.byFragment.get(engine.sequence)[0];
  assert.equal(engine.submit(active, answer).type, "valid");
  const next = engine.activePlayerId;
  assert.equal(engine.submit(next, answer).reason, "duplicate");
  assert.equal(engine.submit(next, "motimaginé").reason, "unknown");
  assert.equal(engine.submit(next, "orange").reason, "fragment");
});

test("une expiration retire une vie, élimine puis désigne le dernier joueur", () => {
  const { engine, advance } = makeEngine({ lives: 1, turnSeconds: 3 });
  engine.start();
  const loser = engine.activePlayerId;
  advance(3_001);
  const timeout = engine.expire();
  assert.equal(timeout.type, "timeout");
  assert.equal(engine.players.get(loser).lives, 0);
  assert.equal(engine.players.get(loser).spectator, true);
  assert.equal(engine.phase, "finished");
  assert.equal(engine.winnerId, "b");
});

test("le réglage de difficulté est borné et les séquences ont des réponses dans le lexique chargé", () => {
  const { engine } = makeEngine({ lives: 99, turnSeconds: 1, difficulty: "expert" });
  assert.deepEqual(engine.settings, { lives: 9, turnSeconds: 3, difficulty: "expert" });
  engine.start();
  assert.ok(engine.lexicon.byFragment.get(engine.sequence).some((word) => !engine.usedWords.has(word)));
  assert.equal(engine.snapshot().dictionarySize, lexicon.words.size);
});
