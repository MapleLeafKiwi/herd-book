/**
 * Herd Book sync — receives changes from every phone and keeps them in this Google Sheet.
 *
 * Setup (once):
 *   1. In the Google Sheet: Extensions › Apps Script. Delete what's there and paste this whole file. Save.
 *   2. Deploy › New deployment › type "Web app".
 *        Execute as: Me      Who has access: Anyone
 *      Deploy, allow access when Google asks, and copy the Web app URL.
 *   3. Put that URL in Herd Book (Log › Phone setup › Sync address).
 *
 * After editing this file later: Deploy › Manage deployments › edit (pencil) › Version: New version › Deploy.
 * That keeps the same URL.
 */
const FARM_CODE = 'CHANGE-ME';   // phones must send this code; change it here to lock old phones out

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

function doGet() { return out_({ ok: true, app: 'Herd Book sync' }); }

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad_request' }); }
  if (String(body.code || '') !== FARM_CODE) return out_({ ok: false, error: 'bad_code' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return out_({ ok: false, error: 'busy' });
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const props = PropertiesService.getScriptProperties();
    const tables = {};
    const table = col => tables[col] || (tables[col] = load_(ss, col));
    const ops = Array.isArray(body.ops) ? body.ops : [];
    let rev = Number(props.getProperty('rev') || 0);
    const conflicts = [];

    if (ops.length) {
      rev = Math.max(Date.now(), rev + 1);
      ops.forEach(op => { if (op && TABS[op.col] && op.id) apply_(table(op.col), op, rev, conflicts); });
      Object.keys(tables).forEach(k => save_(tables[k]));
      props.setProperty('rev', String(rev));
    }

    const since = Number(body.since) || 0;
    const changes = {};
    Object.keys(TABS).forEach(col => {
      let rows = table(col).rows.filter(r => Number(r._rev) > since);
      if (col === 'history' && rows.length > 500) rows = rows.slice(-500);
      changes[col] = rows.map(decode_);
    });
    return out_({ ok: true, rev: rev, changes: changes, conflicts: conflicts });
  } finally {
    lock.releaseLock();
  }
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

function apply_(t, op, rev, conflicts) {
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
  if (op.create) Object.keys(r).forEach(k => { if (k !== 'id') r[k] = ''; });
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
