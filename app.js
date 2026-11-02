/* Kick Ass Timer */
'use strict';
const IS_PHONE = document.documentElement.classList.contains('phone');

// ---------------------------------------------------------------- time sync
// time.is has no public API and doesn't allow cross-site reads, so we do the
// same thing it does: measure this device's clock offset against internet
// time servers, compensating for network delay (NTP-style, best of N samples).
const SYNC_KEY = 'kat.sync.v1';
const RESYNC_MS = 5 * 60 * 1000;

function trimFrac(s) { return s.replace(/(\.\d{3})\d+/, '$1'); }

const SOURCES = [
  {
    name: 'timeapi.io',
    url: () => 'https://timeapi.io/api/time/current/zone?timeZone=UTC',
    read: async (r) => { const j = await r.json(); return Date.parse(trimFrac(j.dateTime) + 'Z'); },
  },
  {
    name: 'worldtimeapi.org',
    url: () => 'https://worldtimeapi.org/api/timezone/Etc/UTC',
    read: async (r) => { const j = await r.json(); return Date.parse(trimFrac(j.utc_datetime)); },
  },
  {
    // Fallback: HTTP Date header from the server hosting this app (1 s resolution).
    name: 'web server',
    coarse: true,
    url: () => 'version.txt?t=' + Math.random().toString(36).slice(2),
    method: 'HEAD',
    read: async (r) => { const d = r.headers.get('Date'); return d ? Date.parse(d) : NaN; },
  },
];

let sync = loadSync();

function loadSync() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_KEY));
    if (s && typeof s.offset === 'number') return Object.assign(s, { stale: true });
  } catch (e) {}
  return { offset: 0, unc: null, source: 'device clock', at: 0, stale: true };
}

function now() { return Date.now() + sync.offset; }

async function sample(src) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4000);
  try {
    const t0 = performance.now();
    const r = await fetch(src.url(), { method: src.method || 'GET', cache: 'no-store', signal: ctrl.signal });
    const t1 = performance.now();
    const devAtArrival = Date.now();
    if (!r.ok && !src.coarse) throw new Error('HTTP ' + r.status);
    const server = await src.read(r);
    if (!isFinite(server)) throw new Error('bad time');
    const rtt = t1 - t0;
    const offset = server - (devAtArrival - rtt / 2);
    const unc = rtt / 2 + (src.coarse ? 500 : 1);
    return { offset, unc, rtt };
  } finally { clearTimeout(to); }
}

// The Date header only has whole seconds, so true server time is in [D, D+1000).
// Intersecting that window over several staggered requests narrows it down a lot.
async function measureCoarse(src, n) {
  let lo = -Infinity, hi = Infinity, ok = 0;
  for (let i = 0; i < n; i++) {
    try {
      const t0 = performance.now();
      const r = await fetch(src.url(), { method: 'HEAD', cache: 'no-store' });
      const t1 = performance.now();
      const dev = Date.now() - (t1 - t0) / 2;
      const D = await src.read(r);
      if (!isFinite(D)) throw new Error('no Date');
      const half = (t1 - t0) / 2;
      lo = Math.max(lo, D - dev - half);
      hi = Math.min(hi, D + 1000 - dev + half);
      ok++;
    } catch (e) { if (i === 0) return null; }
    await new Promise((res) => setTimeout(res, 113 + Math.random() * 60));
  }
  if (!ok || lo > hi) return null;
  return { offset: (lo + hi) / 2, unc: (hi - lo) / 2, source: src.name };
}

async function measure(src, n) {
  if (src.coarse) return measureCoarse(src, n);
  let best = null;
  for (let i = 0; i < n; i++) {
    try {
      const s = await sample(src);
      if (!best || s.unc < best.unc) best = s;
    } catch (e) { if (i === 0) break; }
  }
  if (best) best.source = src.name;
  return best;
}

let syncing = null;
function doSync() {
  if (syncing) return syncing;
  renderSync('Syncing…');
  syncing = (async () => {
    const results = await Promise.all(SOURCES.map((s) => measure(s, s.coarse ? 10 : 4)));
    const good = results.filter(Boolean).sort((a, b) => a.unc - b.unc);
    if (good.length) {
      const b = good[0];
      sync = { offset: Math.round(b.offset), unc: Math.round(b.unc), source: b.source, at: Date.now(), stale: false };
      try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) {}
    } else {
      sync.stale = true;
    }
    renderSync();
  })().finally(() => { syncing = null; });
  return syncing;
}

