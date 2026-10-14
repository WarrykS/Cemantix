"use strict";

// ---------- Sutom : le mot du jour en 6 essais, première lettre donnée ----------
(() => {
  const TRIES = 6;
  const KEYS = ["AZERTYUIOP", "QSDFGHJKLM", "⌫WXCVBN⏎"];
  const S = { secret: null, dico: null, game: null, typed: "", busy: false };

  // Les mots du jour sont légèrement encodés (XOR + base64) pour ne pas se lire d'un coup d'œil
  async function loadSecret(n) {
    const res = await fetch(`data/sutom/${n}.txt?v=${DATA_VERSION}`);
    if (!res.ok) return null;
    const raw = atob((await res.text()).trim());
    const key = `sutom-${n}`;
    let out = "";
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return out;
  }

  async function loadDico() {
    if (S.dico) return S.dico;
    const res = await fetch(`data/sutom/dico.txt?v=${DATA_VERSION}`);
    S.dico = new Set((await res.text()).split("\n"));
    return S.dico;
  }

  const normalize = (s) => stripAccents(s).toUpperCase().replace(/[^A-Z]/g, "");

  // Couleurs d'un essai : "ok" bien placée, "mis" mal placée, "no" absente (doublons gérés)
  function evaluate(guess, secret) {
    const res = Array(secret.length).fill("no");
    const left = {};
    for (let i = 0; i < secret.length; i++) {
      if (guess[i] === secret[i]) res[i] = "ok";
      else left[secret[i]] = (left[secret[i]] || 0) + 1;
    }
    for (let i = 0; i < secret.length; i++) {
      if (res[i] !== "ok" && left[guess[i]]) {
        res[i] = "mis";
        left[guess[i]]--;
      }
    }
    return res;
  }

  const msg = (t) => { $("sutom-message").textContent = t; };
  const saveGame = () => saveState("sutom", S.game.puzzle, S.game);

  // Lettres trouvées (bien placées) à rappeler dans la ligne en cours
  function knownLetters() {
    const known = [S.secret[0]];
    for (const g of S.game.guesses) {
      evaluate(g, S.secret).forEach((r, i) => { if (r === "ok") known[i] = g[i]; });
    }
    return known;
  }

  function render(revealRow = -1) {
    const { game, secret } = S;
    const L = secret.length;
    const known = knownLetters();
    const rows = [];
    for (let r = 0; r < TRIES; r++) {
      const cells = [];
      const guess = game.guesses[r];
      const current = r === game.guesses.length && !game.found && !game.lost;
      const res = guess ? evaluate(guess, secret) : null;
      for (let i = 0; i < L; i++) {
        let letter = "", cls = "tile";
        if (guess) {
          letter = guess[i];
          cls += ` ${res[i]}`;
          if (r === revealRow) cls += " flip";
        } else if (current) {
          const typed = (secret[0] + S.typed)[i];
          if (typed) { letter = typed; cls += " typed"; }
          else if (known[i]) { letter = known[i]; cls += " hint"; }
        }
        const delay = r === revealRow ? ` style="animation-delay:${i * 0.12}s"` : "";
        cells.push(`<div class="${cls}"${delay}>${letter}</div>`);
      }
      rows.push(`<div class="tile-row${current ? " current" : ""}" style="--len:${L}">${cells.join("")}</div>`);
    }
    $("sutom-grid").innerHTML = rows.join("");
    renderKeyboard();
    renderEnd();
  }

  function renderKeyboard() {
    const best = {};
    const rank = { ok: 3, mis: 2, no: 1 };
    for (const g of S.game.guesses) {
      evaluate(g, S.secret).forEach((r, i) => { if ((rank[r] || 0) > (rank[best[g[i]]] || 0)) best[g[i]] = r; });
    }
    const kb = $("sutom-keyboard");
    kb.hidden = S.game.found || S.game.lost;
    kb.innerHTML = KEYS.map((row) => `<div class="kb-row">${[...row].map((k) => {
      const label = k === "⌫" ? "Effacer" : k === "⏎" ? "Valider" : k;
      const wide = k === "⌫" || k === "⏎" ? " wide" : "";
      return `<button type="button" class="key${wide} ${best[k] || ""}" data-key="${k}" aria-label="${label}">${k === "⏎" ? "Valider" : k}</button>`;
    }).join("")}</div>`).join("");
  }

  function renderEnd() {
    const { game, secret } = S;
    const box = $("sutom-end");
    if (!game.found && !game.lost) { box.hidden = true; return; }
    const saveInfo = game.conflict
      ? "ℹ️ Ton résultat du jour était déjà enregistré (depuis un autre appareil)."
      : game.saved ? "✅ Résultat enregistré dans l'historique du groupe." : "⏳ Enregistrement du résultat…";
    box.innerHTML = `
      <h2>${game.found ? `🎉 Bravo, trouvé en ${game.guesses.length} essai${game.guesses.length > 1 ? "s" : ""} !` : "😢 Perdu pour aujourd'hui"}</h2>
      <p>Le mot était <strong>${esc(secret)}</strong>${durationOf(game) != null ? ` · ${fmtDuration(durationOf(game))}` : ""}.</p>
      <p>${saveInfo}</p>
      <p><button type="button" id="sutom-share">Partager mon résultat</button></p>`;
    box.classList.toggle("lost", !!game.lost);
    $("sutom-share").onclick = share;
    box.hidden = false;
  }

  async function share() {
    const g = S.game;
    const emo = { ok: "🟥", mis: "🟡", no: "🟦" };
    const grid = g.guesses.map((w) => evaluate(w, S.secret).map((r) => emo[r]).join("")).join("\n");
    const text = `Sutom entre amis n°${g.puzzle} : ${g.found ? `${g.guesses.length}/6` : "✗/6"}\n${grid}\n${location.origin}${location.pathname}#sutom`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); msg("Résultat copié, tu peux le coller à tes amis !"); }
    } catch { /* partage annulé */ }
  }

  async function saveResult() {
    const g = S.game;
    if (!session() || g.saved) return;
    try {
      const res = await submitResult("sutom", g.puzzle, {
        tries: g.guesses.length, word: S.secret, duration_s: durationOf(g), won: !!g.found,
      });
      g.saved = true;
      g.conflict = res === "duplicate";
    } catch (e) {
      if (!handleAuthError(e)) msg("Impossible d'enregistrer ton résultat pour l'instant, nouvel essai au prochain chargement.");
    }
    saveGame();
    renderEnd();
  }

  async function submit() {
    const { game, secret } = S;
    if (S.busy || game.found || game.lost) return;
    if (dayNumber(parisDate()) !== state.puzzle) { location.reload(); return; }
    const word = secret[0] + S.typed;
    if (word.length < secret.length) { msg(`Il faut un mot de ${secret.length} lettres.`); shake(); return; }
    const dico = await loadDico();
    if (!dico.has(word)) { msg(`« ${word} » n'est pas dans le dictionnaire.`); shake(); return; }
    msg("");
    if (!game.guesses.length) game.start = Date.now();
    game.guesses.push(word);
    S.typed = "";
    if (word === secret) game.found = true;
    else if (game.guesses.length >= TRIES) game.lost = true;
    if (game.found || game.lost) game.end = Date.now();
    saveGame();
    S.busy = true;
    render(game.guesses.length - 1);
    setTimeout(() => {
      S.busy = false;
      if (game.found || game.lost) saveResult();
    }, secret.length * 120 + 400);
  }

  function shake() {
    const row = document.querySelector("#sutom-grid .tile-row.current");
    if (!row) return;
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
  }

  function press(key) {
    if (!S.game || S.game.found || S.game.lost || S.busy) return;
    if (key === "⏎") { submit(); return; }
    if (key === "⌫") { S.typed = S.typed.slice(0, -1); render(); return; }
    if (/^[A-Z]$/.test(key) && S.typed.length < S.secret.length - 1) {
      S.typed += key;
      msg("");
      render();
    }
  }

  $("sutom-keyboard").addEventListener("click", (e) => {
    const b = e.target.closest("[data-key]");
    if (b) press(b.dataset.key);
  });

  document.addEventListener("keydown", (e) => {
    if (activeGame !== "sutom" || !$("tab-play").classList.contains("active")) return;
    if ($("pseudo-dialog").open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest("input, select, textarea")) return;
    if (e.key === "Enter") { e.preventDefault(); press("⏎"); }
    else if (e.key === "Backspace") { e.preventDefault(); press("⌫"); }
    else {
      const k = normalize(e.key);
      if (k.length === 1) press(k);
    }
  });

  async function start() {
    S.game = null;
    S.typed = "";
    $("sutom-grid").innerHTML = "";
    $("sutom-keyboard").hidden = true;
    $("sutom-end").hidden = true;
    msg("");
    if (!S.secret) S.secret = await loadSecret(state.puzzle).catch(() => null);
    if (!S.secret) {
      $("sutom-status").textContent = "Impossible de charger le mot du jour (ou plus de mots disponibles).";
      return;
    }
    $("sutom-status").textContent = `Sutom n°${state.puzzle} — un mot de ${S.secret.length} lettres`;
    if (!session()) return;
    const saved = await loadState("sutom", state.puzzle);
    if (!saved) return;
    const valid = (g) => (g && Array.isArray(g.guesses) ? g : null);
    const local = valid(saved.local), remote = valid(saved.remote);
    const score = (g) => (g ? (g.found || g.lost ? 100 : 0) + g.guesses.length : -1);
    S.game = { puzzle: state.puzzle, guesses: [], found: false, lost: false, start: null, end: null, saved: false,
      ...(score(remote) >= score(local) ? remote : local) };
    render();
    if ((S.game.found || S.game.lost) && !S.game.saved) saveResult();
    loadDico(); // préchargé pendant que le joueur réfléchit
  }

  GAMES.sutom = { title: "Sutom", start };
})();
