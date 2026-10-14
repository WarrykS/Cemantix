"use strict";

const CFG = window.CEMANTIX_CONFIG;
const TOP = 1000;
const DATA_VERSION = 2; // à incrémenter après chaque régénération de data/
const $ = (id) => document.getElementById(id);

// ---------- Utilitaires ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible : la partie ne sera pas conservée */
    }
  },
};

function parisDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

function dayNumber(isoDate) {
  const ms = Date.parse(isoDate + "T00:00:00Z") - Date.parse(CFG.startDate + "T00:00:00Z");
  return Math.round(ms / 86400000) + 1;
}

function puzzleDate(n) {
  const d = new Date(Date.parse(CFG.startDate + "T00:00:00Z") + (n - 1) * 86400000);
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function stripAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae");
}

function normalizeInput(s) {
  // « l'eau » -> « eau » (le vocabulaire ne contient pas d'apostrophes)
  return s.trim().toLowerCase().replace(/^.*[’']/, "").trim().replace(/\s+/g, "-");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtTemp(score) {
  return (score / 100).toFixed(2).replace(".", ",");
}

function fmtDuration(s) {
  if (s == null) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : m ? `${m} min ${String(sec).padStart(2, "0")}` : `${sec} s`;
}

function emoji(score, rank, found) {
  if (found) return "🥳";
  if (rank != null) {
    const p = TOP - rank;
    if (p >= 999) return "😱";
    if (p >= 990) return "🔥";
    if (p >= 900) return "🥵";
    return "😎";
  }
  return score < 0 ? "🧊" : "🥶";
}

// ---------- Données du jeu ----------

let vocab = [];
let wordIndex = new Map();
let accentless = new Map();

async function loadVocab() {
  const res = await fetch(`data/vocab.txt?v=${DATA_VERSION}`);
  if (!res.ok) throw new Error("vocabulaire introuvable");
  vocab = (await res.text()).split("\n");
  vocab.forEach((w, i) => {
    wordIndex.set(w, i);
    const k = stripAccents(w);
    if (!accentless.has(k)) accentless.set(k, i); // vocab trié par fréquence : on garde le plus courant
  });
}

async function loadDay(n) {
  const res = await fetch(`data/days/${n}.bin.gz?v=${DATA_VERSION}`);
  if (!res.ok) return null;
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  const scores = new Int16Array(buf);
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, TOP);
  const rank = new Map(order.map((idx, r) => [idx, r]));
  return { scores, order, rank, secret: order[0] };
}

function lookup(raw) {
  const w = normalizeInput(raw);
  if (wordIndex.has(w)) return wordIndex.get(w);
  const k = stripAccents(w);
  if (accentless.has(k)) return accentless.get(k);
  return null;
}

// ---------- Supabase (historique partagé) ----------

async function sb(path, options = {}) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: CFG.supabaseKey,
      Authorization: `Bearer ${CFG.supabaseKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* corps vide */
    }
    const err = new Error(body.message || `Erreur serveur (${res.status})`);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rpc = (name, args = {}) => sb(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
const fetchHistory = () => rpc("cemantix_history");

// Session : { pseudo, token } (le mot de passe n'est jamais conservé dans le navigateur)
const session = () => store.get("cx_session", null);

function handleAuthError(e) {
  if (e.code === "28000") {
    // session expirée ou supprimée : on redemande le mot de passe
    store.set("cx_session", null);
    renderPseudo();
    askPseudo();
    return true;
  }
  return false;
}

// ---------- Parties et résultats (communs aux trois jeux) ----------

// p_game n'est envoyé que pour Sutom et les mots croisés : Cémantix reste compatible avec l'ancienne base.
const gameArg = (game) => (game === "cemantix" ? {} : { p_game: game });
const stateKey = (game, pseudo, puzzle) =>
  game === "cemantix" ? `cx_v3_game_${pseudo.toLowerCase()}_${puzzle}` : `cx_${game}_${pseudo.toLowerCase()}_${puzzle}`;
const durationOf = (g) => (g.start && g.end ? Math.max(0, Math.round((g.end - g.start) / 1000)) : null);

// Sauvegarde la partie dans le navigateur et sur le serveur (pour la reprendre sur un autre appareil)
function saveState(game, puzzle, data) {
  const sess = session();
  if (!sess) return;
  store.set(stateKey(game, sess.pseudo, puzzle), data);
  rpc("cemantix_save_game", { p_token: sess.token, p_puzzle: puzzle, p_state: data, ...gameArg(game) }).catch(handleAuthError);
}

// Renvoie { local, remote } (données brutes), ou null si la session a expiré
async function loadState(game, puzzle) {
  const sess = session();
  const local = store.get(stateKey(game, sess.pseudo, puzzle), null);
  let remote = null;
  try {
    remote = await rpc("cemantix_load_game", { p_token: sess.token, p_puzzle: puzzle, ...gameArg(game) });
  } catch (e) {
    if (handleAuthError(e)) return null;
  }
  return { local, remote };
}

// Enregistre le résultat du jour : "ok", "duplicate" (déjà enregistré ailleurs) ; lève une erreur sinon
function submitResult(game, puzzle, { tries, word = null, duration_s = null, won = true }) {
  const sess = session();
  return rpc("cemantix_submit", {
    p_token: sess.token, p_puzzle: puzzle, p_tries: tries, p_word: word, p_duration_s: duration_s,
    ...gameArg(game), ...(game === "cemantix" ? {} : { p_won: won }),
  });
}

async function saveResult(game) {
  const sess = session();
  if (!sess || game.saved) return;
  try {
    const res = await submitResult("cemantix", game.puzzle, {
      tries: game.guesses.length, word: vocab[state.day.secret], duration_s: durationOf(game),
    });
    game.saved = true;
    game.conflict = res === "duplicate"; // déjà enregistré depuis un autre appareil
  } catch (e) {
    if (!handleAuthError(e)) {
      showMessage("Impossible d'enregistrer ton résultat pour l'instant, nouvel essai au prochain chargement.");
    }
  }
  saveGame(game);
  renderWin();
}

// ---------- Partie ----------

const state = { puzzle: 0, day: null, game: null, last: null, fresh: null };

function newGame(puzzle) {
  return { puzzle, guesses: [], found: false, start: null, end: null, saved: false };
}

// Les propositions sont sauvegardées sous forme de mots (et non de positions dans le
// vocabulaire) pour survivre à une régénération des données. Chaque joueur a sa partie,
// gardée dans le navigateur et sur le serveur (pour la reprendre sur un autre appareil).
function serializeGame(game) {
  return { ...game, guesses: game.guesses.map((g) => vocab[g.i]) };
}

function deserializeGame(saved, puzzle) {
  if (!saved || !Array.isArray(saved.guesses)) return null;
  const guesses = saved.guesses.filter((w) => wordIndex.has(w)).map((w) => ({ i: wordIndex.get(w) }));
  return { ...newGame(puzzle), ...saved, puzzle, guesses };
}

function saveGame(game) {
  saveState("cemantix", game.puzzle, serializeGame(game));
}

async function loadGame(puzzle) {
  const saved = await loadState("cemantix", puzzle);
  if (!saved) return null;
  let local = deserializeGame(saved.local, puzzle);
  // Partie commencée avant la création des comptes : on la rattache au premier joueur connecté
  const legacy = deserializeGame(store.get(`cx_v2_game_${puzzle}`, null), puzzle);
  if (legacy && !local) {
    local = legacy;
    try {
      localStorage.removeItem(`cx_v2_game_${puzzle}`);
    } catch {
      /* rien */
    }
  }
  const remote = deserializeGame(saved.remote, puzzle);
  // On garde la version la plus avancée (la partie trouvée, sinon celle avec le plus de mots)
  const score = (g) => (g ? (g.found ? 1e6 : 0) + g.guesses.length : -1);
  const game = score(remote) >= score(local) ? remote : local;
  return game || newGame(puzzle);
}

function showMessage(text) {
  $("message").textContent = text;
}

// Nombre de mots plus proches du mot secret que le mot i (le mot secret compris) :
// 1 = le mot le plus proche, il ne reste plus que la réponse.
function distance(i) {
  const day = state.day;
  if (!day.dist) day.dist = new Map();
  if (!day.dist.has(i)) {
    const s = day.scores[i];
    let n = 0;
    for (let j = 0; j < day.scores.length; j++) if (day.scores[j] > s) n++;
    day.dist.set(i, n);
  }
  return day.dist.get(i);
}

const fmtInt = (n) => n.toLocaleString("fr-FR");
const motsTxt = (n) => `${fmtInt(n)} mot${n > 1 ? "s" : ""}`;

function guessRow(g, n, highlight) {
  const rank = state.day.rank.get(g.i);
  const found = g.i === state.day.secret;
  const prog = rank != null ? TOP - rank : null;
  const fresh = g.i === state.fresh;
  const heat = found ? "" : prog >= 990 ? " hot burning" : prog >= 900 ? " hot" : "";
  const bar = prog != null
    ? `<div class="bar${heat}${fresh ? " grow" : ""}"><div style="width:${prog / 10}%"></div><span>${prog}</span></div>`
    : "";
  return `<tr class="${highlight ? "hl" : ""}${found ? " found" : ""}">
    <td>${n}</td><td>${esc(vocab[g.i])}</td><td>${fmtTemp(state.day.scores[g.i])}</td>
    <td><span class="${fresh && (heat || found) ? "pop" : ""}">${emoji(state.day.scores[g.i], rank, found)}</span></td><td>${bar}</td></tr>`;
}

function renderDistance() {
  const { game, day } = state;
  const box = $("distance");
  if (game.found || !game.guesses.length) {
    box.hidden = true;
    return;
  }
  const best = game.guesses.reduce((a, b) => (day.scores[b.i] > day.scores[a.i] ? b : a));
  const d = distance(best.i);
  box.innerHTML = d === 1
    ? `🎯 Tu es à <strong>1 mot</strong> de la réponse : « ${esc(vocab[best.i])} » est le mot le plus proche !`
    : `🎯 Tu es à <strong>${motsTxt(d)}</strong> de la réponse <span>(meilleur mot : « ${esc(vocab[best.i])} »)</span>`;
  box.classList.toggle("close", d <= 100);
  box.hidden = false;
}

function renderGuesses() {
  const { game, day } = state;
  $("guesses").hidden = game.guesses.length === 0;
  const numbered = game.guesses.map((g, k) => ({ ...g, n: k + 1 }));
  const last = state.last != null ? numbered.find((g) => g.i === state.last) : null;
  $("last-guess").innerHTML = last ? guessRow(last, last.n, true) : "";
  numbered.sort((a, b) => day.scores[b.i] - day.scores[a.i]);
  $("guess-list").innerHTML = numbered.map((g) => guessRow(g, g.n, g.i === state.last)).join("");
  state.fresh = null; // l'animation d'arrivée ne joue qu'une fois
  renderDistance();
}

function renderWin() {
  const { game, day } = state;
  const box = $("win");
  if (!game.found) {
    box.hidden = true;
    return;
  }
  const saveInfo = game.conflict
    ? "ℹ️ Ton résultat du jour était déjà enregistré (depuis un autre appareil) : seul le premier compte."
    : game.saved
      ? "✅ Résultat enregistré dans l'historique du groupe."
      : "⏳ Enregistrement du résultat…";
  const closest = day.order.slice(1, 101).map((idx, r) =>
    `<li><span>${esc(vocab[idx])}</span><span>${fmtTemp(day.scores[idx])} °C</span><span>${TOP - r - 1}</span></li>`).join("");
  box.innerHTML = `
    <h2>🥳 Bravo, le mot était « ${esc(vocab[day.secret])} » !</h2>
    <p>Trouvé en <strong>${game.guesses.length}</strong> essai${game.guesses.length > 1 ? "s" : ""}
      ${game.end && game.start ? `et ${fmtDuration(Math.round((game.end - game.start) / 1000))}` : ""}.</p>
    <p>${saveInfo}</p>
    <p><button type="button" id="share-btn">Partager mon score</button></p>
    <details><summary>Les 100 mots les plus proches</summary><ol class="closest">${closest}</ol></details>`;
  $("share-btn").onclick = share;
  box.hidden = false;
}

async function share() {
  const g = state.game;
  const best = g.guesses.length;
  const text = `Cémantix entre amis n°${g.puzzle} : trouvé en ${best} essai${best > 1 ? "s" : ""} 🥳\n${location.origin}${location.pathname}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      showMessage("Score copié, tu peux le coller à tes amis !");
    }
  } catch {
    /* partage annulé */
  }
}

