const $ = (selector) => document.querySelector(selector);
const views = { home: $("#home-view"), lobby: $("#lobby-view"), game: $("#game-view"), finished: $("#finished-view") };
const homeForm = $("#home-form");
const nickname = $("#nickname");
const roomCodeInput = $("#room-code");
const homeFeedback = $("#home-feedback");
const toast = $("#toast");
const storedTokenKey = "bomb-party-session";

let socket;
let state;
let myId = null;
let roomCode = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
let sessionToken = localStorage.getItem(storedTokenKey) ?? "";
let reconnectTimer;
let reconnectDelay = 700;
let lastEventId = 0;
let toastTimer;

roomCodeInput.value = roomCode;

function showView(name) {
  for (const [key, view] of Object.entries(views)) {
    const active = key === name;
    view.hidden = !active;
    view.classList.toggle("active-view", active);
  }
}

function setHomeFeedback(message = "") { homeFeedback.textContent = message; }

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener("open", () => {
    reconnectDelay = 700;
    $("#connection-label").innerHTML = '<span class="status-dot"></span> Connecté';
    if (sessionToken) send({ type: "resume", sessionToken });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  });
  socket.addEventListener("close", () => {
    $("#connection-label").innerHTML = '<span class="status-dot" style="background:#f27e90;box-shadow:none"></span> Reconnexion…';
    if (sessionToken) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 1.5);
    }
  });
}

function handleMessage(message) {
  if (message.type === "welcome") {
    myId = message.playerId;
    roomCode = message.roomCode;
    sessionToken = message.sessionToken;
    localStorage.setItem(storedTokenKey, sessionToken);
    history.replaceState(null, "", `?room=${roomCode}`);
    setHomeFeedback("");
    toast.classList.remove("show");
    toast.textContent = "";
    return;
  }
  if (message.type === "state") {
    renderState(message.state);
    return;
  }
  if (message.type === "feedback") {
    const target = $("#word-feedback");
    target.textContent = message.message;
    target.classList.toggle("valid", message.level === "success");
    if (views.game.hidden) setHomeFeedback(message.message);
    return;
  }
  if (message.type === "error") {
    if (message.code === "SESSION_EXPIRED") {
      localStorage.removeItem(storedTokenKey);
      sessionToken = "";
      myId = null;
      showView("home");
    }
    setHomeFeedback(message.message);
    showToast(message.message);
  }
}

function initials(name) {
  return String(name ?? "?").trim().slice(0, 1).toLocaleUpperCase("fr-FR") || "?";
}

function getMe() { return state?.players.find((player) => player.id === myId); }

function renderState(nextState) {
  state = nextState;
  $("#difficulty-chip").textContent = String(state.difficultyLabel ?? state.settings.difficulty).toUpperCase();
  if (state.phase === "lobby") renderLobby();
  if (state.phase === "playing") renderGame();
  if (state.phase === "finished") renderFinished();
  renderTimer();
  const event = state.lastEvent;
  if (event && event.id > lastEventId) {
    lastEventId = event.id;
    renderEvent(event);
  }
}

function renderLobby() {
  showView("lobby");
  $("#lobby-title").textContent = `Salon ${state.code}`;
  $("#lobby-subtitle").textContent = `${state.players.length} / 8 joueurs · en attente du départ`;
  $("#room-code-label").textContent = state.code;
  const container = $("#lobby-players");
  container.replaceChildren();
  for (const player of state.players) {
    const card = document.createElement("div");
    card.className = "lobby-player";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = initials(player.name);
    const name = document.createElement("strong");
    name.textContent = player.name;
    const status = document.createElement("small");
    status.textContent = player.connected ? "Prêt à jouer" : "Reconnexion…";
    card.append(avatar, name, status);
    if (player.id === state.hostId) {
      const badge = document.createElement("span");
      badge.className = "player-badge";
      badge.textContent = "HÔTE";
      card.append(badge);
    }
    container.append(card);
  }
  const isHost = state.hostId === myId;
  $("#start-button").hidden = !isHost;
  $("#lobby-hint").textContent = isHost
    ? (state.players.filter((player) => player.connected).length >= 2 ? "Tout le monde est prêt ?" : "Il faut au moins deux joueurs pour lancer la partie.")
    : "L’hôte choisit les réglages et lance la partie.";
  for (const id of ["setting-lives", "setting-time", "setting-difficulty"]) {
    $("#" + id).disabled = !isHost;
  }
  $("#setting-lives").value = String(state.settings.lives);
  $("#setting-time").value = String(state.settings.turnSeconds);
  $("#setting-difficulty").value = state.settings.difficulty;
}

