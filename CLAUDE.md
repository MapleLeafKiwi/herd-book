# Herd Book

Offline-first cattle tracker used by ranch crews on phones in the stockyard, often with no signal. Owner: Matthew (GitHub MapleLeafKiwi). The people using it are ranchers and farm hands, not technical users: keep wording plain and the phone UI big and simple.

Live app: https://mapleleafkiwi.github.io/herd-book/ (GitHub Pages, deploys from `main`, root folder, about a minute after a push).

## THIS REPO IS PUBLIC — never commit secrets

Never put any of these in a commit, a file, a test, or a commit message:
- the real sign-up code (`SIGNUP_CODE` in the deployed script; the copy here must say `'CHANGE-ME'`)
- any ranch code or crew code
- Google Sheet IDs or links, or anything from a real ranch's data (names, VIDs, EIDs, brands, prices)
- real eShepherd files (tests use the made-up `tests/fixtures/eshepherd-sample.xlsx`)

When you hand Matthew a new `Code.gs` to paste, put the real sign-up code in that copy only (ask him if you don't have it), and keep `'CHANGE-ME'` in `sheet-script/Code.gs`. The script's web app URL is in `index.html` (`window.HERDBOOK_SYNC_URL`); that is public by design. Security comes from the codes, not from hiding the URL.

## How it fits together

- **App** (`index.html`, `app.js`, `sw.js`): a plain HTML/JS installable web app, no build step, no framework. Matthew can't run builds, so keep it that way. `index.html` holds the markup and all CSS (tokens on `:root`, light and dark). `app.js` is one IIFE with sections marked `// ---------- name ----------`.
- **Data on the phone**: everything is read from `mirror` (last copy from the sheet, in localStorage) with `outbox` (unsent changes) applied on top by `recompute()`. Every edit goes through `put` / `patch` / `remove` → `queue()` → outbox → `sync()`. Never write to `mirror` directly from UI code. Every change gets an `oid` so the sheet applies it once.
- **Service worker** (`sw.js`): caches the app so it opens with no signal. **Bump `CACHE` (herdbook-vN) on every release** or phones keep the old files. The collar scanner files in `ocr/` sit in their own cache (`herdbook-ocr-1`) that survives app updates.
- **Sync script** (`sheet-script/Code.gs`): Google Apps Script bound to Matthew's "Herd Book admin" sheet, deployed as a web app (Execute as: Me, Access: Anyone). One script serves every ranch:
  - The admin sheet's **Ranches** tab lists each ranch: name, full-access code, crew code, Active tick box, its own sheet.
  - "Start a new ranch" in the app (needs the sign-up code) creates that ranch's own Google Sheet.
  - Sync is `POST {code, since, ops}` → applies ops, returns changes since `rev`, plus field-level clash reports (each op carries `base`, the values the phone last saw).
  - The `_sync` tab records applied change ids, so a change uploaded by two phones (after a QR swap) only counts once.
  - A new field on an existing record needs no script change: columns are added automatically. A new kind of record (a new collection or tab) needs `TABS` and `ORDER` entries in the script, plus `COLS` in `app.js`.
- **Roles**: full-access phones see money. **Crew phones must never receive prices**: `CREW_HIDE`, `CREW_BLOCK` and `forCrew_` strip them on the server before sending, and crew writes to money fields are dropped. The app also hides money UI (`fin()`), but the server is the guarantee. QR swaps strip money too (`shareableOps`). Keep all three when adding anything money-related.
- **Updating the live script**: Matthew pastes the new `Code.gs` into Apps Script, then goes to Deploy › Manage deployments › edit › **New version** (never "New deployment", which changes the URL). Tell him plainly whenever a change needs this.

## Features (where to look in app.js)

Herd list and animal form; Yard (collar fitting, "Needs collar"); Collars (collar list, neckband serials, new season); Breeding (exposures by bull or AI, calving window = dates + gestation, default 283; preg checks; calving adds a calf); Health (treatments, withdrawal, boosters); Money (full access only: sales, purchases, expenses, profit $ and %); Log (ranch and phone setup, Share with crew or full-access QR, import/export, change log); clash chooser; offline-only "Swap with nearby phone" (changes as cycling QR codes, read by camera with jsQR); collar serial photo reading on the phone (tesseract.js in `ocr/`, digits only); spreadsheet import (SheetJS, column matching) and export, including filling eShepherd's Bulk Create file (row 1 instructions, row 2 headers, Neckband = 10-digit serial kept as text, dates dd-MM-yyyy, VID letters and digits only).

## Testing

`tests/` runs the real `Code.gs` inside a fake Google Sheet, with the app in headless Chromium as several phones (offline, clashes, crew, multi-ranch, swap, scan):

```
cd tests && npm install && npx playwright install chromium   # first time
node sync.test.js && node swap.test.js && node scan.test.js
```

Run them before every push and add a check for each new behaviour. Screenshots land in `tests/out/` (ignored). Matthew can't test locally: he checks on his phone after a push (close and reopen the app twice to pick up an update).

## Working with Matthew

He prefers practical, working results over explanations. Batch his feedback, make the changes, test, push, then say in a few lines what changed and whether the script needs updating.
