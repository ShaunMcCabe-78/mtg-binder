# Magic Binder

A phone app for Magic: The Gathering players. It scans your cards, keeps your collection on your phone, and builds decks from the cards you own.

**Install:** open https://shaunmccabe-78.github.io/mtg-binder/ on your phone.
- iPhone (Safari): tap **Share → Add to Home Screen**.
- Android (Chrome): tap **⋮ → Install app** (or Add to Home screen).
- Samsung Internet: tap **≡ → Add page to → Home screen**.

Then open **Binder** from your Home Screen. Each phone keeps its own collection.

## What it does
- **Scanning:** photograph a stack of overlapped cards so only the name bars show. The text is read on the phone (Tesseract) and each name is checked against a built-in list of every Magic card (`cards.json`). Portrait or landscape photos both work.
- **Collection:** stored only on your phone (browser storage). Back it up with *Settings → Copy collection backup*.
- **Deck building:**
  - **With Claude:** uses your own Anthropic API key, saved on the phone, a few cents per deck.
  - **Built-in:** free and offline, rule-based.
- **Card details:** card pictures and names from brand-new sets come from Scryfall when you're online.
- **Offline:** after the first scan, everything except Claude and card pictures works without internet.

## Files
| File | Purpose |
|---|---|
| `index.html` | App screens and styles |
| `app.js` | App logic: scanning, collection, decks, settings |
| `matcher.js` | Fuzzy matching of scanned text to real card names |
| `builder.js` | Built-in deckbuilder |
| `cards.json` | Every card: name, cost, type, P/T, short rules text (built from the Forge project's card data) |
| `eng.traineddata.gz` | English text-reading model for Tesseract |
| `sw.js`, `manifest.webmanifest` | Offline support and Home Screen install |

Magic: The Gathering is © Wizards of the Coast. This is an unofficial fan project.
