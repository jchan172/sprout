/* Sprout PWA — baby growth tracker with WHO percentile curves.
   Data persists in localStorage; works offline once installed. */
'use strict';

/* ---------------- utils ---------------- */
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function ageDays(birthStr, dateStr) {
  return Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(birthStr + 'T00:00:00Z')) / 86400000);
}
function fmtDate(str) {
  const d = new Date(str + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function ageString(birthStr, atStr) {
  const days = ageDays(birthStr, atStr || todayStr());
  const m = days / DAYS_PER_MONTH;
  if (m < 1) return days === 1 ? '1 day' : days + ' days';
  if (m < 24) return m.toFixed(1) + ' mo';
  return (m / 12).toFixed(1) + ' yr';
}

/* ---------------- WHO math ---------------- */
const DAYS_PER_MONTH = 30.4375;
const CURVES = [
  { label: '3rd', z: -1.880793608 },
  { label: '15th', z: -1.036433389 },
  { label: '50th', z: 0 },
  { label: '85th', z: 1.036433389 },
  { label: '97th', z: 1.880793608 }
];

function lmsAt(indicator, sex, day) {
  if (day < 0 || day > WHO_MAX_DAYS) return null;
  const key = { weight: 'wfa', length: 'lhfa', head: 'hcfa' }[indicator];
  const t = key && WHO[key] && WHO[key][sex];
  if (!t || day * 3 + 2 >= t.length) return null;
  return [t[day * 3], t[day * 3 + 1], t[day * 3 + 2]];
}
function zScore(x, L, M, S) {
  if (L === 0) return Math.log(x / M) / S;
  return (Math.pow(x / M, L) - 1) / (L * S);
}
function phi(z) { // standard normal CDF, Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function percentileFor(x, L, M, S) { return phi(zScore(x, L, M, S)) * 100; }
function curveValue(z, L, M, S) {
  if (L === 0) return M * Math.exp(S * z);
  return M * Math.pow(1 + L * S * z, 1 / L);
}
function ordinal(p) {
  const n = Math.round(p);
  let suf = 'th';
  if (n % 100 < 11 || n % 100 > 13) {
    if (n % 10 === 1) suf = 'st';
    else if (n % 10 === 2) suf = 'nd';
    else if (n % 10 === 3) suf = 'rd';
  }
  return n + suf;
}

/* ---------------- units ---------------- */
function units() { return DB.units === 'metric' ? 'metric' : 'imperial'; }
function dispWeight(kg) { return units() === 'metric' ? kg : kg * 2.20462; }
function dispLength(cm) { return units() === 'metric' ? cm : cm / 2.54; }
function toKg(v, unit) { return (unit || weightUnit()) === 'kg' ? v : v / 2.20462; }
function toCm(v, unit) { return (unit || lengthUnit()) === 'cm' ? v : v * 2.54; }
function weightUnit() { return units() === 'metric' ? 'kg' : 'lb'; }
function lengthUnit() { return units() === 'metric' ? 'cm' : 'in'; }
function fmtWeight(kg) { return dispWeight(kg).toFixed(1) + ' ' + weightUnit(); }
function fmtLength(cm) { return dispLength(cm).toFixed(1) + ' ' + lengthUnit(); }
function parseNum(str) {
  const t = String(str == null ? '' : str).trim().replace(',', '.');
  if (!t) return null;
  const v = parseFloat(t);
  return isFinite(v) && v > 0 ? v : NaN;
}

const INDICATORS = {
  weight: { title: 'Weight', hint: 'Use a calibrated baby scale.', get: function (m) { return m.weightKg; },
            fmt: fmtWeight, toMetric: toKg, unit: weightUnit, ph: 'e.g. 8.4' },
  length: { title: 'Length', hint: 'Under 2: lying down. Over 2: standing.', get: function (m) { return m.lengthCm; },
            fmt: fmtLength, toMetric: toCm, unit: lengthUnit, ph: 'e.g. 68.5' },
  head:   { title: 'Head', hint: 'Tape around the widest part of the head.', get: function (m) { return m.headCm; },
            fmt: fmtLength, toMetric: toCm, unit: lengthUnit, ph: 'e.g. 43.2' }
};
const IND_KEYS = ['weight', 'length', 'head'];

/* ---------------- store (localStorage) ---------------- */
const LS_KEY = 'sprout.v1';
let DB = null;
function defaultDB() { return { kids: [], measurements: [], deleted: [], units: 'imperial' }; }
function loadDB() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultDB();
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.kids) || !Array.isArray(d.measurements)) return defaultDB();
    if (d.units !== 'metric' && d.units !== 'imperial') d.units = 'imperial';
    if (!Array.isArray(d.deleted)) d.deleted = [];
    // backfill updatedAt for records created before sync existed
    const now = Date.now();
    d.kids.forEach(function (k) { if (!k.updatedAt) k.updatedAt = now; });
    d.measurements.forEach(function (m) { if (!m.updatedAt) m.updatedAt = now; });
    d.deleted.forEach(function (t) { if (!t.updatedAt) t.updatedAt = now; });
    return d;
  } catch (e) { return defaultDB(); }
}
function saveDB() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (e) { /* storage full/blocked */ }
}
function getKid(id) { return DB.kids.find(function (k) { return k.id === id; }); }
function kidMeasurements(kidId) {
  return DB.measurements
    .filter(function (m) { return m.kidId === kidId; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}
function latestFor(kidId, indKey) {
  const ms = kidMeasurements(kidId);
  for (let i = ms.length - 1; i >= 0; i--) {
    if (INDICATORS[indKey].get(ms[i]) != null) return ms[i];
  }
  return null;
}
function percentileOf(kid, msr, indKey) {
  const v = INDICATORS[indKey].get(msr);
  if (v == null) return null;
  const day = ageDays(kid.birth, msr.date);
  const lms = lmsAt(indKey, kid.sex, day);
  if (!lms) return null;
  return percentileFor(v, lms[0], lms[1], lms[2]);
}

/* ---------------- sync (Cloudflare Worker + KV) ----------------
   No database: the whole dataset is a small JSON snapshot stored under a
   random sync key in Workers KV, served by worker.js. Devices merge
   record-by-record using updatedAt, so concurrent edits don't clobber each other. */
const SYNC_LS = 'sprout.sync.v1';
let SYNC = { key: null, lastSyncedAt: 0 };
let syncNote = ''; // transient status line for Settings
function loadSync() {
  try {
    const raw = localStorage.getItem(SYNC_LS);
    if (!raw) return { key: null, lastSyncedAt: 0 };
    const s = JSON.parse(raw);
    return { key: typeof s.key === 'string' ? s.key : null, lastSyncedAt: s.lastSyncedAt || 0 };
  } catch (e) { return { key: null, lastSyncedAt: 0 }; }
}
function saveSync() {
  try { localStorage.setItem(SYNC_LS, JSON.stringify(SYNC)); } catch (e) {}
}
function genSyncKey() {
  let hex = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    hex = Array.from(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  } else {
    for (let i = 0; i < 24; i++) hex += Math.floor(Math.random() * 16).toString(16);
  }
  return [0, 4, 8, 12, 16, 20].map(function (i) { return hex.slice(i, i + 4); }).join('-');
}
function snapshot() {
  return { v: 1, updatedAt: Date.now(), kids: DB.kids, measurements: DB.measurements, deleted: DB.deleted };
}
function applySnapshot(s) {
  DB.kids = Array.isArray(s.kids) ? s.kids : [];
  DB.measurements = Array.isArray(s.measurements) ? s.measurements : [];
  DB.deleted = Array.isArray(s.deleted) ? s.deleted : [];
  saveDB(); // units stay local-only; never synced
}
function mergeSnapshots(a, b) {
  const byId = new Map(); // id -> {rec, tomb}
  function add(rec, isTomb) {
    let e = byId.get(rec.id);
    if (!e) { e = { rec: null, tomb: null }; byId.set(rec.id, e); }
    const cur = isTomb ? e.tomb : e.rec;
    if (!cur || (rec.updatedAt || 0) > (cur.updatedAt || 0)) {
      if (isTomb) e.tomb = rec; else e.rec = rec;
    }
  }
  (a.kids || []).forEach(function (r) { add(r, false); });
  (b.kids || []).forEach(function (r) { add(r, false); });
  (a.measurements || []).forEach(function (r) { add(r, false); });
  (b.measurements || []).forEach(function (r) { add(r, false); });
  (a.deleted || []).forEach(function (t) { add(t, true); });
  (b.deleted || []).forEach(function (t) { add(t, true); });
  const kids = [], measurements = [], deleted = [];
  byId.forEach(function (e) {
    const t = e.tomb, r = e.rec;
    if (t && (!r || (t.updatedAt || 0) >= (r.updatedAt || 0))) { deleted.push(t); return; }
    if (r) {
      if (r.kidId !== undefined) measurements.push(r); else kids.push(r);
    } else if (t) { deleted.push(t); }
  });
  deleted.sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0); });
  return { v: 1, updatedAt: Date.now(), kids: kids, measurements: measurements, deleted: deleted.slice(0, 500) };
}