function renderSync(msg) {
  const el = $('#syncStatus');
  el.classList.remove('ok', 'bad');
  let text;
  if (msg) text = msg;
  else if (!sync.at) { el.classList.add('bad'); text = 'Not synced: using device clock'; }
  else {
    const off = (sync.offset >= 0 ? '+' : '') + (sync.offset / 1000).toFixed(2) + ' s';
    text = `${sync.stale ? 'Offline, last sync' : 'Synced'} ±${sync.unc} ms · device ${off}`;
    if (!sync.stale) el.classList.add('ok');
  }
  el.querySelector('span').textContent = text;
  el.title = sync.at ? `Source: ${sync.source}, measured ${new Date(sync.at).toLocaleString()}` : '';
}

// ---------------------------------------------------------------- storage
const DATA_KEY = 'kat.data.v1';
let db = loadData();

function loadData() {
  try {
    const d = JSON.parse(localStorage.getItem(DATA_KEY));
    if (d && Array.isArray(d.scenarios)) return migrate(d);
  } catch (e) {}
  return { scenarios: [] };
}
let storageOk = true;
function save() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(db)); storageOk = true; }
  catch (e) { storageOk = false; }
  const w = document.getElementById('storageWarn'); if (w) w.hidden = storageOk;
}
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const findScn = (id) => db.scenarios.find((s) => s.id === id);

// Data model: each scenario has sorties [{ id, start, end, edited }] (end null while running).
// Migrate the earlier format that stored separate start/stop events.
function migrate(d) {
 for (const s of d.scenarios) {
  if (!Array.isArray(s.sorties)) {
    s.sorties = [];
    let open = null;
    for (const e of (s.events || []).slice().sort((a, b) => a.t - b.t)) {
      if (e.type === 'start') { if (open) s.sorties.push(open); open = { id: e.id, start: e.t, end: null, edited: !!e.edited }; }
      else if (open) { open.end = e.t; open.edited = open.edited || !!e.edited; s.sorties.push(open); open = null; }
      else s.sorties.push({ id: e.id, start: null, end: e.t, edited: !!e.edited });
    }
    if (open) s.sorties.push(open);
  }
  delete s.events;
 }
 return d;
}
const sKey = (x) => (x.start != null ? x.start : x.end);
const sortSorties = (s) => s.sorties.sort((a, b) => sKey(a) - sKey(b));
const runningSortie = (s) => { for (let i = s.sorties.length - 1; i >= 0; i--) { const x = s.sorties[i]; if (x.start != null && x.end == null) return x; } return null; };

// ---------------------------------------------------------------- helpers
function $(q) { return document.querySelector(q); }
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtTime(t, ms = true) {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` + (ms ? '.' + pad(d.getMilliseconds(), 3) : '');
}
const fmtSec = (t) => (t == null ? '' : fmtTime(t, false));
function fmtDate(t) { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const s = ms / 1000;
  if (s < 60) return Math.floor(s) + 's';
  const m = Math.floor(s / 60), r = s - m * 60;
  if (m < 60) return `${m}:${pad(Math.floor(r))}`;
  return `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(Math.floor(r))}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let toastTimer;
function toast(msg, action) {
  $('#toastMsg').textContent = msg;
  const b = $('#toastBtn');
  b.hidden = !action;
  b.onclick = action ? () => { action(); $('#toast').hidden = true; } : null;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, action ? 5000 : 2500);
}

// ---------------------------------------------------------------- views
let current = null; // scenario id

function safeHistory(fn, url) { try { history[fn](null, '', url); } catch (e) {} }
function goHome() {
  if (location.hash) { try { history.back(); } catch (e) {} }
  setTimeout(() => { if (current) showHome(); }, 60);
}

function showHome() {
  current = null;
  $('#scenario').hidden = true; $('#home').hidden = false;
  if (location.hash) safeHistory('replaceState', location.pathname + location.search);
  renderHome();
}

function openScenario(id, push = true) {
  const s = findScn(id); if (!s) return showHome();
  current = id;
  $('#home').hidden = true; $('#scenario').hidden = false;
  if (push) safeHistory('pushState', '#s=' + encodeURIComponent(s.id));
  $('#scnTitle').textContent = 'Scenario ' + s.number;
  $('#remarks').value = s.remarks || '';
  renderScenario();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  window.scrollTo(0, 0);
  if (!IS_PHONE) setTimeout(() => { try { kbd.focus({ preventScroll: true }); } catch (e) {} }, 0);
}

