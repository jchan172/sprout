# Sprout PWA — Baby Growth Tracker

A no-install web app that tracks your kids' **weight**, **length/height**, and
**head circumference** against **WHO Child Growth Standards (2006)** percentile
curves. No App Store, no Apple Developer account, no build step.

## Getting it on your iPhone (2 minutes)

**Option A — free hosting (recommended, works offline):**
1. Sign up free at Cloudflare Pages, Netlify, or Vercel.
2. Drag this whole folder into a new static site (or `npx vercel`).
3. Open the URL in **Safari** on your iPhone → Share → **Add to Home Screen**.
4. It now opens full-screen like a native app and works offline.

**Option B — quick local test from your Mac:**
1. `cd` into this folder and run `python3 -m http.server 8000`.
2. On your iPhone (same Wi-Fi), open `http://<your-mac-ip>:8000`.
3. Add to Home Screen if you like. (Needs your Mac awake/serving; use Option A for permanent use.)

## How data is stored

Everything lives in your browser's **localStorage** — on your device only,
nothing is uploaded anywhere. It persists across sessions like a native app's
data. Use **Settings → Export JSON** for backups (and to move between devices).

## Features

- Multiple children (name, sex, birth date)
- Measurements by date: weight, length, head circumference (any subset)
- SVG growth charts with WHO 3rd/15th/50th/85th/97th percentile curves,
  birth–5 years, sex-specific; tap a point for date, age, value, percentile
- Latest-percentile summary cards
- Metric/imperial units (Settings)
- Independent lb/kg and in/cm toggles when entering measurements; displays follow Settings
- JSON export/import backup
- Installable (manifest) + offline (service worker)

## Files

| File | What |
|---|---|
| `index.html` | App shell |
| `styles.css` | Mobile-first styles |
| `app.js` | All app logic (vanilla JS, no dependencies) |
| `who-data.js` | WHO LMS tables, day 0–1856, all 3 indicators × both sexes |
| `manifest.webmanifest` | Install metadata |
| `sw.js` | Offline cache |
| `icons/` | App icons |

## The math

Measurements are stored in kg/cm regardless of the selected input or display units.
Run the unit conversion checks with `node --test`.

Percentiles use the LMS method: `z = (((X/M)^L) − 1) / (L·S)`,
`percentile = Φ(z) × 100`, with day-level WHO tables bundled in `who-data.js`.

*For information only — not medical advice.*
# sprout