let syncing = false;
let syncTimer = 0;
let syncPending = false; // local changes (or a failed sync) still need uploading
function scheduleSync() {
  if (!SYNC.key || typeof fetch === 'undefined') return;
  syncPending = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncNow(); }, 2500);
}
// True when a reconnect is a good moment to sync: something is waiting to go
// up, or it's been a while since we last checked for remote changes.
function needsSyncRetry() {
  return !!SYNC.key && !syncing &&
    (syncPending || Date.now() - SYNC.lastSyncedAt > 60000);
}
async function syncNow() {
  if (!SYNC.key || syncing || typeof fetch === 'undefined') return false;
  syncing = true;
  try {
    const url = '/api/sync/' + encodeURIComponent(SYNC.key);
    const local = snapshot();
    let remote = null;
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 200) remote = await r.json();
    else if (r.status !== 404) throw new Error('get ' + r.status);
    const merged = remote ? mergeSnapshots(local, remote) : local;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(merged)
    });
    if (!put.ok) throw new Error('put ' + put.status);
    applySnapshot(merged);
    prunePhotos(); // drop photos for kids deleted elsewhere
    SYNC.lastSyncedAt = Date.now(); saveSync();
    syncPending = false;
    syncNote = '';
    // don't clobber a form the user is typing in; it re-renders on close
    if (!modal) render();
    return true;
  } catch (e) {
    syncNote = 'Sync failed — check your connection and try again.';
    syncPending = true; // retry next time we're online / visible
    if (view.name === 'settings' && !modal) render();
    return false;
  } finally {
    syncing = false;
  }
}
function syncStatusText() {
  if (syncNote) return syncNote;
  if (!SYNC.lastSyncedAt) return 'Enabled — not synced yet.';
  const s = Math.round((Date.now() - SYNC.lastSyncedAt) / 1000);
  if (s < 10) return 'Synced just now.';
  if (s < 60) return 'Synced ' + s + 's ago.';
  const m = Math.round(s / 60);
  if (m < 60) return 'Synced ' + m + 'm ago.';
  return 'Synced ' + new Date(SYNC.lastSyncedAt).toLocaleString() + '.';
}

/* ---------------- device-local kid photos ----------------
   Profile photos stay on this device only: they live in a separate
   localStorage key and are NEVER part of the synced snapshot or exports. */
const PHOTOS_LS = 'sprout.photos.v1';
let PHOTOS = {};
let photoDraft; // undefined = unchanged, null = remove, string = new dataURL
function loadPhotos() {
  try {
    const raw = localStorage.getItem(PHOTOS_LS);
    const p = raw ? JSON.parse(raw) : {};
    return p && typeof p === 'object' ? p : {};
  } catch (e) { return {}; }
}
function savePhotos() {
  try { localStorage.setItem(PHOTOS_LS, JSON.stringify(PHOTOS)); } catch (e) { /* quota */ }
}
function prunePhotos() {
  const ids = {};
  DB.kids.forEach(function (k) { ids[k.id] = true; });
  let changed = false;
  Object.keys(PHOTOS).forEach(function (id) {
    if (!ids[id]) { delete PHOTOS[id]; changed = true; }
  });
  if (changed) savePhotos();
}
// Photo shown in the currently open kid modal (draft, existing, or none).
function modalPhoto() {
  if (photoDraft !== undefined) return photoDraft;
  const id = modal && modal.kidId;
  return (id && PHOTOS[id]) || null;
}
function photoPreviewHTML(photo) {
  return '<span class="photo-preview" data-photo-preview>' +
    (photo ? '<img src="' + photo + '" alt="">' : '👶') + '</span>';
}
function updatePhotoPreview() {
  const el = document.querySelector('[data-photo-preview]');
  if (el) el.outerHTML = photoPreviewHTML(modalPhoto());
  const rb = document.querySelector('[data-photo-remove]');
  if (rb) rb.style.display = modalPhoto() ? '' : 'none';
}
function handlePhotoInput(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f || !/^image\//.test(f.type || '')) return;
  const rd = new FileReader();
  rd.onload = function () {
    const img = new Image();
    img.onload = function () {
      try {
        const MAX = 256; // small enough for localStorage, plenty for a 48px avatar
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        photoDraft = c.toDataURL('image/jpeg', 0.82);
        updatePhotoPreview();
      } catch (e) { /* canvas unavailable */ }
    };
    img.src = rd.result;
  };
  rd.readAsDataURL(f);
}

