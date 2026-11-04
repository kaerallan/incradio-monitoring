/**
 * Locale Proofs — Google Apps Script backend.
 *
 * Viewers like and comment on this week's YouTube video (or live broadcast), then send a
 * screenshot as proof. Each proof counts for one locale straight away; the admin can
 * reject fakes, which removes them from the count.
 *
 * Server-side rules for every proof:
 *   1. The locale is in TOWNS below (the page cannot add locales).
 *   2. It belongs to the current round (a "round" = one week / one link).
 *   3. The file really is a picture (JPEG/PNG/WebP), under MAX_IMAGE_BYTES.
 *   4. One counted proof per phone per round (a rejected proof can be replaced).
 *   5. The exact same screenshot can't be sent twice in a round.
 *
 * Screenshots are saved privately in the owner's Google Drive (one folder per round).
 * Nothing is ever deleted: starting a new round only starts the counts again at zero.
 *
 * Setup (see README.md for the full walkthrough):
 *   - Run setup() once from the editor.
 *   - Project Settings → Script properties → add ADMIN_PASSCODE (the admin page password).
 *   - Deploy → Web app → Execute as: Me, Who has access: Anyone.
 *
 * After editing this file, publish it with Deploy → Manage deployments → Edit →
 * Version: New version (keeps the same URL).
 */

// ===================== EDIT THESE =====================
const TOWNS = [
  'Bacnotan',
  'Balaoan',
  'Balballosa',
  'Ballogo',
  'Bangar',
  'Bangkusay',
  'Baraoas',
  'Carlatan',
  'Dangdangla',
  'Dar-aoan',
  'Dinanum',
  'Duplas Ext',
  'Guinabang',
  'Lipay Ext',
  'Lisqueb',
  'Luna',
  'Luzong Sur Ext',
  'Mameltac GWS',
  'Nagatiran',
  'Nagsabaran GWS',
  'Naguirangan',
  'Pagdalagan',
  'Pao-Balaoan',
  'Pao-San Fernando',
  'Paraoir',
  'San Fernando City',
  'San Juan',
  'San Pablo',
  'San Vicente',
  'Santiago Norte',
  'Santol Ext',
  'Sudipen',
  'Tallipugo',
  'Tanqui',
];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// ======================================================

