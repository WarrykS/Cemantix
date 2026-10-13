"""Génère les données du jeu : vocabulaire + un fichier de scores par jour.

Prérequis :
    pip install spacy spacy-lookups-data wordfreq numpy
    pip install https://github.com/explosion/spacy-models/releases/download/fr_core_news_lg-3.8.0/fr_core_news_lg-3.8.0-py3-none-any.whl

Usage :
    python tools/generate.py --days 400

Le numéro du jour 1 correspond à START_DATE (voir app.js). Relancer le script avec
plus de jours ne change pas les mots déjà attribués (ordre déterministe).
"""
import argparse
import gzip
import json
import os
import random
import re

import numpy as np
import spacy
import spacy_lookups_data
from spacy.lang.fr.stop_words import STOP_WORDS
from wordfreq import top_n_list

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
VOCAB_SIZE = 60000
SEED = 20261013
WORD_RE = re.compile(r"^[a-zàâäçéèêëîïôöùûüÿœæ]+(-[a-zàâäçéèêëîïôöùûüÿœæ]+)*$")

# Mots exclus des mots secrets (vulgaires, noms propres, trop vagues...)
BLOCKLIST = set(open(os.path.join(os.path.dirname(__file__), "blocklist.txt"), encoding="utf-8").read().split())


def load_lexicon():
    d = os.path.join(os.path.dirname(spacy_lookups_data.__file__), "data")
    lookup = json.load(gzip.open(os.path.join(d, "fr_lemma_lookup.json.gz")))
    index = json.load(gzip.open(os.path.join(d, "fr_lemma_index.json.gz")))
    lex = set(lookup) | {x for v in lookup.values() for x in v} | {x for v in index.values() for x in v}
    lemmas = set(index["noun"]) | set(index["adj"]) | set(index["verb"])
    return lookup, lex, lemmas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=400)
    args = ap.parse_args()

    nlp = spacy.load("fr_core_news_lg")
    lookup, lex, lemmas = load_lexicon()

    vocab = []
    for i, w in enumerate(top_n_list("fr", 200000)):
        if len(vocab) >= VOCAB_SIZE:
            break
        if not WORD_RE.match(w) or (len(w) < 2 and w not in ("a", "y", "à")):
            continue
        if not nlp.vocab.has_vector(w) or (w not in lex and i >= 3000):
            continue
        vocab.append(w)
    vocab_set = set(vocab)

    # Mots secrets : noms / adjectifs / verbes à l'infinitif, assez courants
    candidates = []
    pool = vocab[300:9000]
    pool_set = set(pool)
    for doc in nlp.pipe(pool, batch_size=512):
        w, tok = doc.text, doc[0]
        if len(doc) != 1 or len(w) < 4 or "-" in w or w in STOP_WORDS or w in BLOCKLIST or w not in lemmas:
            continue
        if w in lookup and lookup[w] != [w]:  # forme conjuguée / accordée
            continue
        if tok.pos_ not in ("NOUN", "ADJ", "VERB") or tok.lemma_ != w:
            continue
        if tok.pos_ == "VERB" and not w.endswith(("er", "ir", "re")):
            continue
        # participes (« lancé », « portant ») et féminins (« locale », « secrète »)
        if w.endswith(("é", "ée", "ant")) and re.sub(r"(é|ée|ant)$", "er", w) in lemmas:
            continue
        if w.endswith("e") and (w[:-1] in pool_set or re.sub(r"(ère|ète|euse|ive|ienne|elle)$", "", w) != w
                                and any(w[:-len(x)] + y in pool_set for x, y in
                                        (("ère", "er"), ("ète", "et"), ("euse", "eux"), ("ive", "if"), ("ienne", "ien"), ("elle", "el")))):
            continue
        candidates.append(w)
    random.Random(SEED).shuffle(candidates)
    secrets = candidates[: args.days]
    assert len(secrets) == args.days, f"pas assez de mots candidats ({len(candidates)})"

    mat = np.stack([nlp.vocab.get_vector(w) for w in vocab]).astype(np.float32)
    mat /= np.linalg.norm(mat, axis=1, keepdims=True)

    os.makedirs(os.path.join(DATA, "days"), exist_ok=True)
    with open(os.path.join(DATA, "vocab.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(vocab))

    pos = {w: i for i, w in enumerate(vocab)}
    for n, secret in enumerate(secrets, start=1):
        sims = mat @ mat[pos[secret]]
        scores = np.clip(np.round(sims * 10000), -10000, 10000).astype("<i2")
        scores[pos[secret]] = 10000
        with open(os.path.join(DATA, "days", f"{n}.bin.gz"), "wb") as f:
            f.write(gzip.compress(scores.tobytes(), compresslevel=9, mtime=0))

    print(f"vocabulaire : {len(vocab)} mots, {len(candidates)} candidats, {len(secrets)} jours générés")
    assert all(s in vocab_set for s in secrets)


if __name__ == "__main__":
    main()