/* ---------------- Nara Baby CSV import/export ----------------
   Sprout reads and writes the same 51-column CSV layout as Nara Baby's
   activity export, so history can move between the two apps. Only Growth
   rows carry measurements Sprout understands; other activity types are
   skipped on import and never written on export. Values are stored in
   canonical metric (KG/CM), matching Nara Baby's own export. */
const NARA_COLS = [
  'Type', 'Profile Name', 'Start Date/time', 'Start Date/time (Epoch)',
  'Created By Caregiver', 'Last Updated By Caregiver', 'Note', 'Time Zone',
  '[Growth] Head Size', '[Growth] Head Size Unit', '[Growth] Height', '[Growth] Height Unit',
  '[Growth] Weight', '[Growth] Weight Unit',
  '[Diaper] Type', '[Diaper] Detail', '[Diaper] Dirty Color', '[Diaper] Dirty Texture',
  '[Sleep] Duration (Seconds)', '[Sleep] End Date/time', '[Sleep] End Date/time (Epoch)',
  '[Routine] Routine',
  '[Breastfeed] Begin Side', '[Breastfeed] End Side',
  '[Breastfeed] Left Duration (Seconds)', '[Breastfeed] Right Duration (Seconds)',
  '[Bottle Feed] Type', '[Bottle Feed] Breast Milk Volume', '[Bottle Feed] Breast Milk Volume Unit',
  '[Bottle Feed] Formula Name', '[Bottle Feed] Formula Volume', '[Bottle Feed] Formula Volume Unit',
  '[Bottle Feed] Volume', '[Bottle Feed] Volume Unit',
  '[Vaccine] Vaccine',
  '[Pump] Duration (Seconds)', '[Pump] End Date/time', '[Pump] End Date/time (Epoch)',
  '[Pump] Left Volume', '[Pump] Left Volume Unit', '[Pump] Right Volume', '[Pump] Right Volume Unit',
  '[Pump] Total Volume', '[Pump] Total Volume Unit',
  '[Profile] Birth Date', '[Profile] Birth Date (Adjusted)', '[Profile] Sex', '[Profile] Type',
  '_familyKey', '_profileKey', '_activityKey'
];
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (inQ || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvCell(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}
function csvNum(v) {
  if (v == null || !isFinite(v)) return '';
  return String(Number(v.toFixed(4)));
}
function naraWeightToKg(v, unit) {
  const u = String(unit || 'KG').trim().toUpperCase();
  if (u === 'KG' || u === 'KILOGRAM' || u === 'KILOGRAMS') return v;
  if (u === 'G' || u === 'GRAM' || u === 'GRAMS') return v / 1000;
  if (u === 'LB' || u === 'LBS' || u === 'POUND' || u === 'POUNDS') return v * 0.45359237;
  if (u === 'OZ' || u === 'OUNCE' || u === 'OUNCES') return v * 0.028349523125;
  return null; // unknown unit — don't guess
}
function naraLengthToCm(v, unit) {
  const u = String(unit || 'CM').trim().toUpperCase();
  if (u === 'CM' || u === 'CENTIMETER' || u === 'CENTIMETERS') return v;
  if (u === 'MM' || u === 'MILLIMETER' || u === 'MILLIMETERS') return v / 10;
  if (u === 'M' || u === 'METER' || u === 'METERS') return v * 100;
  if (u === 'IN' || u === 'INCH' || u === 'INCHES') return v * 2.54;
  if (u === 'FT' || u === 'FOOT' || u === 'FEET') return v * 30.48;
  return null; // unknown unit — don't guess
}
function exportNaraCSV() {
  const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
    ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '') : '';
  const lines = [NARA_COLS.map(csvCell).join(',')];
  DB.kids.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
    .forEach(function (k) {
      kidMeasurements(k.id).forEach(function (m) {
        const r = new Array(NARA_COLS.length).fill('');
        r[0] = 'Growth';
        r[1] = k.name;
        r[2] = m.date + ' 00:00:00';
        r[3] = String(new Date(+m.date.slice(0, 4), +m.date.slice(5, 7) - 1, +m.date.slice(8, 10)).getTime());
        r[7] = tz;
        if (m.headCm != null) { r[8] = csvNum(m.headCm); r[9] = 'CM'; }
        if (m.lengthCm != null) { r[10] = csvNum(m.lengthCm); r[11] = 'CM'; }
        if (m.weightKg != null) { r[12] = csvNum(m.weightKg); r[13] = 'KG'; }
        lines.push(r.map(csvCell).join(','));
      });
    });
  return lines.join('\n') + '\n';
}
function importNaraCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('empty file');
  const idx = {};
  rows[0].forEach(function (c, i) {
    const name = String(c).trim();
    if (!(name in idx)) idx[name] = i;
  });
  if (idx['Type'] == null || idx['Profile Name'] == null) throw new Error('not a Nara Baby export');
  function col(row, name) {
    const i = idx[name];
    return i == null ? '' : String(row[i] == null ? '' : row[i]).trim();
  }
  function parseVal(s) {
    if (!s) return null;
    const v = parseFloat(String(s).replace(',', '.'));
    return isFinite(v) && v > 0 ? v : null;
  }
  function dateOf(row) {
    const dtm = /^(\d{4}-\d{2}-\d{2})/.exec(col(row, 'Start Date/time') || '');
    if (dtm) return dtm[1];
    const ep = parseInt(col(row, 'Start Date/time (Epoch)'), 10);
    if (isFinite(ep) && ep > 0 && typeof Intl !== 'undefined') {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: col(row, 'Time Zone') || undefined,
          year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date(ep));
        if (/^\d{4}-\d{2}-\d{2}$/.test(parts)) return parts;
      } catch (e) { /* fall through */ }
    }
    return null;
  }
  const now = Date.now();
  const kidsByName = {};
  DB.kids.forEach(function (k) { kidsByName[String(k.name).trim().toLowerCase()] = k; });
  const byKey = {};
  DB.measurements.forEach(function (m) { byKey[m.kidId + '|' + m.date] = m; });
  let created = 0, updated = 0, skipped = 0;
  const unmatched = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length || row.every(function (c) { return !String(c).trim(); })) continue;
    if (col(row, 'Type').toLowerCase() !== 'growth') continue;
    const kid = kidsByName[col(row, 'Profile Name').toLowerCase()];
    if (!kid) { unmatched[col(row, 'Profile Name') || '(blank)'] = true; skipped++; continue; }
    const date = dateOf(row);
    if (!date) { skipped++; continue; }
    const w = parseVal(col(row, '[Growth] Weight'));
    const l = parseVal(col(row, '[Growth] Height'));
    const hc = parseVal(col(row, '[Growth] Head Size'));
    const wKg = w == null ? null : naraWeightToKg(w, col(row, '[Growth] Weight Unit'));
    const lCm = l == null ? null : naraLengthToCm(l, col(row, '[Growth] Height Unit'));
    const hcCm = hc == null ? null : naraLengthToCm(hc, col(row, '[Growth] Head Size Unit'));
    if (wKg == null && lCm == null && hcCm == null) { skipped++; continue; }
    const key = kid.id + '|' + date;
    let m = byKey[key];
    if (!m) {
      m = { id: uid(), kidId: kid.id, date: date, weightKg: null, lengthCm: null, headCm: null, updatedAt: now };
      DB.measurements.push(m);
      byKey[key] = m;
      created++;
    } else updated++;
    if (wKg != null) m.weightKg = wKg;
    if (lCm != null) m.lengthCm = lCm;
    if (hcCm != null) m.headCm = hcCm;
    m.updatedAt = now;
  }
  return { created: created, updated: updated, skipped: skipped, unmatched: Object.keys(unmatched).sort() };
}

