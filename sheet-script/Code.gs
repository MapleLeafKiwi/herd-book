/**
 * Herd Book sync — one script for every ranch.
 *
 * Setup (once):
 *   1. Make a Google Sheet called "Herd Book admin". Extensions › Apps Script. Replace everything with this file.
 *      Set SIGNUP_CODE below, then Save.
 *   2. Deploy › New deployment › gear › Web app.  Execute as: Me   Who has access: Anyone.  Deploy, allow access,
 *      copy the Web app URL.
 *
 * Sharing: each ranch has a full-access code (sees prices) and a crew code (never sees prices). The app's Share
 *   button hands out either. Prices are removed here, before data leaves the sheet, so crew phones never get them.
 *
 * Running it:
 *   - Ranches sign themselves up in the app with the sign-up code. Each ranch gets its own Google Sheet in your Drive
 *     and a row in the "Ranches" tab of this sheet. Untick "Active" on a row to switch that ranch off.
 *   - After editing this file: Deploy › Manage deployments › pencil › Version: New version › Deploy (same URL).
 */
const SIGNUP_CODE = 'CHANGE-ME';   // give this only to people allowed to start a ranch
const NEW_RANCHES_ACTIVE = true;        // false = new ranches wait until you tick "Active" in the Ranches tab

const TABS = { animals: 'Animals', exposures: 'Bull exposures', collars: 'Collars', history: 'Change log' };
const ORDER = {
  animals:   ['id','collar','kind','group','brand1','brand2','collarOn','notes','purchasePrice','purchaseDate','salePrice','saleDate','createdAt','updatedAt','updatedBy'],
  exposures: ['id','bullId','group','cowIds','start','end','note','updatedAt','updatedBy'],
  collars:   ['id','number','status','note','createdAt','updatedAt','updatedBy'],
  history:   ['id','at','by','action','text','targetType','targetId','changes']
};
const NUM  = ['purchasePrice','salePrice','createdAt','updatedAt','at','_rev'];
const BOOL = ['collarOn','_deleted'];
const JSONF = ['cowIds','changes'];
const RANCH_HEAD = ['Ranch', 'Ranch code', 'Crew code', 'Active', 'Sheet', 'Started by', 'Started', 'Sheet ID'];
// Crew phones (crew code) never receive or change these.
const FIN = ['purchasePrice', 'purchaseDate', 'salePrice', 'saleDate'];
const WORDS = ['tag','calf','bale','gate','chute','creek','range','ridge','corral','spur','prairie','hay','brand','rope','yard','herd','bull','heifer','saddle','fence','cedar','willow','aspen','badger','coulee','butte','sage','stone','river','meadow'];

function doGet() { return out_({ ok: true, app: 'Herd Book sync' }); }

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad_request' }); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return out_({ ok: false, error: 'busy' });
  try {
    if (body.action === 'createRanch') return out_(createRanch_(body));
    if (body.action === 'resetCrewCode') return out_(resetCrewCode_(body));
    return out_(sync_(body));
  } finally {
    lock.releaseLock();
  }
}

