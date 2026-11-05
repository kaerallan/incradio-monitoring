# Locale Proofs

A small static site (GitHub Pages) for the weekly radio broadcast. Viewers pick their
locale, like and comment on the YouTube live or video, and send a screenshot as proof.
Each proof counts for that locale right away. The admin reviews the screenshots and can
reject fakes.

- `index.html`: send a proof (mobile first, works on laptops too)
- `stats.html`: public per-locale results for the current week
- `admin.html`: admin page (passcode), not linked from the public pages

The backend is a Google Apps Script web app bound to a Google Sheet. Screenshots are stored
privately in the owner's Google Drive, in one folder per round.

## Rules

- One counted proof per phone per round (a round is one week, one link).
- The exact same screenshot can't be sent twice.
- Only real pictures (JPG, PNG or WebP, up to 4 MB). The page shrinks big screenshots first.
- If the admin rejects a proof, it leaves the count, and that phone may send a new screenshot.
- Nothing is ever deleted. Starting a new round only sets the counts back to zero.

## For the admin

Open `admin.html` and enter the passcode.

- **Change the link**: paste the YouTube link (live, `youtu.be`, or a normal video link) and a
  title. "Save link" keeps this week's counts, which is useful when the live becomes a video.
- **Start new round**: sets every locale back to 0 for the new week. Export first. Older rounds
  stay saved and can still be exported.
- **Export**: pick a round, then
  - "stats + screenshots (.zip)": `stats.csv` (per-locale counts), `proofs.csv` (every proof with
    time, locale, status, screenshot file name and Drive link) and a `screenshots/<locale>/` folder.
  - "stats only (.csv)": just the per-locale counts.
- **Review screenshots**: filter by round, locale or status, then tap a screenshot to see it full
  size. Tap Reject on fakes; Restore undoes it.

## Setup (owner, once)

1. Create a Google Sheet, then Extensions → Apps Script.
2. Paste `apps-script/Code.gs`. In Project Settings, tick "Show appsscript.json in editor" and
   paste `apps-script/appsscript.json`.
3. Run `setup` once and allow the permissions (tick every box). It asks for Google Sheets and for
   Google Drive. Apps Script's DriveApp needs full Drive access to make the screenshots folder,
   but the code only ever touches the Sheet and the "Locale Proofs screenshots" folder it creates.
4. Project Settings → Script properties → add `ADMIN_PASSCODE` with a strong passcode. Give it
   only to the admin.
5. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone. Copy the `/exec` URL
   into `ENDPOINT_URL` in `config.js`.
6. After any later change to `Code.gs`: Deploy → Manage deployments → Edit → Version: New version
   (keeps the same URL).

To change the passcode, edit `ADMIN_PASSCODE` in Script properties (it takes effect right away).
After 10 wrong passcodes, the admin page locks for 10 minutes.

## Local testing

```
node dev/mock-server.js   # http://localhost:8767, admin passcode: test-pass
node dev/test.js          # rule and abuse tests
```

The mock runs `Code.gs` against in-memory fakes of Sheets, Drive and the cache. Nothing is saved.

## Limits to know

- Screenshots can't be checked automatically. The admin review is the real check.
- "One per phone" uses an id stored on the phone. Clearing the browser data allows another
  proof, but it still needs a different screenshot, and the admin sees every one.
- Exporting a large round downloads each screenshot through the backend, about 1 to 3 minutes per
  few hundred proofs. The Drive folder link on the admin page is the fallback.