/* ---------------- view state ---------------- */
let view = { name: 'kids' };
let modal = null; // {type:'kid',kidId?} | {type:'msr',kidId,msrId?}

/* ---------------- chart (SVG) ---------------- */
function niceTicks(min, max, n) {
  if (!(max > min)) return [min];
  const span = max - min, raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}
function chartSVG(kid, indKey, selectedId) {
  const W = 640, H = 380, PL = 48, PR = 14, PT = 14, PB = 36;
  const xMax = 61;
  const toDisp = indKey === 'weight' ? dispWeight : dispLength;
  const series = CURVES.map(function (c) {
    const pts = [];
    for (let d = 0; d <= WHO_MAX_DAYS; d += 16) {
      const lms = lmsAt(indKey, kid.sex, d);
      pts.push([d / DAYS_PER_MONTH, toDisp(curveValue(c.z, lms[0], lms[1], lms[2]))]);
    }
    return { label: c.label, pts: pts };
  });
  const p3 = series[0].pts, p97 = series[4].pts;
  let lo = Infinity, hi = -Infinity;
  p3.concat(p97).forEach(function (p) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const X = function (m) { return PL + (m / xMax) * (W - PL - PR); };
  const Y = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };
  const f1 = function (n) { return Math.round(n * 10) / 10; };

  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(INDICATORS[indKey].title) + ' growth chart">';
  // band
  let band = 'M' + p3.map(function (p) { return f1(X(p[0])) + ',' + f1(Y(p[1])); }).join('L');
  band += 'L' + p97.slice().reverse().map(function (p) { return f1(X(p[0])) + ',' + f1(Y(p[1])); }).join('L') + 'Z';
  s += '<path d="' + band + '" fill="#1a73e8" opacity="0.06"/>';
  // gridlines + y labels
  niceTicks(lo + pad, hi - pad, 5).forEach(function (t) {
    s += '<line x1="' + PL + '" y1="' + f1(Y(t)) + '" x2="' + (W - PR) + '" y2="' + f1(Y(t)) + '" stroke="#e5e7eb"/>';
    s += '<text x="' + (PL - 7) + '" y="' + f1(Y(t) + 4) + '" text-anchor="end" font-size="11" fill="#6b7280">' + Math.round(t) + '</text>';
  });
  // x labels
  for (let m = 0; m <= 60; m += 6) {
    const lbl = m === 0 ? 'Birth' : (m % 12 === 0 ? (m / 12) + 'y' : m + 'm');
    s += '<text x="' + f1(X(m)) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="11" fill="#6b7280">' + lbl + '</text>';
  }
  // curves
  const colors = { '3rd': '#9aa0a6', '15th': '#80868b', '50th': '#2f9e44', '85th': '#80868b', '97th': '#9aa0a6' };
  series.forEach(function (ser) {
    const d = 'M' + ser.pts.map(function (p) { return f1(X(p[0])) + ',' + f1(Y(p[1])); }).join('L');
    const w = ser.label === '50th' ? 2.6 : 1.1;
    s += '<path d="' + d + '" fill="none" stroke="' + colors[ser.label] + '" stroke-width="' + w + '"/>';
  });
  // child points
  const pts = kidMeasurements(kid.id).map(function (m) {
    const v = INDICATORS[indKey].get(m);
    if (v == null) return null;
    const day = ageDays(kid.birth, m.date);
    if (day < 0 || day > WHO_MAX_DAYS) return null;
    return { m: m, x: X(day / DAYS_PER_MONTH), y: Y(toDisp(v)) };
  }).filter(Boolean);
  pts.forEach(function (p) {
    const sel = p.m.id === selectedId;
    s += '<circle cx="' + f1(p.x) + '" cy="' + f1(p.y) + '" r="' + (sel ? 7 : 5) + '" fill="#1a73e8"'
      + ' data-action="select-point" data-id="' + p.m.id + '" style="cursor:pointer">'
      + '<title>' + esc(fmtDate(p.m.date)) + '</title></circle>';
    if (sel) s += '<line x1="' + f1(p.x) + '" y1="' + PT + '" x2="' + f1(p.x) + '" y2="' + (H - PB) + '" stroke="#1a73e8" stroke-dasharray="4,4" opacity="0.5"/>';
  });
  s += '</svg>';
  return s;
}

/* ---------------- views ---------------- */
function topbar(title, back, titleAction) {
  return '<div class="topbar">' +
    (back ? '<a class="back" href="#" data-action="nav-kids" aria-label="Back">‹</a>' : '') +
    '<h1' + (titleAction ? ' data-action="' + titleAction + '" style="cursor:pointer"' : '') + '>' + esc(title) + '</h1>' +
    (view.name === 'kids'
      ? '<button class="iconbtn" data-action="nav-settings" aria-label="Settings">⚙️</button>'
        + '<button class="iconbtn" data-action="open-kid-modal" aria-label="Add child" style="background:var(--green);color:#fff">＋</button>'
      : '') +
    '</div>';
}

