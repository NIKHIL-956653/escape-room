# CAN YOU ESCAPE?

A browser escape-room game. Nine rooms, five minutes each, no frameworks, no backend, no build step — open `index.html` and play.

**Play:** clone the repo and open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari — desktop or phone).

## The rooms

| # | Room | Lock | Exit |
|---|------|------|------|
| 1 | The Room | keypad safe | right wall |
| 2 | The Study | four-letter chest | right wall |
| 3 | The Cellar | valve wall (order) | right wall |
| 4 | The Abandoned Train | suitcase dials → route board → emergency brake | compartment door |
| 5 | The Gambit | brass padlock, read in a mirror | left wall |
| 6 | The Bunker | breakers → plotting scope → grid-reference safe | blast door, centre |
| 7 | The Observatory | dome crank → eyepiece → lens cabinet (the image is inverted) | floor hatch |
| 8 | Plan B | the vault (Plan A) fails on a time lock → the sealed second page → count the tiles → deposit box → wait for the mains to go | service grille, floor-left |
| 9 | The Clockmaker's Bench | copy the running clock's gear train onto the wall pegs, deduce the fourth wheel by fit, turn the crank | trapdoor in the ceiling |

Every room hides its answer in the scene itself — the game never prints a code in text. Clues are shapes, numbers and positions, never colour alone.

## Features

- 5-minute timer per room, three progressive hints (each costs stars), 1–3 star rating
- Room-select screen; progress and best stars saved in `localStorage`
- Cinematic transitions between rooms; each room has its own lighting, ambience and puzzle mechanic
- All sound is synthesised with the Web Audio API — no audio files
- Keyboard, mouse and touch; landscape and portrait layouts

## Stack

Three files, nothing else:

- `index.html` — the nine scenes and the lock templates
- `style.css` — all art is CSS (gradients, clip-paths, shadows, 3D transforms)
- `script.js` — one state object, a `LEVELS` table, inspectors and locks per room

## Author

Built by [NIKHIL-956653](https://github.com/NIKHIL-956653).