function renderPlayerCard(player, index, total) {
  const card = document.createElement("article");
  card.className = `player-card${player.id === state.activePlayerId ? " active" : ""}${player.spectator ? " spectator" : ""}${player.connected ? "" : " disconnected"}`;
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  const x = 50 + Math.cos(angle) * 42;
  const y = 50 + Math.sin(angle) * 42;
  card.style.left = `${x}%`;
  card.style.top = `${y}%`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(player.name);
  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.name;
  const role = document.createElement("span");
  role.className = "player-role";
  role.textContent = player.spectator ? "Spectateur" : player.id === state.activePlayerId ? "À son tour" : player.connected ? "En jeu" : "Absent";
  const hearts = document.createElement("div");
  hearts.className = "hearts";
  for (let index = 0; index < state.settings.lives; index += 1) {
    const heart = document.createElement("span");
    heart.className = index < player.lives ? "" : "off";
    heart.textContent = "♥";
    hearts.append(heart);
  }
  const lastWord = document.createElement("div");
  lastWord.className = "last-word";
  if (player.lastWord) appendHighlighted(lastWord, player.lastWord.display, player.lastWord.sequence);
  else lastWord.textContent = "Aucun mot pour l’instant";
  const live = document.createElement("div");
  const typing = state.liveInput?.playerId === player.id ? state.liveInput.text : "";
  live.className = `live-typing${typing ? " has-input" : ""}`;
  live.textContent = typing;
  card.append(avatar, name, role, hearts, lastWord, live);
  return card;
}

function appendHighlighted(container, display, fragment) {
  const source = String(display ?? "");
  const normalizedChars = [];
  let normalized = "";
  for (const [index, character] of Array.from(source).entries()) {
    const clean = character.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR").replace(/[^a-z]/g, "");
    for (const letter of clean) { normalized += letter; normalizedChars.push(index); }
  }
  const needle = String(fragment ?? "");
  const start = normalized.indexOf(needle);
  const end = start < 0 ? -1 : start + needle.length;
  let buffer = "";
  let highlighted = false;
  for (const [index, character] of Array.from(source).entries()) {
    const match = start >= 0 && normalizedChars.some((sourceIndex, normalizedIndex) => sourceIndex === index && normalizedIndex >= start && normalizedIndex < end);
    if (match && !highlighted) {
      if (buffer) container.append(document.createTextNode(buffer));
      buffer = "";
      const span = document.createElement("span");
      span.className = "found";
      span.textContent = character;
      container.append(span);
      highlighted = true;
    } else if (match && highlighted) {
      container.lastChild.textContent += character;
    } else {
      if (highlighted) { highlighted = false; }
      buffer += character;
    }
  }
  if (buffer) container.append(document.createTextNode(buffer));
}

function renderGame() {
  showView("game");
  const me = getMe();
  const isMyTurn = state.activePlayerId === myId;
  const isSpectator = Boolean(me?.spectator) || !state.order.includes(myId);
  $("#game-state-label").textContent = isSpectator ? "MODE SPECTATEUR" : isMyTurn ? "À TOI DE JOUER" : "LA BOMBE CIRCULE";
  $("#sequence").textContent = state.sequence ?? "--";
  $("#answer-count").textContent = state.sequenceAnswerCount ? `${state.sequenceAnswerCount} réponses possibles` : "Séquence en préparation";
  $("#used-count").textContent = `${state.usedCount} mot${state.usedCount > 1 ? "s" : ""} utilisé${state.usedCount > 1 ? "s" : ""}`;
  const input = $("#word-input");
  input.disabled = !isMyTurn || isSpectator;
  input.placeholder = isMyTurn ? "Écris un mot…" : isSpectator ? "Tu regardes la partie" : "Au tour d’un autre joueur";
  const message = $("#turn-message");
  message.textContent = isSpectator ? "Tu es spectateur jusqu’à la prochaine partie." : isMyTurn ? "Trouve la séquence avant l’explosion." : `${state.players.find((player) => player.id === state.activePlayerId)?.name ?? "Un joueur"} joue…`;
  const ring = $("#players-ring");
  ring.replaceChildren(...state.players.map((player, index) => renderPlayerCard(player, index, state.players.length)));
  const activeIndex = state.players.findIndex((player) => player.id === state.activePlayerId);
  const arrow = $("#turn-arrow");
  if (activeIndex < 0) arrow.classList.add("hidden");
  else {
    arrow.classList.remove("hidden");
    arrow.style.transform = `rotate(${(activeIndex / state.players.length) * 360 - 90}deg)`;
  }
  if (isMyTurn && document.activeElement !== input) input.focus();
}