function renderHome() {
  const list = $('#scenarioList');
  const items = [...db.scenarios].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  $('#emptyList').hidden = items.length > 0;
  list.innerHTML = items.map((s) => {
    const n = s.sorties.length;
    return `<li data-id="${esc(s.id)}"><span><span class="num">#${esc(s.number)}</span>${runningSortie(s) ? '<span class="badge">RUNNING</span>' : ''}</span>
      <span class="meta">${n} sortie${n === 1 ? '' : 's'}<br>${s.updated ? new Date(s.updated).toLocaleString() : ''}</span></li>`;
  }).join('');
}

function renderScenario() {
  const s = findScn(current); if (!s) return;
  sortSorties(s);
  const nt = runningSortie(s) ? 'stop' : 'start';
  $('#markBtn').className = 'mark ' + nt;
  $('#markLabel').textContent = nt.toUpperCase();
  $('#evCount').textContent = s.sorties.length ? `(${s.sorties.length})` : '';
  $('#emptyEvents').hidden = s.sorties.length > 0;
  $('#eventRows').innerHTML = s.sorties.map((x, i) => `<tr data-id="${esc(x.id)}">
      <td>${i + 1}${x.edited ? '<span class="edited" title="Edited manually">✎</span>' : ''}</td>
      <td class="time t-start">${fmtSec(x.start) || '–'}</td>
      <td class="time t-stop">${x.end != null ? fmtSec(x.end) : (x.start != null ? '<span class="live">running</span>' : '–')}</td>
      <td>${x.start != null && x.end != null ? fmtDur(x.end - x.start) : ''}</td>
      <td class="acts"><button class="ico" data-act="edit" aria-label="Edit">✏️</button><button class="ico" data-act="del" aria-label="Delete">🗑️</button></td>
    </tr>`).join('');
  tickRun();
}

function tickRun() {
  if (!current) return;
  const s = findScn(current); if (!s) return;
  const r = runningSortie(s);
  const el = $('#runInfo');
  if (r) {
    el.classList.add('running');
    el.textContent = `Sortie ${s.sorties.indexOf(r) + 1} running ${fmtDur(now() - r.start)}`;
  } else {
    el.classList.remove('running');
    el.textContent = `Next: start sortie ${s.sorties.length + 1}`;
  }
}

// ---------------------------------------------------------------- actions
function openOrCreate(numRaw) {
  const number = String(numRaw).trim();
  if (!number) return;
  let s = db.scenarios.find((x) => x.number === number);
  if (!s) {
    s = { id: uid(), number, remarks: '', sorties: [], created: now(), updated: now() };
    db.scenarios.push(s); save();
  }
  $('#scenarioInput').value = '';
  openScenario(s.id);
}

let lastMark = -1e9;
function mark() {
  const s = findScn(current); if (!s) return;
  const t = now();
  if (performance.now() - lastMark < 300) return; // guard against accidental double taps
  lastMark = performance.now();
  sortSorties(s);
  const r = runningSortie(s);
  let undo;
  if (r) { r.end = t; undo = () => { r.end = null; }; }
  else { const x = { id: uid(), start: t, end: null }; s.sorties.push(x); undo = () => { s.sorties = s.sorties.filter((y) => y !== x); }; }
  s.updated = Date.now(); save();
  renderScenario();
  const b = $('#markBtn'); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 120);
  if (navigator.vibrate) navigator.vibrate(r ? [30, 40, 30] : 40);
  toast(`${r ? 'STOP' : 'START'} at ${fmtSec(t)}`, () => { undo(); s.updated = Date.now(); save(); renderScenario(); });
}

function deleteSortie(id) {
  const s = findScn(current); if (!s) return;
  const idx = s.sorties.findIndex((x) => x.id === id); if (idx < 0) return;
  const [x] = s.sorties.splice(idx, 1); s.updated = Date.now(); save(); renderScenario();
  toast(`Deleted sortie ${idx + 1}`, () => { s.sorties.push(x); save(); renderScenario(); });
}

