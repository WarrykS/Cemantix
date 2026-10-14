# Cémantix entre amis

Un jeu façon [Cémantix](https://cemantix.certitudes.org/) : trouver le mot secret du jour grâce à la proximité de sens
(« température »). Le même mot pour tout le monde, un nouveau chaque jour à minuit (heure de Paris).

Chaque ami choisit un **pseudo** : ses trouvailles sont enregistrées dans un historique partagé
(onglets « Classement du jour » et « Historique »), consultable depuis n'importe quel appareil.

## Fonctionnement

- **Site statique** (`index.html`, `app.js`, `style.css`) : hébergé sur GitHub Pages.
- **Données du jeu** (`data/`) : vocabulaire de 60 000 mots et, pour chaque jour, la similarité de chaque mot avec le
  mot secret, pré-calculées avec le modèle word2vec **frWac** de Jean-Philippe Fauconnier (licence CC-BY 3.0),
  le même type de modèle que Cémantix. 420 jours sont générés (du 13/10/2026 jusqu'au 06/12/2027) ;
  les mots secrets sont listés dans `tools/secrets.txt`.
- **Historique partagé** : base Supabase (projet `cemantix`), table `results`.
  Les visiteurs peuvent seulement *ajouter* le résultat du jour ; la lecture passe par la fonction
  `cemantix_history()` qui masque le mot du jour en cours. Configuration dans `config.js`.

## Mettre en ligne (GitHub Pages)

Dépôt → **Settings** → **Pages** → *Build and deployment* : Source = **Deploy from a branch**,
branche `main`, dossier `/ (root)` → **Save**. Le site sera disponible quelques minutes plus tard sur
`https://warryks.github.io/cemantix/`.

## Générer plus de jours

```bash
pip install numpy wordfreq rocksdict spacy spacy-lookups-data
pip install https://github.com/explosion/spacy-models/releases/download/fr_core_news_lg-3.8.0/fr_core_news_lg-3.8.0-py3-none-any.whl
python tools/generate.py --days 800
```

Les mots déjà attribués (`tools/secrets.txt`) ne changent jamais ; les nouveaux sont tirés au sort en excluant
`tools/blocklist.txt`. Après une régénération, incrémenter `DATA_VERSION` dans `app.js`.