function kidsView() {
  let h = topbar('Sprout', false);
  if (!DB.kids.length) {
    h += '<div class="empty"><div class="big">🌱</div><h2>Track their growth</h2>' +
      '<p>Log weight, length, and head circumference, and watch them grow against WHO reference curves with percentiles.</p>' +
      '<button class="btn primary" data-action="open-kid-modal">Add your first child</button></div>';
  } else {
    h += DB.kids.map(function (k) {
      const n = kidMeasurements(k.id).length;
      const photo = PHOTOS[k.id];
      return '<a class="kidrow" href="#" data-action="nav-kid" data-id="' + k.id + '">' +
        '<span class="avatar">' + (photo ? '<img src="' + photo + '" alt="">' : (k.sex === 'boy' ? '👦' : '👧')) + '</span>' +
        '<span><span class="name">' + esc(k.name) + '</span>' +
        '<div class="sub">' + esc(ageString(k.birth)) + ' old · ' + n + ' measurement' + (n === 1 ? '' : 's') + '</div></span>' +
        '<span class="chev">›</span></a>';
    }).join('');
  }
  h += '<p class="caption footnote">Data is stored only on this device. Back it up from Settings → Export.</p>';
  return h;
}

function statCards(kid, tab) {
  return '<div class="stats">' + IND_KEYS.map(function (key) {
    const ind = INDICATORS[key];
    const m = latestFor(kid.id, key);
    let inner = '<div class="t">' + ind.title + '</div>';
    if (m) {
      const v = ind.get(m);
      inner += '<div class="v">' + esc(ind.fmt(v)) + '</div>';
      const p = percentileOf(kid, m, key);
      inner += p == null
        ? '<div class="p muted">past 5y</div>'
        : '<div class="p">' + ordinal(p) + ' pct</div>';
    } else {
      inner += '<div class="v muted">—</div>';
    }
    return '<button class="stat' + (tab === key ? ' active' : '') + '" data-action="set-tab" data-ind="' + key + '">' + inner + '</button>';
  }).join('') + '</div>';
}

function pointInfo(kid, indKey, selectedId) {
  const ind = INDICATORS[indKey];
  let m = selectedId ? DB.measurements.find(function (x) { return x.id === selectedId; }) : null;
  if (!m || INDICATORS[indKey].get(m) == null) m = latestFor(kid.id, indKey);
  if (!m) return '<p class="small muted">No ' + ind.title.toLowerCase() + ' measurements yet — tap ＋ below to add one.</p>';
  const v = ind.get(m);
  const p = percentileOf(kid, m, indKey);
  return '<div class="ptinfo"><div><div class="d">' + esc(fmtDate(m.date)) + '</div>' +
    '<div class="a">' + esc(ageString(kid.birth, m.date)) + ' old</div></div>' +
    '<div><div class="v">' + esc(ind.fmt(v)) + '</div>' +
    '<div class="p">' + (p == null ? 'outside WHO range' : ordinal(p) + ' percentile') + '</div></div></div>';
}

function kidView(kidId) {
  const kid = getKid(kidId);
  if (!kid) return kidsView();
  const tab = view.tab || 'weight';
  const ind = INDICATORS[tab];
  const ms = kidMeasurements(kidId).slice().reverse();

  let h = '<div class="topbar">' +
    '<h1 class="kidcycle" data-action="cycle-kid" aria-label="Switch child">' + esc(kid.name) + ' <span class="cycledown">⌄</span></h1>' +
    '<button class="homebtn" data-action="nav-kids" aria-label="Home"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11.2 12 4l9 7.2"/><path d="M5.6 9.8V20h12.8V9.8"/><path d="M10 20v-5.2h4V20"/></svg></button></div>';
  h += '<div class="card"><div style="display:flex;align-items:center;gap:10px">' +
    '<div style="flex:1"><h3 style="font-size:17px">' + esc(ageString(kid.birth)) + ' old</h3>' +
    '<div class="small muted">Born ' + esc(fmtDate(kid.birth)) + ' · ' + (kid.sex === 'boy' ? 'Boy' : 'Girl') + '</div></div>' +
    '<button class="btn ghost" data-action="open-kid-modal" data-id="' + kid.id + '">Edit</button>' +
    '</div></div>';

  h += statCards(kid, tab);

  h += '<div class="seg">' + IND_KEYS.map(function (key) {
    return '<button class="' + (tab === key ? 'active' : '') + '" data-action="set-tab" data-ind="' + key + '">' + INDICATORS[key].title + '</button>';
  }).join('') + '</div>';
  h += '<p class="caption">' + esc(ind.hint) + '</p>';

  h += '<div class="chart-wrap">' + chartSVG(kid, tab, view.selectedId) + '</div>';
  h += '<div class="legend"><span><span class="dot" style="background:#2f9e44"></span>50th</span>' +
    '<span><span class="dot" style="background:#9aa0a6"></span>3rd / 97th</span>' +
    '<span><span class="dot" style="background:#1a73e8"></span>' + esc(kid.name) + '</span></div>';
  h += pointInfo(kid, tab, view.selectedId);

  h += '<div class="sect-head" id="msr-head"><h2>Measurements</h2>' +
    '<button class="iconbtn" data-action="open-msr-modal" data-kid="' + kid.id + '" aria-label="Add measurement" style="background:var(--green);color:#fff">＋</button></div>';
  if (!ms.length) {
    h += '<p class="small muted">No measurements yet.</p>';
  } else {
    const SHOW_N = 10;
    const expanded = !!view.showAllMsr;
    const hasMore = ms.length > SHOW_N;
    const shown = expanded ? ms : ms.slice(0, SHOW_N);
    h += '<div class="msr-wrap">' + shown.map(function (m) {
      const vals = IND_KEYS.map(function (key) {
        const v = INDICATORS[key].get(m);
        if (v == null) return '';
        const p = percentileOf(kid, m, key);
        return '<div>' + esc(INDICATORS[key].fmt(v)) +
          (p == null ? '' : ' <span class="pct">' + ordinal(p) + '</span>') + '</div>';
      }).join('');
      return '<div class="mrow" data-action="open-msr-modal" data-kid="' + kid.id + '" data-id="' + m.id + '">' +
        '<div><div class="date">' + esc(fmtDate(m.date)) + '</div>' +
        '<div class="age">' + esc(ageString(kid.birth, m.date)) + ' old</div></div>' +
        '<div class="vals">' + vals + '</div></div>';
    }).join('') + (!expanded && hasMore ? '<div class="msr-fade"></div>' : '') + '</div>';
    if (hasMore) {
      h += '<button class="seemore" data-action="toggle-msr-list">' +
        (expanded ? 'See Less <span>▴</span>' : 'See More <span>▾</span>') + '</button>';
    }
  }
  h += '<p class="caption footnote">Reference: WHO Child Growth Standards (2006). For information only — not medical advice.</p>';
  return h;
}