function submitGuess(raw) {
  if (dayNumber(parisDate()) !== state.puzzle) {
    location.reload(); // minuit est passé : nouveau mot
    return;
  }
  const { game } = state;
  if (!game || !raw.trim()) return;
  const i = lookup(raw);
  if (i == null) {
    showMessage(`Je ne connais pas le mot « ${raw.trim()} ».`);
    return;
  }
  state.last = i;
  if (game.guesses.some((g) => g.i === i)) {
    showMessage(`« ${vocab[i]} » a déjà été proposé.`);
  } else {
    if (!game.guesses.length) game.start = Date.now(); // le chrono démarre au premier mot
    game.guesses.push({ i });
    state.fresh = i;
    // L'encadré « Tu es à N mots » couvre déjà le meilleur mot : on ne détaille que les autres
    const isBest = game.guesses.every((g) => distance(g.i) >= distance(i));
    showMessage(isBest ? "" : `« ${vocab[i]} » est à ${motsTxt(distance(i))} de la réponse.`);
    if (i === state.day.secret && !game.found) {
      game.found = true;
      game.end = Date.now();
      $("guess-form").hidden = true;
    }
    saveGame(game);
  }
  renderGuesses();
  if (game.found) {
    renderWin();
    saveResult(game);
  }
}

// ---------- Pseudo ----------

