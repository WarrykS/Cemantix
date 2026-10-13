"use strict";

const CFG = window.CEMANTIX_CONFIG;
const TOP = 1000;
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
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe").replace(/æ/g, "ae");
}

function normalizeInput(s) {
  return s.trim().toLowerCase().replace(/[’']/g, "").replace(/\s+/g, "-");
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
  const res = await fetch("data/vocab.txt");
  if (!res.ok) throw new Error("vocabulaire introuvable");
  vocab = (await res.text()).split("\n");
  vocab.forEach((w, i) => {
    wordIndex.set(w, i);
    const k = stripAccents(w);
    if (!accentless.has(k)) accentless.set(k, i); // vocab trié par fréquence : on garde le plus courant
  });
}

async function loadDay(n) {
  const res = await fetch(`data/days/${n}.bin.gz`);
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
    const err = new Error(`Supabase ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const fetchHistory = () => sb("rpc/cemantix_history", { method: "POST", body: "{}" });

async function saveResult(game) {
  const pseudo = store.get("cx_pseudo", "");
  if (!pseudo || game.saved) return;
  try {
    await sb("results", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        puzzle: game.puzzle,
        pseudo,
        tries: game.guesses.length,
        word: vocab[state.day.secret],
        duration_s: Math.max(0, Math.round((game.end - game.start) / 1000)),
      }),
    });
    game.saved = true;
  } catch (e) {
    if (e.status === 409) {
      game.saved = true; // déjà enregistré pour ce pseudo aujourd'hui
    } else {
      showMessage("Impossible d'enregistrer ton résultat pour l'instant, nouvel essai au prochain chargement.");
    }
  }
  store.set(`cx_game_${game.puzzle}`, game);
  renderWin();
}

// ---------- Partie ----------

const state = { puzzle: 0, day: null, game: null, last: null };

function newGame(puzzle) {
  return { puzzle, guesses: [], found: false, start: Date.now(), end: null, saved: false };
}

function showMessage(text) {
  $("message").textContent = text;
}

function guessRow(g, n, highlight) {
  const rank = state.day.rank.get(g.i);
  const found = g.i === state.day.secret;
  const prog = rank != null ? TOP - rank : null;
  const bar = prog != null
    ? `<div class="bar"><div style="width:${prog / 10}%"></div><span>${prog}</span></div>`
    : "";
  return `<tr class="${highlight ? "hl" : ""}${found ? " found" : ""}">
    <td>${n}</td><td>${esc(vocab[g.i])}</td><td>${fmtTemp(state.day.scores[g.i])}</td>
    <td>${emoji(state.day.scores[g.i], rank, found)}</td><td>${bar}</td></tr>`;
}

function renderGuesses() {
  const { game, day } = state;
  $("guesses").hidden = game.guesses.length === 0;
  const numbered = game.guesses.map((g, k) => ({ ...g, n: k + 1 }));
  const last = state.last != null ? numbered.find((g) => g.i === state.last) : null;
  $("last-guess").innerHTML = last ? guessRow(last, last.n, true) : "";
  numbered.sort((a, b) => day.scores[b.i] - day.scores[a.i]);
  $("guess-list").innerHTML = numbered.map((g) => guessRow(g, g.n, g.i === state.last)).join("");
}

function renderWin() {
  const { game, day } = state;
  const box = $("win");
  if (!game.found) {
    box.hidden = true;
    return;
  }
  const pseudo = store.get("cx_pseudo", "");
  const saveInfo = game.saved
    ? "✅ Résultat enregistré dans l'historique du groupe."
    : pseudo
      ? "⏳ Enregistrement du résultat…"
      : `<button class="link" type="button" onclick="askPseudo()">Choisis un pseudo</button> pour enregistrer ton résultat.`;
  const closest = day.order.slice(1, 101).map((idx, r) =>
    `<li><span>${esc(vocab[idx])}</span><span>${fmtTemp(day.scores[idx])} °C</span><span>${TOP - r - 1}</span></li>`).join("");
  box.innerHTML = `
    <h2>🥳 Bravo, le mot était « ${esc(vocab[day.secret])} » !</h2>
    <p>Trouvé en <strong>${game.guesses.length}</strong> essai${game.guesses.length > 1 ? "s" : ""}
      ${game.end ? `et ${fmtDuration(Math.round((game.end - game.start) / 1000))}` : ""}.</p>
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
  if (!raw.trim()) return;
  const i = lookup(raw);
  if (i == null) {
    showMessage(`Je ne connais pas le mot « ${raw.trim()} ».`);
    return;
  }
  state.last = i;
  if (game.guesses.some((g) => g.i === i)) {
    showMessage(`« ${vocab[i]} » a déjà été proposé.`);
  } else {
    game.guesses.push({ i });
    showMessage("");
    if (i === state.day.secret && !game.found) {
      game.found = true;
      game.end = Date.now();
      $("guess-form").hidden = true;
    }
    store.set(`cx_game_${game.puzzle}`, game);
  }
  renderGuesses();
  if (game.found) {
    renderWin();
    saveResult(game);
  }
}

// ---------- Pseudo ----------

function renderPseudo() {
  const p = store.get("cx_pseudo", "");
  $("pseudo-btn").textContent = p ? `👤 ${p}` : "👤 Choisir un pseudo";
}

function askPseudo() {
  $("pseudo-input").value = store.get("cx_pseudo", "");
  $("pseudo-dialog").showModal();
}
window.askPseudo = askPseudo;

$("pseudo-form").addEventListener("submit", () => {
  const p = $("pseudo-input").value.trim().slice(0, 24);
  if (!p) return;
  store.set("cx_pseudo", p);
  renderPseudo();
  if (state.game && state.game.found && !state.game.saved) saveResult(state.game);
});

// ---------- Classement & historique ----------

let history = null;

async function loadHistory(force) {
  if (history && !force) return history;
  history = await fetchHistory();
  return history;
}

async function renderToday() {
  const box = $("today-board");
  box.innerHTML = "<p>Chargement…</p>";
  try {
    const rows = (await loadHistory(true)).filter((r) => r.puzzle === state.puzzle);
    if (!rows.length) {
      box.innerHTML = "<p>Personne n'a encore trouvé le mot d'aujourd'hui. À toi de jouer !</p>";
      return;
    }
    const me = store.get("cx_pseudo", "").toLowerCase();
    box.innerHTML = `<table class="board"><thead><tr><th></th><th>Joueur</th><th>Essais</th><th>Temps</th><th>Heure</th></tr></thead><tbody>
      ${rows.map((r, k) => `<tr class="${r.pseudo.toLowerCase() === me ? "me" : ""}">
        <td>${["🥇", "🥈", "🥉"][k] || k + 1}</td><td>${esc(r.pseudo)}</td><td>${r.tries}</td>
        <td>${fmtDuration(r.duration_s)}</td>
        <td>${new Date(r.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</td></tr>`).join("")}
      </tbody></table>`;
  } catch {
    box.innerHTML = "<p>Impossible de charger le classement. Vérifie ta connexion.</p>";
  }
}

async function renderHistory() {
  const list = $("history-list");
  list.innerHTML = "<p>Chargement…</p>";
  let rows;
  try {
    rows = await loadHistory(true);
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
  const stats = new Map();
  for (const r of rows) {
    const k = r.pseudo.toLowerCase();
    if (filter && k !== filter) continue;
    const s = stats.get(k) || { pseudo: r.pseudo, n: 0, total: 0, best: Infinity };
    s.n++;
    s.total += r.tries;
    s.best = Math.min(s.best, r.tries);
    stats.set(k, s);
  }
  const statRows = [...stats.values()].sort((a, b) => b.n - a.n || a.total / a.n - b.total / b.n);
  $("stats").innerHTML = statRows.length
    ? `<table class="board"><thead><tr><th>Joueur</th><th>Mots trouvés</th><th>Moyenne</th><th>Record</th></tr></thead><tbody>
      ${statRows.map((s) => `<tr><td>${esc(s.pseudo)}</td><td>${s.n}</td><td>${(s.total / s.n).toFixed(1).replace(".", ",")}</td><td>${s.best}</td></tr>`).join("")}
      </tbody></table>`
    : "";

  if (!shown.length) {
    list.innerHTML = "<p>Aucune trouvaille enregistrée pour l'instant.</p>";
    return;
  }
  const byPuzzle = new Map();
  for (const r of shown) {
    if (!byPuzzle.has(r.puzzle)) byPuzzle.set(r.puzzle, []);
    byPuzzle.get(r.puzzle).push(r);
  }
  list.innerHTML = [...byPuzzle.entries()].sort((a, b) => b[0] - a[0]).map(([n, rs]) => {
    const word = rs.find((r) => r.word)?.word;
    return `<article class="day">
      <header><strong>N°${n}</strong> · ${puzzleDate(n)}
        <span class="word">${word ? `« ${esc(word)} »` : "mot du jour 🤫"}</span></header>
      <ul>${rs.sort((a, b) => a.tries - b.tries).map((r) =>
        `<li><span>${esc(r.pseudo)}</span><span>${r.tries} essai${r.tries > 1 ? "s" : ""}${r.duration_s != null ? ` · ${fmtDuration(r.duration_s)}` : ""}</span></li>`).join("")}</ul>
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

$("pseudo-btn").addEventListener("click", askPseudo);

// ---------- Démarrage ----------

async function init() {
  renderPseudo();
  state.puzzle = dayNumber(parisDate());
  $("puzzle-label").textContent = `Jour n°${state.puzzle}`;
  try {
    await loadVocab();
    state.day = await loadDay(state.puzzle);
  } catch (e) {
    console.error(e);
  }
  if (!state.day) {
    $("status").textContent = state.puzzle < 1
      ? "Le jeu n'a pas encore commencé, reviens bientôt !"
      : "Impossible de charger le mot du jour (ou plus de mots disponibles).";
    return;
  }
  $("status").textContent = `Mot secret n°${state.puzzle} — ${puzzleDate(state.puzzle)}`;
  state.game = store.get(`cx_game_${state.puzzle}`, null) || newGame(state.puzzle);
  $("guess-form").hidden = state.game.found;
  renderGuesses();
  renderWin();
  if (state.game.found && !state.game.saved) saveResult(state.game);
  if (!store.get("cx_pseudo", "")) askPseudo();
  else if (!state.game.found) $("guess-input").focus();
}

init();