function renderFinished() {
  showView("finished");
  const winner = state.players.find((player) => player.id === state.winnerId);
  $("#winner-title").textContent = winner ? `${winner.name} gagne !` : "Partie terminée";
  $("#winner-subtitle").textContent = winner ? "La dernière personne avec des vies remporte la partie." : "Tout le monde a quitté le salon.";
  const scoreboard = $("#final-scoreboard");
  scoreboard.replaceChildren();
  for (const [index, player] of [...state.players].sort((a, b) => b.lives - a.lives).entries()) {
    const row = document.createElement("div");
    row.className = `score-row${player.id === state.winnerId ? " winner" : ""}`;
    const rank = document.createElement("span"); rank.className = "score-rank"; rank.textContent = `0${index + 1}`;
    const name = document.createElement("span"); name.className = "score-name"; name.textContent = player.name;
    const lives = document.createElement("span"); lives.className = "score-lives"; lives.textContent = player.lives > 0 ? `${"♥".repeat(player.lives)}` : "Éliminé";
    row.append(rank, name, lives); scoreboard.append(row);
  }
  const isHost = state.hostId === myId;
  $("#play-again").hidden = !isHost;
  $("#replay-hint").textContent = isHost ? "Les mêmes joueurs peuvent repartir avec les réglages actuels." : "L’hôte peut relancer une partie quand vous êtes prêts.";
}

function renderTimer() {
  if (!state?.expiresAt || state.phase !== "playing") {
    $("#timer-text").textContent = "--";
    $("#timer-progress").style.width = "0%";
    return;
  }
  const remaining = Math.max(0, state.expiresAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  const progress = Math.max(0, Math.min(100, remaining / (state.settings.turnSeconds * 1000) * 100));
  $("#timer-text").textContent = String(seconds).padStart(2, "0");
  $("#timer-progress").style.width = `${progress}%`;
  $("#timer-progress").classList.toggle("urgent", seconds <= 3);
}

function renderEvent(event) {
  const bomb = $("#bomb");
  if (event.type === "timeout") {
    bomb.classList.remove("explode");
    void bomb.offsetWidth;
    bomb.classList.add("explode");
    if (event.playerId === myId) showFeedback("La bombe a explosé — une vie en moins.", false);
    else showToast("La bombe a explosé !");
  } else if (event.type === "valid" && event.playerId === myId) {
    showFeedback("Validé ! La bombe passe.", true);
  }
}

function showFeedback(message, valid) {
  const target = $("#word-feedback");
  target.textContent = message;
  target.classList.toggle("valid", valid);
  clearTimeout(showFeedback.timer);
  showFeedback.timer = setTimeout(() => { target.textContent = ""; }, 1800);
}

setInterval(renderTimer, 100);

homeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formAction = event.submitter?.dataset.action ?? "create";
  const name = nickname.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return setHomeFeedback("Choisis un pseudo pour jouer.");
  if (formAction === "join" && !code) return setHomeFeedback("Indique le code du salon.");
  localStorage.setItem("bomb-party-name", name);
  setHomeFeedback("");
  connect();
  const sendJoin = () => send(formAction === "create" ? { type: "create", name } : { type: "join", name, code });
  if (socket.readyState === WebSocket.OPEN) sendJoin();
  else socket.addEventListener("open", sendJoin, { once: true });
});

$("#start-button").addEventListener("click", () => send({ type: "start" }));
$("#play-again").addEventListener("click", () => send({ type: "play-again" }));
$("#word-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#word-input");
  if (input.disabled || !input.value.trim()) return;
  send({ type: "submit", word: input.value, actionId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}` });
  input.value = "";
});
$("#word-input").addEventListener("input", (event) => send({ type: "typing", text: event.target.value }));
for (const id of ["setting-lives", "setting-time", "setting-difficulty"]) {
  $("#" + id).addEventListener("change", () => send({
    type: "set-settings",
    lives: $("#setting-lives").value,
    turnSeconds: $("#setting-time").value,
    difficulty: $("#setting-difficulty").value
  }));
}
$("#copy-room").addEventListener("click", async () => {
  const invite = `${location.origin}?room=${roomCode}`;
  try { await navigator.clipboard.writeText(invite); showToast("Lien d’invitation copié."); }
  catch { showToast(`Code du salon : ${roomCode}`); }
});
$("#rules-button").addEventListener("click", () => $("#rules-dialog").showModal());
$("#close-rules").addEventListener("click", () => $("#rules-dialog").close());
$("#rules-dialog").addEventListener("click", (event) => { if (event.target === $("#rules-dialog")) $("#rules-dialog").close(); });

nickname.value = localStorage.getItem("bomb-party-name") ?? "";
connect();
