# Herd Book

Offline-first cattle tracker: herd, collars, bulls, purchase and sale prices, with sync to a Google Sheet.

- **App:** https://mapleleafkiwi.github.io/herd-book/ (open on a phone, then Add to Home Screen)
- **Sheet script:** `sheet-script/Code.gs` is pasted into the Google Sheet (Extensions › Apps Script) and deployed as a web app (Execute as: Me, Who has access: Anyone). The real farm code is set only in the copy inside the sheet, not here.

Each phone enters its name and the farm code once (Log › Phone setup). Data is kept on the phone and synced to the sheet whenever there is signal.