let editing = null; // sortie id, or 'new'
function openEdit(id) {
  const s = findScn(current); if (!s) return;
  let x;
  if (id === 'new') { x = { start: now(), end: null }; $('#editTitle').textContent = 'Add sortie'; }
  else { x = s.sorties.find((y) => y.id === id); if (!x) return; $('#editTitle').textContent = `Edit sortie ${s.sorties.indexOf(x) + 1}`; }
  editing = id;
  $('#editDate').value = fmtDate(x.start != null ? x.start : x.end);
  $('#editStart').value = fmtSec(x.start);
  $('#editEnd').value = fmtSec(x.end);
  $('#editErr').hidden = true;
  $('#editDlg').showModal();
}

// Parse "HH:MM[:SS]" on the chosen date. Returns undefined if invalid, null if empty.
function parseTime(str, dm) {
  str = str.trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return undefined;
  return new Date(+dm[1], +dm[2] - 1, +dm[3], +m[1], +m[2], +(m[3] || 0)).getTime();
}
// Keep the original (sub-second) value if the user didn't change the shown second.
const keep = (orig, t) => (orig != null && t != null && Math.floor(orig / 1000) === Math.floor(t / 1000) ? orig : t);

function saveEdit() {
  const s = findScn(current); if (!s) return false;
  const err = (msg) => { $('#editErr').textContent = msg; $('#editErr').hidden = false; return false; };
  const dm = $('#editDate').value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return err('Enter a valid date.');
  let start = parseTime($('#editStart').value, dm);
  let end = parseTime($('#editEnd').value, dm);
  if (start === undefined || end === undefined) return err('Times must look like 14:03:27');
  if (start == null && end == null) return err('Enter at least a start time.');
  if (start != null && end != null && end < start) end += 24 * 3600 * 1000; // crossed midnight
  if (editing === 'new') {
    s.sorties.push({ id: uid(), start, end, edited: true });
  } else {
    const x = s.sorties.find((y) => y.id === editing); if (!x) return true;
    start = keep(x.start, start); end = keep(x.end, end);
    if (start !== x.start || end !== x.end) {
      if (!x.orig) x.orig = { start: x.start, end: x.end };
      x.start = start; x.end = end; x.edited = true;
    }
  }
  s.updated = Date.now(); save(); renderScenario();
  return true;
}

// Two-tap confirm instead of confirm(), which some viewers block.
let delArmed = null;
function deleteScenario() {
  const s = findScn(current); if (!s) return;
  const b = $('#deleteScnBtn');
  if (delArmed !== s.id) {
    delArmed = s.id; b.classList.add('armed');
    b.textContent = `Tap again to delete scenario ${s.number} (${s.sorties.length} sorties)`;
    setTimeout(disarmDelete, 4000);
    return;
  }
  disarmDelete();
  db.scenarios = db.scenarios.filter((x) => x.id !== s.id); save();
  goHome();
}
function disarmDelete() { delArmed = null; const b = $('#deleteScnBtn'); b.classList.remove('armed'); b.textContent = 'Delete scenario'; }

// ---------------------------------------------------------------- CSV
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = (a) => a.map(csvCell).join(',');
// One row per sortie. The three sortie/hit columns are left empty to fill in later.
const CSV_HEAD = ['Scenario', 'Sortie', 'Start time', 'End time', 'Sortie start time', 'Hit time', 'Sortie end time', 'Remarks'];

function scenarioRows(s) {
  sortSorties(s);
  return s.sorties.map((x, i) => [s.number, i + 1, fmtSec(x.start), fmtSec(x.end), '', '', '', i === 0 ? (s.remarks || '') : '']);
}

