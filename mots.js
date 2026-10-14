"use strict";

// ---------- Mots croisés : une petite grille par jour ----------
(() => {
  const M = { grid: null, cells: new Map(), game: null, cur: null, dir: "a", wrong: new Set(), saveTimer: null };
  const key = (r, c) => `${r},${c}`;
  const msg = (t) => { $("mots-message").textContent = t; };

  async function loadGrid(n) {
    const res = await fetch(`data/mots/${n}.json?v=${DATA_VERSION}`);
    if (!res.ok) return null;
    const grid = await res.json();
    // cases : lettre attendue + mot horizontal / vertical auquel elles appartiennent
    M.cells = new Map();
    for (const e of grid.entries) {
      e.cells = [];
      for (let i = 0; i < e.answer.length; i++) {
        const r = e.d === "a" ? e.r : e.r + i, c = e.d === "a" ? e.c + i : e.c;
        const k = key(r, c);
        if (!M.cells.has(k)) M.cells.set(k, { r, c, answer: e.answer[i], a: null, d: null, num: null });
        const cell = M.cells.get(k);
        cell[e.d] = e;
        if (i === 0) cell.num = e.n;
        e.cells.push(k);
      }
    }
    return grid;
  }

  const entryAt = (k, dir) => M.cells.get(k)?.[dir] || null;
  const currentEntry = () => entryAt(M.cur, M.dir) || entryAt(M.cur, M.dir === "a" ? "d" : "a");

  function render() {
    const { grid, game } = M;
    const box = $("mots-grid");
    box.style.setProperty("--cols", grid.cols);
    const entry = currentEntry();
    const inWord = new Set(entry ? entry.cells : []);
    let html = "";
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const k = key(r, c);
        const cell = M.cells.get(k);
        if (!cell) { html += `<div class="cw-cell block"></div>`; continue; }
        const cls = ["cw-cell"];
        if (inWord.has(k)) cls.push("word");
        if (k === M.cur) cls.push("cur");
        if (M.wrong.has(k)) cls.push("wrong");
        if (game.found) cls.push("done");
        html += `<label class="${cls.join(" ")}">${cell.num ? `<span class="num">${cell.num}</span>` : ""}
          <input data-k="${k}" maxlength="2" autocomplete="off" autocapitalize="characters" spellcheck="false"
            aria-label="Case ligne ${r + 1}, colonne ${c + 1}" value="${game.letters[k] || ""}"${game.found ? " readonly" : ""}></label>`;
      }
    }
    box.innerHTML = html;
    renderClues();
    renderCurrentClue();
    renderEnd();
    $("mots-actions").hidden = game.found;
  }

  function renderClues() {
    const entry = currentEntry();
    const list = (d, title) => `<div><h3>${title}</h3><ol>${M.grid.entries.filter((e) => e.d === d).map((e) => {
      const done = e.cells.every((k) => M.game.letters[k]);
      return `<li class="${e === entry ? "active" : ""}${done ? " filled" : ""}" data-n="${e.n}" data-d="${d}">
        <b>${e.n}.</b> ${esc(e.clue)} <span class="len">(${e.answer.length})</span></li>`;
    }).join("")}</ol></div>`;
    $("mots-clues").innerHTML = list("a", "Horizontalement") + list("d", "Verticalement");
  }

  function renderCurrentClue() {
    const e = currentEntry();
    const box = $("mots-clue");
    box.hidden = !e || M.game.found;
    if (e) box.innerHTML = `<b>${e.n} ${e.d === "a" ? "horizontal" : "vertical"}</b> · ${esc(e.clue)} <span class="len">(${e.answer.length})</span>`;
  }

  function renderEnd() {
    const g = M.game;
    const box = $("mots-end");
    if (!g.found) { box.hidden = true; return; }
    const saveInfo = g.conflict
      ? "ℹ️ Ton résultat du jour était déjà enregistré (depuis un autre appareil)."
      : g.saved ? "✅ Résultat enregistré dans l'historique du groupe." : "⏳ Enregistrement du résultat…";
    box.innerHTML = `<h2>🎉 Grille terminée en ${fmtDuration(durationOf(g)) || "un rien de temps"} !</h2>
      <p>${g.checks ? `${g.checks} vérification${g.checks > 1 ? "s" : ""} utilisée${g.checks > 1 ? "s" : ""}.` : "Sans aucune vérification, chapeau !"}</p>
      <p>${saveInfo}</p>
      <p><button type="button" id="mots-share">Partager mon temps</button></p>`;
    $("mots-share").onclick = share;
    box.hidden = false;
  }

  async function share() {
    const g = M.game;
    const text = `Mots croisés entre amis n°${g.puzzle} : grille finie en ${fmtDuration(durationOf(g))}${g.checks ? ` (${g.checks} vérif.)` : " sans vérification"} ✏️\n${location.origin}${location.pathname}#mots`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); msg("Résultat copié, tu peux le coller à tes amis !"); }
    } catch { /* partage annulé */ }
  }

  // Sauvegarde regroupée : au plus une écriture serveur par seconde pendant la saisie
  function saveGame(now) {
    clearTimeout(M.saveTimer);
    const run = () => saveState("mots", M.game.puzzle, M.game);
    if (now) run();
    else M.saveTimer = setTimeout(run, 1000);
  }

  async function saveResult() {
    const g = M.game;
    if (!session() || g.saved) return;
    try {
      const res = await submitResult("mots", g.puzzle, { tries: g.checks + 1, duration_s: durationOf(g), won: true });
      g.saved = true;
      g.conflict = res === "duplicate";
    } catch (e) {
      if (!handleAuthError(e)) msg("Impossible d'enregistrer ton résultat pour l'instant, nouvel essai au prochain chargement.");
    }
    saveGame(true);
    renderEnd();
  }

  function checkComplete() {
    const g = M.game;
    const all = [...M.cells.keys()];
    if (!all.every((k) => g.letters[k])) { msg(""); return; }
    if (all.every((k) => g.letters[k] === M.cells.get(k).answer)) {
      g.found = true;
      g.end = Date.now();
      M.wrong.clear();
      msg("");
      saveGame(true);
      render();
      saveResult();
    } else {
      msg("La grille est pleine, mais il reste des erreurs.");
    }
  }

  function focusCell(k) {
    M.cur = k;
    render();
    const input = document.querySelector(`#mots-grid input[data-k="${k}"]`);
    if (input) { input.focus({ preventScroll: true }); input.select(); }
  }

  function select(k, toggle) {
    const cell = M.cells.get(k);
    if (!cell) return;
    if (toggle && k === M.cur && cell.a && cell.d) M.dir = M.dir === "a" ? "d" : "a";
    else if (!cell[M.dir]) M.dir = cell.a ? "a" : "d";
    focusCell(k);
  }

  function move(step) {
    const e = currentEntry();
    if (!e) return;
    const i = e.cells.indexOf(M.cur) + step;
    if (i >= 0 && i < e.cells.length) focusCell(e.cells[i]);
  }

  function setLetter(k, letter) {
    const g = M.game;
    if (g.found) return;
    if (!g.start && letter) g.start = Date.now(); // le chrono démarre à la première lettre
    if (letter) g.letters[k] = letter;
    else delete g.letters[k];
    M.wrong.delete(k);
    saveGame();
  }

  const grid = $("mots-grid");
  grid.addEventListener("click", (e) => {
    const input = e.target.closest("label")?.querySelector("input");
    if (input) { e.preventDefault(); select(input.dataset.k, true); }
  });
  grid.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const letter = stripAccents(e.target.value).toUpperCase().replace(/[^A-Z]/g, "").slice(-1);
    setLetter(k, letter);
    if (letter) {
      const ent = currentEntry();
      const i = ent ? ent.cells.indexOf(k) : -1;
      if (ent && i < ent.cells.length - 1) focusCell(ent.cells[i + 1]);
      else focusCell(k);
    } else {
      render();
    }
    checkComplete();
  });
  grid.addEventListener("keydown", (e) => {
    const k = e.target.dataset?.k;
    if (!k) return;
    const [r, c] = k.split(",").map(Number);
    const go = (rr, cc, dir) => { if (M.cells.has(key(rr, cc))) { M.dir = dir; focusCell(key(rr, cc)); } };
    if (e.key === "Backspace" && !M.game.letters[k]) { e.preventDefault(); move(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(r, c + 1, "a"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(r, c - 1, "a"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); go(r + 1, c, "d"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(r - 1, c, "d"); }
    else if (e.key === "Tab") {
      e.preventDefault();
      const list = M.grid.entries;
      const i = list.indexOf(currentEntry());
      const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      M.dir = next.d;
      focusCell(next.cells.find((x) => !M.game.letters[x]) || next.cells[0]);
    }
  });
  $("mots-clues").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-n]");
    if (!li || M.game.found) return;
    const ent = M.grid.entries.find((x) => String(x.n) === li.dataset.n && x.d === li.dataset.d);
    M.dir = ent.d;
    focusCell(ent.cells.find((x) => !M.game.letters[x]) || ent.cells[0]);
  });
  $("mots-check").addEventListener("click", () => {
    const g = M.game;
    if (g.found) return;
    if (dayNumber(parisDate()) !== state.puzzle) { location.reload(); return; }
    g.checks = (g.checks || 0) + 1;
    M.wrong = new Set([...M.cells.keys()].filter((k) => g.letters[k] && g.letters[k] !== M.cells.get(k).answer));
    const filled = [...M.cells.keys()].filter((k) => g.letters[k]).length;
    msg(M.wrong.size
      ? `${M.wrong.size} lettre${M.wrong.size > 1 ? "s" : ""} fausse${M.wrong.size > 1 ? "s" : ""} (en rouge).`
      : filled ? "Aucune erreur pour l'instant, continue !" : "La grille est encore vide.");
    saveGame(true);
    render();
  });

  async function start() {
    M.game = null;
    M.wrong = new Set();
    $("mots-grid").innerHTML = "";
    $("mots-clues").innerHTML = "";
    $("mots-clue").hidden = true;
    $("mots-actions").hidden = true;
    $("mots-end").hidden = true;
    msg("");
    if (!M.grid) M.grid = await loadGrid(state.puzzle).catch(() => null);
    if (!M.grid) {
      $("mots-status").textContent = "Impossible de charger la grille du jour (ou plus de grilles disponibles).";
      return;
    }
    $("mots-status").textContent = `Grille n°${state.puzzle} — ${M.grid.entries.length} mots à trouver`;
    if (!session()) return;
    const saved = await loadState("mots", state.puzzle);
    if (!saved) return;
    const valid = (g) => (g && g.letters && typeof g.letters === "object" ? g : null);
    const local = valid(saved.local), remote = valid(saved.remote);
    const score = (g) => (g ? (g.found ? 1e6 : 0) + Object.keys(g.letters).length : -1);
    M.game = { puzzle: state.puzzle, letters: {}, checks: 0, found: false, start: null, end: null, saved: false,
      ...(score(remote) >= score(local) ? remote : local) };
    const first = M.grid.entries[0];
    M.dir = first.d;
    M.cur = first.cells[0];
    render();
    if (M.game.found && !M.game.saved) saveResult();
  }

  GAMES.mots = { title: "Mots croisés", start };
})();
