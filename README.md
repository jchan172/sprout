# Sprout PWA — Baby Growth Tracker

A no-install web app that tracks your kids' **weight**, **length/height**, and
**head circumference** against **WHO Child Growth Standards (2006)** percentile
curves. No App Store, no Apple Developer account, no build step.

## Getting it on your iPhone (2 minutes)

**Option A — free hosting (recommended, works offline):**
1. Sign up free at Cloudflare, Netlify, or Vercel.
2. Drag this whole folder into a new static site (or `npx vercel`). Note: the
   cross-device sync API needs the Cloudflare Worker (`worker.js` +
   `wrangler.jsonc`); plain static hosts serve the tracker without sync.
3. Open the URL in **Safari** on your iPhone → Share → **Add to Home Screen**.
4. It now opens full-screen like a native app and works offline.

**Option B — quick local test from your Mac:**
1. `cd` into this folder and run `python3 -m http.server 8000`.
2. On your iPhone (same Wi-Fi), open `http://<your-mac-ip>:8000`.
3. Add to Home Screen if you like. (Needs your Mac awake/serving; use Option A for permanent use.)

## Sync between devices (optional)

No database needed: the whole dataset is a small JSON snapshot stored in
**Cloudflare Workers KV** under a random sync key. Devices merge record by
record (newest `updatedAt` wins), so edits made offline on two devices don't
clobber each other. Your unit preference stays per-device.

### One-time Cloudflare setup

The sync API is a **Worker** (`worker.js`) serving the static site plus
`/api/sync/*`; `wrangler.jsonc` at the repo root wires it up for Workers
Builds (deploy command `npx wrangler deploy`). The `"name"` in
`wrangler.jsonc` must exactly match the Worker name in the dashboard, or the
build fails.

1. **Create a KV namespace:** Cloudflare dashboard → Workers & Pages → KV →
   **Create namespace**, name it e.g. `sprout-sync`.
2. **Bind it to your Worker:** open the Worker → Settings → **Bindings** →
   Add → **KV namespace**:
   - Variable name: `SPROUT_KV`
   - Namespace: the one you just created
3. **Redeploy** for the binding to take effect (required — bindings only apply
   to new deployments). Push any commit, or use Retry deployment.

That's it. The API is two endpoints served by the Worker:

- `GET /api/sync/:key` → snapshot JSON or 404
- `PUT /api/sync/:key` → stores a validated snapshot (5 MB cap)

The sync key is a bearer token: anyone with the code can read/write the data,
so treat it like a password. It can't be guessed (96-bit random) and there's
no endpoint that lists keys — wrong keys just get a 404.

### Using it

1. On your **first** device: Settings → Sync → **Enable sync on this device**.
   You'll get a code like `a3f9-…`.
2. On the **second** device: Settings → Sync → enter the code → **Join**.
3. After that it syncs automatically: on launch, when the app becomes visible,
   and a few seconds after every change. There's also a **Sync now** button.

## How data is stored

Everything lives in your browser's **localStorage** — on your device only,
nothing is uploaded anywhere. It persists across sessions like a native app's
data. Use **Settings → Export CSV** for backups (Nara Baby-compatible format).

## Features

- Multiple children (name, sex, birth date)
- Measurements by date: weight, length, head circumference (any subset)
- SVG growth charts with WHO 3rd/15th/50th/85th/97th percentile curves,
  birth–5 years, sex-specific; tap a point for date, age, value, percentile
- Latest-percentile summary cards
- Metric/imperial units (Settings)
- Independent lb/kg and in/cm toggles when entering measurements; displays follow Settings
- CSV export/import in Nara Baby's format (import a Nara Baby export to migrate history)
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
