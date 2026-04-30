# Maths Warriors

Server-authoritative Firebase version of the dice combat game.

## What runs where

- `index.html` renders the game, handles selections, and calls Cloud Functions.
- `functions/index.js` creates rooms, joins rooms, validates turns, resolves attacks, and rolls dice.
- `database.rules.json` lets players read public rooms while blocking access to player tokens in `roomSecrets`.

## Deploy

From this folder:

```sh
firebase login
firebase use math-warrior-7d2a7
cd functions
npm install
cd ..
firebase deploy
```

The callable functions are deployed to `asia-southeast1`, matching the client code in `index.html`.