function renderPseudo() {
  const sess = session();
  $("pseudo-btn").textContent = sess ? `👤 ${sess.pseudo} · changer` : "👤 Se connecter";
}

function askPseudo() {
  const sess = session();
  $("pseudo-input").value = sess ? sess.pseudo : store.get("cx_pseudo", "");
  $("password-input").value = "";
  $("login-error").textContent = "";
  if (!$("pseudo-dialog").open) $("pseudo-dialog").showModal();
  ($("pseudo-input").value ? $("password-input") : $("pseudo-input")).focus();
}
window.askPseudo = askPseudo;

$("pseudo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").textContent = "";
  try {
    const old = session();
    const res = await rpc("cemantix_login", { p_pseudo: $("pseudo-input").value, p_password: $("password-input").value });
    if (old) rpc("cemantix_logout", { p_token: old.token }).catch(() => {});
    store.set("cx_session", { pseudo: res.pseudo, token: res.token });
    $("pseudo-dialog").close();
    renderPseudo();
    await restartGames();
    if (res.created) flash(`Compte « ${res.pseudo} » créé. Retiens bien ton mot de passe !`);
  } catch (err) {
    $("login-error").textContent = err.message || "Connexion impossible, vérifie ta connexion internet.";
  } finally {
    btn.disabled = false;
  }
});