const PROOF_SHEET = 'Proofs';
const PROOF_HEADERS = ['Timestamp', 'Round', 'Locale', 'Status', 'Proof ID', 'Device ID', 'Image SHA-256', 'File ID', 'Device', 'Reviewed'];
const COL = { TIME: 0, ROUND: 1, TOWN: 2, STATUS: 3, ID: 4, DEVICE: 5, HASH: 6, FILE: 7, UA: 8, REVIEWED: 9 };
const NCOLS = PROOF_HEADERS.length;
const ROUND_SHEET = 'Rounds';
const ROUND_HEADERS = ['Round', 'Title', 'YouTube link', 'Video ID', 'Started', 'Ended'];
const STATS_CACHE_SECONDS = 15;
const ADMIN_MAX_FAILS = 10;           // wrong passcodes allowed per 10 minutes
const MIMES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// ---------------------------------------------------------------- entry points

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'stats';
  try {
    if (action === 'config') return json_({ ok: true, round: publicRound_(round_()), towns: TOWNS });
    if (action === 'stats') return statsResponse_();
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  try {
    if (p.action === 'submit') return json_(submit_(p));
    if (p.action === 'mine') return json_(mine_(p));
    if (p.action === 'admin') return json_(admin_(p));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------- viewers

function submit_(p) {
  const r = round_();
  if (!r.id) return { ok: false, error: 'The site is not set up yet.' };
  if (!r.videoId) return { ok: false, code: 'nolink', error: "This week's video link hasn't been set yet." };
  if (p.round !== r.id) return { ok: false, code: 'round', error: 'A new week has started. Please refresh the page.' };
  const town = String(p.town || '');
  if (TOWNS.indexOf(town) < 0) return { ok: false, error: 'Unknown locale.' };
  const device = id_(p.device, 64);
  if (device.length < 8) return { ok: false, error: 'Missing device id.' };
  const mime = String(p.mime || '');
  if (!MIMES[mime]) return { ok: false, code: 'type', error: 'Please send a picture (JPG or PNG).' };
  if (typeof p.image !== 'string' || p.image.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) {
    return { ok: false, code: 'size', error: 'That picture is too big.' };
  }
  let bytes;
  try { bytes = Utilities.base64Decode(p.image); } catch (err) { return { ok: false, code: 'type', error: 'Please send a picture (JPG or PNG).' }; }
  if (bytes.length < 500) return { ok: false, code: 'type', error: 'That picture looks empty.' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'size', error: 'That picture is too big.' };
  if (!magicOk_(bytes, mime)) return { ok: false, code: 'type', error: 'Please send a picture (JPG or PNG).' };
  const hash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));

  // Cheap check first, so obvious repeats never touch Drive.
  let dup = findDup_(r, device, hash);
  if (dup) return dup;

  const now = new Date();
  const proofId = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const name = r.id + '_' + town.replace(/[^\w-]+/g, '-') + '_' +
    Utilities.formatDate(now, 'UTC', "yyyyMMdd'T'HHmmss") + '_' + proofId + MIMES[mime];
  const file = roundFolder_(r).createFile(Utilities.newBlob(bytes, mime, name));

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { file.setTrashed(true); return { ok: false, code: 'busy', error: 'The server is busy. Please try again.' }; }
  try {
    const cur = round_();
    if (cur.id !== r.id) { file.setTrashed(true); return { ok: false, code: 'round', error: 'A new week has started. Please refresh the page.' }; }
    dup = findDup_(cur, device, hash);
    if (dup) { file.setTrashed(true); return dup; }
    proofSheet_().appendRow([now, r.id, "'" + town, 'counted', "'" + proofId, "'" + device, "'" + hash,
      "'" + file.getId(), "'" + String(p.ua || '').slice(0, 200), '']);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('stats');
  return { ok: true, town: town, proofId: proofId, round: r.id };
}

/** What has this phone sent in the current round? */
function mine_(p) {
  const r = round_();
  const device = id_(p.device, 64);
  if (!r.id || device.length < 8) return { ok: true, round: r.id, status: 'none' };
  const rows = roundRows_(r);
  let last = null;
  for (let i = 0; i < rows.length; i++) if (rows[i][COL.DEVICE] === device) last = rows[i];
  if (!last) return { ok: true, round: r.id, status: 'none' };
  return { ok: true, round: r.id, status: last[COL.STATUS], town: last[COL.TOWN] };
}

function findDup_(r, device, hash) {
  const rows = roundRows_(r);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][COL.HASH] === hash) return { ok: false, code: 'dupimage', error: 'This screenshot was already sent.' };
    if (rows[i][COL.DEVICE] === device && rows[i][COL.STATUS] !== 'rejected') {
      return { ok: false, code: 'already', town: rows[i][COL.TOWN], error: 'This phone already sent a proof this week.' };
    }
  }
  return null;
}

function statsResponse_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('stats');
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const r = round_();
  const counts = {};
  TOWNS.forEach(function (t) { counts[t] = 0; });
  let total = 0;
  roundRows_(r).forEach(function (row) {
    if (row[COL.STATUS] !== 'rejected' && counts.hasOwnProperty(row[COL.TOWN])) { counts[row[COL.TOWN]]++; total++; }
  });
  const towns = TOWNS.map(function (t) { return { town: t, count: counts[t] }; })
    .sort(function (a, b) { return b.count - a.count || a.town.localeCompare(b.town); });
  const body = JSON.stringify({ ok: true, round: publicRound_(r), total: total, towns: towns, updated: new Date().toISOString() });
  try { cache.put('stats', body, STATS_CACHE_SECONDS); } catch (err) { /* too big to cache */ }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- admin

function admin_(p) {
  const props = PropertiesService.getScriptProperties();
  const pass = props.getProperty('ADMIN_PASSCODE');
  if (!pass) return { ok: false, code: 'nopass', error: 'The owner must set ADMIN_PASSCODE first (Apps Script → Project Settings → Script properties).' };
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('admin_fails') || 0);
  if (fails >= ADMIN_MAX_FAILS) return { ok: false, code: 'locked', error: 'Too many wrong passcodes. Try again in 10 minutes.' };
  if (typeof p.pass !== 'string' || !safeEqual_(hashStr_(p.pass), hashStr_(pass))) {
    cache.put('admin_fails', String(fails + 1), 600);
    return { ok: false, code: 'auth', error: 'Wrong passcode.' };
  }

  switch (p.op) {
    case 'state': return adminState_();
    case 'rows': return { ok: true, round: String(p.round || ''), rows: adminRows_(String(p.round || '')) };
    case 'image': return adminImage_(String(p.id || ''));
    case 'setStatus': return adminSetStatus_(String(p.id || ''), p.status);
    case 'setLink': return adminSetLink_(p.link, p.title);
    case 'newRound': return adminNewRound_(p.link, p.title);
    case 'check': return { ok: true };
  }
  return { ok: false, error: 'unknown admin op' };
}