function syncSection() {
  if (!SYNC.key) {
    return '<div class="card"><h3>Sync between devices</h3>' +
      '<p class="small muted">Keep the same data on your phone, tablet, etc. — stored as a small file in Cloudflare KV, no database. Enable on <b>one</b> device, then join with the code on the others.</p>' +
      '<button class="btn primary block" data-action="sync-enable">Enable sync on this device</button>' +
      '<div class="field"><label>Or join with a code</label><div class="input-row">' +
      '<input data-sync-code placeholder="xxxx-xxxx-xxxx-xxxx" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<button class="btn ghost" data-action="sync-join">Join</button></div></div>' +
      '<div class="ferr" data-sync-err></div></div>';
  }
  return '<div class="card"><h3>Sync between devices</h3>' +
    '<p class="small muted">Enter this code on your other device under Settings → Sync → Join with a code. Anyone with the code can read and write this data.</p>' +
    '<div class="codebox">' + esc(SYNC.key) + '</div>' +
    '<div class="btnrow"><button class="btn ghost" data-action="sync-copy">Copy code</button>' +
    '<button class="btn ghost" data-action="sync-now">Sync now</button></div>' +
    '<p class="small muted">' + esc(syncStatusText()) + '</p>' +
    '<div class="ferr" data-sync-err></div>' +
    '<button class="btn danger block" data-action="sync-disable">Disable sync</button></div>';
}
function syncErr(msg) {
  const el = document.querySelector('[data-sync-err]');
  if (el) el.textContent = msg;
}

function settingsView() {
  const u = units();
  let h = topbar('Settings', true);
  h += '<div class="card"><h3>Units</h3><div class="seg" style="margin-top:8px">' +
    '<button class="' + (u === 'metric' ? 'active' : '') + '" data-action="set-units" data-v="metric">Metric (kg, cm)</button>' +
    '<button class="' + (u === 'imperial' ? 'active' : '') + '" data-action="set-units" data-v="imperial">Imperial (lb, in)</button>' +
    '</div></div>';
  h += syncSection();
  h += '<div class="card"><h3>Backup</h3>' +
    '<p class="small muted">Export uses the Nara Baby CSV format — good as a backup, and you can import a Nara Baby export here to bring your history into Sprout.</p>' +
    '<div class="btnrow"><button class="btn ghost" data-action="export">Export CSV</button>' +
    '<label class="btn ghost" style="text-align:center;cursor:pointer">Import CSV<input type="file" accept=".csv,text/csv" data-change="import" style="display:none"></label></div></div>';
  h += '<div class="card"><h3>Add to Home Screen</h3>' +
    '<p class="small muted">On iPhone: open this page in Safari → Share → <b>Add to Home Screen</b>. It then opens full-screen like an app and works offline.</p></div>';
  h += '<div class="card"><h3>Reference data</h3>' +
    '<p class="disclaimer">Growth curves and percentiles come from the WHO Child Growth Standards (2006) — weight-for-age, length/height-for-age, and head-circumference-for-age for boys and girls, birth to 5 years, computed with the LMS method.</p></div>';
  h += '<div class="card"><h3>Please note</h3>' +
    '<p class="disclaimer">Sprout is a tracking tool, not medical advice. If a measurement looks off the expected curve or you\'re worried about your child\'s growth, talk to your pediatrician.</p></div>';
  return h;
}

/* ---------------- modals ---------------- */
function kidModal(kidId) {
  const k = kidId ? getKid(kidId) : null;
  const photo = (k && PHOTOS[k.id]) || null;
  return '<div class="modal-back" data-action="backdrop"><div class="modal" role="dialog">' +
    '<div class="grabber"></div><h2>' + (k ? 'Edit child' : 'Add child') + '</h2>' +
    '<form data-form="kid"><input type="hidden" name="id" value="' + (k ? k.id : '') + '">' +
    '<div class="field"><label>Name</label><input name="name" required maxlength="40" value="' + esc(k ? k.name : '') + '" placeholder="e.g. Maya"></div>' +
    '<div class="field"><label>Sex <span class="hint">— picks the right WHO reference curves</span></label>' +
    '<select name="sex"><option value="boy"' + (!k || k.sex === 'boy' ? ' selected' : '') + '>Boy</option>' +
    '<option value="girl"' + (k && k.sex === 'girl' ? ' selected' : '') + '>Girl</option></select></div>' +
    '<div class="field"><label>Birth date</label><input type="date" name="birth" required max="' + todayStr() + '" value="' + esc(k ? k.birth : '') + '"></div>' +
    '<div class="field"><label>Photo <span class="hint">— stays on this device, never synced</span></label>' +
    '<div class="photorow">' + photoPreviewHTML(photo) +
    '<label class="btn ghost" style="cursor:pointer">Choose photo<input type="file" accept="image/*" data-change="photo" style="display:none"></label>' +
    '<button type="button" class="btn ghost" data-action="remove-photo" data-photo-remove style="display:' + (photo ? '' : 'none') + '">Remove</button>' +
    '</div></div>' +
    '<div class="ferr" data-err></div>' +
    '<div class="btnrow"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button>' +
    '<button type="submit" class="btn primary">' + (k ? 'Save' : 'Add') + '</button></div>' +
    (k ? '<button type="button" class="btn danger block" data-action="delete-kid" data-id="' + k.id + '">Delete ' + esc(k.name) + '</button>' : '') +
    '</form></div></div>';
}