$("pseudo-btn").addEventListener("click", () => {
  const sess = session();
  if (sess && !confirm(`Te déconnecter de « ${sess.pseudo} » pour changer de joueur ?`)) return;
  if (sess) {
    rpc("cemantix_logout", { p_token: sess.token }).catch(() => {});
    store.set("cx_session", null);
    renderPseudo();
    restartGames();
  }
  askPseudo();
});
$("login-open").addEventListener("click", askPseudo);

// ---------- Classement & historique ----------

let historyRows = null;

async function loadHistory(force) {
  if (historyRows && !force) return historyRows;
  historyRows = await fetchHistory();
  return historyRows;
}

// Présentation des résultats propre à chaque jeu
const RESULT = {
  cemantix: {
    todayTitle: "Ils ont trouvé aujourd'hui",
    historyTitle: "Historique des trouvailles",
    empty: "Personne n'a encore trouvé le mot d'aujourd'hui. À toi de jouer !",
    sort: (a, b) => a.tries - b.tries || (a.duration_s ?? 1e9) - (b.duration_s ?? 1e9),
    score: (r) => `${r.tries} essai${r.tries > 1 ? "s" : ""}`,
    statHead: ["Mots trouvés", "Moyenne", "Record"],
    stats: (rs) => [rs.length, avg(rs.map((r) => r.tries)), Math.min(...rs.map((r) => r.tries))],
  },
  sutom: {
    todayTitle: "Résultats du jour",
    historyTitle: "Historique Sutom",
    empty: "Personne n'a encore joué le Sutom d'aujourd'hui. À toi de jouer !",
    sort: (a, b) => (b.won - a.won) || a.tries - b.tries || (a.duration_s ?? 1e9) - (b.duration_s ?? 1e9),
    score: (r) => (r.won ? `${r.tries}/6` : "✗ perdu"),
    statHead: ["Gagnés", "Moyenne", "Record"],
    stats: (rs) => {
      const won = rs.filter((r) => r.won);
      return [`${won.length}/${rs.length}`, won.length ? avg(won.map((r) => r.tries)) : "–",
        won.length ? `${Math.min(...won.map((r) => r.tries))}/6` : "–"];
    },
  },
  mots: {
    todayTitle: "Grille du jour : les plus rapides",
    historyTitle: "Historique des grilles",
    empty: "Personne n'a encore fini la grille d'aujourd'hui. À toi de jouer !",
    sort: (a, b) => (a.duration_s ?? 1e9) - (b.duration_s ?? 1e9) || a.tries - b.tries,
    score: (r) => `${fmtDuration(r.duration_s) || "?"}${r.tries > 1 ? ` · ${r.tries - 1} vérif.` : ""}`,
    statHead: ["Grilles", "Temps moyen", "Record"],
    stats: (rs) => {
      const t = rs.map((r) => r.duration_s).filter((x) => x != null);
      return [rs.length, t.length ? fmtDuration(Math.round(t.reduce((x, y) => x + y, 0) / t.length)) : "–",
        t.length ? fmtDuration(Math.min(...t)) : "–"];
    },
  },
};
const avg = (xs) => (xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(1).replace(".", ",");

async function renderToday() {
  const R = RESULT[activeGame];
  $("today-title").textContent = R.todayTitle;
  const box = $("today-board");
  box.innerHTML = "<p>Chargement…</p>";
  try {
    const rows = (await loadHistory(true))
      .filter((r) => (r.game || "cemantix") === activeGame && r.puzzle === state.puzzle)
      .sort(R.sort);
    if (!rows.length) {
      box.innerHTML = `<p>${R.empty}</p>`;
      return;
    }
    const me = (session()?.pseudo || "").toLowerCase();
    box.innerHTML = `<table class="board"><thead><tr><th></th><th>Joueur</th><th>Résultat</th><th>Temps</th><th>Heure</th></tr></thead><tbody>
      ${rows.map((r, k) => `<tr class="${r.pseudo.toLowerCase() === me ? "me" : ""}">
        <td>${r.won === false ? "" : ["🥇", "🥈", "🥉"][k] || k + 1}</td><td>${esc(r.pseudo)}</td><td>${esc(R.score(r))}</td>
        <td>${fmtDuration(r.duration_s)}</td>
        <td>${new Date(r.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</td></tr>`).join("")}
      </tbody></table>`;
  } catch {
    box.innerHTML = "<p>Impossible de charger le classement. Vérifie ta connexion.</p>";
  }
}

async function renderHistory() {
  const R = RESULT[activeGame];
  $("history-title").textContent = R.historyTitle;
  const list = $("history-list");
  list.innerHTML = "<p>Chargement…</p>";
  let rows;
  try {
    rows = (await loadHistory(true)).filter((r) => (r.game || "cemantix") === activeGame);
  } catch {
    list.innerHTML = "<p>Impossible de charger l'historique. Vérifie ta connexion.</p>";
    return;
  }

  // Liste des joueurs pour le filtre
  const select = $("player-filter");
  const players = [...new Map(rows.map((r) => [r.pseudo.toLowerCase(), r.pseudo])).values()].sort((a, b) => a.localeCompare(b, "fr"));
  const current = select.value || store.get("cx_history_filter", "");
  select.innerHTML = `<option value="">Tout le monde</option>` +
    players.map((p) => `<option value="${esc(p.toLowerCase())}">${esc(p)}</option>`).join("");
  select.value = players.some((p) => p.toLowerCase() === current) ? current : "";

  const filter = select.value;
  const shown = filter ? rows.filter((r) => r.pseudo.toLowerCase() === filter) : rows;

  // Statistiques par joueur
  const byPlayer = new Map();
  for (const r of shown) {
    const k = r.pseudo.toLowerCase();
    if (!byPlayer.has(k)) byPlayer.set(k, []);
    byPlayer.get(k).push(r);
  }
  const statRows = [...byPlayer.values()].map((rs) => ({ pseudo: rs[0].pseudo, cols: R.stats(rs), n: rs.length }))
    .sort((a, b) => b.n - a.n);
  $("stats").innerHTML = statRows.length
    ? `<table class="board"><thead><tr><th>Joueur</th>${R.statHead.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>
      ${statRows.map((s) => `<tr><td>${esc(s.pseudo)}</td>${s.cols.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
      </tbody></table>`
    : "";

  if (!shown.length) {
    list.innerHTML = "<p>Aucun résultat enregistré pour l'instant.</p>";
    return;
  }
  const byPuzzle = new Map();
  for (const r of shown) {
    if (!byPuzzle.has(r.puzzle)) byPuzzle.set(r.puzzle, []);
    byPuzzle.get(r.puzzle).push(r);
  }
  list.innerHTML = [...byPuzzle.entries()].sort((a, b) => b[0] - a[0]).map(([n, rs]) => {
    const word = rs.find((r) => r.word)?.word;
    const label = activeGame === "mots" ? "" : word ? `« ${esc(word)} »` : "mot du jour 🤫";
    return `<article class="day">
      <header><strong>N°${n}</strong> · ${puzzleDate(n)}<span class="word">${label}</span></header>
      <ul>${rs.sort(R.sort).map((r) => `<li><span>${esc(r.pseudo)}</span><span>${esc(R.score(r))}${
        activeGame !== "mots" && r.duration_s != null ? ` · ${fmtDuration(r.duration_s)}` : ""}</span></li>`).join("")}</ul>
    </article>`;
  }).join("");
}

$("player-filter").addEventListener("change", (e) => {
  store.set("cx_history_filter", e.target.value);
  renderHistory();
});

// ---------- Onglets ----------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "today") renderToday();
    if (btn.dataset.tab === "history") renderHistory();
  });
});

$("yesterday-btn").addEventListener("click", async () => {
  if (state.puzzle <= 1) {
    $("yesterday-word").textContent = "C'est le tout premier jour !";
    return;
  }
  $("yesterday-word").textContent = "…";
  const d = await loadDay(state.puzzle - 1).catch(() => null);
  $("yesterday-word").textContent = d ? `« ${vocab[d.secret]} »` : "indisponible";
});

$("guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("guess-input");
  submitGuess(input.value);
  input.value = "";
  input.focus();
});


// ---------- Démarrage ----------

// Affiche la partie du joueur connecté (ou l'invitation à se connecter)
function renderGame() {
  const game = state.game;
  $("guess-form").hidden = !game || game.found;
  if (!game) {
    $("guesses").hidden = true;
    $("distance").hidden = true;
    $("win").hidden = true;
    showMessage("");
    return;
  }
  renderGuesses();
  renderWin();
}

async function startCemantix() {
  state.game = null;
  state.last = null;
  if (!state.day) {
    try {
      if (!vocab.length) await loadVocab();
      state.day = await loadDay(state.puzzle);
    } catch (e) {
      console.error(e);
    }
  }
  if (!state.day) {
    $("status").textContent = typeof DecompressionStream === "undefined"
      ? "Ton navigateur est trop ancien pour ce jeu : mets-le à jour (ou essaie Chrome / Firefox / Safari récent)."
      : state.puzzle < 1
        ? "Le jeu n'a pas encore commencé, reviens bientôt !"
        : "Impossible de charger le mot du jour (ou plus de mots disponibles).";
    return;
  }
  $("status").textContent = `Mot secret n°${state.puzzle} — ${puzzleDate(state.puzzle)}`;
  if (session()) state.game = await loadGame(state.puzzle);
  renderGame();
  if (!state.game) return;
  if (state.game.found && !state.game.saved) saveResult(state.game);
  else if (!state.game.found && activeGame === "cemantix") $("guess-input").focus();
}

// ---------- Jeux ----------

// Chaque jeu s'enregistre ici : { title, start() } ; start() (re)charge la partie du joueur connecté
const GAMES = { cemantix: { title: "Cémantix", start: startCemantix } };
window.GAMES = GAMES;
let activeGame = "cemantix";
const started = new Set();

// Message bref dans la zone du jeu affiché
function flash(text) {
  const el = $(activeGame === "cemantix" ? "message" : `${activeGame}-message`);
  if (el) el.textContent = text;
}

async function activateGame(id) {
  if (!GAMES[id]) id = "cemantix";
  activeGame = id;
  store.set("cx_active_game", id);
  history.replaceState(null, "", id === "cemantix" ? location.pathname : `#${id}`);
  $("game-title").textContent = GAMES[id].title;
  document.querySelectorAll(".game-btn").forEach((b) => b.classList.toggle("active", b.dataset.game === id));
  document.querySelectorAll(".game").forEach((g) => { g.hidden = g.id !== `game-${id}`; });
  const tab = document.querySelector(".tab.active")?.dataset.tab;
  if (tab === "today") renderToday();
  if (tab === "history") renderHistory();
  $("login-needed").hidden = !!session();
  if (!started.has(id)) {
    started.add(id);
    await GAMES[id].start();
  }
}

// Après une connexion ou une déconnexion : chaque jeu recharge la partie du nouveau joueur
async function restartGames() {
  started.clear();
  for (const id of Object.keys(GAMES)) if (GAMES[id].reset) GAMES[id].reset();
  $("login-needed").hidden = !!session();
  started.add(activeGame);
  await GAMES[activeGame].start();
  if (!session()) askPseudo();
}

document.querySelectorAll(".game-btn").forEach((b) => b.addEventListener("click", () => activateGame(b.dataset.game)));

async function init() {
  renderPseudo();
  state.puzzle = dayNumber(parisDate());
  $("puzzle-label").textContent = `Jour n°${state.puzzle}`;
  const fromHash = location.hash.slice(1);
  await activateGame(GAMES[fromHash] ? fromHash : store.get("cx_active_game", "cemantix"));
  if (!session()) askPseudo();
}

// Les autres jeux (sutom.js, mots.js) s'enregistrent avant ce signal
document.addEventListener("DOMContentLoaded", init);
