# Rose's generic study app

A desktop study app for Windows: a book-style PDF reader with room to write in the margins, lined notebooks, saved links and flashcards.

## Features

- **Books**: open any PDF as a two-page book, with highlights (snap-to-text or freehand), text boxes, arrows, bookmarks, search, zoom, snips and "match my printed edition" page numbering.
- **Notebooks**: lined A4 notebooks, one for each book plus standalone ones, with formatting, links, page references and pasted images.
- **Links**: saved web pages, organised into groups.
- **Flashcards**: two-sided cards in named stacks, studied in a random order.
- **Flashcard games**: study breaks while playing Geometry Dash. Built but switched off for now (marked "Coming soon").

Everything is stored as plain files in `%APPDATA%\Rose's generic study app\Library`.

## Building it yourself

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm run dist
```

The installer appears in `release/`. To try the app without installing it, run `npm run bundle` and then `npx electron .`

## Layout

| Folder | What's in it |
|---|---|
| `src/` | The app's interface (HTML, CSS, JavaScript). `build.mjs` bundles it into `app/index.html`. |
| `electron/` | The desktop shell: file storage, window, snips, the Geometry Dash helper (`gd.js`). |
| `build/` | App icons. |
| `gd-helper/` | Source for the optional Geode mod that counts Geometry Dash attempts. |

Turning flashcard games back on: set `GAMES_ENABLED = true` in both `src/study.js` and `electron/main.js`.
