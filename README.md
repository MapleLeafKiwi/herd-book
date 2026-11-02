# Herd Book

Offline-first cattle tracker for one or many ranches: herd, collars, breeding and calving windows, vaccines and treatments, money and expenses, spreadsheet import/export (including filling eShepherd's Bulk Create file). Works with no signal and syncs to Google Sheets when it has signal.

- **App:** https://mapleleafkiwi.github.io/herd-book/ (open on a phone, then Add to Home Screen)
- **Sync script:** `sheet-script/Code.gs` goes into a Google Sheet ("Herd Book admin") via Extensions › Apps Script, deployed as a web app (Execute as: Me, Who has access: Anyone). The real sign-up code is set only in the copy inside that sheet.

**Ranches.** In the app, "Start a new ranch" (needs the sign-up code) creates the ranch's own Google Sheet and a row in the admin sheet's **Ranches** tab. Untick *Active* there to switch a ranch off. Crew join with the ranch's link or QR code (Log › Ranch & phone setup).

**Sharing.** Each ranch has a full-access code (sees purchase and sale prices) and a crew code (never sees them). The app's Share button gives a link and QR code for either. Prices are stripped by the sheet script before data is sent to a crew phone, and crew can't change prices. "Make a new crew link" retires the old crew code.
