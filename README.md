# Cémantix entre amis

Trois jeux du jour sur le même site, avec les mêmes comptes, un classement du jour et un historique partagés :

- **Cémantix** : trouver le mot secret grâce à la proximité de sens (« température »).
- **Sutom** : trouver un mot de 6 à 9 lettres en 6 essais, la première lettre est donnée.
- **Mots croisés** : une petite grille de 8 mots par jour, chronométrée.

Le même défi pour tout le monde, renouvelé chaque jour à minuit (heure de Paris). Chaque ami se connecte avec un
**pseudo et un mot de passe** (le compte est créé à la première connexion) ; ses parties en cours le suivent sur tous
ses appareils et personne ne peut jouer ni enregistrer un résultat à sa place.

## Fonctionnement

- **Site statique** (`index.html`, `app.js`, `style.css`) : hébergé sur GitHub Pages.
- **Données du jeu** (`data/`) : vocabulaire de 60 000 mots et, pour chaque jour, la similarité de chaque mot avec le
  mot secret, pré-calculées avec le modèle word2vec **frWac** de Jean-Philippe Fauconnier (licence CC-BY 3.0),
  le même type de modèle que Cémantix. 420 jours sont générés (du 13/10/2026 jusqu'au 06/12/2027) ;
  les mots secrets sont listés dans `tools/secrets.txt`.
- **Comptes et historique partagé** : base Supabase (projet `cemantix`). Tables `players` (mots de passe chiffrés
  avec bcrypt), `sessions`, `games` (partie en cours) et `results`. Aucune table n'est lisible ni modifiable
  directement : tout passe par les fonctions `cemantix_login`, `cemantix_logout`, `cemantix_load_game`,
  `cemantix_save_game`, `cemantix_submit` et `cemantix_history` (qui masque le mot du jour en cours).
  Configuration dans `config.js`.
- **Mot de passe oublié** : dans Supabase → *Table Editor* → `players`, supprimer la ligne du joueur
  (ses résultats restent dans l'historique) ; il pourra recréer son compte avec le même pseudo.

- **Sutom** (`sutom.js`, `data/sutom/`) : un mot par jour (`tools/sutom_secrets.txt`, encodé dans
  `data/sutom/<n>.txt`) et un dictionnaire de 123 000 mots acceptés (`data/sutom/dico.txt`).
- **Mots croisés** (`mots.js`, `data/mots/<n>.json`) : grilles construites automatiquement à partir de la banque
  `tools/mots_croises.txt` (≈ 450 mots avec leurs définitions). Pour plus de variété, ajouter des lignes
  « MOT;définition » puis relancer `python tools/generate_games.py --days 420`.
- **Base** : les scripts SQL appliqués sont dans `supabase/`.

## Mettre en ligne (GitHub Pages)

Dépôt → **Settings** → **Pages** → *Build and deployment* : Source = **Deploy from a branch**,
branche `main`, dossier `/ (root)` → **Save**. Le site sera disponible quelques minutes plus tard sur
`https://warryks.github.io/Cemantix/`.

## Générer plus de jours

```bash
pip install numpy wordfreq rocksdict spacy spacy-lookups-data
pip install https://github.com/explosion/spacy-models/releases/download/fr_core_news_lg-3.8.0/fr_core_news_lg-3.8.0-py3-none-any.whl
python tools/generate.py --days 800
```

Les mots déjà attribués (`tools/secrets.txt`) ne changent jamais ; les nouveaux sont tirés au sort en excluant
`tools/blocklist.txt`. Après une régénération, incrémenter `DATA_VERSION` dans `app.js`.