function adminState_() {
  const r = round_();
  const counted = {}, rejected = {};
  TOWNS.forEach(function (t) { counted[t] = 0; rejected[t] = 0; });
  roundRows_(r).forEach(function (row) {
    const t = row[COL.TOWN];
    if (!counted.hasOwnProperty(t)) return;
    if (row[COL.STATUS] === 'rejected') rejected[t]++; else counted[t]++;
  });
  const rounds = [];
  const rs = roundSheet_();
  if (rs.getLastRow() > 1) {
    rs.getRange(2, 1, rs.getLastRow() - 1, ROUND_HEADERS.length).getValues().forEach(function (v) {
      rounds.push({ id: String(v[0]), title: String(v[1]), link: String(v[2]), videoId: String(v[3]), started: iso_(v[4]), ended: iso_(v[5]) });
    });
  }
  const folderId = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  return {
    ok: true,
    round: publicRound_(r),
    rounds: rounds.reverse(),
    towns: TOWNS.map(function (t) { return { town: t, counted: counted[t], rejected: rejected[t] }; }),
    folderUrl: folderId ? 'https://drive.google.com/drive/folders/' + folderId : '',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'),
  };
}

function adminRows_(roundId) {
  const sh = proofSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, NCOLS).getValues()
    .filter(function (v) { return String(v[COL.ROUND]) === roundId; })
    .map(function (v) {
      return {
        id: String(v[COL.ID]), time: iso_(v[COL.TIME]), town: String(v[COL.TOWN]), status: String(v[COL.STATUS]),
        device: String(v[COL.DEVICE]).slice(0, 8), fileId: String(v[COL.FILE]), reviewed: iso_(v[COL.REVIEWED]),
      };
    });
}