function trimNum(v) {
  const s = Number(v).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
function msrModal(kidId, msrId) {
  const kid = getKid(kidId);
  const m = msrId ? DB.measurements.find(function (x) { return x.id === msrId; }) : null;
  const dispW = m && m.weightKg != null ? trimNum(dispWeight(m.weightKg)) : '';
  const dispL = m && m.lengthCm != null ? trimNum(dispLength(m.lengthCm)) : '';
  const dispH = m && m.headCm != null ? trimNum(dispLength(m.headCm)) : '';
  const dateVal = m ? m.date : todayStr();
  const ageD = ageDays(kid.birth, dateVal);
  const lenHint = ageD < 730 ? 'Lying down' : 'Standing';

  function fld(name, label, val, unit, hint, ph) {
    const options = name === 'weight' ? ['lb', 'kg'] : ['in', 'cm'];
    return '<div class="field"><label for="msr-' + name + '">' + label + ' <span class="hint">— ' + hint + '</span></label>' +
      '<div class="input-row"><input id="msr-' + name + '" name="' + name + '" inputmode="decimal" placeholder="' + ph + '" value="' + esc(val) + '">' +
      '<input type="hidden" name="' + name + 'Unit" value="' + unit + '">' +
      '<div class="seg unit-toggle" role="group" aria-label="' + label + ' unit">' + options.map(function (option) {
        return '<button type="button" class="' + (unit === option ? 'active' : '') + '" aria-pressed="' + (unit === option) +
          '" data-action="set-input-unit" data-field="' + name + '" data-v="' + option + '">' + option + '</button>';
      }).join('') + '</div></div></div>';
  }
  return '<div class="modal-back" data-action="backdrop"><div class="modal" role="dialog">' +
    '<div class="grabber"></div><h2>' + (m ? 'Edit measurement' : 'Add measurement') + '</h2>' +
    '<form data-form="msr"><input type="hidden" name="id" value="' + (m ? m.id : '') + '">' +
    '<input type="hidden" name="kidId" value="' + kid.id + '">' +
    '<div class="field"><label>Date</label><input type="date" name="date" required min="' + esc(kid.birth) + '" max="' + todayStr() + '" value="' + esc(dateVal) + '" data-change="msr-date">' +
    '<div class="small muted" style="margin-top:4px" data-age>Age on this date: ' + esc(ageString(kid.birth, dateVal)) + '</div></div>' +
    fld('weight', 'Weight', dispW, weightUnit(), 'optional', INDICATORS.weight.ph) +
    fld('length', 'Length', dispL, lengthUnit(), lenHint + ', optional', INDICATORS.length.ph) +
    fld('head', 'Head circumference', dispH, lengthUnit(), 'widest part, optional', INDICATORS.head.ph) +
    '<p class="caption">Fill in whichever you measured — at least one is required.</p>' +
    '<div class="ferr" data-err></div>' +
    '<div class="btnrow"><button type="button" class="btn ghost" data-action="close-modal">Cancel</button>' +
    '<button type="submit" class="btn primary">Save</button></div>' +
    (m ? '<button type="button" class="btn danger block" data-action="delete-msr" data-id="' + m.id + '" data-kid="' + kid.id + '">Delete this measurement</button>' : '') +
    '</form></div></div>';
}

/* ---------------- render ---------------- */
function render() {
  const app = document.getElementById('app');
  if (view.name === 'kid') app.innerHTML = kidView(view.kidId);
  else if (view.name === 'settings') app.innerHTML = settingsView();
  else app.innerHTML = kidsView();
  const mr = document.getElementById('modal-root');
  if (!modal) { mr.innerHTML = ''; return; }
  mr.innerHTML = modal.type === 'kid' ? kidModal(modal.kidId) : msrModal(modal.kidId, modal.msrId);
  const first = mr.querySelector('input[name="name"], input[name="date"]');
  if (first && !modal.kidId && !modal.msrId) setTimeout(function () { first.focus(); }, 60);
}

/* ---------------- form handling ---------------- */
function formError(form, msg) {
  const el = form.querySelector('[data-err]');
  if (el) el.textContent = msg;
}
function handleKidForm(form) {
  const fd = new FormData(form);
  const id = fd.get('id');
  const name = String(fd.get('name') || '').trim();
  const sex = fd.get('sex') === 'girl' ? 'girl' : 'boy';
  const birth = String(fd.get('birth') || '');
  if (!name) return formError(form, 'Give them a name first.');
  if (!birth) return formError(form, 'Pick a birth date.');
  let kid = null;
  if (id) {
    kid = getKid(id);
    if (kid) { kid.name = name; kid.sex = sex; kid.birth = birth; kid.updatedAt = Date.now(); }
  } else {
    kid = { id: uid(), name: name, sex: sex, birth: birth, updatedAt: Date.now() };
    DB.kids.push(kid);
    view = { name: 'kid', kidId: kid.id, tab: 'weight' };
  }
  if (kid && photoDraft !== undefined) {
    if (photoDraft) PHOTOS[kid.id] = photoDraft; else delete PHOTOS[kid.id];
    savePhotos();
  }
  photoDraft = undefined;
  modal = null; saveDB(); scheduleSync(); render();
}
function handleMsrForm(form) {
  const fd = new FormData(form);
  const id = fd.get('id'), kidId = fd.get('kidId');
  const kid = getKid(kidId);
  if (!kid) return;
  const date = String(fd.get('date') || '');
  const w = parseNum(fd.get('weight')), l = parseNum(fd.get('length')), h = parseNum(fd.get('head'));
  if (!date) return formError(form, 'Pick a date.');
  const anyTyped = String(fd.get('weight') || '').trim() || String(fd.get('length') || '').trim() || String(fd.get('head') || '').trim();
  if (!anyTyped) return formError(form, 'Enter at least one measurement.');
  if ((w == null && String(fd.get('weight') || '').trim()) || w !== w ||
      (l == null && String(fd.get('length') || '').trim()) || l !== l ||
      (h == null && String(fd.get('head') || '').trim()) || h !== h)
    return formError(form, "Couldn't read those numbers — use digits like 8.4.");
  const rec = {
    weightKg: w == null ? null : toKg(w, fd.get('weightUnit')),
    lengthCm: l == null ? null : toCm(l, fd.get('lengthUnit')),
    headCm: h == null ? null : toCm(h, fd.get('headUnit'))
  };
  if (id) {
    const m = DB.measurements.find(function (x) { return x.id === id; });
    if (m) { m.date = date; m.weightKg = rec.weightKg; m.lengthCm = rec.lengthCm; m.headCm = rec.headCm; m.updatedAt = Date.now(); }
  } else {
    DB.measurements.push({ id: uid(), kidId: kidId, date: date,
      weightKg: rec.weightKg, lengthCm: rec.lengthCm, headCm: rec.headCm, updatedAt: Date.now() });
  }
  modal = null; saveDB(); scheduleSync(); render();
}

/* ---------------- actions ---------------- */
const Actions = {
  'nav-kids': function () { view = { name: 'kids' }; render(); },
  'nav-kid': function (d) { view = { name: 'kid', kidId: d.id, tab: 'weight' }; render(); window.scrollTo(0, 0); },
  'cycle-kid': function () {
    const ids = DB.kids.map(function (k) { return k.id; });
    view.kidId = ids[(ids.indexOf(view.kidId) + 1) % ids.length];
    view.selectedId = null;
    view.showAllMsr = false;
    render();
    window.scrollTo(0, 0);
  },
  'nav-settings': function () { view = { name: 'settings' }; render(); window.scrollTo(0, 0); },
  'open-kid-modal': function (d) { photoDraft = undefined; modal = { type: 'kid', kidId: d.id || null }; render(); },
  'open-msr-modal': function (d) { modal = { type: 'msr', kidId: d.kid, msrId: d.id || null }; render(); },
  'close-modal': function () { photoDraft = undefined; modal = null; render(); },
  'backdrop': function (d, el, e) { if (e.target === el) { photoDraft = undefined; modal = null; render(); } },
  'remove-photo': function () { photoDraft = null; updatePhotoPreview(); },
  'set-tab': function (d) { view.tab = d.ind; view.selectedId = null; render(); },
  'select-point': function (d) {
    view.selectedId = view.selectedId === d.id ? null : d.id;
    render();
  },
  'toggle-msr-list': function () {
    view.showAllMsr = !view.showAllMsr;
    render();
    if (!view.showAllMsr) {
      const el = document.getElementById('msr-head');
      if (el && el.scrollIntoView) el.scrollIntoView();
    }
  },
  'set-units': function (d) { DB.units = d.v === 'metric' ? 'metric' : 'imperial'; saveDB(); render(); },
  'set-input-unit': function (d, el) {
    const form = el.closest('form');
    const input = form.elements[d.field];
    const unit = form.elements[d.field + 'Unit'];
    if (unit.value === d.v) return;
    const value = parseNum(input.value);
    if (value != null && isFinite(value)) {
      const metric = d.field === 'weight' ? toKg(value, unit.value) : toCm(value, unit.value);
      const converted = d.v === 'lb' ? metric * 2.20462 : d.v === 'in' ? metric / 2.54 : metric;
      input.value = String(Number(converted.toPrecision(12)));
    }
    unit.value = d.v;
    form.querySelectorAll('[data-action="set-input-unit"][data-field="' + d.field + '"]').forEach(function (button) {
      const active = button.dataset.v === d.v;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  },
  'delete-kid': function (d) {
    const k = getKid(d.id);
    if (!k) return;
    if (!confirm('Delete ' + k.name + ' and all their measurements? This can\'t be undone.')) return;
    const now = Date.now();
    DB.deleted.push({ id: k.id, updatedAt: now });
    DB.measurements.forEach(function (m) {
      if (m.kidId === d.id) DB.deleted.push({ id: m.id, updatedAt: now });
    });
    DB.kids = DB.kids.filter(function (x) { return x.id !== d.id; });
    DB.measurements = DB.measurements.filter(function (x) { return x.kidId !== d.id; });
    prunePhotos();
    modal = null; view = { name: 'kids' }; saveDB(); scheduleSync(); render();
  },
  'delete-msr': function (d) {
    if (!confirm('Delete this measurement?')) return;
    DB.deleted.push({ id: d.id, updatedAt: Date.now() });
    DB.measurements = DB.measurements.filter(function (x) { return x.id !== d.id; });
    modal = null; saveDB(); scheduleSync(); render();
  },
  'export': function () {
    const blob = new Blob([exportNaraCSV()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sprout-export-' + todayStr() + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  },
  'sync-enable': function () {
    SYNC.key = genSyncKey(); SYNC.lastSyncedAt = 0; saveSync();
    render();
    syncNow().then(function () { render(); });
  },
  'sync-join': function () {
    const input = document.querySelector('[data-sync-code]');
    const code = ((input && input.value) || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{8,64}$/.test(code)) { syncErr('Enter the code from your other device.'); return; }
    SYNC.key = code; SYNC.lastSyncedAt = 0; saveSync();
    render();
    syncNow().then(function (ok) {
      if (!ok) {
        SYNC.key = null; saveSync(); render();
        syncErr('Could not find that code. Check it and try again.');
      } else { render(); }
    });
  },
  'sync-copy': function () {
    const done = function () { syncNote = 'Code copied.'; render(); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(SYNC.key).then(done, function () { syncErr('Copy failed — long-press the code to copy it.'); });
    } else { syncErr('Long-press the code to copy it.'); }
  },
  'sync-now': function () { syncNow().then(function () { render(); }); },
  'sync-disable': function () {
    if (!confirm('Disable sync on this device? Your local data stays.')) return;
    SYNC.key = null; SYNC.lastSyncedAt = 0; syncNote = ''; saveSync();
    render();
  }
};

function handleImport(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = function () {
    try {
      const res = importNaraCSV(String(r.result));
      saveDB(); scheduleSync(); view = { name: 'kids' }; render();
      const parts = [];
      if (res.created) parts.push(res.created + ' new');
      if (res.updated) parts.push(res.updated + ' updated');
      let msg = parts.length
        ? 'Imported ' + parts.join(' and ') + ' measurement' + (res.created + res.updated === 1 ? '' : 's') + '.'
        : 'No growth measurements found to import.';
      if (res.unmatched.length) {
        msg += ' No matching child for: ' + res.unmatched.join(', ') + ' — add them first, then import again.';
      } else if (res.skipped) {
        msg += ' Skipped ' + res.skipped + ' row' + (res.skipped === 1 ? '' : 's') + ' with no usable growth data.';
      }
      alert(msg);
    } catch (e) { alert("Couldn't read that file — is it a Nara Baby CSV export?"); }
    input.value = '';
  };
  r.readAsText(f);
}

/* ---------------- boot ---------------- */
if (typeof document !== 'undefined') {
  DB = loadDB();
  SYNC = loadSync();
  PHOTOS = loadPhotos();
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = Actions[el.dataset.action];
    if (fn) {
      if (el.tagName === 'A') e.preventDefault();
      fn(el.dataset, el, e);
    }
  });
  document.addEventListener('submit', function (e) {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'kid') handleKidForm(form);
    else if (form.dataset.form === 'msr') handleMsrForm(form);
  });
  document.addEventListener('change', function (e) {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    if (el.dataset.change === 'import') handleImport(el);
    else if (el.dataset.change === 'photo') handlePhotoInput(el);
    else if (el.dataset.change === 'msr-date') {
      const kidId = (document.querySelector('input[name="kidId"]') || {}).value;
      const kid = kidId && getKid(kidId);
      const ageEl = document.querySelector('[data-age]');
      if (kid && ageEl && el.value) {
        const d = ageDays(kid.birth, el.value);
        ageEl.textContent = 'Age on this date: ' + ageString(kid.birth, el.value);
      }
    }
  });
  document.addEventListener('DOMContentLoaded', function () {
    render();
    if (SYNC.key) syncNow(); // catch up with other devices on launch
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && SYNC.key && Date.now() - SYNC.lastSyncedAt > 60000) syncNow();
  });
  // Was offline (doctor's office, dead zone): push the moment we're back.
  window.addEventListener('online', function () {
    if (needsSyncRetry()) syncNow();
  });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // Don't wait for the 24h update throttle — check for a new version now.
        if (reg && reg.update) reg.update();
      }).catch(function () {});
      // A new service worker just took over: reload once so the new code runs.
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (hadController && !modal) window.location.reload();
      });
    });
  }
}
