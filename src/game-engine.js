import { findFragmentIndex, normalizeWord } from "./lexicon.js";

export const DIFFICULTIES = {
  facile: { label: "Facile", min: 30, max: Infinity },
  standard: { label: "Standard", min: 12, max: 29 },
  expert: { label: "Expert", min: 4, max: 11 }
};

const randomItem = (items, random = Math.random) => items[Math.floor(random() * items.length)];

export function cleanSettings(settings = {}) {
  const lives = Number(settings.lives);
  const turnSeconds = Number(settings.turnSeconds);
  const difficulty = DIFFICULTIES[settings.difficulty] ? settings.difficulty : "standard";
  return {
    lives: Number.isInteger(lives) ? Math.min(9, Math.max(1, lives)) : 3,
    turnSeconds: Number.isInteger(turnSeconds) ? Math.min(30, Math.max(3, turnSeconds)) : 8,
    difficulty
  };
}

export class GameEngine {
  constructor({ lexicon, now = () => Date.now(), random = Math.random, code = "" }) {
    this.lexicon = lexicon;
    this.now = now;
    this.random = random;
    this.code = code;
    this.phase = "lobby";
    this.settings = cleanSettings();
    this.players = new Map();
    this.hostId = null;
    this.order = [];
    this.turnIndex = -1;
    this.activePlayerId = null;
    this.sequence = null;
    this.expiresAt = 0;
    this.turnId = 0;
    this.usedWords = new Set();
    this.winnerId = null;
  }

