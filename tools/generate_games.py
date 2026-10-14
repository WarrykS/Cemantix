"""Génère les données du Sutom et des mots croisés (un fichier par jour).

Usage : python tools/generate_games.py --days 420
Prérequis : ceux de tools/generate.py (wordfreq, spacy, spacy-lookups-data, modèle fr_core_news_lg).

- Sutom : mots secrets tirés des noms / adjectifs / verbes courants de 6 à 9 lettres
  (data/sutom/<n>.txt, encodé pour ne pas lire la réponse d'un coup d'œil) et dictionnaire
  des mots acceptés (data/sutom/dico.txt).
- Mots croisés : grilles construites à partir de tools/mots_croises.txt (« MOT;définition »),
  enregistrées dans data/mots/<n>.json.
"""
import argparse
import base64
import json
import os
import random
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import ROOT, TOOLS, load_lexicon, new_candidates  # noqa: E402
from wordfreq import top_n_list  # noqa: E402

DATA = os.path.join(ROOT, "data")
SEED = 20261013


def norm(w):
    w = w.replace("œ", "oe").replace("æ", "ae").replace("Œ", "OE").replace("Æ", "AE")
    w = unicodedata.normalize("NFD", w)
    return "".join(c for c in w if not unicodedata.combining(c)).upper()


def encode(word, n):
    """Encodage léger (XOR + base64) : évite de lire la réponse en ouvrant le fichier."""
    key = f"sutom-{n}".encode()
    raw = bytes(b ^ key[i % len(key)] for i, b in enumerate(word.encode()))
    return base64.b64encode(raw).decode()


# ---------- Sutom ----------

def build_sutom(days, lookup, lex, lemmas):
    # mots acceptés : formes du lexique français + mots courants (évite noms propres et fautes rares)
    words = [w for w in top_n_list("fr", 40000) if re.fullmatch(r"[a-zàâäçéèêëîïôöùûüÿœæ]+", w)]
    dico = {norm(w) for w in lex | set(words) if re.fullmatch(r"[a-zàâäçéèêëîïôöùûüÿœæ]+", w)}
    dico = sorted(w for w in dico if 6 <= len(w) <= 9 and w.isalpha() and w.isascii())

    # Les mots déjà attribués (tools/sutom_secrets.txt) ne changent jamais ; on complète si besoin.
    path = os.path.join(TOOLS, "sutom_secrets.txt")
    secrets = open(path, encoding="utf-8").read().split() if os.path.exists(path) else []
    if len(secrets) < days:
        cemantix = set(open(os.path.join(TOOLS, "secrets.txt"), encoding="utf-8").read().split())
        cands = new_candidates(top_n_list("fr", 20000), lookup, lemmas, cemantix)
        random.Random(SEED + 1).shuffle(cands)
        seen = set(secrets)
        for w in cands:
            n = norm(w)
            if 6 <= len(n) <= 9 and n.isalpha() and n not in seen:
                seen.add(n)
                secrets.append(n)
        assert len(secrets) >= days, f"pas assez de mots pour le Sutom ({len(secrets)})"
        secrets = secrets[:days]
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(secrets) + "\n")

    out = os.path.join(DATA, "sutom")
    os.makedirs(out, exist_ok=True)
    dico_set = set(dico)
    for n, w in enumerate(secrets[:days], start=1):
        assert w in dico_set
        with open(os.path.join(out, f"{n}.txt"), "w") as f:
            f.write(encode(w, n))
    with open(os.path.join(out, "dico.txt"), "w") as f:
        f.write("\n".join(dico))
    print(f"Sutom : {len(dico)} mots acceptés, {days} jours (ex. {secrets[:8]})")


# ---------- Mots croisés ----------

