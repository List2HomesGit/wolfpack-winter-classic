# Wolfpack Winter Classic — website setup

## Folder layout

```
wolfclassic/
  tournwolf.png        original logo (full size)
  docs/                ← this folder is the website (GitHub Pages serves it)
    index.html
    tournwolf-web.png  hero logo (transparent background)
    tournwolf-180.png  top bar, phone home-screen icon, email header
    favicon.png        browser tab icon
  backend/
    Code.gs            paste into Google Apps Script
    appsscript.json
```

Two pieces:

- **`docs/index.html`** — the whole public site: event info, team application form, the private roster & payment page, and the organizer dashboard (`yoursite/#admin`).
- **`Code.gs`** — the backend, running free in Google Apps Script. It saves everything to a Google Sheet and sends all emails from your Google account.

## How it works

1. A manager applies → row added to the Sheet → manager gets a "we received your application" email, organizers get an alert.
2. You open `yoursite/#admin`, enter the organizer key, and review teams by division.
3. **Approve** → manager gets an email with their team's private roster link, the entry-fee instructions, and a deadline 48 hours out.
4. Manager fills in players/staff (or uploads their roster file, saved to a Google Drive folder) and says how they paid.
5. You check your e-Transfers and click **Mark paid**. Once roster + payment are both in, the team flips to **Confirmed** and the manager gets a confirmation email.
6. An hourly check emails the manager a reminder 12 hours before the deadline and alerts organizers when a team goes overdue. From the dashboard you can **Extend 24h** or **Decline** and approve a waitlisted team.

## Setup (about 15 minutes)

### 1. Backend
1. Create a new Google Sheet (e.g. "Wolfpack Winter Classic – Applications") in the Google account that should send the emails.
2. **Extensions → Apps Script.** Replace the contents of `Code.gs` with this repo's `Code.gs`.
3. Optional: **Project Settings → Show "appsscript.json"**, then paste in `appsscript.json` (sets the Edmonton time zone).
4. Edit the `CONFIG` block at the top: `ORGANIZER_EMAILS`, `ENTRY_FEE`, `ETRANSFER_EMAIL`, and later `SITE_URL`.
5. **Project Settings → Script properties → Add property:** `ADMIN_KEY` = a long organizer password. Share it only with the committee.
6. In the editor, select the `setup` function and click **Run**. Approve the permissions (Sheets, Drive, Gmail, triggers).
7. **Deploy → New deployment → type: Web app.** Execute as: **Me**. Who has access: **Anyone**. Copy the URL ending in `/exec`.

### 2. Site
1. In `index.html`, fill in the `CONFIG` block near the bottom: paste the `/exec` URL into `API_URL`, plus `ENTRY_FEE`, `ETRANSFER_EMAIL`, `CONTACT_EMAIL`, `VENUE`, and `SPOTS` per division if you want them shown.
2. Host it on **GitHub Pages** (free):
   - Create a repo, e.g. `wolfpack-winter-classic`, and push this whole folder to the `main` branch. On a free GitHub plan the repo must be public for Pages. That's fine: the organizer key lives in Apps Script, not in these files.
   - In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder: `/docs` → Save**.
   - About a minute later the site is live at `https://<your-username>.github.io/wolfpack-winter-classic/`. Every push to `main` updates it.
   - When you register the domain: **Settings → Pages → Custom domain**, enter it, add the DNS records GitHub shows you, then tick **Enforce HTTPS**.
3. Put the final site address into `SITE_URL` in `Code.gs` (so email links point to the right place), then **Deploy → Manage deployments → Edit → New version → Deploy**.

> Any time you change `Code.gs`, redeploy a new version under **Manage deployments** — the `/exec` URL stays the same.

### 3. Test it end to end
Apply with your own email → check the receipt → approve yourself at `#admin` → open the roster link from the approval email → submit → mark paid → check the confirmation email.

## Notes
- Gmail limits Apps Script to about 100 email recipients a day on a personal account (1,500 on Google Workspace). A tournament of this size uses far fewer.
- The Sheet is your master record and export: sort, filter, or download it any time. Don't rename the column headers.
- Roster files land in the Drive folder "Wolfpack Winter Classic – Rosters".
- e-Transfers can't be verified automatically, which is why payment is confirmed with the **Mark paid** button.
