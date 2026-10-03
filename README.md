# Magic Binder

A phone app for Magic: The Gathering players. It scans your cards, keeps your collection on your phone, and builds decks from the cards you own.

**Install:** open https://shaunmccabe-78.github.io/mtg-binder/ on your phone.
- iPhone (Safari): tap **Share → Add to Home Screen**.
- Android (Chrome): tap **⋮ → Install app** (or Add to Home screen).
- Samsung Internet: tap **≡ → Add page to → Home screen**.

Then open **Binder** from your Home Screen. Each phone keeps its own collection.

## What it does
- **Scanning:** photograph a stack of overlapped cards so only the name bars show. The text is read on the phone (Tesseract) and each name is checked against a built-in list of every Magic card (`cards.json`). Portrait or landscape photos both work.
- **Sets:** in Grid mode the whole card shows, so the app also reads which printing each card is from the small print at the bottom left (e.g. "U 0178 · SOS • EN"). If it can't tell, no set is recorded. In the card sheet you can set or change the printing of each copy; Stacked scans save cards without a set. The backup keeps sets as `2 Name (SOS) 178` lines.
- **Prices:** euro prices from Cardmarket via Scryfall (updated daily): per copy in the card sheet (by its recorded printing), per card and in total in the collection (sort by value), per deck, and for everything in Settings. Kept on the phone for offline viewing.
- **Deleting cards:** in the collection list tap **Select**, tick one or more cards, then **Delete** (with Undo). In "All collections" it removes them everywhere; in one collection only from that one.
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
| `namebars.js` | Finds each card's name bar in a photo so it can be read on its own |
| `scan-core.js` | Shared scanning steps: text direction, bar finding, reading one bar |
| `scan-stacked.js` | Stacked layout: overlapped cards in one column |
| `scan-grid.js` | Grid layout: cards side by side; works out the grid and reads each card's name bar |
| `scan-set.js` | Grid layout: reads which printing (set code and collector number) each card is |
| `builder.js` | Built-in deckbuilder |
| `cards.json` | Every card: name, cost, type, P/T, short rules text (built from the Forge project's card data) |
| `prints.json` | Every card's printings (set code, collector number, rarity) and set names (built from the Forge project's set files; newer printings come from Scryfall when online) |
| `eng.traineddata.gz` | English text-reading model for Tesseract |
| `sw.js`, `manifest.webmanifest` | Offline support and Home Screen install |

Magic: The Gathering is © Wizards of the Coast. This is an unofficial fan project.

## Planned
- **Card set, older cards:** cards from before about 2014 have no set code printed, so their set can only be picked in the card sheet. Comparing the set symbol was tried, but at photo size the symbols are too alike to tell apart reliably.
- **Binder pages:** a scan option for binder/folder pages with plastic pockets (building on Grid mode).