def load_bank():
    bank = {}
    for line in open(os.path.join(TOOLS, "mots_croises.txt"), encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        word, clue = line.split(";", 1)
        word = norm(word.strip())
        assert word.isalpha() and 3 <= len(word) <= 9, word
        if word not in bank:
            bank[word] = clue.strip()
    return bank


def try_place(grid, word, r, c, d):
    """Renvoie le nombre de croisements si le mot peut être posé, sinon None."""
    dr, dc = (0, 1) if d == "a" else (1, 0)
    if grid.get((r - dr, c - dc)) or grid.get((r + dr * len(word), c + dc * len(word))):
        return None
    cross = 0
    for i, ch in enumerate(word):
        rr, cc = r + dr * i, c + dc * i
        cur = grid.get((rr, cc))
        if cur:
            if cur != ch:
                return None
            cross += 1
        else:
            # une lettre nouvelle ne doit toucher aucune lettre sur les côtés
            if grid.get((rr + dc, cc + dr)) or grid.get((rr - dc, cc - dr)):
                return None
    return cross if cross else None


def build_grid(words, rng, max_size=10, target=8):
    grid, placed = {}, []
    first = words[0]
    for i, ch in enumerate(first):
        grid[(0, i)] = ch
    placed.append((first, 0, 0, "a"))
    for word in words[1:]:
        if len(placed) >= target:
            break
        if word in (p[0] for p in placed):
            continue
        options = []
        for (r, c), ch in list(grid.items()):
            for i, wc in enumerate(word):
                if wc != ch:
                    continue
                for d in "ad":
                    sr, sc = (r, c - i) if d == "a" else (r - i, c)
                    cross = try_place(grid, word, sr, sc, d)
                    if cross is None:
                        continue
                    cells = [(sr + (k if d == "d" else 0), sc + (k if d == "a" else 0)) for k in range(len(word))]
                    rows = [x[0] for x in grid] + [x[0] for x in cells]
                    cols = [x[1] for x in grid] + [x[1] for x in cells]
                    if max(rows) - min(rows) >= max_size or max(cols) - min(cols) >= max_size:
                        continue
                    options.append((cross, rng.random(), sr, sc, d))
        if options:
            options.sort(reverse=True)
            _, _, sr, sc, d = options[0]
            for k, ch in enumerate(word):
                grid[(sr + (k if d == "d" else 0), sc + (k if d == "a" else 0))] = ch
            placed.append((word, sr, sc, d))
    return grid, placed


def build_mots(days):
    bank = load_bank()
    words = sorted(bank)
    rng = random.Random(SEED + 2)
    usage = {w: 0 for w in words}
    out = os.path.join(DATA, "mots")
    os.makedirs(out, exist_ok=True)
    for n in range(1, days + 1):
        best = None
        for _ in range(40):
            # on privilégie les mots les moins utilisés jusqu'ici
            pool = sorted(words, key=lambda w: (usage[w], rng.random()))[:120]
            rng.shuffle(pool)
            start = max(pool[:10], key=len)
            order = [start] + [w for w in pool if w != start]
            grid, placed = build_grid(order, rng)
            if len(placed) >= 7 and (best is None or len(placed) > len(best[1])):
                best = (grid, placed)
            if best and len(best[1]) >= 8:
                break
        grid, placed = best
        r0 = min(r for r, _ in grid)
        c0 = min(c for _, c in grid)
        rows = max(r for r, _ in grid) - r0 + 1
        cols = max(c for _, c in grid) - c0 + 1
        # numérotation classique : de gauche à droite, de haut en bas
        starts = sorted({(r - r0, c - c0) for _, r, c, _ in placed})
        num = {pos: i + 1 for i, pos in enumerate(starts)}
        entries = []
        for word, r, c, d in placed:
            usage[word] += 1
            entries.append({"n": num[(r - r0, c - c0)], "d": d, "r": r - r0, "c": c - c0,
                            "answer": word, "clue": bank[word]})
        entries.sort(key=lambda e: (e["d"], e["n"]))
        with open(os.path.join(out, f"{n}.json"), "w", encoding="utf-8") as f:
            json.dump({"rows": rows, "cols": cols, "entries": entries}, f, ensure_ascii=False, separators=(",", ":"))
    used = sorted(usage.values())
    print(f"Mots croisés : {len(words)} mots dans la banque, {days} grilles, chaque mot utilisé {used[0]} à {used[-1]} fois")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=420)
    args = ap.parse_args()
    lookup, lex, lemmas = load_lexicon()
    build_sutom(args.days, lookup, lex, lemmas)
    build_mots(args.days)


if __name__ == "__main__":
    main()