// ---------- ranches ----------
function ranchesSheet_() {
  const admin = SpreadsheetApp.getActiveSpreadsheet();
  let sh = admin.getSheetByName('Ranches');
  if (!sh) {
    sh = admin.insertSheet('Ranches', 0);
    sh.getRange(1, 1, 1, RANCH_HEAD.length).setValues([RANCH_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function ranches_() {
  const sh = ranchesSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, RANCH_HEAD.length).getValues().map((r, i) => ({
    row: i + 2, name: String(r[0]), code: String(r[1]).trim().toLowerCase(), crew: String(r[2]).trim().toLowerCase(),
    active: r[3] === true || String(r[3]).toLowerCase() === 'true', sheetId: String(r[7])
  })).filter(r => r.code);
}
function createRanch_(body) {
  if (String(body.signup || '').trim().toLowerCase() !== SIGNUP_CODE.toLowerCase()) return { ok: false, error: 'bad_signup' };
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'no_name' };
  const code = newCode_(), crew = newCode_([code]);
  const ss = SpreadsheetApp.create('Herd Book – ' + name);
  Object.keys(TABS).forEach(col => load_(ss, col));
  const blank = ss.getSheetByName('Sheet1'); if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
  const sh = ranchesSheet_(), row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, RANCH_HEAD.length).setValues([[name, code, crew, NEW_RANCHES_ACTIVE, ss.getUrl(), String(body.by || ''), new Date(), ss.getId()]]);
  sh.getRange(row, 4).insertCheckboxes();
  if (NEW_RANCHES_ACTIVE) sh.getRange(row, 4).setValue(true);
  return { ok: true, code: code, crewCode: crew, role: 'full', ranch: name, active: NEW_RANCHES_ACTIVE };
}
function newCode_(also) {
  const taken = {}; (also || []).forEach(c => taken[c] = true);
  ranches_().forEach(r => { taken[r.code] = true; if (r.crew) taken[r.crew] = true; });
  let c;
  do { c = pick_() + '-' + pick_() + '-' + (100 + Math.floor(Math.random() * 900)); } while (taken[c]);
  return c;
}
function resetCrewCode_(body) {
  const code = String(body.code || '').trim().toLowerCase();
  const ranch = ranches_().filter(r => r.code === code)[0];
  if (!ranch) return { ok: false, error: 'bad_code' };          // only full-access phones can do this
  const crew = newCode_();
  ranchesSheet_().getRange(ranch.row, 3).setValue(crew);
  return { ok: true, crewCode: crew };
}
function lookup_(code) {
  code = String(code || '').trim().toLowerCase();
  if (!code) return null;
  const all = ranches_();
  for (let i = 0; i < all.length; i++) {
    if (all[i].code === code) return { ranch: all[i], role: 'full' };
    if (all[i].crew && all[i].crew === code) return { ranch: all[i], role: 'crew' };
  }
  return null;
}
// Remove prices from everything a crew phone receives.
function forCrew_(col, o) {
  if (col === 'animals') {
    o.sold = !!(o.saleDate || (o.salePrice !== '' && o.salePrice != null));
    FIN.forEach(k => delete o[k]);
  } else if (col === 'history') {
    const had = (o.changes || []).length;
    o.changes = (o.changes || []).filter(c => FIN.indexOf(c.f) < 0);
    if (had && !o.changes.length) return null;                  // a price-only edit: crew don't see it at all
  }
  return o;
}
function pick_() { return WORDS[Math.floor(Math.random() * WORDS.length)]; }

// ---------- sync ----------
function sync_(body) {
  const found = lookup_(body.code);
  if (!found) return { ok: false, error: 'bad_code' };
  const ranch = found.ranch, crew = found.role === 'crew';
  if (!ranch.active) return { ok: false, error: 'ranch_off', ranch: ranch.name };
  const ss = SpreadsheetApp.openById(ranch.sheetId);
  const props = PropertiesService.getScriptProperties();
  const revKey = 'rev:' + ranch.sheetId;
  const tables = {};
  const table = col => tables[col] || (tables[col] = load_(ss, col));
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const conflicts = [];
  let rev = Number(props.getProperty(revKey) || 0);

  if (ops.length) {
    rev = Math.max(Date.now(), rev + 1);
    ops.forEach(op => {
      if (!op || !TABS[op.col] || !op.id) return;
      if (crew) {                                              // crew can't change prices, even by crafting a request
        [op.patch, op.base].forEach(o => { if (o && typeof o === 'object') { FIN.forEach(k => delete o[k]); delete o.sold; } });
        if (op.col === 'history' && op.patch && Array.isArray(op.patch.changes)) op.patch.changes = op.patch.changes.filter(c => c && FIN.indexOf(c.f) < 0);
      }
      apply_(table(op.col), op, rev, conflicts, crew);
    });
    Object.keys(tables).forEach(k => save_(tables[k]));
    props.setProperty(revKey, String(rev));
  }

  const since = Number(body.since) || 0;
  const changes = {};
  Object.keys(TABS).forEach(col => {
    let rows = table(col).rows.filter(r => Number(r._rev) > since);
    if (col === 'history' && rows.length > 500) rows = rows.slice(-500);
    changes[col] = rows.map(decode_);
    if (crew) changes[col] = changes[col].map(o => forCrew_(col, o)).filter(Boolean);
  });
  const out = { ok: true, ranch: ranch.name, role: found.role, rev: rev, changes: changes,
    conflicts: crew ? conflicts.filter(c => FIN.indexOf(c.field) < 0) : conflicts };
  if (!crew) {
    let crewCode = ranch.crew;
    if (!crewCode) { crewCode = newCode_(); ranchesSheet_().getRange(ranch.row, 3).setValue(crewCode); }
    out.crewCode = crewCode;
  }
  return out;
}

function load_(ss, col) {
  let sh = ss.getSheetByName(TABS[col]);
  if (!sh) {
    sh = ss.insertSheet(TABS[col]);
    const h = ORDER[col].concat(['_rev', '_deleted']);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  const vals = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  const header = vals[0].map(String).filter(h => h !== '');
  const t = { sh: sh, col: col, header: header, headerChanged: false, rows: [], idx: {}, changed: false, appended: [] };
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][0] === '' || vals[i][0] == null) continue;
    const r = {};
    header.forEach((h, j) => r[h] = vals[i][j]);
    r.id = String(r.id);
    t.idx[r.id] = t.rows.length;
    t.rows.push(r);
  }
  return t;
}

