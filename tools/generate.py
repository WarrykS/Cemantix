"""Génère les données du jeu : vocabulaire + un fichier de scores par jour.

Les similarités viennent du modèle word2vec frWac de Jean-Philippe Fauconnier
(https://fauconnier.github.io/, licence CC-BY 3.0), le même type de modèle que Cémantix.
On le télécharge depuis la copie publiée par Spark NLP (base RocksDB).

Prérequis :
    pip install numpy wordfreq rocksdict spacy spacy-lookups-data
    pip install https://github.com/explosion/spacy-models/releases/download/fr_core_news_lg-3.8.0/fr_core_news_lg-3.8.0-py3-none-any.whl

Usage :
    python tools/generate.py --days 800

Les mots secrets déjà attribués sont lus dans tools/secrets.txt et ne changent jamais ;
s'il en faut plus, de nouveaux mots sont tirés au sort et ajoutés à la fin du fichier.
"""
import argparse
import glob
import gzip
import json
import os
import random
import re
import urllib.request
import zipfile

import numpy as np
from wordfreq import top_n_list

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(ROOT, ".cache")
MODEL_URL = ("https://s3.amazonaws.com/auxdata.johnsnowlabs.com/public/models/"
             "word2vec_wac_200_fr_3.4.0_3.0_1643751580352.zip")
VOCAB_SIZE = 60000
SEED = 20261013
WORD_RE = re.compile(r"^[a-zàâäçéèêëîïôöùûüÿœæ]+(-[a-zàâäçéèêëîïôöùûüÿœæ]+)*$")


def load_frwac():
    """Renvoie {mot: vecteur} du modèle frWac (téléchargé et mis en cache la première fois)."""
    npz = os.path.join(CACHE, "frwac.npz")
    if not os.path.exists(npz):
        from rocksdict import AccessType, Options, Rdict

        os.makedirs(CACHE, exist_ok=True)
        zpath = os.path.join(CACHE, "frwac.zip")
        if not os.path.exists(zpath):
            print("Téléchargement du modèle frWac (118 Mo)…")
            urllib.request.urlretrieve(MODEL_URL, zpath)
        zipfile.ZipFile(zpath).extractall(os.path.join(CACHE, "frwac"))
        store = glob.glob(os.path.join(CACHE, "frwac", "storage", "*"))[0]
        db = Rdict(store, options=Options(raw_mode=True), access_type=AccessType.read_only())
        words, vecs = [], []
        for k, v in db.items():
            words.append(k.decode("utf-8", "replace"))
            vecs.append(np.frombuffer(v, "<f4"))
        db.close()
        np.savez(npz, words=np.array(words), vecs=np.stack(vecs))
    d = np.load(npz)
    return dict(zip(d["words"].tolist(), d["vecs"]))


def load_lexicon():
    import spacy_lookups_data

    d = os.path.join(os.path.dirname(spacy_lookups_data.__file__), "data")
    lookup = json.load(gzip.open(os.path.join(d, "fr_lemma_lookup.json.gz")))
    index = json.load(gzip.open(os.path.join(d, "fr_lemma_index.json.gz")))
    lex = set(lookup) | {x for v in lookup.values() for x in v} | {x for v in index.values() for x in v}
    lemmas = set(index["noun"]) | set(index["adj"]) | set(index["verb"])
    return lookup, lex, lemmas


def new_candidates(vocab, lookup, lemmas, exclude):
    """Noms / adjectifs / verbes à l'infinitif assez courants, pour de nouveaux mots secrets."""
    import spacy
    from spacy.lang.fr.stop_words import STOP_WORDS

    blocklist = set(open(os.path.join(TOOLS, "blocklist.txt"), encoding="utf-8").read().split())
    nlp = spacy.load("fr_core_news_lg")
    pool = vocab[300:9000]
    pool_set = set(pool)
    out = []
    for doc in nlp.pipe(pool, batch_size=512):
        w, tok = doc.text, doc[0]
        if len(doc) != 1 or len(w) < 4 or "-" in w or w in STOP_WORDS or w in blocklist or w in exclude:
            continue
        if w not in lemmas or (w in lookup and lookup[w] != [w]):
            continue
        if tok.pos_ not in ("NOUN", "ADJ", "VERB") or tok.lemma_ != w:
            continue
        if tok.pos_ == "VERB" and not w.endswith(("er", "ir", "re")):
            continue
        # participes (« lancé », « portant ») et féminins (« locale », « secrète »)
        if w.endswith(("é", "ée", "ant")) and re.sub(r"(é|ée|ant)$", "er", w) in lemmas:
            continue
        if w.endswith("e") and (w[:-1] in pool_set or any(
                w.endswith(x) and w[:-len(x)] + y in pool_set for x, y in
                (("ère", "er"), ("ète", "et"), ("euse", "eux"), ("ive", "if"), ("ienne", "ien"), ("elle", "el")))):
            continue
        out.append(w)
    random.Random(SEED).shuffle(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=420)
    args = ap.parse_args()

    vectors = load_frwac()
    lookup, lex, lemmas = load_lexicon()

    secrets_path = os.path.join(TOOLS, "secrets.txt")
    secrets = open(secrets_path, encoding="utf-8").read().split() if os.path.exists(secrets_path) else []

    # Vocabulaire accepté : mots français courants présents dans le modèle
    vocab = []
    for i, w in enumerate(top_n_list("fr", 250000)):
        if len(vocab) >= VOCAB_SIZE:
            break
        if not WORD_RE.match(w) or (len(w) < 2 and w not in ("a", "y", "à")):
            continue
        if w not in vectors or (w not in lex and i >= 3000):
            continue
        vocab.append(w)
    vocab_set = set(vocab)
    vocab += [w for w in secrets if w not in vocab_set]

    if len(secrets) < args.days:
        extra = new_candidates(vocab, lookup, lemmas, set(secrets))
        secrets += extra[: args.days - len(secrets)]
        assert len(secrets) >= args.days, "pas assez de mots candidats"
        with open(secrets_path, "w", encoding="utf-8") as f:
            f.write("\n".join(secrets) + "\n")

    mat = np.stack([vectors[w] for w in vocab]).astype(np.float32)
    mat /= np.linalg.norm(mat, axis=1, keepdims=True)

    os.makedirs(os.path.join(DATA, "days"), exist_ok=True)
    with open(os.path.join(DATA, "vocab.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(vocab))

    pos = {w: i for i, w in enumerate(vocab)}
    for n, secret in enumerate(secrets[: args.days], start=1):
        sims = mat @ mat[pos[secret]]
        scores = np.clip(np.round(sims * 10000), -10000, 10000).astype("<i2")
        scores[pos[secret]] = 10000
        with open(os.path.join(DATA, "days", f"{n}.bin.gz"), "wb") as f:
            f.write(gzip.compress(scores.tobytes(), compresslevel=9, mtime=0))

    print(f"vocabulaire : {len(vocab)} mots, {args.days} jours générés")


if __name__ == "__main__":
    main()