/** Returns a screenshot, but only one that this site saved (looked up by proof id). */
function adminImage_(proofId) {
  const found = findProof_(proofId);
  if (!found) return { ok: false, error: 'No such proof.' };
  const blob = DriveApp.getFileById(String(found.values[COL.FILE])).getBlob();
  return { ok: true, id: proofId, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function adminSetStatus_(proofId, status) {
  if (status !== 'rejected' && status !== 'counted') return { ok: false, error: 'bad status' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, code: 'busy', error: 'The server is busy. Please try again.' };
  try {
    const found = findProof_(proofId);
    if (!found) return { ok: false, error: 'No such proof.' };
    if (status === 'counted') {
      // Restoring must not give one phone two counted proofs in the same round.
      const v = found.values;
      const rows = proofSheet_().getRange(2, 1, proofSheet_().getLastRow() - 1, NCOLS).getValues();
      for (let i = 0; i < rows.length; i++) {
        if (i + 2 !== found.row && rows[i][COL.ROUND] === v[COL.ROUND] && rows[i][COL.DEVICE] === v[COL.DEVICE] &&
            rows[i][COL.STATUS] !== 'rejected') {
          return { ok: false, error: 'This phone already has another counted proof in this round. Reject that one first.' };
        }
      }
    }
    const sh = proofSheet_();
    sh.getRange(found.row, COL.STATUS + 1).setValue(status);
    sh.getRange(found.row, COL.REVIEWED + 1).setValue(new Date());
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('stats');
  return { ok: true, id: proofId, status: status };
}

/** Fix or change this round's link without touching the counts. */
function adminSetLink_(link, title) {
  const v = parseVideo_(link);
  if (!v) return { ok: false, error: 'That doesn\'t look like a YouTube link.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    const r = round_();
    const t = cleanTitle_(title) || r.title;
    props.setProperty('ROUND_LINK', v.link);
    props.setProperty('ROUND_VIDEO', v.id);
    props.setProperty('ROUND_TITLE', t);
    const rs = roundSheet_();
    if (rs.getLastRow() > 1) {
      const ids = rs.getRange(2, 1, rs.getLastRow() - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === r.id) { rs.getRange(i + 2, 2, 1, 3).setValues([[t, v.link, v.id]]); break; }
      }
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('stats');
  return { ok: true, round: publicRound_(round_()) };
}

/** Start a new round: counts start again at zero. Older rounds stay in the sheet and Drive. */
function adminNewRound_(link, title) {
  const v = parseVideo_(link);
  if (!v) return { ok: false, error: 'That doesn\'t look like a YouTube link.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    startRound_(v, cleanTitle_(title));
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('stats');
  return { ok: true, round: publicRound_(round_()) };
}

function startRound_(v, title) {
  const props = PropertiesService.getScriptProperties();
  const rs = roundSheet_();
  const old = props.getProperty('ROUND_ID');
  const now = new Date();
  if (old && rs.getLastRow() > 1) {
    const ids = rs.getRange(2, 1, rs.getLastRow() - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === old) { rs.getRange(i + 2, 6).setValue(now); break; }
    }
  }
  const no = Number(props.getProperty('ROUND_NO') || 0) + 1;
  const id = 'R' + no;
  const t = title || ('Round ' + no);
  const folder = rootFolder_().createFolder(id + ' ' + t);
  rs.appendRow(["'" + id, "'" + t, "'" + (v ? v.link : ''), "'" + (v ? v.id : ''), now, '']);
  props.setProperty('ROUND_NO', String(no));
  props.setProperty('ROUND_ID', id);
  props.setProperty('ROUND_TITLE', t);
  props.setProperty('ROUND_LINK', v ? v.link : '');
  props.setProperty('ROUND_VIDEO', v ? v.id : '');
  props.setProperty('ROUND_STARTED', now.toISOString());
  props.setProperty('ROUND_START_ROW', String(proofSheet_().getLastRow() + 1));
  props.setProperty('ROUND_FOLDER_ID', folder.getId());
  SpreadsheetApp.flush();
}

// ---------------------------------------------------------------- one-time setup

/** Run this once from the Apps Script editor (select "setup" → Run). */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Google Sheet (Extensions → Apps Script) and run setup again.');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  proofSheet_();
  roundSheet_();
  rootFolder_();
  if (!props.getProperty('ROUND_ID')) startRound_(null, 'Round 1');
  console.log('Setup done. Now add ADMIN_PASSCODE under Project Settings → Script properties, then deploy.');
}

// ---------------------------------------------------------------- helpers

function round_() {
  const p = PropertiesService.getScriptProperties();
  return {
    id: p.getProperty('ROUND_ID') || '',
    title: p.getProperty('ROUND_TITLE') || '',
    link: p.getProperty('ROUND_LINK') || '',
    videoId: p.getProperty('ROUND_VIDEO') || '',
    started: p.getProperty('ROUND_STARTED') || '',
    startRow: Number(p.getProperty('ROUND_START_ROW') || 2),
  };
}

function publicRound_(r) {
  return { id: r.id, title: r.title, link: r.link, videoId: r.videoId, started: r.started };
}

/** Rows of the current round (they are always appended after ROUND_START_ROW). */
function roundRows_(r) {
  if (!r.id) return [];
  const sh = proofSheet_();
  const start = Math.max(2, r.startRow);
  const last = sh.getLastRow();
  if (last < start) return [];
  return sh.getRange(start, 1, last - start + 1, NCOLS).getValues()
    .filter(function (v) { return String(v[COL.ROUND]) === r.id; });
}

function findProof_(proofId) {
  if (!/^[0-9a-f]{12}$/.test(proofId)) return null;
  const sh = proofSheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const ids = sh.getRange(2, COL.ID + 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === proofId) {
      return { row: i + 2, values: sh.getRange(i + 2, 1, 1, NCOLS).getValues()[0] };
    }
  }
  return null;
}

function parseVideo_(link) {
  const s = String(link || '').trim();
  let m = s.match(/(?:[?&]v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})(?![\w-])/);
  if (!m && /^[\w-]{11}$/.test(s)) m = [s, s];
  if (!m) return null;
  return { id: m[1], link: 'https://www.youtube.com/watch?v=' + m[1] };
}

function cleanTitle_(t) {
  return String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
}

function magicOk_(b, mime) {
  const u = function (i) { return b[i] & 255; };
  if (mime === 'image/jpeg') return u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF;
  if (mime === 'image/png') return u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47;
  if (mime === 'image/webp') return u(0) === 0x52 && u(1) === 0x49 && u(8) === 0x57 && u(9) === 0x45;
  return false;
}

function proofSheet_() { return sheetNamed_(PROOF_SHEET, PROOF_HEADERS); }
function roundSheet_() { return sheetNamed_(ROUND_SHEET, ROUND_HEADERS); }

function sheetNamed_(name, headers) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setup() once from the Apps Script editor.');
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const f = DriveApp.createFolder('Locale Proofs screenshots');
  props.setProperty('ROOT_FOLDER_ID', f.getId());
  return f;
}

function roundFolder_(r) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROUND_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const f = rootFolder_().createFolder(r.id + ' ' + r.title);
  props.setProperty('ROUND_FOLDER_ID', f.getId());
  return f;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function hashStr_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function iso_(v) {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v.toISOString === 'function') return v.toISOString();
  return v ? String(v) : '';
}

function id_(v, max) {
  return String(v == null ? '' : v).replace(/[^\w-]/g, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