  addPlayer({ id, name, connected = true }) {
    if (this.players.has(id)) {
      const player = this.players.get(id);
      player.name = name || player.name;
      player.connected = connected;
      return player;
    }
    const player = {
      id,
      name,
      connected,
      lives: this.settings.lives,
      spectator: this.phase === "playing",
      lastWord: null
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    return player;
  }

  setConnected(id, connected) {
    const player = this.players.get(id);
    if (player) player.connected = connected;
    return player;
  }

  removePlayer(id) {
    const wasActive = this.activePlayerId === id;
    const removedIndex = this.order.indexOf(id);
    this.players.delete(id);
    this.order = this.order.filter((playerId) => playerId !== id);
    if (removedIndex >= 0 && removedIndex < this.turnIndex) this.turnIndex -= 1;
    if (this.hostId === id) this.transferHost();
    if (wasActive && this.phase === "playing") this.startNextTurn();
    return this.players.size === 0;
  }

  transferHost() {
    this.hostId = [...this.players.values()].find((player) => player.connected)?.id
      ?? this.players.keys().next().value
      ?? null;
  }

  setSettings(settings) {
    if (this.phase !== "lobby") return false;
    this.settings = cleanSettings({ ...this.settings, ...settings });
    return true;
  }

  start() {
    if (this.phase !== "lobby") return { ok: false, reason: "phase" };
    const connectedPlayers = [...this.players.values()].filter((player) => player.connected);
    if (connectedPlayers.length < 2) return { ok: false, reason: "players" };
    this.phase = "playing";
    this.winnerId = null;
    this.usedWords.clear();
    this.order = connectedPlayers.map((player) => player.id);
    this.turnIndex = -1;
    for (const player of this.players.values()) {
      player.lives = this.settings.lives;
      player.spectator = !player.connected;
      player.lastWord = null;
    }
    this.startNextTurn();
    return { ok: true };
  }

  resetForReplay() {
    if (this.phase !== "finished") return false;
    this.phase = "lobby";
    this.order = [];
    this.turnIndex = -1;
    this.activePlayerId = null;
    this.sequence = null;
    this.expiresAt = 0;
    this.usedWords.clear();
    this.winnerId = null;
    for (const player of this.players.values()) {
      player.lives = this.settings.lives;
      player.spectator = false;
      player.lastWord = null;
    }
    return true;
  }

  getAliveConnected() {
    return this.order
      .map((id) => this.players.get(id))
      .filter((player) => player?.connected && player.lives > 0 && !player.spectator);
  }

  chooseSequence() {
    const difficulty = DIFFICULTIES[this.settings.difficulty];
    const eligible = [];
    for (const [fragment, words] of this.lexicon.byFragment) {
      if (words.length < difficulty.min || words.length > difficulty.max) continue;
      if (words.some((word) => !this.usedWords.has(word))) eligible.push(fragment);
    }
    const fallback = [...this.lexicon.byFragment.keys()].filter((fragment) => {
      const words = this.lexicon.byFragment.get(fragment);
      return words.some((word) => !this.usedWords.has(word));
    });
    return randomItem(eligible.length ? eligible : fallback, this.random) ?? "ou";
  }

  startNextTurn() {
    if (this.phase !== "playing") return null;
    const alive = this.getAliveConnected();
    if (alive.length <= 1) {
      this.finish(alive[0]?.id ?? null);
      return null;
    }

    const startingIndex = this.turnIndex;
    for (let step = 1; step <= this.order.length; step += 1) {
      const index = (startingIndex + step + this.order.length) % this.order.length;
      const player = this.players.get(this.order[index]);
      if (player?.connected && player.lives > 0 && !player.spectator) {
        this.turnIndex = index;
        this.activePlayerId = player.id;
        this.sequence = this.chooseSequence();
        this.expiresAt = this.now() + this.settings.turnSeconds * 1000;
        this.turnId += 1;
        return player.id;
      }
    }
    this.finish(null);
    return null;
  }

  finish(winnerId) {
    this.phase = "finished";
    this.winnerId = winnerId;
    this.activePlayerId = null;
    this.sequence = null;
    this.expiresAt = 0;
  }

  expire() {
    if (this.phase !== "playing") return { type: "ignored" };
    const playerId = this.activePlayerId;
    const player = this.players.get(playerId);
    if (player) {
      player.lives = Math.max(0, player.lives - 1);
      if (player.lives === 0) player.spectator = true;
    }
    const result = {
      type: "timeout",
      playerId,
      eliminated: Boolean(player && player.lives === 0),
      lives: player?.lives ?? 0,
      sequence: this.sequence
    };
    this.startNextTurn();
    return { ...result, winnerId: this.winnerId, phase: this.phase };
  }

  submit(playerId, rawWord) {
    if (this.phase !== "playing" || this.activePlayerId !== playerId) {
      return { type: "ignored" };
    }
    if (this.now() >= this.expiresAt) return this.expire();
    const display = String(rawWord ?? "").trim().slice(0, 48);
    const normalized = normalizeWord(display);
    if (!normalized) return { type: "invalid", reason: "unknown" };
    if (!this.lexicon.words.has(normalized)) return { type: "invalid", reason: "unknown" };
    if (this.usedWords.has(normalized)) return { type: "invalid", reason: "duplicate" };
    if (!normalized.includes(this.sequence)) return { type: "invalid", reason: "fragment" };

    const sequence = this.sequence;
    this.usedWords.add(normalized);
    const player = this.players.get(playerId);
    if (player) {
      player.lastWord = { display, normalized, sequence, index: findFragmentIndex(normalized, sequence) };
    }
    const result = { type: "valid", playerId, word: display, sequence };
    this.startNextTurn();
    return { ...result, nextPlayerId: this.activePlayerId, winnerId: this.winnerId, phase: this.phase };
  }

  snapshot() {
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      hostId: this.hostId,
      players: [...this.players.values()].map(({ id, name, connected, lives, spectator, lastWord }) => ({
        id, name, connected, lives, spectator, lastWord
      })),
      order: this.order,
      activePlayerId: this.activePlayerId,
      sequence: this.sequence,
      sequenceAnswerCount: this.sequence ? (this.lexicon.byFragment.get(this.sequence)?.filter((word) => !this.usedWords.has(word)).length ?? 0) : 0,
      expiresAt: this.expiresAt,
      turnId: this.turnId,
      usedCount: this.usedWords.size,
      winnerId: this.winnerId,
      dictionarySize: this.lexicon.words.size,
      difficultyLabel: DIFFICULTIES[this.settings.difficulty].label
    };
  }
}