function buildCsv(list) {
  const lines = [csvRow(CSV_HEAD)];
  for (const s of list) {
    const rows = scenarioRows(s);
    if (!rows.length) rows.push([s.number, '', '', '', '', '', '', s.remarks || '']);
    rows.forEach((r) => lines.push(csvRow(r)));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8 (e.g. Hebrew remarks)
}

async function deliver(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const mobile = IS_PHONE;
  if (mobile && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: 'text/csv' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const stamp = () => { const d = new Date(now()); return fmtDate(d) + '_' + pad(d.getHours()) + pad(d.getMinutes()); };
function exportScenario() {
  const s = findScn(current); if (!s) return;
  deliver(`scenario_${String(s.number).replace(/[^\w-]+/g, '_')}_${stamp()}.csv`, buildCsv([s]));
}
function exportAll() {
  if (!db.scenarios.length) return toast('Nothing to export yet.');
  const list = [...db.scenarios].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  deliver(`kick_ass_timer_all_${stamp()}.csv`, buildCsv(list));
}

// ---------------------------------------------------------------- wiring
// No <form> submit: sandboxed viewers (file previews, chat apps) silently block it.
$('#scenarioInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); openOrCreate($('#scenarioInput').value); }
});
$('#openBtn').addEventListener('click', () => openOrCreate($('#scenarioInput').value));
$('#scenarioList').addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) openScenario(li.dataset.id); });
$('#backBtn').addEventListener('click', goHome);
$('#markBtn').addEventListener('click', mark);
$('#exportBtn').addEventListener('click', exportScenario);
$('#exportAllBtn').addEventListener('click', exportAll);
$('#addEventBtn').addEventListener('click', () => openEdit('new'));
$('#deleteScnBtn').addEventListener('click', deleteScenario);
$('#clockBtn').addEventListener('click', () => doSync());
$('#eventRows').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('tr').dataset.id;
  if (b.dataset.act === 'edit') openEdit(id);
  else deleteSortie(id);
});
$('#editSave').addEventListener('click', () => { if (saveEdit()) $('#editDlg').close(); });
['#editStart', '#editEnd'].forEach((q) => $(q).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (saveEdit()) $('#editDlg').close(); } }));
$('#editCancel').addEventListener('click', () => $('#editDlg').close());

let remarksTimer;
$('#remarks').addEventListener('input', () => {
  const s = findScn(current); if (!s) return;
  s.remarks = $('#remarks').value; s.updated = Date.now();
  clearTimeout(remarksTimer);
  $('#remarksSaved').textContent = 'Saving…';
  remarksTimer = setTimeout(() => { save(); $('#remarksSaved').textContent = 'Saved automatically'; }, 300);
});
$('#remarks').addEventListener('blur', () => { clearTimeout(remarksTimer); save(); $('#remarksSaved').textContent = 'Saved automatically'; });

// Keyboard capture field. Phone soft keyboards only appear when a text field is
// focused, and Android keyboards often report every key as "Unidentified"
// (keyCode 229), so we also watch the field's content: if anything gets
// deleted, that was a Backspace.
const KBD_FILL = 'xxxxxxxxxxxxxxxxxxxx';
const kbd = $('#kbdCapture');
function resetKbd() {
  kbd.value = KBD_FILL;
  try { kbd.setSelectionRange(KBD_FILL.length, KBD_FILL.length); } catch (e) {}
}
resetKbd();
kbd.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' || e.keyCode === 8) {
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) mark();
    resetKbd();
  }
});
kbd.addEventListener('input', (e) => {
  const deleted = (e.inputType && e.inputType.startsWith('delete')) || kbd.value.length < KBD_FILL.length;
  if (deleted) mark();
  resetKbd();
});
['focus', 'click', 'select'].forEach((ev) => kbd.addEventListener(ev, () => setTimeout(resetKbd, 0)));
kbd.addEventListener('focus', () => { $('#kbdLabel').textContent = '✅ Ready: press Backspace to log'; });
kbd.addEventListener('blur', () => { $('#kbdLabel').textContent = '⌨️ Click here, then press Backspace to log'; });

// Backspace anywhere on the scenario screen also records (physical keyboards),
// unless typing in a field.
document.addEventListener('keydown', (e) => {
  if (IS_PHONE || !(e.key === 'Backspace' || e.keyCode === 8) || !current || $('#editDlg').open) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  if (e.repeat) return;
  mark();
});

window.addEventListener('popstate', route);
function route() {
  const m = location.hash.match(/^#s=(.+)$/);
  if (m && findScn(decodeURIComponent(m[1]))) openScenario(decodeURIComponent(m[1]), false);
  else showHome();
}

// Keep in step with other tabs on the same device.
window.addEventListener('storage', (e) => {
  if (e.key === DATA_KEY) { db = loadData(); current ? renderScenario() : renderHome(); }
});

// Clock
function frame() {
  $('#clock').textContent = fmtTime(now(), false) + '.' + Math.floor(new Date(now()).getMilliseconds() / 100);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(tickRun, 100);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - sync.at > 60 * 1000) doSync();
});
window.addEventListener('online', () => doSync());
setInterval(() => doSync(), RESYNC_MS);

// Install
let deferredPrompt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && location.protocol !== 'file:') $('#installCard').hidden = false;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null; $('#installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#installCard').hidden = true; });

try {
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
} catch (e) {}

renderSync();
save(); // probes storage, shows a warning if this viewer blocks it
route();
doSync();