// Compare two cell values the way the app means them (so 2450 == "2450", "" == false for checkboxes).
function norm_(k, v) {
  if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (BOOL.indexOf(k) >= 0) return String(v).toLowerCase() === 'true' ? 'true' : 'false';
  if (v == null || v === '') return '';
  if (NUM.indexOf(k) >= 0) return String(Number(v));
  return String(v);
}

function apply_(t, op, rev, conflicts, crew) {
  const id = String(op.id);
  const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
  if (t.col === 'history') {
    if (t.idx[id] !== undefined) return;                       // already logged (resent after a dropped reply)
    const r = { id: id };
    Object.keys(patch).forEach(k => { if (k !== 'id' && k.charAt(0) !== '_') r[k] = enc_(patch[k]); });
    r._rev = rev; r._deleted = 'false';
    addCols_(t, r);
    t.idx[id] = t.rows.length; t.rows.push(r); t.appended.push(r);
    return;
  }
  let r;
  if (t.idx[id] === undefined) {
    if (op.del) return;
    r = { id: id }; t.idx[id] = t.rows.length; t.rows.push(r);
  } else {
    r = t.rows[t.idx[id]];
    if (String(r._deleted) === 'true' && !op.create) {         // another phone deleted it first: tell this phone
      if (!op.del) conflicts.push({ col: t.col, id: id, type: 'deleted', by: String(r.updatedBy || ''), at: Number(r.updatedAt) || '' });
      return;
    }
  }
  if (op.create) Object.keys(r).forEach(k => { if (k !== 'id' && !(crew && FIN.indexOf(k) >= 0)) r[k] = ''; });
  if (op.del) {
    r._deleted = 'true';
  } else {
    const base = op.base && typeof op.base === 'object' && !op.create ? op.base : null;
    const meta = {}; let applied = 0, wanted = 0;
    Object.keys(patch).forEach(k => {
      if (k === 'id' || k.charAt(0) === '_') return;
      if (k === 'updatedAt' || k === 'updatedBy' || k === 'createdAt') { meta[k] = patch[k]; return; }
      wanted++;
      if (base && Object.prototype.hasOwnProperty.call(base, k)) {
        const cur = norm_(k, r[k]), was = norm_(k, enc_(base[k])), want = norm_(k, enc_(patch[k]));
        if (cur !== was && cur !== want) {                     // someone else changed this field since this phone last synced
          const o = {}; o[k] = r[k];
          conflicts.push({ col: t.col, id: id, type: 'field', field: k, mine: patch[k], theirs: decode_(o)[k], by: String(r.updatedBy || ''), at: Number(r.updatedAt) || '' });
          return;
        }
      }
      r[k] = enc_(patch[k]); applied++;
    });
    if (wanted && !applied && !op.create) return;               // every field clashed: leave the row as it is
    Object.keys(meta).forEach(k => r[k] = enc_(meta[k]));
    r._deleted = 'false';
  }
  r._rev = rev;
  addCols_(t, r);
  t.changed = true;
}

function addCols_(t, r) {
  Object.keys(r).forEach(k => {
    if (t.header.indexOf(k) < 0) {
      const at = t.header.indexOf('_rev');
      if (k.charAt(0) !== '_' && at >= 0) t.header.splice(at, 0, k); else t.header.push(k);
      t.headerChanged = true;
    }
  });
}

function save_(t) {
  const sh = t.sh, h = t.header;
  if (t.headerChanged || t.changed) {
    const rows = [h].concat(t.rows.map(r => h.map(k => r[k] == null ? '' : r[k])));
    ensure_(sh, rows.length, h.length);
    const range = sh.getRange(1, 1, rows.length, h.length);
    range.setNumberFormat('@');
    range.setValues(rows.map(row => row.map(String)));
    sh.getRange(1, 1, 1, h.length).setFontWeight('bold');
  } else if (t.appended.length) {
    const start = sh.getLastRow() + 1;
    const rows = t.appended.map(r => h.map(k => r[k] == null ? '' : String(r[k])));
    ensure_(sh, start + rows.length - 1, h.length);
    const range = sh.getRange(start, 1, rows.length, h.length);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
}

function ensure_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

function enc_(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function decode_(r) {
  const o = {};
  Object.keys(r).forEach(k => {
    let v = r[k];
    if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (v == null) v = '';
    if (NUM.indexOf(k) >= 0) o[k] = v === '' ? '' : Number(v);
    else if (BOOL.indexOf(k) >= 0) o[k] = v === true || String(v).toLowerCase() === 'true';
    else if (JSONF.indexOf(k) >= 0) { try { o[k] = v === '' ? [] : JSON.parse(v); } catch (err) { o[k] = []; } }
    else o[k] = String(v);
  });
  return o;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
