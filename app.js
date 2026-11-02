// Herd Book — offline-first cattle tracker. Data lives on the phone and syncs to a Google Sheet when there is signal.
(() => {
// Paste the Google Apps Script web app URL here (or enter it in Log › Phone setup).
const SYNC_URL = window.HERDBOOK_SYNC_URL || '';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const byCollar = (a,b) => String(a.collar||'~').localeCompare(String(b.collar||'~'), undefined, {numeric:true});
const KIND = {cow:'Cow', heifer:'Heifer', bull:'Bull', steer:'Steer', calf:'Calf'};
const FIELDS = [['kind','Type'],['collar','Collar'],['group','Group'],['brand1','Brand'],['brand2','2nd brand'],['collarOn','Collar fitted'],['notes','Notes'],
  ['vid','Visual tag (VID)'],['eid','EID / RFID'],['breed','Breed'],['birthDate','Date of birth'],
  ['purchasePrice','Purchase price'],['purchaseDate','Purchase date'],['salePrice','Sale price'],['saleDate','Sale date']];
const MONEY = new Set(['purchasePrice','salePrice']);
const DATES = new Set(['purchaseDate','saleDate']);
const money = n => (n===''||n==null||isNaN(n)) ? '' : Number(n).toLocaleString('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:2});
const parseMoney = v => { v=String(v||'').replace(/[$,\s]/g,''); if(v==='') return ''; const n=Number(v); return isNaN(n)?null:Math.round(n*100)/100; };
const rid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,10);
const canWrite = true;

const S = { animals:new Map(), exposures:new Map(), collars:new Map(), treatments:new Map(), expenses:new Map(), preg:new Map(), mYear:'', mGroup:'', cFilter:'all', history:[], loaded:true, tab:'herd', group:'', yGroup:'', yFilter:'need', showSold:false, lastSync:0 };

// ---------- local storage ----------
const LS = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch{ return false; } }
};
const K = { mirror:'herdbook.app.mirror', outbox:'herdbook.app.outbox', cfg:'herdbook.app.config' };
const mirror = LS.get(K.mirror, {});
const COLS = ['animals','exposures','collars','treatments','expenses','preg'];
COLS.forEach(c=>{ mirror[c] = mirror[c] || {}; });
mirror.history = mirror.history || []; mirror.rev = mirror.rev || 0;
let outbox = LS.get(K.outbox, []);
let conflicts = LS.get('herdbook.app.conflicts', []);
const saveConflicts = () => LS.set('herdbook.app.conflicts', conflicts);
let inflight = 0;   // outbox entries currently being sent; never merge into these
const cfg = LS.get(K.cfg, {});
let storageOk = LS.set('herdbook.app.probe', 1);
S.lastSync = mirror.at || 0;

// A setup link can carry the sync address (s) and farm code (k).
try{
  const p = new URLSearchParams(location.search);
  if(p.get('s')) cfg.url = p.get('s');
  if(p.get('k')) cfg.code = p.get('k');
  if(p.get('s') || p.get('k')) LS.set(K.cfg, cfg);
}catch{}
const syncUrl = () => cfg.url || SYNC_URL;
const me = () => cfg.name || 'Someone';
try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch{}

let mirrorTimer=null;
function saveMirror(){ clearTimeout(mirrorTimer); mirrorTimer=setTimeout(()=>{ mirror.at=S.lastSync; if(!LS.set(K.mirror,mirror)) storageOk=false; },300); }
function saveOutbox(){ outbox.forEach(o=>{ if(!o.oid) o.oid=rid(); }); if(!LS.set(K.outbox,outbox)){ storageOk=false; toast('This phone is out of storage space. Get signal and sync before making more changes.'); } }

function recompute(){
  const cur = {}; COLS.forEach(c=>{ cur[c] = {...mirror[c]}; }); const pendingHist=[];
  for(const op of outbox){
    const [col,id] = op.path.split('/');
    if(col==='history'){ if(op.op==='set') pendingHist.push({...op.data, pending:true}); continue; }
    const tgt = cur[col] || null;
    if(!tgt) continue;
    if(op.op==='set') tgt[id]={...op.data};
    else if(op.op==='update'){ tgt[id]={...(tgt[id]||{}),...op.data}; }
    else if(op.op==='delete') delete tgt[id];
  }
  COLS.forEach(c=>{ S[c] = new Map(Object.entries(cur[c]).map(([id,d])=>[id,{...d,id}])); });
  const seen = new Set();
  S.history = pendingHist.reverse().concat(mirror.history).filter(h=>{ if(!h.id) return true; if(seen.has(h.id)) return false; seen.add(h.id); return true; });
  renderAll(); updateSync(); renderConflictBar();
}
let syncSoon=null;
const META = new Set(['updatedAt','updatedBy','createdAt']);
// What this phone last saw from the sheet for these fields: lets the sheet spot two phones editing the same field.
function baseOf(path, data){
  const i=path.indexOf('/'), col=path.slice(0,i), id=path.slice(i+1);
  const m = mirror[col] && mirror[col][id];
  const mine = outbox.filter(o=>o.path===path && o.data);     // this phone's own unsent values count as seen
  if(!m && !mine.length) return null;
  const b={};
  Object.keys(data).forEach(k=>{
    if(META.has(k)) return;
    let v = m ? (m[k] ?? '') : '';
    mine.forEach(o=>{ if(k in o.data) v = o.data[k]; });
    b[k] = v;
  });
  return Object.keys(b).length ? b : null;
}
function queue(op, path, data, base){
  data = data || null;
  if(op==='update'){
    // fold repeated edits to the same record into one pending change
    for(let i=outbox.length-1; i>=inflight; i--){
      const o=outbox[i]; if(o.path!==path) continue;
      if(o.shared || o.via) break;               // already handed to another phone: keep it exactly as sent
      if(o.op==='update'){ o.data={...o.data,...data}; if(base) o.base={...base,...(o.base||{})}; o.t=Date.now(); return done(); }
      if(o.op==='set'){ o.data={...o.data,...data}; o.t=Date.now(); return done(); }
      break;
    }
  }
  outbox.push({op, path, data, base:base||null, t:Date.now()});
  return done();
  function done(){ saveOutbox(); recompute(); clearTimeout(syncSoon); syncSoon=setTimeout(sync, 1500); return true; }
}
const put = (path,data)=>queue('set',path,data);
const patch = (path,data,base)=>queue('update',path,data, base || baseOf(path,data));
const remove = path=>queue('delete',path);
function logChange(targetId, targetType, text, action, changes){
  const id = rid();
  put('history/'+id, { id, targetId, targetType, text, action, changes: changes||[], at: Date.now(), by: me() });
}

// ---------- sync with the Google Sheet ----------
let syncing=false, lastErr='';
async function post(body){
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 30000);
  try{
    const r = await fetch(syncUrl(), {method:'POST', body:JSON.stringify(body), headers:{'Content-Type':'text/plain;charset=utf-8'}, redirect:'follow', signal:ac.signal});
    return await r.json();
  } finally { clearTimeout(t); }
}
function mergeChanges(ch){
  if(!ch) return;
  COLS.forEach(col=>(ch[col]||[]).forEach(r=>{
    const {id,_rev,_deleted,...rest} = r; if(!id) return;
    if(_deleted) delete mirror[col][id]; else mirror[col][id]=rest;
  }));
  if(ch.history && ch.history.length){
    const m = new Map(mirror.history.map(h=>[h.id,h]));
    ch.history.forEach(h=>{ const {_rev,_deleted,...rest}=h; m.set(rest.id,rest); });
    mirror.history = [...m.values()].sort((a,b)=>b.at-a.at).slice(0,400);
  }
}
async function sync(){
  clearTimeout(syncSoon);
  if(syncing) return;
  if(!syncUrl() || !cfg.code || navigator.onLine===false){ updateSync(); return; }
  syncing=true; updateSync();
  try{
    do{
      const batch = outbox.slice(0,150); inflight = batch.length;
      const ops = batch.map(o=>{ const i=o.path.indexOf('/'); return {col:o.path.slice(0,i), id:o.path.slice(i+1), patch:o.data, base:o.base||null, create:o.op==='set', del:o.op==='delete', oid:o.oid}; });
      let res;
      try{ res = await post({code:cfg.code, since:mirror.rev||0, ops}); } finally { inflight = 0; }
      if(res && res.ok && Array.isArray(res.conflicts) && res.conflicts.length) takeConflicts(res.conflicts, batch);
      if(!res || !res.ok){
        lastErr = res && res.error==='bad_code' ? 'This ranch code no longer works. Ask the ranch for a new share link.'
          : res && res.error==='ranch_off' ? `${res.ranch||'This ranch'} is switched off or waiting for approval.`
          : res && res.error==='busy' ? 'The sheet is busy. Trying again shortly.' : 'The sheet couldn’t take the changes. Trying again shortly.';
        break;
      }
      outbox.splice(0, batch.length); saveOutbox();
      mergeChanges(res.changes); mirror.rev = res.rev || mirror.rev;
      if(res.ranch!==undefined && (res.ranch!==cfg.ranchName || res.role!==cfg.role || (res.crewCode||'')!==(cfg.crewCode||''))){ cfg.ranchName=res.ranch; cfg.role=res.role; cfg.crewCode=res.crewCode||''; LS.set(K.cfg,cfg); }
      S.lastSync = Date.now(); lastErr=''; netDown=false; saveMirror();
    } while(outbox.length);
  }catch(e){
    netDown = true;
    lastErr = navigator.onLine===false ? '' : 'Couldn’t reach the sheet. Trying again shortly.';
  }finally{
    syncing=false; recompute(); renderSetup();
  }
}
window.addEventListener('online', ()=>{ netDown=false; updateSync(); sync(); });
window.addEventListener('offline', updateSync);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) sync(); });
setInterval(()=>{ if(!document.hidden) sync(); }, 60000);

function updateSync(){
  const el=$('#sync'); if(!el) return;
  const n=outbox.length, online=navigator.onLine!==false;
  let t, off=false;
  if(!storageOk){ t='Not saving on this phone'; off=true; }
  else if(!syncUrl() || !cfg.code){ t = n ? `${n} saved on phone · not connected` : 'Saved on phone · not connected'; off=true; }
  else if(!online){ t = n ? `No signal · ${n} saved on phone` : 'No signal · up to date'; off=!!n; }
  else if(syncing) t = n ? `Sending ${n} change${n>1?'s':''}…` : 'Checking for updates…';
  else if(lastErr){ t = n ? `${n} waiting · sync problem` : 'Sync problem'; off=true; }
  else if(n) t = `${n} change${n>1?'s':''} waiting to send`;
  else t = S.lastSync ? 'Synced '+ago(S.lastSync) : 'Ready';
  el.textContent=(cfg.ranchName?cfg.ranchName+' · ':'')+t; el.classList.toggle('off',off);
  renderSwapBar();
  $('#setupBanner').hidden = !!(syncUrl() && cfg.code);
}

// ---------- helpers ----------
function ago(t){
  if(!t) return '';
  const s = (Date.now()-t)/1000;
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+' min ago';
  if(s<86400) return Math.floor(s/3600)+' h ago';
  if(s<86400*7) return Math.floor(s/86400)+' d ago';
  return new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}
const fmtDate = d => d ? new Date(d+'T12:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : '';
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true,2800); }
const isSold = a => !!(a.sold===true || a.saleDate || (a.salePrice!==''&&a.salePrice!=null));
// Prices are shown on full-access phones (and on a phone that hasn't joined a ranch). Crew phones never receive them.
const fin = () => !cfg.code || cfg.role==='full';
const FIN = ['purchasePrice','purchaseDate','salePrice','saleDate'];
const animals = () => [...S.animals.values()];
const onHand = () => animals().filter(a=>!isSold(a));
const females = () => onHand().filter(a=>a.kind!=='bull');
const bulls = () => onHand().filter(a=>a.kind==='bull').sort(byCollar);
const groups = () => [...new Set(onHand().map(a=>a.group).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
const label = a => a ? `${KIND[a.kind]||'Cow'} ${a.collar ? '#'+a.collar : (a.brand1||'(no collar)')}` : 'Deleted animal';
const collarHtml = (a, xl) => a.collar ? `<span class="collar${xl?' xl':''}">${esc(a.collar)}</span>` : `<span class="collar none${xl?' xl':''}">no collar</span>`;
const brandsHtml = a => [a.brand1,a.brand2].filter(Boolean).map(b=>`<span class="brand">${esc(b)}</span>`).join(' ');
function matches(a, q){
  if(!q) return true;
  const hay = [a.collar,a.brand1,a.brand2,a.group,a.notes,KIND[a.kind],a.vid,a.eid,a.breed].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t=>hay.includes(t));
}

// ---------- tabs ----------
function setTab(){
  const t = (location.hash||'#herd').slice(1);
  S.tab = t==='bulls' ? 'breeding' : ['herd','yard','collars','breeding','health','money','log'].includes(t) ? t : 'herd';
  if(S.tab==='money' && !fin()) S.tab='herd';
  $('#navMoney').hidden = !fin();
  document.querySelectorAll('nav a').forEach(a=>a.setAttribute('aria-current', a.dataset.tab===S.tab?'page':'false'));
  document.querySelectorAll('section[data-view]').forEach(s=>s.hidden = s.dataset.view!==S.tab);
  renderAll();
}
window.addEventListener('hashchange', setTab);

// ---------- herd ----------
function renderHerd(){
  const pool = S.showSold ? animals() : onHand();
  const g = [...new Set(pool.map(a=>a.group).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(S.group && !g.includes(S.group)) S.group='';
  $('#groupChips').innerHTML = [['','All',pool.length], ...g.map(x=>[x,x,pool.filter(a=>a.group===x).length])]
    .map(([v,l,n])=>`<button type="button" class="chip" data-g="${esc(v)}" aria-pressed="${S.group===v}">${esc(l)} · ${n}</button>`).join('');
  const inGroup = pool.filter(a=>!S.group || a.group===S.group);
  const live = inGroup.filter(a=>!isSold(a)), sold = inGroup.filter(isSold);
  const fem = live.filter(a=>a.kind!=='bull'), withCollar = live.filter(a=>a.collar);
  const sum = (xs,k) => xs.reduce((t,a)=>t+(Number(a[k])||0),0);
  const bought = fin() ? sum(inGroup,'purchasePrice') : 0, soldFor = fin() ? sum(sold,'salePrice') : 0;
  $('#stats').innerHTML = animals().length ? `<span><b>${live.length}</b>on hand</span><span><b>${fem.length}</b>cows &amp; heifers</span><span><b>${live.length-fem.length}</b>bulls</span><span><b>${withCollar.filter(a=>a.collarOn).length}/${withCollar.length}</b>collars fitted</span>${S.showSold?`<span><b>${sold.length}</b>sold</span>`:''}${bought?`<span><b class="money">${money(bought)}</b>paid</span>`:''}${S.showSold&&soldFor?`<span><b class="money">${money(soldFor)}</b>sold for</span>`:''}` : '';
  const q = $('#q').value.trim();
  const rows = inGroup.filter(a=>matches(a,q)).sort(byCollar);
  const el = $('#herdList');
  if(!animals().length){ el.innerHTML = `<div class="empty"><strong>No cattle recorded yet</strong>Tap “Add animal” to enter the first cow, or import a spreadsheet from the Log tab.${!(syncUrl()&&cfg.code)?' If the herd is already in the Google Sheet, connect this phone in Log › Phone setup.':''}</div>`; return; }
  if(!rows.length){ el.innerHTML = `<div class="empty"><strong>No matches</strong>Nothing matches “${esc(q)}”${S.group?` in ${esc(S.group)}`:''}${S.showSold?'':'. Sold animals are hidden'}.</div>`; return; }
  el.innerHTML = `<div class="list">${rows.map(a=>`
    <button type="button" class="row${isSold(a)?' sold':''}" data-id="${esc(a.id)}">
      ${collarHtml(a)}
      <span class="main">
        <span class="line1">${brandsHtml(a) || '<span class="muted">No brand</span>'}
          ${a.kind==='bull'?'<span class="pill bull">Bull</span>':a.kind==='heifer'?'<span class="pill">Heifer</span>':''}
          ${isSold(a)?'<span class="pill sold">Sold</span>': a.collar ? (a.collarOn?'<span class="pill ok">Fitted</span>':'<span class="pill warn">Not fitted</span>') : ''}${!isSold(a)&&withdrawalUntil(a.id)?'<span class="pill warn">Withdrawal</span>':''}</span>
        <span class="line2">${esc(a.group||'No group')}${a.notes?' · '+esc(a.notes):''}</span>
      </span>
      <span class="when">${esc(ago(a.updatedAt))}</span>
    </button>`).join('')}</div>`;
}
$('#q').addEventListener('input', renderHerd);
$('#showSold').addEventListener('change', e=>{ S.showSold=e.target.checked; renderHerd(); });
$('#groupChips').addEventListener('click', e=>{ const b=e.target.closest('[data-g]'); if(!b) return; S.group=b.dataset.g; renderHerd(); });
$('#herdList').addEventListener('click', e=>{ const r=e.target.closest('[data-id]'); if(r) openAnimal(r.dataset.id); });
$('#addBtn').addEventListener('click', ()=>openAnimal(null));

// ---------- yard ----------
function renderYard(){
  const g = groups();
  const sel = $('#yGroup');
  if(S.yGroup && !g.includes(S.yGroup)) S.yGroup='';
  sel.innerHTML = `<option value="">All groups</option>` + g.map(x=>`<option ${x===S.yGroup?'selected':''}>${esc(x)}</option>`).join('');
  const q = $('#yq').value.trim();
  let rows = onHand().filter(a=>!S.yGroup || a.group===S.yGroup).filter(a=>matches(a,q));
  if(S.yFilter==='need') rows = rows.filter(a=>a.collar ? !a.collarOn : a.kind!=='calf');
  rows.sort(byCollar);
  const exact = q && onHand().find(a=>String(a.collar).toLowerCase()===q.toLowerCase());
  if(exact) rows = [exact, ...rows.filter(a=>a!==exact)];
  const notice = $('#yNotice');
  const qc = q && collarFor(q);
  if(q && /^[0-9A-Za-z-]+$/.test(q) && !exact && /\d/.test(q)) notice.innerHTML =
    qc ? (qc.status==='lost' ? `<div class="notice warn">Collar ${esc(q)} is marked lost.</div>` : `<div class="notice ok">Collar ${esc(q)} is unused. Open it on the Collars tab to give it to a cow.</div>`)
    : S.collars.size ? `<div class="notice warn">Collar ${esc(q)} isn’t in your collar list.</div>` : `<div class="notice ok">Collar ${esc(q)} is not assigned to any animal.</div>`;
  else if(exact && exact.collarOn) notice.innerHTML = `<div class="notice warn">Collar ${esc(exact.collar)} is already fitted on ${esc(label(exact))}.</div>`;
  else notice.innerHTML = '';
  const el = $('#yardList');
  if(!rows.length){ el.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>${S.yFilter==='need'&&!q?'Every collar in this group is fitted':'No matches'}</strong>${S.yFilter==='need'?'Switch to “All” to see fitted collars too.':'Try a brand or collar number.'}</div>`; return; }
  el.innerHTML = rows.slice(0,120).map(a=>`
    <div class="ycard${a.collarOn?' fitted':''}">
      <div class="top">${collarHtml(a,true)}<div style="min-width:0;display:flex;flex-direction:column;gap:6px">
        <div class="brands">${brandsHtml(a)||'<span class="muted">No brand</span>'}</div>
        <div class="meta">${esc(KIND[a.kind]||'Cow')} · ${esc(a.group||'No group')}</div></div></div>
      ${a.notes?`<div class="small">${esc(a.notes)}</div>`:''}
      <div class="acts">
        ${a.collar ? `<button type="button" class="btn ${a.collarOn?'':'tag'}" data-fit="${esc(a.id)}">${a.collarOn?'Undo fitted':'Collar fitted ✓'}</button>` : `<button type="button" class="btn tag" data-fitc="${esc(a.id)}">Fit collar</button>`}
        <button type="button" class="btn" data-open="${esc(a.id)}">Details</button>
      </div>
    </div>`).join('');
}
$('#yq').addEventListener('input', renderYard);
$('#yGroup').addEventListener('change', e=>{ S.yGroup=e.target.value; renderYard(); });
$('#yFilter').addEventListener('click', e=>{ const b=e.target.closest('[data-f]'); if(!b) return; S.yFilter=b.dataset.f; document.querySelectorAll('#yFilter button').forEach(x=>x.setAttribute('aria-pressed', x===b)); renderYard(); });
$('#yardList').addEventListener('click', e=>{
  const o=e.target.closest('[data-open]'); if(o) return openAnimal(o.dataset.open);
  const fc=e.target.closest('[data-fitc]'); if(fc) return openFitCollar(fc.dataset.fitc);
  const f=e.target.closest('[data-fit]'); if(f) toggleFit(S.animals.get(f.dataset.fit));
});

// ---------- bulls ----------
const expsForBull = id => [...S.exposures.values()].filter(x=>x.bullId===id).sort((a,b)=>(b.start||'').localeCompare(a.start||''));
const expsForCow = id => [...S.exposures.values()].filter(x=>(x.cowIds||[]).includes(id)).sort((a,b)=>(b.start||'').localeCompare(a.start||''));
function expLine(x, showBull){
  const b = S.animals.get(x.bullId);
  const range = `${fmtDate(x.start)} – ${x.end?fmtDate(x.end):'<b>still in</b>'}`;
  return `<div class="exp"><span class="who">${showBull?esc(b?label(b):'AI / outside bull'):''}${x.group?`${showBull?' · ':''}${esc(x.group)}`:''} · ${(x.cowIds||[]).length} cows</span><span class="muted">${range}</span></div>`;
}
function renderBulls(){
  const el=$('#bullList');
  const bs=bulls();
  if(!bs.length){ el.innerHTML=`<div class="empty"><strong>No bulls recorded</strong>Add an animal and set its type to Bull. Then record which cows he runs with here.</div>`; return; }
  el.innerHTML = bs.map(b=>{
    const xs=expsForBull(b.id), open=xs.filter(x=>!x.end);
    return `<div class="card">
      <h3>${collarHtml(b)} ${brandsHtml(b)} ${open.length?'<span class="pill ok">Out with cows</span>':'<span class="pill">Not out</span>'}</h3>
      ${xs.length? xs.map(x=>`<div style="display:flex;flex-direction:column;gap:6px">${expLine(x,false)}
          <div class="bar">${!x.end?`<button type="button" class="btn" data-pull="${esc(x.id)}">Pull bull</button>`:''}<button type="button" class="btn" data-cows="${esc(x.id)}">See cows</button></div></div>`).join('') : '<div class="small muted">No cows recorded with this bull yet.</div>'}
      <div class="bar"><button type="button" class="btn primary" data-turn="${esc(b.id)}">Put with cows</button><button type="button" class="btn" data-open="${esc(b.id)}">Bull details</button></div>
    </div>`;}).join('');
}
$('#expBtn').addEventListener('click', ()=>openExposure(null));
$('#bullList').addEventListener('click', e=>{
  const t=e.target.closest('[data-turn]'); if(t) return openExposure(t.dataset.turn);
  const o=e.target.closest('[data-open]'); if(o) return openAnimal(o.dataset.open);
  const p=e.target.closest('[data-pull]'); if(p) return openPull(p.dataset.pull);
  const c=e.target.closest('[data-cows]'); if(c) return openCows(c.dataset.cows);
});

// ---------- collars ----------
const STATE = {free:'Unused', assigned:'Not fitted', fitted:'Fitted', lost:'Lost'};
const ckey = n => String(n??'').trim().toLowerCase();
const cid = n => 'c-'+ckey(n).replace(/[^a-z0-9_\-.~]/g,'_').slice(0,190);
const collarFor = n => S.collars.get(cid(n));
const collarList = () => [...S.collars.values()].sort((a,b)=>String(a.number).localeCompare(String(b.number),undefined,{numeric:true}));
function wearers(){ const m=new Map(); onHand().forEach(a=>{ if(a.collar){ const k=ckey(a.collar); if(!m.has(k)) m.set(k,[]); m.get(k).push(a); } }); return m; }
function collarState(c, w){
  if(c.status==='lost') return 'lost';
  const on=w.get(ckey(c.number))||[];
  return on.length ? (on.some(a=>a.collarOn)?'fitted':'assigned') : 'free';
}
const freeCollars = () => { const w=wearers(); return collarList().filter(c=>collarState(c,w)==='free'); };
function parseNums(t){
  const out=[];
  String(t).replace(/\s*-\s*/g,'-').split(/[\s,;]+/).forEach(tok=>{
    if(!tok) return;
    const m=tok.match(/^([A-Za-z]*)(\d+)-[A-Za-z]*(\d+)$/);
    if(m){ const [,p,a,b]=m; const lo=Math.min(+a,+b), hi=Math.max(+a,+b); if(hi-lo>2000) return;
      const pad=a.length>1&&a[0]==='0'?a.length:0; for(let i=lo;i<=hi;i++) out.push(p+String(i).padStart(pad,'0')); }
    else out.push(tok);
  });
  return [...new Set(out)];
}
function addCollars(nums, note){
  const now=Date.now(); let n=0;
  nums.forEach(num=>{ num=String(num).trim(); if(!num || S.collars.has(cid(num))) return;
    outbox.push({op:'set', path:'collars/'+cid(num), data:{number:num, note:note||'', status:'ok', createdAt:now, updatedAt:now, updatedBy:me()}, t:now}); n++; });
  saveOutbox();
  if(n) logChange('collars','collar',`Added ${n} collar${n>1?'s':''} to the list`,'added',[]); else recompute();
  return n;
}
function setAnimalCollar(a, num){
  if(!a) return;
  patch('animals/'+a.id, {collar:num, collarOn:false, updatedAt:Date.now(), updatedBy:me()});
  logChange(a.id,'animal',label({...a, collar:num||a.collar}),'edited',[{f:'collar',from:a.collar||'',to:num}].concat(a.collarOn?[{f:'collarOn',from:true,to:false}]:[]));
}
function toggleFit(a){
  if(!a) return; const to=!a.collarOn;
  patch('animals/'+a.id, {collarOn:to, updatedAt:Date.now(), updatedBy:me()});
  logChange(a.id,'animal',label(a),'edited',[{f:'collarOn',from:!!a.collarOn,to}]);
  toast(to?`Collar ${a.collar} fitted`:`Collar ${a.collar} marked not fitted`);
}
function renderCollars(){
  const el=$('#collarList'), w=wearers(), list=collarList();
  const states=list.map(c=>[c,collarState(c,w)]);
  const cnt=k=>states.filter(([,s])=>k==='all'||s===k).length;
  $('#cChips').innerHTML=[['all','All'],['free','Unused'],['assigned','Not fitted'],['fitted','Fitted'],['lost','Lost']]
    .map(([k,l])=>`<button type="button" class="chip" data-cf="${k}" aria-pressed="${S.cFilter===k}">${l} · ${cnt(k)}</button>`).join('');
  const known=new Set(list.map(c=>ckey(c.number)));
  const orphans=[...w.keys()].filter(k=>!known.has(k)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const dups=[...w.values()].filter(a=>a.length>1);
  let warn='';
  if(dups.length) warn+=`<div class="notice warn">${dups.map(a=>`Collar ${esc(a[0].collar)} is on ${a.length} animals: ${a.map(x=>esc(x.brand1||label(x))).join(', ')}`).join('<br>')}</div>`;
  if(orphans.length) warn+=`<div class="card"><div><b>${orphans.length} collar${orphans.length>1?'s are':' is'} on cattle but not in this list:</b> ${orphans.slice(0,40).map(k=>esc(w.get(k)[0].collar)).join(', ')}${orphans.length>40?' …':''}</div><div><button type="button" class="btn" id="cAddOrphans">Add ${orphans.length>1?'them':'it'} to the list</button></div></div>`;
  $('#cWarn').innerHTML=warn;
  $('#seasonCount').textContent=onHand().filter(a=>a.collar&&a.collarOn).length;
  if(!list.length){ el.innerHTML=`<div class="empty"><strong>No collars listed yet</strong>Tap “Add collars” and enter your numbers as a range, like 1-150.${orphans.length?' Or add the collars already on your cattle above.':''}</div>`; return; }
  const q=ckey($('#cq').value);
  const rows=states.filter(([c,s])=>(S.cFilter==='all'||s===S.cFilter) && (!q || ckey(c.number).includes(q) || ckey(c.note).includes(q) || (w.get(ckey(c.number))||[]).some(a=>matches(a,q))));
  if(!rows.length){ el.innerHTML=`<div class="empty"><strong>No collars here</strong>${S.cFilter==='free'&&!q?'Every collar in the list is in use.':'Nothing matches this search or filter.'}</div>`; return; }
  el.innerHTML=`<div class="cgrid">${rows.map(([c,s])=>{ const a=(w.get(ckey(c.number))||[])[0];
    return `<button type="button" class="ctile ${s}" data-c="${esc(c.id)}"><span class="collar">${esc(c.number)}</span><span class="pill ${s==='fitted'?'ok':s==='assigned'?'warn':''}">${STATE[s]}</span><span class="who">${a?esc(a.brand1||label(a)):(c.note?esc(c.note):'&nbsp;')}</span></button>`; }).join('')}</div>`;
}
$('#cq').addEventListener('input', renderCollars);
$('#cChips').addEventListener('click', e=>{ const b=e.target.closest('[data-cf]'); if(!b) return; S.cFilter=b.dataset.cf; renderCollars(); });
$('#collarList').addEventListener('click', e=>{ const t=e.target.closest('[data-c]'); if(t) openCollar(t.dataset.c); });
$('#cWarn').addEventListener('click', e=>{ if(!e.target.closest('#cAddOrphans')) return;
  const w=wearers(); const known=new Set(collarList().map(c=>ckey(c.number)));
  const n=addCollars([...w.keys()].filter(k=>!known.has(k)).map(k=>w.get(k)[0].collar)); toast(`Added ${n} collars to the list`); });
$('#cAddBtn').addEventListener('click', openAddCollars);
$('#seasonBtn').addEventListener('click', e=>{
  const b=e.currentTarget;
  if(!b.classList.contains('armed')){ b.classList.add('armed'); b.textContent='Tap again to confirm'; return; }
  b.classList.remove('armed'); b.textContent='Start new season';
  const xs=onHand().filter(a=>a.collar&&a.collarOn);
  if(!xs.length){ toast('No collars are marked fitted'); return; }
  const now=Date.now();
  xs.forEach(a=>outbox.push({op:'update', path:'animals/'+a.id, data:{collarOn:false, updatedAt:now, updatedBy:me()}, t:now}));
  saveOutbox();
  logChange('season','season',`New season: ${xs.length} collars marked not fitted`,'reset',[]);
  toast(`${xs.length} collars marked not fitted`);
});
$('#cExport').addEventListener('click', ()=>{
  const w=wearers(); const rows=[['collar','status','on_animal','brand1','brand2','group','fitted','note']];
  collarList().forEach(c=>{ const a=(w.get(ckey(c.number))||[])[0];
    rows.push([c.number,STATE[collarState(c,w)],a?label(a):'',a?a.brand1:'',a?a.brand2:'',a?a.group:'',a?(a.collarOn?'yes':'no'):'',c.note||'']); });
  saveFile(`collars-${today()}.csv`, rows.map(r=>r.map(csvCell).join(',')).join('\n'), 'text/csv');
});
function openAddCollars(){
  openSheet(`<div style="display:flex;flex-direction:column;gap:14px"><div class="sheet-h"><h2>Add collars</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="caf" class="card">
      <label class="f">Collar numbers<textarea id="ca-nums" placeholder="1-150, 152, 160-175"></textarea></label>
      <div class="small muted" id="ca-prev">Use a dash for a run of numbers and commas between groups.</div>
      <label class="f">Note for these collars (optional)<input id="ca-note" type="text" placeholder="e.g. bought 2026, orange"></label>
      <button class="btn primary" type="submit">Add collars</button>
    </form></div>`);
  $('#ca-nums').addEventListener('input', ()=>{ const ns=parseNums($('#ca-nums').value); const nw=ns.filter(n=>!S.collars.has(cid(n)));
    $('#ca-prev').textContent = ns.length ? `${nw.length} new collar${nw.length===1?'':'s'}${ns.length>nw.length?`, ${ns.length-nw.length} already listed`:''}${nw.length?`: ${nw.slice(0,8).join(', ')}${nw.length>8?' …':''}`:''}` : 'Use a dash for a run of numbers and commas between groups.'; });
  $('#caf').addEventListener('submit', e=>{ e.preventDefault(); const n=addCollars(parseNums($('#ca-nums').value), $('#ca-note').value.trim()); closeSheet(); toast(n?`Added ${n} collar${n>1?'s':''}`:'Those collars are already listed'); });
}
function openCollar(id){
  const c=S.collars.get(id); if(!c){ closeSheet(); return; }
  const w=wearers(), on=w.get(ckey(c.number))||[], a=on[0], s=collarState(c,w);
  const past=animals().filter(x=>isSold(x)&&ckey(x.collar)===ckey(c.number));
  const hist=S.history.filter(h=>h.targetId===id || (h.changes||[]).some(ch=>ch.f==='collar'&&(ckey(ch.from)===ckey(c.number)||ckey(ch.to)===ckey(c.number))));
  const free=onHand().filter(x=>!x.collar).sort((x,y)=>String(x.brand1||'').localeCompare(String(y.brand1||''),undefined,{numeric:true}));
  openSheet(`<div id="cs" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="collar xl">${esc(c.number)}</span><span class="pill ${s==='fitted'?'ok':s==='assigned'?'warn':''}">${STATE[s]}</span></div><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="card">
      ${a ? `<div><b>On ${esc(label(a))}</b> ${brandsHtml(a)} <span class="muted small">${esc(a.group||'')}</span></div>
        ${on.length>1?`<div class="notice warn">Also on ${on.slice(1).map(x=>esc(label(x))).join(', ')}.</div>`:''}
        <div class="bar"><button type="button" class="btn" data-open="${esc(a.id)}">Animal details</button>
        <button type="button" class="btn ${a.collarOn?'':'tag'}" data-fit="${esc(a.id)}">${a.collarOn?'Undo fitted':'Collar fitted ✓'}</button><button type="button" class="btn" data-unassign="${esc(a.id)}">Take off this animal</button></div>`
      : `<div class="muted">Not on any animal.</div>
        ${s!=='lost' ? (free.length ? `<b>Give this collar to</b>
          <input id="c-filter" type="search" placeholder="Filter by brand, group or notes">
          <div class="picklist">${free.map(x=>`<button type="button" class="row" style="grid-template-columns:1fr auto" data-assign="${esc(x.id)}" data-s="${esc([x.brand1,x.brand2,x.group,x.notes,KIND[x.kind]].join(' ').toLowerCase())}"><span class="main"><span class="line1">${brandsHtml(x)||'<span class="muted">No brand</span>'} <span class="pill">${esc(KIND[x.kind]||'Cow')}</span></span><span class="line2">${esc(x.group||'No group')}${x.notes?' · '+esc(x.notes):''}</span></span><span class="small muted">Assign</span></button>`).join('')}</div>`
          : '<div class="small muted">Every animal on hand already has a collar.</div>') : ''}`}
    </div>
    <form id="cf" class="card">
      <label class="f">Collar note<input id="c-note" type="text" value="${esc(c.note||'')}" placeholder="Colour, condition, battery"></label>
      <label class="f">eShepherd neckband serial (optional)<input id="c-nb" type="text" inputmode="numeric" value="${esc(c.neckband||'')}" placeholder="e.g. 4153663861"></label>
      <label class="check"><input id="c-lost" type="checkbox" ${c.status==='lost'?'checked':''}> Lost or out of use</label>
      <div class="bar"><button class="btn primary" type="submit" style="flex:1">Save</button><button class="btn danger" type="button" id="c-del">Remove from list</button></div>
    </form>
    <div class="card"><b>Collar history</b>
      ${past.map(x=>`<div class="exp"><span>${esc(label(x))} ${brandsHtml(x)}</span><span class="muted">sold ${esc(fmtDate(x.saleDate))}</span></div>`).join('')}
      ${hist.length ? logHtml(hist.slice(0,30)) : (past.length?'':'<div class="small muted">No changes recorded for this collar yet.</div>')}
    </div></div>`);
  const root=$('#cs');
  root.addEventListener('click', e=>{
    const o=e.target.closest('[data-open]'); if(o) return openAnimal(o.dataset.open);
    const f=e.target.closest('[data-fit]'); if(f){ toggleFit(S.animals.get(f.dataset.fit)); return openCollar(id); }
    const u=e.target.closest('[data-unassign]'); if(u){ const x=S.animals.get(u.dataset.unassign); setAnimalCollar(x,''); toast(`Collar ${c.number} taken off`); return openCollar(id); }
    const g=e.target.closest('[data-assign]'); if(g){ const x=S.animals.get(g.dataset.assign); setAnimalCollar(x,c.number); toast(`Collar ${c.number} given to ${x.brand1||label(x)}`); return openCollar(id); }
    const d=e.target.closest('#c-del'); if(d){
      if(!d.classList.contains('armed')){ d.classList.add('armed'); d.textContent='Tap again to remove'; return; }
      remove('collars/'+id); logChange(id,'collar',`Collar ${c.number}`,'removed from list',[]); closeSheet(); toast(`Collar ${c.number} removed from the list`); }
  });
  const flt=$('#c-filter');
  flt && flt.addEventListener('input', e=>{ const q=e.target.value.toLowerCase().trim(); root.querySelectorAll('[data-assign]').forEach(b=>b.hidden=!!q&&!b.dataset.s.includes(q)); });
  $('#cf').addEventListener('submit', e=>{
    e.preventDefault();
    const note=$('#c-note').value.trim(), status=$('#c-lost').checked?'lost':'ok', neckband=$('#c-nb').value.trim(), ch=[];
    if(neckband!==(c.neckband||'')) ch.push({f:'Neckband serial',from:c.neckband||'',to:neckband});
    if(note!==(c.note||'')) ch.push({f:'Collar note',from:c.note||'',to:note});
    if(status!==(c.status||'ok')) ch.push({f:'Collar status',from:c.status==='lost'?'lost':'in use',to:status==='lost'?'lost':'in use'});
    if(!ch.length){ closeSheet(); return; }
    patch('collars/'+id, {note, status, neckband, updatedAt:Date.now(), updatedBy:me()});
    logChange(id,'collar',`Collar ${c.number}`,'edited',ch); closeSheet(); toast('Saved');
  });
}

// ---------- clashes: the same field changed on two phones before either synced ----------
const XLABEL = { start:'Put-in date', end:'Pulled date', cowIds:'Cows', note:'Note', status:'Status', number:'Collar number', bullId:'Bull' };
const fieldLabel = f => (FIELDS.find(x=>x[0]===f)||[f, XLABEL[f]||f])[1];
function fmtVal(f, v){
  if(f==='collarOn') return (v===true||v==='true') ? 'Fitted' : 'Not fitted';
  if(f==='kind') return KIND[v]||v||'(blank)';
  if(f==='status') return v==='lost' ? 'Lost' : 'In use';
  if(f==='cowIds') return Array.isArray(v) ? `${v.length} cows` : '(blank)';
  if(f==='bullId') return label(S.animals.get(v));
  if(v===''||v==null) return '(blank)';
  if(MONEY.has(f)) return money(v);
  if(DATES.has(f)||f==='start'||f==='end') return fmtDate(v);
  return String(v);
}
function whatOf(col, id, rec){
  if(col==='animals') return label(rec || S.animals.get(id));
  if(col==='collars') return `Collar ${(rec||S.collars.get(id)||{}).number||''}`;
  if(col==='treatments') return `Treatment: ${(rec||S.treatments.get(id)||{}).product||''}`;
  if(col==='expenses') return `Expense: ${(rec||S.expenses.get(id)||{}).category||''}`;
  if(col==='preg') return `Breeding record for ${label(S.animals.get((rec||S.preg.get(id)||{}).cowId))}`;
  const x = rec || S.exposures.get(id); return x ? `${label(S.animals.get(x.bullId))} with ${x.group||'selected cows'}` : 'Bull with cows';
}
function takeConflicts(list, batch){
  const times = {}; batch.forEach(o=>{ times[o.path]=o.t; });
  list.forEach(c=>{
    const path = c.col+'/'+c.id;
    const coll = S[c.col] || S.exposures;
    const rec = coll.get(c.id);
    const item = { key: path+'|'+(c.field||'deleted'), col:c.col, id:c.id, type:c.type, field:c.field||'', mine:c.mine, theirs:c.theirs, by:c.by||'', at:c.at||'', myAt:times[path]||Date.now(), what:whatOf(c.col,c.id,rec), record: rec ? {...rec} : null };
    conflicts = conflicts.filter(x=>x.key!==item.key).concat([item]);
  });
  saveConflicts();
  setTimeout(()=>{ if($('#scrim').hidden) openConflicts(); else toast('Some changes clashed. Tap the orange bar to choose.'); }, 50);
}
function renderConflictBar(){
  const b=$('#conflictBar'); if(!b) return;
  b.hidden = !conflicts.length;
  b.textContent = `${conflicts.length} change${conflicts.length>1?'s':''} clashed with someone else’s. Tap to choose which to keep.`;
}
$('#conflictBar').addEventListener('click', openConflicts);
function openConflicts(){
  renderConflictBar();
  if(!conflicts.length){ closeSheet(); return; }
  openSheet(`<div id="cx" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>Choose which to keep</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="small muted">These were changed on two phones before either one synced. Nothing is lost until you choose.</div>
    ${conflicts.map((c,i)=> c.type==='deleted' ? `<div class="card">
        <b>${esc(c.what)}</b>
        <div>${esc(c.by||'Someone')} deleted this ${c.at?esc(ago(c.at))+' ':''}before your changes were sent.</div>
        <div class="bar">${c.record?`<button type="button" class="btn primary" data-keep="restore" data-i="${i}">Bring it back with my changes</button>`:''}<button type="button" class="btn" data-keep="theirs" data-i="${i}">Leave it deleted</button></div>
      </div>` : `<div class="card">
        <b>${esc(c.what)} · ${esc(fieldLabel(c.field))}</b>
        <div class="grid2">
          <div class="vbox"><div class="small muted">Yours · ${esc(ago(c.myAt))}</div><div class="val">${esc(fmtVal(c.field,c.mine))}</div></div>
          <div class="vbox"><div class="small muted">${esc(c.by||'Other phone')} · ${esc(ago(c.at))}</div><div class="val">${esc(fmtVal(c.field,c.theirs))}</div></div>
        </div>
        <div class="bar"><button type="button" class="btn primary" data-keep="mine" data-i="${i}">Keep mine</button><button type="button" class="btn" data-keep="theirs" data-i="${i}">Keep ${esc(c.by||'theirs')}${c.by?'’s':''}</button></div>
      </div>`).join('')}
  </div>`);
  $('#cx').addEventListener('click', e=>{
    const b=e.target.closest('[data-keep]'); if(!b) return;
    const c=conflicts[+b.dataset.i]; if(!c) return;
    const path=c.col+'/'+c.id, now=Date.now();
    if(c.local){
      resolveLocalClash(c, b.dataset.keep==='mine'?'mine':'theirs');
      logChange(c.id, c.col, c.what, b.dataset.keep==='mine' ? `kept ${me()}’s version over ${c.by}’s` : `kept ${c.by}’s version`, [{f:c.field, from:b.dataset.keep==='mine'?c.theirs:c.mine, to:b.dataset.keep==='mine'?c.mine:c.theirs}]);
    } else if(b.dataset.keep==='mine'){
      patch(path, {[c.field]:c.mine, updatedAt:now, updatedBy:me()}, {[c.field]:c.theirs});
      logChange(c.id, c.col, c.what, `kept ${me()}’s version over ${c.by||'the other phone'}’s`, [{f:c.field, from:c.theirs, to:c.mine}]);
    } else if(b.dataset.keep==='restore' && c.record){
      const {id, ...rec} = c.record;
      put(path, {...rec, updatedAt:now, updatedBy:me()});
      logChange(c.id, c.col, c.what, 'brought back after it was deleted', []);
    } else if(c.type!=='deleted'){
      logChange(c.id, c.col, c.what, `kept ${c.by||'the other phone'}’s version`, [{f:c.field, from:c.mine, to:c.theirs}]);
    }
    conflicts = conflicts.filter(x=>x!==c); saveConflicts();
    openConflicts();
  });
}

// ---------- log ----------
function changeText(c){
  const lab = (FIELDS.find(f=>f[0]===c.f)||[c.f,c.f])[1];
  const v = x => c.f==='collarOn' ? (x===true||x==='true'?'yes':'no') : c.f==='kind' ? (KIND[x]||x) : (x===''||x==null) ? '—' : MONEY.has(c.f) ? money(x) : DATES.has(c.f) ? fmtDate(x) : x;
  return `${esc(lab)}: ${c.from!==undefined?`<del>${esc(v(c.from))}</del> → `:''}<ins>${esc(v(c.to))}</ins>`;
}
function logHtml(items){
  if(!items.length) return `<div class="empty"><strong>No changes yet</strong>Every add, edit and delete shows up here with who made it.</div>`;
  return `<div class="log">${items.map(h=>`<div class="logitem">
    <div class="head"><b>${esc(h.text)}</b><span class="muted">${h.pending?'<span class="pill warn">Not sent yet</span> ':''}${esc(ago(h.at))}</span></div>
    <div class="muted small">${esc(h.action)} by ${esc(h.by||'someone')} · ${esc(new Date(h.at).toLocaleString())}</div>
    ${(h.changes||[]).length?`<ul>${h.changes.map(c=>`<li>${changeText(c)}</li>`).join('')}</ul>`:''}
  </div>`).join('')}</div>`;
}
function renderLog(){ $('#logList').innerHTML = logHtml(S.history.slice(0,150)); renderSetup(); }

// ---------- ranch & phone setup ----------
function shareLink(code){
  if(!syncUrl() || !code) return '';
  const s = (cfg.url && cfg.url!==SYNC_URL) || !SYNC_URL ? 's=' + encodeURIComponent(syncUrl()) + '&' : '';
  return location.origin + location.pathname + '?' + s + 'k=' + encodeURIComponent(code);
}
function drawQR(el, text){
  el.innerHTML='';
  if(!text || typeof qrcode!=='function') return;
  try{ const q=qrcode(0,'M'); q.addData(text); q.make(); el.innerHTML=q.createSvgTag({cellSize:4, margin:2, scalable:true}); }catch{}
}
async function copyFrom(btn){
  const el = btn.closest('[data-share]').querySelector('[data-link]');
  try{ await navigator.clipboard.writeText(el.value); toast('Link copied'); }
  catch{ el.focus(); el.select(); toast('Link selected. Copy it from the menu.'); }
}
document.addEventListener('click', e=>{ const b=e.target.closest('[data-copy]'); if(b) copyFrom(b); });

// Share: crew links never carry prices (the sheet strips them); full links do.
function openShare(intro){
  if(!cfg.code){ openStart(true); return; }
  const full = cfg.role==='full';
  let mode = 'crew';
  const crewCode = () => full ? cfg.crewCode : cfg.code;
  const draw = () => {
    const code = mode==='full' ? cfg.code : crewCode();
    const link = shareLink(code);
    $('#sh-body').innerHTML = !code ? `<div class="notice warn">Sync once with signal to get the crew link.</div>` : `
      <div class="notice ${mode==='full'?'warn':'ok'}">${mode==='full'
        ? 'Full access: they see purchase and sale prices, and can share full access with others.'
        : 'Crew: they can see and update cattle, collars and bulls, but never see purchase or sale prices.'}</div>
      <div class="qr" data-qr></div>
      <input type="text" readonly value="${esc(link)}" data-link>
      <div class="fab-row"><button class="btn primary" type="button" data-copy>Copy link</button>${navigator.share?'<button class="btn" type="button" id="sh-native">Send…</button>':''}</div>
      <div class="small muted">They scan the code with their phone camera (or open the link), then tap Add to Home Screen. Code: <b>${esc(code)}</b></div>
      ${full && mode==='crew' ? `<div class="small">Someone left the crew? <button type="button" class="btn danger" id="sh-reset">Make a new crew link</button><br><span class="muted">Every crew phone will need the new link.</span></div>` : ''}`;
    drawQR($('#sh-body [data-qr]'), link);
    const nat=$('#sh-native'); nat && nat.addEventListener('click', ()=>navigator.share({title:`${cfg.ranchName||'Ranch'} on Herd Book`, text:`Join ${cfg.ranchName||'our ranch'} on Herd Book`, url:link}).catch(()=>{}));
    const rs=$('#sh-reset'); rs && rs.addEventListener('click', async ()=>{
      if(!rs.classList.contains('armed')){ rs.classList.add('armed'); rs.textContent='Tap again: old crew link stops working'; return; }
      if(navigator.onLine===false){ toast('Making a new crew link needs signal'); return; }
      rs.disabled=true; let res=null;
      try{ res=await post({action:'resetCrewCode', code:cfg.code}); }catch{}
      if(res && res.ok){ cfg.crewCode=res.crewCode; LS.set(K.cfg,cfg); toast('New crew link made. The old one no longer works.'); draw(); }
      else { rs.disabled=false; toast('Couldn’t make a new link. Try again with signal.'); }
    });
  };
  openSheet(`<div style="display:flex;flex-direction:column;gap:14px" data-share>
    <div class="sheet-h"><h2>${esc(intro || 'Share '+(cfg.ranchName||'this ranch'))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    ${full ? `<div class="seg" id="sh-mode"><button type="button" data-m="crew" aria-pressed="true">Crew · no prices</button><button type="button" data-m="full" aria-pressed="false">Full access</button></div>` : `<div class="small muted">You can share crew access. Crew never see prices.</div>`}
    <div id="sh-body" style="display:flex;flex-direction:column;gap:10px"></div>
  </div>`);
  const m=$('#sh-mode');
  m && m.addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; mode=b.dataset.m; m.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed', x===b)); draw(); });
  draw();
}
$('#shareBtn').addEventListener('click', ()=>openShare());

function renderSetup(){
  const st=$('#cfg-status'); if(!st) return;
  const nameEl=$('#cfg-name'), urlEl=$('#cfg-url');
  if(document.activeElement!==nameEl) nameEl.value = cfg.name||'';
  if(document.activeElement!==urlEl) urlEl.value = cfg.url||SYNC_URL||'';
  $('#ranchLine').innerHTML = cfg.code
    ? `<div class="small muted">Ranch</div><div style="font-size:20px;font-weight:700">${esc(cfg.ranchName||'Connecting…')}</div><div class="small muted">${cfg.role==='full'?'Full access, including prices':cfg.role==='crew'?'Crew access, no prices':''}</div><div style="margin-top:8px"><button type="button" class="btn primary" id="shareNow">Share this ranch</button></div>`
    : `<b>Not part of a ranch yet.</b> <button type="button" class="btn" id="joinNow">Join or start a ranch</button>`;
  st.textContent = !(syncUrl()&&cfg.code) ? 'Changes are kept on this phone only until it joins a ranch.'
    : lastErr ? lastErr
    : S.lastSync ? `Last synced ${new Date(S.lastSync).toLocaleString()}.` : 'Tap “Sync now” to load the herd.';
  st.textContent += ocrReady() ? ' Collar photo scanner is ready to use without signal.' : ' The collar photo scanner downloads the next time there’s signal.';
  $('#shareBtn').hidden = !cfg.code;
}
$('#setupCard').addEventListener('click', e=>{ if(e.target.closest('#shareNow')) openShare(); });
$('#setupCard').addEventListener('click', e=>{ if(e.target.closest('#joinNow')) openStart(true); });
$('#cfg-save').addEventListener('click', ()=>{ cfg.name=$('#cfg-name').value.trim(); LS.set(K.cfg,cfg); toast('Saved'); renderSetup(); });
$('#cfg-url-save').addEventListener('click', ()=>{ const u=$('#cfg-url').value.trim(); if(u && u!==SYNC_URL) cfg.url=u; else delete cfg.url; LS.set(K.cfg,cfg); lastErr=''; toast('Saved'); renderSetup(); sync(); });
$('#syncNow').addEventListener('click', ()=>{ if(!(syncUrl()&&cfg.code)){ openStart(true); return; } sync(); });
$('#switchRanch').addEventListener('click', ()=>openStart(true));

// Move this phone to a different ranch. Never throws away unsent changes from a ranch it already belongs to.
function switchTo(code, ranchName){
  code = String(code||'').trim().toLowerCase();
  if(!code) return 'Enter the ranch code.';
  if(code===cfg.code){ if(ranchName) cfg.ranchName=ranchName; LS.set(K.cfg,cfg); return ''; }
  if(cfg.code && outbox.length) return `This phone has ${outbox.length} change${outbox.length>1?'s':''} for ${cfg.ranchName||'its ranch'} that haven’t been sent yet. Get signal and sync before switching.`;
  if(cfg.code){ COLS.forEach(c=>{ mirror[c]={}; }); mirror.history=[]; outbox=[]; saveOutbox(); conflicts=[]; saveConflicts(); }
  mirror.rev=0; S.lastSync=0; saveMirror();
  cfg.code=code; cfg.ranchName=ranchName||''; delete cfg.role; delete cfg.crewCode; LS.set(K.cfg,cfg); lastErr='';
  recompute(); renderSetup();
  return '';
}
function openStart(force){
  if(!force && cfg.name && cfg.code) return;
  const fromLink = !!cfg.code && !force;
  openSheet(`<div style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>${fromLink?'Welcome to Herd Book':'Set up this phone'}</h2>${force?'<button class="x" type="button" aria-label="Close">×</button>':''}</div>
    <form id="stf" class="card" autocomplete="off">
      <label class="f">Your name<input id="st-name" type="text" autocomplete="name" value="${esc(cfg.name||'')}" placeholder="Shown next to the changes you make"></label>
      ${fromLink ? `<div class="small muted">This phone will join the ranch from your link.</div>` : `
      <div class="seg" id="st-mode"><button type="button" data-m="join" aria-pressed="true">Join a ranch</button><button type="button" data-m="start" aria-pressed="false">Start a new ranch</button></div>
      <div id="st-join"><label class="f">Ranch code<input id="st-code" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="From someone on the ranch"></label></div>
      <div id="st-start" hidden style="display:flex;flex-direction:column;gap:10px">
        <label class="f">Ranch name<input id="st-ranch" type="text" placeholder="e.g. Willow Creek Ranch"></label>
        <label class="f">Sign-up code<input id="st-signup" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="From whoever runs Herd Book"></label>
        <div class="small muted">Starting a ranch needs signal. It creates the ranch’s own Google Sheet.</div>
      </div>`}
      ${!syncUrl()?`<label class="f">Sync address<input id="st-url" type="url" placeholder="https://script.google.com/…"></label>`:''}
      <div id="st-msg"></div>
      <button class="btn primary" type="submit" id="st-go">Start</button>
      ${!force?'<button class="btn" type="button" id="st-skip">Not now, keep records on this phone</button>':''}
    </form></div>`);
  let mode='join';
  const m=$('#st-mode');
  m && m.addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; mode=b.dataset.m;
    m.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed', x===b)); $('#st-join').hidden=mode!=='join'; $('#st-start').hidden=mode!=='start'; });
  const skip=$('#st-skip'); skip && skip.addEventListener('click', ()=>{ cfg.name=$('#st-name').value.trim()||cfg.name; LS.set(K.cfg,cfg); closeSheet(); renderSetup(); });
  const say = (t, ok) => { $('#st-msg').innerHTML = t ? `<div class="notice ${ok?'ok':'warn'}">${esc(t)}</div>` : ''; };
  $('#stf').addEventListener('submit', async e=>{
    e.preventDefault();
    const name=$('#st-name').value.trim(); if(!name){ say('Enter your name.'); return; }
    cfg.name=name;
    const u=$('#st-url'); if(u && u.value.trim()) cfg.url=u.value.trim();
    LS.set(K.cfg,cfg);
    if(fromLink){ closeSheet(); renderSetup(); sync(); return; }
    if(!syncUrl()){ say('Enter the sync address.'); return; }
    if(mode==='join'){
      const err=switchTo($('#st-code').value); if(err){ say(err); return; }
      closeSheet(); toast('Joining ranch…'); sync(); return;
    }
    const ranch=$('#st-ranch').value.trim(), signup=$('#st-signup').value.trim();
    if(!ranch || !signup){ say('Enter the ranch name and the sign-up code.'); return; }
    if(cfg.code && outbox.length){ say(`This phone has ${outbox.length} unsent changes for ${cfg.ranchName||'its ranch'}. Sync before starting a new ranch.`); return; }
    if(navigator.onLine===false){ say('Starting a ranch needs signal. Try again when you have it.'); return; }
    const go=$('#st-go'); go.disabled=true; say('Creating the ranch…', true);
    let res=null;
    try{ res=await post({action:'createRanch', signup, name:ranch, by:name}); }catch{}
    go.disabled=false;
    if(!res){ say('Couldn’t reach the sheet. Starting a ranch needs signal.'); return; }
    if(!res.ok){ say(res.error==='bad_signup'?'That sign-up code isn’t right.':'The ranch couldn’t be created. Try again.'); return; }
    switchTo(res.code, res.ranch); cfg.role='full'; cfg.crewCode=res.crewCode||''; LS.set(K.cfg,cfg); renderSetup();
    openShare(`${res.ranch} is ready. Add your crew`);
    sync();
  });
}

// ---------- sheet ----------
function openSheet(html){ $('#sheet').innerHTML=html; $('#scrim').hidden=false; }
function closeSheet(){ stopSwap(); $('#scrim').hidden=true; $('#sheet').innerHTML=''; }
$('#scrim').addEventListener('click', e=>{ if(e.target.id==='scrim' || e.target.closest('.x')) closeSheet(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && !$('#scrim').hidden) closeSheet(); });

function openAnimal(id){
  const a = id ? S.animals.get(id) : {kind:'cow', group:S.group||'', collarOn:false};
  if(id && !a) return;
  const xs = id ? (a.kind==='bull'?expsForBull(id):expsForCow(id)) : [];
  const mv = k => a[k]===''||a[k]==null ? '' : Number(a[k]).toFixed(2).replace(/\.00$/,'');
  openSheet(`
    <div class="sheet-h"><h2>${id?esc(label(a)):'New animal'}${id&&isSold(a)?' <span class="pill sold">Sold</span>':''}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    ${id&&!isSold(a)?`<div class="bar"><button type="button" class="btn tag" data-goto="fit">${CAM} Fit collar</button></div>`:''}
    <form id="af" class="card" autocomplete="off">
      <div class="grid2">
        <label class="f">Type<select id="a-kind">${Object.entries(KIND).map(([k,v])=>`<option value="${k}" ${a.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <div class="f" style="grid-column:1/-1"><label for="a-collar">Collar #</label><div class="inrow"><input id="a-collar" type="text" inputmode="numeric" list="collarlist" value="${esc(a.collar||'')}">${camButton('a-cphoto')}</div><datalist id="collarlist">${freeCollars().map(c=>`<option value="${esc(c.number)}">`).join('')}</datalist><div id="a-scan"></div></div>
        <label class="f">Group<input id="a-group" type="text" list="grouplist" value="${esc(a.group||'')}"><datalist id="grouplist">${groups().map(g=>`<option value="${esc(g)}">`).join('')}</datalist></label>
        <label class="check"><input id="a-on" type="checkbox" ${a.collarOn?'checked':''}> Collar fitted</label>
        <label class="f">Brand<input id="a-b1" type="text" value="${esc(a.brand1||'')}"></label>
        <label class="f">Second brand (optional)<input id="a-b2" type="text" value="${esc(a.brand2||'')}"></label>
      </div>
      <div class="grid2">
        <label class="f">Visual tag (VID)<input id="a-vid" type="text" value="${esc(a.vid||'')}"></label>
        <label class="f">EID / RFID tag<input id="a-eid" type="text" inputmode="numeric" value="${esc(a.eid||'')}"></label>
        <label class="f">Breed<input id="a-breed" type="text" list="breedlist" value="${esc(a.breed||'')}"><datalist id="breedlist">${[...new Set(animals().map(x=>x.breed).filter(Boolean))].map(b=>`<option value="${esc(b)}">`).join('')}</datalist></label>
        <label class="f">Date of birth<input id="a-dob" type="date" value="${esc(a.birthDate||'')}"></label>
      </div>
      <label class="f">Notes<textarea id="a-notes">${esc(a.notes||'')}</textarea></label>
      ${fin()?`      <div class="grid2">
        <label class="f">Purchase price ($)<input id="a-pp" type="text" inputmode="decimal" value="${esc(mv('purchasePrice'))}"></label>
        <label class="f">Purchase date<input id="a-pd" type="date" value="${esc(a.purchaseDate||'')}"></label>
        <label class="f">Sale price ($)<input id="a-sp" type="text" inputmode="decimal" value="${esc(mv('salePrice'))}"></label>
        <label class="f">Sale date<input id="a-sd" type="date" value="${esc(a.saleDate||'')}"></label>
      </div>
      <div class="small muted" id="a-margin"></div>`:''}
      <div id="a-warn"></div>
      <div class="bar"><button class="btn primary" type="submit" style="flex:1">${id?'Save changes':'Add animal'}</button>${id?'<button class="btn danger" type="button" id="a-del">Delete</button>':''}</div>
    </form>
    ${id?`<div class="card">
      <button type="button" class="updated" id="a-hist">Last updated ${esc(ago(a.updatedAt))}${a.updatedBy?` by ${esc(a.updatedBy)}`:''} · show changes</button>
      <div id="a-histlist" hidden></div>
    </div>
    ${(()=>{ if(a.kind==='bull'||a.kind==='steer') return ''; const b=breedingFor(a); return `<div class="card"><b>Breeding</b>${b?`<div><span class="pill ${BSTATUS[b.status][1]}">${BSTATUS[b.status][0]}</span> ${b.from&&b.status!=='calved'&&b.status!=='open'?`Due ${esc(fmtDate(b.from))} – ${esc(fmtDate(b.to))}`:''}</div>`:'<div class="small muted">Nothing recorded.</div>'}<div class="bar"><button type="button" class="btn" data-goto="breed">Breeding details</button></div></div>`; })()}
    <div class="card"><b>Health</b>${(()=>{ const ts=treatmentsFor(id), w=withdrawalUntil(id); return (w?`<div class="notice warn">On withdrawal until ${esc(fmtDate(w))}</div>`:'')+(ts.length?ts.slice(0,8).map(t=>`<div class="exp"><span>${esc(t.product)}${t.dose?' · '+esc(t.dose):''}</span><span class="muted">${esc(fmtDate(t.date))}</span></div>`).join(''):'<div class="small muted">No treatments recorded.</div>'); })()}
      <div class="bar"><button type="button" class="btn" data-goto="treat">Record treatment</button></div></div>
    <div class="card"><b>${a.kind==='bull'?'Cows he has been with':'Bulls she has been with'}</b>
      ${xs.length? xs.map(x=> a.kind==='bull' ? expLine(x,false) : expLine(x,true)).join('') : '<div class="small muted">None recorded.</div>'}
    </div>`:''}
  `);
  const margin=()=>{ const p=parseMoney($('#a-pp').value), s=parseMoney($('#a-sp').value);
    $('#a-margin').textContent = (typeof p==='number' && typeof s==='number') ? `Difference: ${money(s-p)}` : ''; };
  if(fin()){ $('#a-pp').addEventListener('input',margin); $('#a-sp').addEventListener('input',margin); margin();
    $('#a-sd').addEventListener('change', ()=>{ const w=id&&withdrawalUntil(id); if(w && $('#a-sd').value && $('#a-sd').value<=w) $('#a-warn').innerHTML=`<div class="notice warn">This animal is on withdrawal until ${esc(fmtDate(w))}.</div>`; }); }
  $('#sheet').querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click', ()=>{ if(b.dataset.goto==='breed') openBreedCow(id); else if(b.dataset.goto==='fit') openFitCollar(id); else openTreatment(null,[id]); }));
  const collarInput=$('#a-collar');
  const checkDup=()=>{ const v=collarInput.value.trim(); const d=v && onHand().find(o=>o.id!==id && ckey(o.collar)===ckey(v)); const c=v && collarFor(v);
    $('#a-warn').innerHTML = d?`<div class="notice warn">Collar ${esc(v)} is already on ${esc(label(d))}${d.group?' in '+esc(d.group):''}.</div>`
      : (c && c.status==='lost') ? `<div class="notice warn">Collar ${esc(v)} is marked lost in the collar list.</div>`
      : (v && !c && S.collars.size) ? `<div class="notice warn">Collar ${esc(v)} isn’t in your collar list. You can add it from the Collars tab.</div>` : ''; };
  collarInput.addEventListener('input', checkDup);
  wireScan('#a-cphoto', '#a-scan', n=>{ collarInput.value=n; checkDup(); });
  if(id){
    $('#a-hist').addEventListener('click', ()=>{
      const box=$('#a-histlist'); if(!box.hidden){ box.hidden=true; return; }
      box.hidden=false; box.innerHTML=logHtml(S.history.filter(h=>h.targetId===id).sort((x,y)=>y.at-x.at));
    });
    const del=$('#a-del');
    del.addEventListener('click', ()=>{
      if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent='Tap again to delete'; return; }
      remove('animals/'+id);
      logChange(id,'animal',label(a),'deleted',FIELDS.filter(([k])=>a[k]!==undefined&&a[k]!==''&&a[k]!==false).map(([k])=>({f:k,from:a[k],to:''})));
      closeSheet(); toast(label(a)+' deleted');
    });
  }
  $('#af').addEventListener('submit', e=>{
    e.preventDefault();
    const pp=fin()?parseMoney($('#a-pp').value):'', sp=fin()?parseMoney($('#a-sp').value):'';
    if(pp===null || sp===null){ $('#a-warn').innerHTML='<div class="notice warn">Prices should be numbers, like 2450 or 2450.50.</div>'; return; }
    const v={ kind:$('#a-kind').value, collar:collarInput.value.trim(), group:$('#a-group').value.trim(), brand1:$('#a-b1').value.trim(), brand2:$('#a-b2').value.trim(), collarOn:$('#a-on').checked, notes:$('#a-notes').value.trim(),
      vid:$('#a-vid').value.trim(), eid:$('#a-eid').value.trim(), breed:$('#a-breed').value.trim(), birthDate:$('#a-dob').value,
      purchasePrice:pp, purchaseDate:fin()?$('#a-pd').value:'', salePrice:sp, saleDate:fin()?$('#a-sd').value:'' };
    if(!fin()) FIN.forEach(k=>delete v[k]);
    if(!v.collar && !v.brand1){ $('#a-warn').innerHTML='<div class="notice warn">Enter a collar number or a brand so you can find this animal later.</div>'; return; }
    const now=Date.now();
    if(!id){
      const nid=rid();
      put('animals/'+nid, {...v, createdAt:now, updatedAt:now, updatedBy:me()});
      logChange(nid,'animal',label(v),'added',FIELDS.filter(([k])=>k in v&&v[k]!==''&&v[k]!==false).map(([k])=>({f:k,to:v[k]})));
      closeSheet(); toast('Added '+label(v));
    } else {
      const blank = k => k==='collarOn'?false:'';
      const changes=FIELDS.filter(([k])=>k in v&&(a[k]??blank(k))!==v[k]).map(([k])=>({f:k,from:a[k]??'',to:v[k]}));
      if(!changes.length){ closeSheet(); return; }
      const upd={updatedAt:now, updatedBy:me()}; changes.forEach(c=>upd[c.f]=v[c.f]);
      patch('animals/'+id, upd);
      logChange(id,'animal',label(v),'edited',changes);
      closeSheet(); toast('Saved');
    }
  });
}

function openExposure(bullId, presetCows){
  const bs=bulls();
  const g=groups();
  let mode=presetCows&&presetCows.length?'pick':'group';
  openSheet(`
    <div class="sheet-h"><h2>Record breeding</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="ef" class="card">
      <label class="f">Bull<select id="e-bull">${bs.map(b=>`<option value="${esc(b.id)}" ${b.id===bullId?'selected':''}>${esc(label(b))}${b.brand1?' · '+esc(b.brand1):''}</option>`).join('')}<option value="" ${!bs.length?'selected':''}>AI or bull not in Herd Book</option></select></label>
      <div class="seg" id="e-mode"><button type="button" data-m="group" aria-pressed="${mode==='group'}">Whole group</button><button type="button" data-m="pick" aria-pressed="${mode==='pick'}">Pick cows</button></div>
      <div id="e-groupbox" ${mode!=='group'?'hidden':''}><label class="f">Group<select id="e-group">${g.map(x=>`<option>${esc(x)}</option>`).join('')||'<option value="">No groups yet</option>'}</select></label></div>
      <div id="e-pickbox" ${mode!=='pick'?'hidden':''}>
        <input id="e-filter" type="search" placeholder="Filter by collar, brand or group">
        <div class="picklist" id="e-pick" style="margin-top:8px">${females().sort(byCollar).map(c=>`<label data-s="${esc([c.collar,c.brand1,c.brand2,c.group].join(' ').toLowerCase())}"><input type="checkbox" value="${esc(c.id)}" ${presetCows&&presetCows.includes(c.id)?'checked':''}> <span>${esc(label(c))} ${c.brand1?'· '+esc(c.brand1):''} <span class="muted small">${esc(c.group||'')}</span></span></label>`).join('')}</div>
      </div>
      <div class="small muted" id="e-count"></div>
      <div class="grid2">
        <label class="f">Bull in, or AI date<input id="e-start" type="date" value="${today()}"></label>
        <label class="f">Bull out (blank if still in; same day for AI)<input id="e-end" type="date"></label>
      </div>
      <label class="f">Note<input id="e-note" type="text" placeholder="Pasture, field, etc."></label>
      <button class="btn primary" type="submit">Save</button>
    </form>`);
  const pickIds=()=> mode==='group' ? females().filter(c=>c.group && c.group===$('#e-group').value).map(c=>c.id) : [...document.querySelectorAll('#e-pick input:checked')].map(i=>i.value);
  const count=()=>{ const s=$('#e-start').value, e2=$('#e-end').value||s, G=gestation(); $('#e-count').textContent = `${pickIds().length} cows and heifers. Calving window: ${s?fmtDate(addDays(s,G)):'?'} – ${$('#e-end').value?fmtDate(addDays(e2,G)):'grows until the bull is out'}.`; };
  $('#e-start').addEventListener('change',count); $('#e-end').addEventListener('change',count);
  $('#e-mode').addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; mode=b.dataset.m;
    document.querySelectorAll('#e-mode button').forEach(x=>x.setAttribute('aria-pressed',x===b)); $('#e-groupbox').hidden=mode!=='group'; $('#e-pickbox').hidden=mode!=='pick'; count(); });
  $('#e-group').addEventListener('change',count); $('#e-pick').addEventListener('change',count);
  $('#e-filter').addEventListener('input', e=>{ const q=e.target.value.toLowerCase().trim(); document.querySelectorAll('#e-pick label').forEach(l=>l.hidden = !!q && !l.dataset.s.includes(q)); });
  count();
  $('#ef').addEventListener('submit', e=>{
    e.preventDefault();
    const ids=pickIds(); if(!ids.length){ toast('Choose at least one cow'); return; }
    const bull=S.animals.get($('#e-bull').value) || null;
    const rec={ bullId:bull?bull.id:'', cowIds:ids, group: mode==='group'?$('#e-group').value:'', start:$('#e-start').value||today(), end:$('#e-end').value||'', note:$('#e-note').value.trim(), updatedAt:Date.now(), updatedBy:me() };
    const xid=rid();
    put('exposures/'+xid, rec);
    const bname = bull ? label(bull) : 'AI / outside bull';
    logChange(xid,'exposure',`${bname} with ${rec.group||'selected cows'} (${ids.length} head)`,'added',[{f:'Put in',to:fmtDate(rec.start)}].concat(rec.end?[{f:'Pulled',to:fmtDate(rec.end)}]:[]));
    if(bull) logChange(bull.id,'animal',label(bull),'put with cows',[{f:'Cows',to:`${rec.group||'selected cows'} · ${ids.length} head from ${fmtDate(rec.start)}`}]);
    closeSheet(); toast('Recorded');
  });
}
function openPull(xid){
  const x=S.exposures.get(xid); if(!x) return; const b=S.animals.get(x.bullId);
  openSheet(`<div class="sheet-h"><h2>Pull ${esc(label(b))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="pf" class="card"><div class="small muted">In with ${esc(x.group||'selected cows')} since ${esc(fmtDate(x.start))}.</div>
    <label class="f">Pulled on<input id="p-end" type="date" value="${today()}"></label>
    <button class="btn primary" type="submit">Save</button></form>`);
  $('#pf').addEventListener('submit', e=>{ e.preventDefault(); const end=$('#p-end').value||today();
    patch('exposures/'+xid, {end, updatedAt:Date.now(), updatedBy:me()});
    logChange(xid,'exposure',`${label(b)} pulled from ${x.group||'selected cows'}`,'edited',[{f:'Pulled',from:'',to:fmtDate(end)}]);
    if(b) logChange(b.id,'animal',label(b),'pulled',[{f:'Pulled',to:fmtDate(end)}]);
    closeSheet(); toast('Bull pulled'); });
}
function openCows(xid){
  const x=S.exposures.get(xid); if(!x) return; const b=S.animals.get(x.bullId);
  const cows=(x.cowIds||[]).map(id=>S.animals.get(id)||{id,collar:'',kind:'cow',deleted:true}).sort(byCollar);
  openSheet(`<div class="sheet-h"><h2>${esc(label(b))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="small muted">${esc(x.group||'Selected cows')} · ${esc(fmtDate(x.start))} – ${x.end?esc(fmtDate(x.end)):'still in'}${x.note?' · '+esc(x.note):''}</div>
    <div class="list">${cows.map(c=>`<button type="button" class="row" ${c.deleted?'disabled':`data-id="${esc(c.id)}"`}>${collarHtml(c)}<span class="main"><span class="line1">${c.deleted?'<span class="muted">Deleted animal</span>':brandsHtml(c)||'<span class="muted">No brand</span>'}</span><span class="line2">${esc(c.group||'')}</span></span><span></span></button>`).join('')}</div>`);
  $('#sheet .list').addEventListener('click', e=>{ const r=e.target.closest('[data-id]'); if(r) openAnimal(r.dataset.id); });
}

// ---------- backup / import ----------
const csvCell = v => { v=String(v??''); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
async function saveFile(filename, data, type){
  const blob = new Blob([data], {type});
  try{
    const file = new File([blob], filename, {type});
    if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({files:[file], title:filename}); return;
    }
  }catch(e){ if(e && e.name==='AbortError') return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast('Saved '+filename);
}
function parseCsv(text){
  const out=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else q=false; } else cell+=c; }
    else if(c==='"') q=true; else if(c===','){ row.push(cell); cell=''; }
    else if(c==='\n'||c==='\r'){ if(c==='\r'&&text[i+1]==='\n') i++; row.push(cell); out.push(row); row=[]; cell=''; }
    else cell+=c; }
  if(cell||row.length){ row.push(cell); out.push(row); }
  return out.filter(r=>r.some(x=>x.trim()));
}
// ---------- shared date helpers ----------
const addDays = (d, n) => { if(!d) return ''; const x=new Date(d+'T12:00'); x.setDate(x.getDate()+Number(n||0)); return x.toLocaleDateString('en-CA'); };
const daysBetween = (a, b) => Math.round((new Date(b+'T12:00') - new Date(a+'T12:00'))/86400000);
const shortDate = d => d ? new Date(d+'T12:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '';
const yearOf = d => d ? String(d).slice(0,4) : '';
const pct = (a, b) => b ? (a/b*100) : null;
const fmtPct = p => p==null ? '—' : (p>0?'+':'')+p.toFixed(1)+'%';
function animalPicker(id, list, checked){
  return `<input id="${id}-filter" type="search" placeholder="Filter by collar, brand or group">
    <div class="picklist" id="${id}" style="margin-top:8px">${list.sort(byCollar).map(c=>`<label data-s="${esc([c.collar,c.brand1,c.brand2,c.group,c.vid,KIND[c.kind]].join(' ').toLowerCase())}"><input type="checkbox" value="${esc(c.id)}" ${checked&&checked.includes(c.id)?'checked':''}> <span>${esc(label(c))} ${c.brand1?'· '+esc(c.brand1):''} <span class="muted small">${esc(c.group||'')}</span></span></label>`).join('')}</div>`;
}
function wirePicker(id){
  const f=$('#'+id+'-filter'); f && f.addEventListener('input', e=>{ const q=e.target.value.toLowerCase().trim(); document.querySelectorAll('#'+id+' label').forEach(l=>l.hidden = !!q && !l.dataset.s.includes(q)); });
  return () => [...document.querySelectorAll('#'+id+' input:checked')].map(i=>i.value);
}

// ---------- health: vaccines & medicines ----------
const ROUTES = ['Subcutaneous (SC)','Intramuscular (IM)','Pour-on','Oral','Intranasal','Intravenous (IV)','Topical'];
const TTYPE = {vaccine:'Vaccine', medicine:'Medicine', other:'Other'};
const treatments = () => [...S.treatments.values()].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.updatedAt||0)-(a.updatedAt||0));
const treatmentsFor = id => treatments().filter(t=>(t.animalIds||[]).includes(id));
const withdrawalEnd = t => (t.withdrawalDays!==''&&t.withdrawalDays!=null&&Number(t.withdrawalDays)>0) ? addDays(t.date, Number(t.withdrawalDays)) : '';
function withdrawalUntil(id){ let end=''; treatmentsFor(id).forEach(t=>{ const e=withdrawalEnd(t); if(e && e>=today() && e>end) end=e; }); return end; }
function boostersDue(){
  // latest record per animal+product with a booster date; due if within 30 days or overdue
  const seen=new Set(), out=[];
  treatments().forEach(t=>{ (t.animalIds||[]).forEach(aid=>{ const k=aid+'|'+String(t.product).toLowerCase(); if(seen.has(k)) return; seen.add(k);
    const a=S.animals.get(aid); if(!a || isSold(a) || !t.boosterDue) return;
    const d=daysBetween(today(), t.boosterDue); if(d<=30) out.push({a, t, d}); }); });
  return out.sort((x,y)=>x.d-y.d);
}
function treatmentCard(t){
  const ids=t.animalIds||[]; const names=ids.slice(0,6).map(id=>{ const a=S.animals.get(id); return a?(a.collar?'#'+a.collar:(a.brand1||label(a))):'(deleted)'; });
  const w=withdrawalEnd(t);
  return `<button type="button" class="row" style="grid-template-columns:1fr auto" data-treat="${esc(t.id)}"><span class="main">
    <span class="line1">${esc(t.product||'Treatment')} <span class="pill ${t.kind==='vaccine'?'ok':''}">${esc(TTYPE[t.kind]||'Other')}</span>${w&&w>=today()?`<span class="pill warn">Withdrawal to ${esc(shortDate(w))}</span>`:''}</span>
    <span class="line2">${esc(fmtDate(t.date))} · ${ids.length} head${t.group?' · '+esc(t.group):''}${t.dose?' · '+esc(t.dose):''}${t.route?' · '+esc(t.route):''}</span>
    <span class="line2">${esc(names.join(', '))}${ids.length>6?' …':''}${t.givenBy?' · by '+esc(t.givenBy):''}${fin()&&t.cost!==''&&t.cost!=null?' · '+esc(money(t.cost)):''}</span></span><span></span></button>`;
}
function renderHealth(){
  const q=($('#hq').value||'').toLowerCase().trim();
  const due=boostersDue();
  const wd=onHand().map(a=>({a, end:withdrawalUntil(a.id)})).filter(x=>x.end).sort((x,y)=>x.end.localeCompare(y.end));
  $('#healthDue').innerHTML = (due.length?`<div class="card"><b>Boosters due</b>${due.map(({a,t,d})=>`<div class="exp"><span>${esc(label(a))} ${brandsHtml(a)} · ${esc(t.product)}</span><span class="${d<0?'warn-text':'muted'}">${d<0?`${-d} d overdue`:d===0?'today':`in ${d} d`} (${esc(shortDate(t.boosterDue))})</span></div>`).join('')}</div>`:'')
    + (wd.length?`<div class="card"><b>On withdrawal: don’t sell or slaughter yet</b>${wd.map(({a,end})=>`<div class="exp"><span>${esc(label(a))} ${brandsHtml(a)}</span><span class="warn-text">until ${esc(fmtDate(end))}</span></div>`).join('')}</div>`:'');
  const list=treatments().filter(t=>!q || [t.product,t.kind,t.notes,t.batch,t.group,t.givenBy, ...(t.animalIds||[]).map(id=>{ const a=S.animals.get(id); return a?[a.collar,a.brand1,a.brand2,a.vid].join(' '):''; })].join(' ').toLowerCase().includes(q));
  $('#healthList').innerHTML = !S.treatments.size ? `<div class="empty"><strong>No treatments recorded yet</strong>Tap “Record treatment” after vaccinating or treating a cow or a whole group.</div>`
    : !list.length ? `<div class="empty"><strong>No matches</strong>Nothing matches “${esc(q)}”.</div>`
    : `<div class="list">${list.map(treatmentCard).join('')}</div>`;
}
function openTreatment(id, presetIds){
  const t = id ? S.treatments.get(id) : {date:today(), kind:'vaccine', animalIds:presetIds||[], givenBy:me()};
  if(id && !t) return;
  const products=[...new Set(treatments().map(x=>x.product).filter(Boolean))];
  const g=groups(); let mode = (t.animalIds||[]).length ? 'pick' : 'group';
  openSheet(`<div class="sheet-h"><h2>${id?'Treatment':'Record treatment'}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="tf" class="card" autocomplete="off">
      <div class="grid2">
        <label class="f">Product<input id="t-product" type="text" list="t-products" value="${esc(t.product||'')}" placeholder="e.g. Bovi-Shield Gold"><datalist id="t-products">${products.map(p=>`<option value="${esc(p)}">`).join('')}</datalist></label>
        <label class="f">Type<select id="t-kind">${Object.entries(TTYPE).map(([k,v])=>`<option value="${k}" ${t.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="f">Date given<input id="t-date" type="date" value="${esc(t.date||today())}"></label>
        <label class="f">Dose<input id="t-dose" type="text" value="${esc(t.dose||'')}" placeholder="e.g. 2 mL"></label>
        <label class="f">Route<input id="t-route" type="text" list="t-routes" value="${esc(t.route||'')}"><datalist id="t-routes">${ROUTES.map(r=>`<option value="${esc(r)}">`).join('')}</datalist></label>
        <label class="f">Withdrawal (days)<input id="t-wd" type="text" inputmode="numeric" value="${esc(t.withdrawalDays??'')}" placeholder="0 if none"></label>
        <label class="f">Booster due (optional)<input id="t-boost" type="date" value="${esc(t.boosterDue||'')}"></label>
        <label class="f">Batch / lot<input id="t-batch" type="text" value="${esc(t.batch||'')}"></label>
        <label class="f">Given by<input id="t-by" type="text" value="${esc(t.givenBy||'')}"></label>
        ${fin()?`<label class="f">Cost ($, optional)<input id="t-cost" type="text" inputmode="decimal" value="${esc(t.cost??'')}"></label>`:''}
      </div>
      <div class="small muted" id="t-wdnote"></div>
      <b>Given to</b>
      <div class="seg" id="t-mode"><button type="button" data-m="group" aria-pressed="${mode==='group'}">Whole group</button><button type="button" data-m="pick" aria-pressed="${mode==='pick'}">Pick animals</button></div>
      <div id="t-groupbox" ${mode!=='group'?'hidden':''}><label class="f">Group<select id="t-group">${g.map(x=>`<option ${x===t.group?'selected':''}>${esc(x)}</option>`).join('')||'<option value="">No groups yet</option>'}</select></label></div>
      <div id="t-pickbox" ${mode!=='pick'?'hidden':''}>${animalPicker('t-pick', onHand(), t.animalIds)}</div>
      <div class="small muted" id="t-count"></div>
      <label class="f">Notes<textarea id="t-notes">${esc(t.notes||'')}</textarea></label>
      <div id="t-warn"></div>
      <div class="bar"><button class="btn primary" type="submit" style="flex:1">${id?'Save changes':'Save treatment'}</button>${id?'<button class="btn danger" type="button" id="t-del">Delete</button>':''}</div>
    </form>`);
  const picked = wirePicker('t-pick');
  const ids = () => mode==='group' ? onHand().filter(a=>a.group && a.group===$('#t-group').value).map(a=>a.id) : picked();
  const count = () => { $('#t-count').textContent = `${ids().length} head will get this treatment.`;
    const wd=Number($('#t-wd').value)||0; $('#t-wdnote').textContent = wd>0 ? `Withdrawal ends ${fmtDate(addDays($('#t-date').value||today(), wd))}.` : ''; };
  $('#t-mode').addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; mode=b.dataset.m; $('#t-mode').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); $('#t-groupbox').hidden=mode!=='group'; $('#t-pickbox').hidden=mode!=='pick'; count(); });
  ['#t-group','#t-pick','#t-wd','#t-date'].forEach(s=>{ const el=$(s); el && el.addEventListener(s==='#t-wd'?'input':'change', count); });
  count();
  const del=$('#t-del');
  del && del.addEventListener('click', ()=>{ if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent='Tap again to delete'; return; }
    remove('treatments/'+id); logChange(id,'treatment',`${t.product} (${(t.animalIds||[]).length} head)`,'deleted',[]); closeSheet(); toast('Treatment deleted'); });
  $('#tf').addEventListener('submit', e=>{
    e.preventDefault();
    const list=ids(); const cost=fin()?parseMoney($('#t-cost').value):undefined;
    if(!$('#t-product').value.trim()){ $('#t-warn').innerHTML='<div class="notice warn">Enter the product name.</div>'; return; }
    if(!list.length){ $('#t-warn').innerHTML='<div class="notice warn">Choose who got it.</div>'; return; }
    if(cost===null){ $('#t-warn').innerHTML='<div class="notice warn">Cost should be a number.</div>'; return; }
    const wd=$('#t-wd').value.trim(); if(wd && isNaN(Number(wd))){ $('#t-warn').innerHTML='<div class="notice warn">Withdrawal should be a number of days.</div>'; return; }
    const rec={ product:$('#t-product').value.trim(), kind:$('#t-kind').value, date:$('#t-date').value||today(), dose:$('#t-dose').value.trim(), route:$('#t-route').value.trim(),
      withdrawalDays: wd===''?'':Number(wd), boosterDue:$('#t-boost').value, batch:$('#t-batch').value.trim(), givenBy:$('#t-by').value.trim(),
      animalIds:list, group: mode==='group'?$('#t-group').value:'', notes:$('#t-notes').value.trim(), updatedAt:Date.now(), updatedBy:me() };
    if(fin()) rec.cost=cost;
    if(id){ patch('treatments/'+id, rec); logChange(id,'treatment',`${rec.product} (${list.length} head)`,'edited',[]); }
    else { const nid=rid(); put('treatments/'+nid, rec); logChange(nid,'treatment',`${rec.product} given to ${list.length} head${rec.group?' in '+rec.group:''}`,'added',[]); }
    closeSheet(); toast(id?'Saved':`Recorded for ${list.length} head`);
  });
}
$('#treatBtn').addEventListener('click', ()=>openTreatment(null));
$('#hq').addEventListener('input', renderHealth);
$('#healthList').addEventListener('click', e=>{ const r=e.target.closest('[data-treat]'); if(r) openTreatment(r.dataset.treat); });

// ---------- breeding: pregnancy & calving ----------
const gestation = () => Number(cfg.gestation)||283;
const pregRecs = id => [...S.preg.values()].filter(p=>p.cowId===id).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
function breedingFor(cow){
  const ex = expsForCow(cow.id)[0];
  const recs = pregRecs(cow.id);
  if(!ex && !recs.length) return null;
  const since = ex ? ex.start : '';
  const recent = recs.filter(p=>!since || (p.date||'')>=since);
  const calving = recent.find(p=>p.type==='calving');
  const check = recent.find(p=>p.type==='check');
  const G = gestation();
  let from='', to='', basis='';
  if(check && check.result==='pregnant' && check.daysPregnant!=='' && check.daysPregnant!=null && !isNaN(Number(check.daysPregnant))){
    const due = addDays(check.date, G - Number(check.daysPregnant)); from=addDays(due,-7); to=addDays(due,7); basis='from preg check';
  } else if(ex){ from=addDays(ex.start, G); to=addDays(ex.end||today(), G); basis = ex.end ? 'from exposure dates' : 'bull still in; window grows until he’s pulled'; }
  const status = calving ? 'calved' : check && check.result==='open' ? 'open' : check && check.result==='pregnant' ? 'pregnant' : ex ? 'exposed' : 'unknown';
  return { ex, check, calving, from, to, basis, status };
}
const BSTATUS = {calved:['Calved','ok'], open:['Open','warn'], pregnant:['Pregnant','ok'], exposed:['Exposed',''], unknown:['—','']};
function breedRow(a, b){
  const [txt,cls]=BSTATUS[b.status];
  const win = b.status==='calved' ? `Calved ${fmtDate(b.calving.date)}` : b.status==='open' ? `Checked open ${fmtDate(b.check.date)}` : b.from ? `Due ${shortDate(b.from)} – ${shortDate(b.to)}` : '';
  const bull = b.ex ? (b.ex.bullId ? label(S.animals.get(b.ex.bullId)) : 'AI / no bull') : '';
  return `<button type="button" class="row" data-breed="${esc(a.id)}">${collarHtml(a)}<span class="main"><span class="line1">${brandsHtml(a)||'<span class="muted">No brand</span>'} <span class="pill ${cls}">${txt}</span></span><span class="line2">${esc(win)}${bull?' · '+esc(bull):''}</span></span><span></span></button>`;
}
function renderBreeding(){
  $('#gestNote').textContent = `Calving windows use a ${gestation()}-day gestation. Real calving can land about 10 days either side.`;
  const rows = onHand().filter(a=>a.kind!=='bull' && a.kind!=='steer').map(a=>({a, b:breedingFor(a)})).filter(x=>x.b);
  const t=today(), soon=addDays(t,30), recentCalved=addDays(t,-60);
  const sec = (title, list, empty) => list.length ? `<h2>${title} · ${list.length}</h2><div class="list">${list.map(x=>breedRow(x.a,x.b)).join('')}</div>` : (empty?`<h2>${title}</h2><div class="small muted">${empty}</div>`:'');
  const active = rows.filter(x=>x.b.status==='pregnant'||x.b.status==='exposed').sort((x,y)=>(x.b.from||'').localeCompare(y.b.from||''));
  const calvingSoon = active.filter(x=>x.b.from && x.b.from<=soon);
  const later = active.filter(x=>!(x.b.from && x.b.from<=soon));
  $('#breedList').innerHTML = !rows.length ? `<div class="empty"><strong>No breeding recorded yet</strong>Record which bull went in with which cows (or an AI date) and each cow gets a calving window.</div>`
    : sec('Calving now or within 30 days', calvingSoon, 'None due in the next 30 days.')
    + sec('Expecting later', later)
    + sec('Open', rows.filter(x=>x.b.status==='open'))
    + sec('Calved in the last 60 days', rows.filter(x=>x.b.status==='calved' && x.b.calving.date>=recentCalved));
  renderBulls();
}
function openBreedCow(id){
  const a=S.animals.get(id); if(!a) return; const b=breedingFor(a)||{status:'unknown'};
  const G=gestation();
  openSheet(`<div id="bc" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>${esc(label(a))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="card">
      <div>${brandsHtml(a)} <span class="pill ${BSTATUS[b.status][1]}">${BSTATUS[b.status][0]}</span></div>
      ${b.from&&b.status!=='calved'&&b.status!=='open'?`<div style="font-size:20px;font-weight:700">Due ${esc(fmtDate(b.from))} – ${esc(fmtDate(b.to))}</div><div class="small muted">${esc(b.basis)} · ${G}-day gestation</div>`:''}
      ${b.ex?`<div class="small">Exposed ${esc(fmtDate(b.ex.start))} – ${b.ex.end?esc(fmtDate(b.ex.end)):'still in'} · ${esc(b.ex.bullId?label(S.animals.get(b.ex.bullId)):'AI / no bull')}</div>`:''}
      ${b.check?`<div class="small">Preg check ${esc(fmtDate(b.check.date))}: <b>${esc(b.check.result)}</b>${b.check.daysPregnant!==''&&b.check.daysPregnant!=null?` · ${esc(b.check.daysPregnant)} days along`:''}</div>`:''}
      ${b.calving?`<div class="small">Calved ${esc(fmtDate(b.calving.date))}${b.calving.calfSex?' · '+esc(b.calving.calfSex):''}${b.calving.notes?' · '+esc(b.calving.notes):''}</div>`:''}
      <div class="bar"><button type="button" class="btn" data-act="check">Record preg check</button><button type="button" class="btn tag" data-act="calving">Record calving</button></div>
      <div class="bar"><button type="button" class="btn" data-act="expose">Record breeding</button><button type="button" class="btn" data-act="open">Cow details</button></div>
    </div>
    ${pregRecs(id).length?`<div class="card"><b>History</b>${pregRecs(id).map(p=>`<div class="exp"><span>${p.type==='calving'?'Calved':'Preg check: '+esc(p.result)}${p.notes?' · '+esc(p.notes):''}</span><span class="muted">${esc(fmtDate(p.date))} <button type="button" class="linkbtn" data-delp="${esc(p.id)}">remove</button></span></div>`).join('')}</div>`:''}
  </div>`);
  $('#bc').addEventListener('click', e=>{
    const b2=e.target.closest('[data-act]');
    if(b2){ const act=b2.dataset.act; if(act==='open') return openAnimal(id); if(act==='expose') return openExposure(null, [id]); return openPreg(id, act); }
    const d=e.target.closest('[data-delp]'); if(d){ remove('preg/'+d.dataset.delp); logChange(id,'animal',label(a),'removed a breeding record',[]); openBreedCow(id); }
  });
}
function openPreg(cowId, type){
  const a=S.animals.get(cowId); if(!a) return;
  openSheet(`<div class="sheet-h"><h2>${type==='check'?'Preg check':'Calving'} · ${esc(label(a))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="pgf" class="card" autocomplete="off">
      <label class="f">Date<input id="pg-date" type="date" value="${today()}"></label>
      ${type==='check' ? `
        <div class="seg" id="pg-res"><button type="button" data-r="pregnant" aria-pressed="true">Pregnant</button><button type="button" data-r="open" aria-pressed="false">Open</button><button type="button" data-r="unsure" aria-pressed="false">Not sure</button></div>
        <label class="f">Days pregnant (optional, from the vet)<input id="pg-days" type="text" inputmode="numeric" placeholder="Makes the due date more exact"></label>
        <div class="small muted" id="pg-due"></div>`
      : `<div class="grid2"><label class="f">Calf<select id="pg-sex"><option value="">—</option><option>Heifer calf</option><option>Bull calf</option><option>Twins</option><option>Stillborn</option></select></label>
          <label class="f">Calf collar or tag (optional)<input id="pg-calftag" type="text"></label></div>
        <label class="check"><input id="pg-addcalf" type="checkbox" checked> Add the calf to the herd</label>`}
      <label class="f">Notes<input id="pg-notes" type="text"></label>
      <button class="btn primary" type="submit">Save</button>
    </form>`);
  let res='pregnant';
  const rs=$('#pg-res');
  const due=()=>{ const d=Number($('#pg-days')?.value); $('#pg-due') && ($('#pg-due').textContent = res==='pregnant' && d>0 ? `Due about ${fmtDate(addDays($('#pg-date').value||today(), gestation()-d))}.` : ''); };
  rs && rs.addEventListener('click', e=>{ const b=e.target.closest('[data-r]'); if(!b) return; res=b.dataset.r; rs.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); due(); });
  $('#pg-days') && $('#pg-days').addEventListener('input', due);
  $('#pgf').addEventListener('submit', e=>{
    e.preventDefault();
    const date=$('#pg-date').value||today(), notes=$('#pg-notes').value.trim(), pid=rid(), now=Date.now();
    if(type==='check'){
      const dp=$('#pg-days').value.trim();
      put('preg/'+pid, {cowId, type:'check', date, result:res, daysPregnant: dp===''||isNaN(Number(dp))?'':Number(dp), notes, updatedAt:now, updatedBy:me()});
      logChange(cowId,'animal',label(a),'preg checked',[{f:'Result',to:res+(dp?` (${dp} days)`:'')}]);
    } else {
      const sex=$('#pg-sex').value; let calfId='';
      if($('#pg-addcalf').checked && sex!=='Stillborn'){
        calfId=rid(); const calf={kind:'calf', collar:$('#pg-calftag').value.trim(), group:a.group||'', brand1:'', brand2:'', collarOn:false,
          notes:`${sex||'Calf'} of ${label(a)}`, birthDate:date, damId:cowId, createdAt:now, updatedAt:now, updatedBy:me()};
        put('animals/'+calfId, calf); logChange(calfId,'animal',label(calf),'born',[{f:'Dam',to:label(a)}]);
      }
      put('preg/'+pid, {cowId, type:'calving', date, calfSex:sex, calfId, notes, updatedAt:now, updatedBy:me()});
      logChange(cowId,'animal',label(a),'calved',[{f:'Calf',to:sex||'recorded'}]);
    }
    closeSheet(); toast('Saved'); openBreedCow(cowId);
  });
}
$('#breedList').addEventListener('click', e=>{ const r=e.target.closest('[data-breed]'); if(r) openBreedCow(r.dataset.breed); });
$('#gestBtn').addEventListener('click', ()=>{
  openSheet(`<div class="sheet-h"><h2>Gestation length</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="gf" class="card"><label class="f">Days from breeding to calving<input id="g-days" type="text" inputmode="numeric" value="${gestation()}"></label>
    <div class="small muted">Beef cattle average about 283 days. Some breeds run a few days shorter or longer.</div><button class="btn primary" type="submit">Save</button></form>`);
  $('#gf').addEventListener('submit', e=>{ e.preventDefault(); const d=Number($('#g-days').value); if(d>=250&&d<=310){ cfg.gestation=d; LS.set(K.cfg,cfg); closeSheet(); renderAll(); toast('Saved'); } else toast('Enter a number between 250 and 310'); });
});

// ---------- money (full access only) ----------
const EXP_CATS = ['Feed','Vet & medicine','Fuel','Labour','Repairs','Freight & trucking','Pasture & lease','Fees & commissions','Equipment','Other'];
function renderMoney(){
  if(!fin()){ $('#moneyBody').innerHTML='<div class="empty"><strong>Not available on this phone</strong>Money is only shown on phones with full access.</div>'; return; }
  const years=[...new Set([...animals().flatMap(a=>[yearOf(a.purchaseDate),yearOf(a.saleDate)]), ...[...S.expenses.values()].map(x=>yearOf(x.date)), ...[...S.treatments.values()].map(t=>yearOf(t.date))].filter(Boolean))].sort().reverse();
  const ySel=$('#mYear'), gSel=$('#mGroup');
  const yv=S.mYear||'', gv=S.mGroup||'';
  ySel.innerHTML=`<option value="">All years</option>`+years.map(y=>`<option ${y===yv?'selected':''}>${y}</option>`).join('');
  const allGroups=[...new Set(animals().map(a=>a.group).filter(Boolean))].sort();
  gSel.innerHTML=`<option value="">Whole herd</option>`+allGroups.map(g=>`<option ${g===gv?'selected':''}>${esc(g)}</option>`).join('');
  const inY = d => !yv || yearOf(d)===yv;
  const pool = animals().filter(a=>!gv || a.group===gv);
  const num = v => Number(v)||0, has = v => v!==''&&v!=null&&!isNaN(Number(v));
  const bought = pool.filter(a=>has(a.purchasePrice) && inY(a.purchaseDate||''));
  const sold = pool.filter(a=>isSold(a) && has(a.salePrice) && inY(a.saleDate||''));
  const purchases = bought.reduce((t,a)=>t+num(a.purchasePrice),0), sales = sold.reduce((t,a)=>t+num(a.salePrice),0);
  const exps = [...S.expenses.values()].filter(x=>inY(x.date) && (!gv || !x.group || x.group===gv)).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const expTotal = exps.reduce((t,x)=>t+num(x.amount),0);
  const tCost = [...S.treatments.values()].filter(t=>has(t.cost) && inY(t.date) && (!gv || (t.animalIds||[]).some(id=>(S.animals.get(id)||{}).group===gv))).reduce((t,x)=>t+num(x.cost),0);
  const costs = purchases + expTotal + tCost, net = sales - costs;
  const soldWithCost = sold.filter(a=>has(a.purchasePrice));
  const sp = soldWithCost.reduce((t,a)=>t+num(a.salePrice),0), cp = soldWithCost.reduce((t,a)=>t+num(a.purchasePrice),0);
  const onHandCost = pool.filter(a=>!isSold(a) && has(a.purchasePrice)).reduce((t,a)=>t+num(a.purchasePrice),0);
  const tile = (k, v, sub, cls) => `<div class="mtile ${cls||''}"><div class="small muted">${k}</div><div class="mv">${v}</div>${sub?`<div class="small muted">${sub}</div>`:''}</div>`;
  $('#moneyBody').innerHTML = `
    <div class="mtiles">
      ${tile('Net profit', money(net), `${fmtPct(pct(net, costs))} on ${money(costs)} spent`, net>=0?'good':'bad')}
      ${tile('Sales', money(sales), `${sold.length} head sold`)}
      ${tile('Purchases', money(purchases), `${bought.length} head bought`)}
      ${tile('Expenses', money(expTotal+tCost), tCost?`incl. ${money(tCost)} treatments`:`${exps.length} entries`)}
    </div>
    <div class="card"><b>Sold animals</b>
      <div class="small muted">Profit on animals with both a purchase and a sale price: ${money(sp-cp)} (${fmtPct(pct(sp-cp, cp))}). Expenses aren’t split per animal.</div>
      ${sold.length?`<div class="tablewrap"><table class="mtable"><thead><tr><th>Animal</th><th>Sold</th><th class="r">Bought</th><th class="r">Sold for</th><th class="r">Profit</th><th class="r">%</th></tr></thead><tbody>
      ${sold.sort((a,b)=>(b.saleDate||'').localeCompare(a.saleDate||'')).map(a=>{ const p=has(a.purchasePrice)?num(a.salePrice)-num(a.purchasePrice):null;
        return `<tr data-id="${esc(a.id)}"><td>${esc(label(a))}${a.brand1?' · '+esc(a.brand1):''}</td><td>${esc(shortDate(a.saleDate))}</td><td class="r">${has(a.purchasePrice)?money(a.purchasePrice):'—'}</td><td class="r">${money(a.salePrice)}</td><td class="r ${p==null?'':p>=0?'good-text':'warn-text'}">${p==null?'—':money(p)}</td><td class="r">${p==null?'—':fmtPct(pct(p,num(a.purchasePrice)))}</td></tr>`; }).join('')}
      </tbody></table></div>`:'<div class="small muted">No sales in this period.</div>'}
    </div>
    <div class="card"><b>On hand</b><div class="small muted">${pool.filter(a=>!isSold(a)).length} head on hand · ${money(onHandCost)} paid for those with a purchase price.</div></div>
    <div class="card"><div class="bar" style="justify-content:space-between"><b>Expenses</b><button type="button" class="btn primary" id="expAdd">+ Add expense</button></div>
      ${exps.length?`<div class="tablewrap"><table class="mtable"><thead><tr><th>Date</th><th>What</th><th class="r">Amount</th></tr></thead><tbody>${exps.map(x=>`<tr data-exp="${esc(x.id)}"><td>${esc(shortDate(x.date))}</td><td>${esc(x.category||'')}${x.description?' · '+esc(x.description):''}${x.group?` <span class="muted">(${esc(x.group)})</span>`:''}</td><td class="r">${money(x.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="small muted">No expenses in this period.</div>'}
    </div>`;
}
$('#mYear').addEventListener('change', e=>{ S.mYear=e.target.value; renderMoney(); });
$('#mGroup').addEventListener('change', e=>{ S.mGroup=e.target.value; renderMoney(); });
$('#moneyBody').addEventListener('click', e=>{
  if(e.target.closest('#expAdd')) return openExpense(null);
  const x=e.target.closest('[data-exp]'); if(x) return openExpense(x.dataset.exp);
  const r=e.target.closest('tr[data-id]'); if(r) openAnimal(r.dataset.id);
});
function openExpense(id){
  if(!fin()) return;
  const x = id ? S.expenses.get(id) : {date:today(), group:S.mGroup||''};
  if(id && !x) return;
  openSheet(`<div class="sheet-h"><h2>${id?'Expense':'Add expense'}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="xf" class="card" autocomplete="off"><div class="grid2">
      <label class="f">Date<input id="x-date" type="date" value="${esc(x.date||today())}"></label>
      <label class="f">Amount ($)<input id="x-amt" type="text" inputmode="decimal" value="${esc(x.amount??'')}"></label>
      <label class="f">Category<input id="x-cat" type="text" list="x-cats" value="${esc(x.category||'')}"><datalist id="x-cats">${EXP_CATS.map(c=>`<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="f">Group (optional)<select id="x-group"><option value="">Whole herd</option>${groups().map(g=>`<option ${g===x.group?'selected':''}>${esc(g)}</option>`).join('')}</select></label></div>
      <label class="f">Description<input id="x-desc" type="text" value="${esc(x.description||'')}" placeholder="e.g. 40 round bales"></label>
      <div id="x-warn"></div>
      <div class="bar"><button class="btn primary" type="submit" style="flex:1">Save</button>${id?'<button class="btn danger" type="button" id="x-del">Delete</button>':''}</div>
    </form>`);
  const del=$('#x-del'); del && del.addEventListener('click', ()=>{ if(!del.classList.contains('armed')){ del.classList.add('armed'); del.textContent='Tap again to delete'; return; } remove('expenses/'+id); logChange(id,'expense',`Expense: ${x.category||''} ${money(x.amount)}`,'deleted',[]); closeSheet(); toast('Deleted'); });
  $('#xf').addEventListener('submit', e=>{
    e.preventDefault(); const amt=parseMoney($('#x-amt').value);
    if(amt===null||amt===''){ $('#x-warn').innerHTML='<div class="notice warn">Enter the amount, like 1250 or 1250.50.</div>'; return; }
    const rec={date:$('#x-date').value||today(), amount:amt, category:$('#x-cat').value.trim()||'Other', group:$('#x-group').value, description:$('#x-desc').value.trim(), updatedAt:Date.now(), updatedBy:me()};
    if(id) patch('expenses/'+id, rec); else { const nid=rid(); put('expenses/'+nid, rec); id=nid; }
    logChange(id,'expense',`Expense: ${rec.category}${rec.description?' – '+rec.description:''}`,'saved',[{f:'amount',to:rec.amount}]);
    closeSheet(); toast('Saved');
  });
}

// ---------- spreadsheets: import ----------
let xlsxLoading=null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  return xlsxLoading || (xlsxLoading = new Promise((res, rej)=>{ const s=document.createElement('script'); s.src='./xlsx.mini.min.js'; s.onload=()=>res(window.XLSX); s.onerror=()=>{ xlsxLoading=null; rej(new Error('load')); }; document.head.appendChild(s); }));
}
async function readSheetFile(file){
  const name=file.name.toLowerCase();
  if(name.endsWith('.csv') || name.endsWith('.txt')) return { sheets:{ [file.name]: parseCsv(await file.text()) } };
  const X = await loadXLSX();
  const wb = X.read(await file.arrayBuffer(), {type:'array', cellDates:true});
  const sheets={}; wb.SheetNames.forEach(n=>{ sheets[n]=X.utils.sheet_to_json(wb.Sheets[n], {header:1, raw:true, defval:''}).filter(r=>r.some(v=>String(v).trim()!=='')); });
  return { sheets };
}
const IMPORT_FIELDS = () => [
  ['collar','Collar #',['collar','collarno','collarnumber','neckband']], ['kind','Type',['type','kind','class','stockclass','sex']], ['group','Group',['group','herd','pasture','mob','location']],
  ['brand1','Brand',['brand','brand1','tattooorbrand','tattoo']], ['brand2','2nd brand',['brand2','secondbrand']], ['vid','Visual tag (VID)',['vid','visualtag','tag','eartag','visualid','tagno']],
  ['eid','EID / RFID',['eid','rfid','ccia','cciatag','electronicid','eidtag','nlis']], ['breed','Breed',['breed']], ['birthDate','Date of birth',['dob','dateofbirth','birthdate','born','birth']],
  ['collarOn','Collar fitted',['collarfitted','fitted','collaron']], ['notes','Notes',['notes','note','comments','comment','remarks']],
  ...(fin()?[['purchasePrice','Purchase price',['purchaseprice','price','cost','boughtfor','purchase']], ['purchaseDate','Purchase date',['purchasedate','datebought','bought']], ['salePrice','Sale price',['saleprice','soldfor','sale']], ['saleDate','Sale date',['saledate','datesold','sold']]]:[])
];
const normHead = h => String(h).toLowerCase().replace(/[^a-z0-9]/g,'');
function toISO(v, order){
  if(v instanceof Date && !isNaN(v)) return v.toLocaleDateString('en-CA');
  const s=String(v||'').trim(); if(!s) return '';
  let m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if(m){ let [ ,a,b,y]=m; if(y.length===2) y=(Number(y)>50?'19':'20')+y; let mo=a, d=b; if(order==='dmy' || Number(a)>12) { mo=b; d=a; } if(Number(mo)>12) return ''; return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  const t=Date.parse(s); return isNaN(t)?'':new Date(t).toLocaleDateString('en-CA');
}
function kindOf(v){ const k=String(v||'').toLowerCase(); if(!k) return ''; if(k.startsWith('bull')&&!k.includes('calf')) return 'bull'; if(k.startsWith('heif')) return 'heifer'; if(k.startsWith('steer')) return 'steer'; if(k.includes('calf')) return 'calf'; if(k.startsWith('cow')||k==='f') return 'cow'; return ''; }
function openImport(){
  openSheet(`<div id="imp" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>Import a spreadsheet</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="card"><div class="small">Choose an Excel (.xlsx) or CSV file with one animal per row and column names in the first row. You’ll match the columns next.</div>
      <label class="btn primary" for="imp-file" style="text-align:center">Choose file</label><input id="imp-file" type="file" accept=".xlsx,.xlsm,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
      <div id="imp-msg" class="small"></div></div>
    <div id="imp-map"></div></div>`);
  $('#imp-file').addEventListener('change', async e=>{
    const file=e.target.files[0]; if(!file) return;
    $('#imp-msg').textContent='Reading…';
    let data; try{ data=await readSheetFile(file); }catch{ $('#imp-msg').textContent='That file couldn’t be read. Save it as .xlsx or .csv and try again.'; return; }
    const names=Object.keys(data.sheets).filter(n=>data.sheets[n].length>1);
    if(!names.length){ $('#imp-msg').textContent='No rows found in that file.'; return; }
    $('#imp-msg').textContent=`${file.name}`;
    mapStep(data.sheets, names, names[0]);
  });
}
function mapStep(sheets, names, sheetName){
  const all=sheets[sheetName];
  let hr=all.findIndex(r=>r.filter(v=>String(v).trim()!=='').length>=3); if(hr<0) hr=0;
  const rows=all.slice(hr), head=rows[0].map(h=>String(h).trim()), body=rows.slice(1);
  const isES = head.some(h=>/^neck\s*band$/i.test(h));
  const F=IMPORT_FIELDS();
  const guess = aliases => { const i=head.findIndex(h=>aliases.includes(normHead(h))); return i; };
  const opts = sel => `<option value="-1">— skip —</option>`+head.map((h,i)=>`<option value="${i}" ${i===sel?'selected':''}>${esc(h||'Column '+(i+1))}</option>`).join('');
  $('#imp-map').innerHTML = `<div class="card">
    ${isES?'<div class="notice ok">This looks like an eShepherd file. Neckband serials go into Collar #, and rows with no VID, EID or brand are skipped.</div>':''}
    ${names.length>1?`<label class="f">Sheet<select id="imp-sheet">${names.map(n=>`<option ${n===sheetName?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`:''}
    <b>Match the columns</b> <span class="small muted">${body.length} rows</span>
    <div class="grid2">${F.map(([k,l,al])=>`<label class="f">${esc(l)}<select data-map="${k}">${opts(guess(al))}</select></label>`).join('')}</div>
    <div class="grid2">
      <label class="f">Match existing animals by<select id="imp-match"><option value="collar">Collar #</option><option value="eid">EID / RFID</option><option value="vid">Visual tag</option><option value="none">Don’t match (always add new)</option></select></label>
      <label class="f">Dates like 03/04/2025 mean<select id="imp-order"><option value="mdy">Month/Day/Year</option><option value="dmy" ${isES?'selected':''}>Day/Month/Year</option></select></label>
    </div>
    <label class="check"><input id="imp-onlysold" type="checkbox"> Include animals that are already sold</label>
    <div id="imp-preview" class="small"></div>
    <button class="btn primary" type="button" id="imp-go">Import</button></div>`;
  const s=$('#imp-sheet'); s && s.addEventListener('change', e=>mapStep(sheets, names, e.target.value));
  const plan = () => {
    const map={}; document.querySelectorAll('[data-map]').forEach(el=>{ const i=Number(el.value); if(i>=0) map[el.dataset.map]=i; });
    const by=$('#imp-match').value, order=$('#imp-order').value, incl=$('#imp-onlysold').checked;
    const index={}; if(by!=='none') animals().forEach(a=>{ const v=String(a[by]||'').trim().toLowerCase(); if(v && (incl || !isSold(a))) index[v]=a; });
    const out={add:[], upd:[], skip:0};
    body.forEach(r=>{
      const v={}; Object.entries(map).forEach(([k,i])=>{ let x=r[i]; if(x==null) return;
        if(k==='birthDate'||k==='purchaseDate'||k==='saleDate') x=toISO(x, order);
        else if(k==='purchasePrice'||k==='salePrice'){ x=parseMoney(x instanceof Date?'':x); if(x===null) x=''; }
        else if(k==='collarOn') x=/^(y|yes|true|1|fitted|x)$/i.test(String(x).trim());
        else if(k==='kind') x=kindOf(x);
        else x=(x instanceof Date?x.toLocaleDateString('en-CA'):String(x)).trim();
        if(x!=='' && x!==false) v[k]=x; else if(k==='collarOn' && x===false) v[k]=false; });
      if(!v.brand1 && !v.vid && !v.eid && !(v.collar && (v.group||v.notes||v.kind||v.breed))){ out.skip++; return; }
      const key = by!=='none' ? String(v[by]||'').trim().toLowerCase() : '';
      const hit = key && index[key];
      if(hit){ const ch={}; Object.entries(v).forEach(([k,x])=>{ if((hit[k]??'')!==x && !(k==='collarOn' && !!hit[k]===x)) ch[k]=x; }); if(Object.keys(ch).length) out.upd.push([hit,ch]); }
      else { out.add.push(v); if(key) index[key]=v; }
    });
    return out;
  };
  const prev = () => { const p=plan(); $('#imp-preview').innerHTML = `<b>${p.add.length}</b> new animals, <b>${p.upd.length}</b> existing animals updated${p.skip?`, ${p.skip} rows skipped (no collar, brand or tag)`:''}.`; };
  $('#imp-map').addEventListener('change', prev); prev();
  $('#imp-go').addEventListener('click', ()=>{
    const p=plan(); const now=Date.now();
    p.add.forEach(v=>outbox.push({op:'set', path:'animals/'+rid(), data:{kind:'cow', collarOn:false, ...v, kind:v.kind||'cow', createdAt:now, updatedAt:now, updatedBy:me()}, t:now}));
    p.upd.forEach(([a,ch])=>outbox.push({op:'update', path:'animals/'+a.id, data:{...ch, updatedAt:now, updatedBy:me()}, base:baseOf('animals/'+a.id, ch), t:now}));
    saveOutbox();
    logChange('import','import',`Spreadsheet import: ${p.add.length} added, ${p.upd.length} updated`,'imported',[]);
    closeSheet(); toast(`Imported: ${p.add.length} added, ${p.upd.length} updated`);
  });
}

// ---------- spreadsheets: export ----------
const animalRow = (a, F) => Object.assign({
  'Type':KIND[a.kind]||'Cow', 'Collar':a.collar||'', 'Collar fitted':a.collarOn?'Yes':'No', 'Group':a.group||'', 'Brand':a.brand1||'', '2nd brand':a.brand2||'',
  'Visual tag (VID)':a.vid||'', 'EID / RFID':a.eid||'', 'Breed':a.breed||'', 'Date of birth':a.birthDate||'', 'Notes':a.notes||'' },
  F ? {'Purchase price':a.purchasePrice??'', 'Purchase date':a.purchaseDate||'', 'Sale price':a.salePrice??'', 'Sale date':a.saleDate||''} : {'Sold':isSold(a)?'Yes':''},
  (()=>{ const b=breedingFor(a); return {'Breeding status':b?BSTATUS[b.status][0]:'', 'Calving window':b&&b.from&&b.status!=='calved'&&b.status!=='open'?`${b.from} to ${b.to}`:'', 'On withdrawal until':withdrawalUntil(a.id)}; })(),
  {'Last updated':a.updatedAt?new Date(a.updatedAt).toLocaleString():''});
function exportPool(){ const w=$('#ex-which')?.value||'onhand'; return animals().filter(a=> w==='all' ? true : w==='onhand' ? !isSold(a) : (!isSold(a) && a.group===w)).sort(byCollar); }
function toCSV(rows){ if(!rows.length) return ''; const h=Object.keys(rows[0]); return [h.map(csvCell).join(',')].concat(rows.map(r=>h.map(k=>csvCell(r[k])).join(','))).join('\n'); }
// eShepherd's Bulk Create file: row 1 instructions, row 2 headers (Action, Animal ID, Neckband, EID*, VID*, Breed, Stock Class,
// Date of Birth, Tattoo or Brand, Weight (lb), Weighed date, Expected Weight Gain (lb), Pregnancy Status, Note). Dates dd-MM-yyyy.
const ES_HEAD = ['Action','Animal ID','Neckband','EID*','VID*','Breed','Stock Class','Date of Birth','Tattoo or Brand','Weight (lb)','Weighed date','Expected Weight Gain (lb)','Pregnancy Status','Note'];
const esVid = v => String(v||'').replace(/[^A-Za-z0-9]/g,'').slice(0,20);
function esPreg(a){
  const b=breedingFor(a); if(!b) return '';
  if(b.status==='pregnant') return 'Pregnant';
  if(b.status==='exposed') return 'Joined';
  if(b.status==='open') return 'Empty';
  if(b.status==='calved' && daysBetween(b.calving.date, today())<=210) return 'Wet/Lactating';
  return '';
}
// Which Herd Book animal wears this neckband? Collar list serial first, then the collar number itself.
function animalForNeckband(serial){
  const digits = s => String(s).replace(/\D/g,'').replace(/^0+/,'');
  const sv=String(serial).trim(); if(!sv) return null;
  const live=onHand().filter(a=>a.collar), w=wearers();
  const c=collarList().find(c=>c.neckband && digits(c.neckband)===digits(sv));
  if(c){ const a=(w.get(ckey(c.number))||[])[0]; if(a) return a; }
  return live.find(a=>String(a.collar).trim()===sv) || live.find(a=>digits(a.collar) && digits(a.collar)===digits(sv)) || null;
}
function openExport(){
  openSheet(`<div id="exs" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>Export</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="card"><b>eShepherd collars</b>
      <div class="small">In eShepherd, tap <b>+ › Bulk Create – Download File</b> and choose that file here. Herd Book fills in each neckband’s animal (VID, EID, brand, breed, stock class, birth date, pregnancy status, group) and gives it back. Upload it with <b>Bulk Create – Upload File</b>.</div>
      <label class="f">eShepherd VID comes from<select id="ex-vid"><option value="vid">Visual tag (VID) field</option><option value="collar">Collar number</option><option value="brand1">Brand</option></select></label>
      <label class="f">eShepherd Note gets<select id="ex-note"><option value="group">Group name</option><option value="notes">Herd Book notes</option><option value="keep">Leave as it is</option></select></label>
      <label class="btn primary" for="ex-esfile" style="text-align:center">Choose eShepherd file</label><input id="ex-esfile" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
      <div id="ex-msg" class="small"></div></div>
    <div class="card"><label class="f">Which animals<select id="ex-which"><option value="onhand">On hand</option><option value="all">All, including sold</option>${groups().map(g=>`<option value="${esc(g)}">Group: ${esc(g)}</option>`).join('')}</select></label>
      ${!fin()?'<div class="small muted">Exports from this phone don’t include prices.</div>':''}
      <button class="btn primary" type="button" data-ex="xlsx">Everything as an Excel workbook</button>
      <div class="small muted">Sheets for animals, treatments, breeding, collars${fin()?', expenses':''}.</div>
      <button class="btn" type="button" data-ex="csv">Animal list (CSV)</button>
      <button class="btn" type="button" data-ex="json">Full backup file (JSON)</button></div></div>`);
  const msg = t => { $('#ex-msg').innerHTML=t; };
  $('#exs').addEventListener('click', async e=>{
    const b=e.target.closest('[data-ex]'); if(!b) return;
    const F=fin(), pool=exportPool(), stamp=today();
    if(b.dataset.ex==='csv') return saveFile(`herd-${stamp}.csv`, toCSV(pool.map(a=>animalRow(a,F))), 'text/csv');
    if(b.dataset.ex==='json') return saveFile(`herd-backup-${stamp}.json`, JSON.stringify({exported:new Date().toISOString(), ranch:cfg.ranchName||'', animals:animals(), exposures:[...S.exposures.values()], collars:[...S.collars.values()], treatments:[...S.treatments.values()], pregnancy:[...S.preg.values()], ...(F?{expenses:[...S.expenses.values()]}:{})},null,2), 'application/json');
    if(b.dataset.ex==='xlsx'){
      let X; try{ X=await loadXLSX(); }catch{ toast('Excel export needs the app to have loaded once with signal.'); return; }
      const wb=X.utils.book_new(); const add=(n,rows)=>X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows.length?rows:[{'':'(none)'}]), n);
      add('Animals', pool.map(a=>animalRow(a,F)));
      add('Treatments', treatments().map(t=>Object.assign({'Date':t.date,'Product':t.product,'Type':TTYPE[t.kind]||'','Dose':t.dose||'','Route':t.route||'','Withdrawal days':t.withdrawalDays??'','Withdrawal ends':withdrawalEnd(t),'Booster due':t.boosterDue||'','Batch':t.batch||'','Given by':t.givenBy||'','Head':(t.animalIds||[]).length,'Animals':(t.animalIds||[]).map(id=>label(S.animals.get(id))).join(', '),'Notes':t.notes||''}, F?{'Cost':t.cost??''}:{})));
      add('Breeding', onHand().map(a=>({a,b:breedingFor(a)})).filter(x=>x.b).map(({a,b})=>({'Animal':label(a),'Brand':a.brand1||'','Status':BSTATUS[b.status][0],'Exposed from':b.ex?b.ex.start:'','Exposed to':b.ex?(b.ex.end||'still in'):'','Bull':b.ex?(b.ex.bullId?label(S.animals.get(b.ex.bullId)):'AI'):'','Due from':b.from,'Due to':b.to,'Preg check':b.check?`${b.check.date} ${b.check.result}`:'','Calved':b.calving?b.calving.date:''})));
      add('Collars', collarList().map(c=>{ const w=wearers(); const a=(w.get(ckey(c.number))||[])[0]; return {'Collar':c.number,'eShepherd neckband':c.neckband||'','Status':STATE[collarState(c,w)],'On animal':a?label(a):'','Brand':a?a.brand1||'':'','Note':c.note||''}; }));
      if(F) add('Expenses', [...S.expenses.values()].sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map(x=>({'Date':x.date,'Category':x.category||'','Description':x.description||'','Group':x.group||'','Amount':x.amount})));
      return saveFile(`herd-book-${stamp}.xlsx`, X.write(wb,{bookType:'xlsx',type:'array'}), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  });
  $('#ex-esfile').addEventListener('change', async e=>{
    const file=e.target.files[0]; e.target.value=''; if(!file) return;
    msg('Reading…');
    let X; try{ X=await loadXLSX(); }catch{ msg('This needs the app to have loaded once with signal.'); return; }
    let wb; try{ wb = file.name.toLowerCase().endsWith('.csv') ? X.read(await file.text(), {type:'string', raw:true}) : X.read(await file.arrayBuffer(), {type:'array', cellDates:true}); }catch{ msg('That file couldn’t be read.'); return; }
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=X.utils.sheet_to_json(ws,{header:1, raw:false, defval:''});
    const hi=rows.findIndex(r=>r.some(c=>/^\s*neck\s*band\s*$/i.test(String(c))));
    if(hi<0){ msg('<span class="warn-text">No “Neckband” column found. Is this the eShepherd Bulk Create file?</span>'); return; }
    const head=rows[hi].map(c=>String(c).trim()); const col=re=>head.findIndex(h=>re.test(h));
    const c={action:col(/^action$/i), aid:col(/^animal\s*id$/i), nb:col(/^neck\s*band$/i), eid:col(/^eid/i), vid:col(/^vid/i), breed:col(/^breed$/i), cls:col(/stock\s*class/i), dob:col(/birth/i), brand:col(/tattoo|brand/i), preg:col(/pregnan/i), note:col(/^note/i)};
    const vidFrom=$('#ex-vid').value, noteFrom=$('#ex-note').value;
    const setStr=(r,ci,v)=>{ if(ci<0) return; const ref=X.utils.encode_cell({r,c:ci}); if(v===''||v==null){ delete ws[ref]; return; } ws[ref]={t:'s', v:String(v)}; };
    const setDate=(r,ci,iso)=>{ if(ci<0||!iso) return; const ref=X.utils.encode_cell({r,c:ci}); const d=new Date(iso+'T00:00:00Z'); ws[ref]={t:'n', v:(d - Date.UTC(1899,11,30))/86400000, z:'dd-mm-yyyy'}; };
    let filled=0, seen=new Set(); const noCow=[], noId=[];
    for(let r=hi+1; r<rows.length; r++){
      const nb=String(rows[r][c.nb]||'').trim(); if(!nb) continue;
      const a=animalForNeckband(nb); if(!a){ noCow.push(nb); continue; }
      if(seen.has(a.id)){ noCow.push(nb+' (cow already on another neckband)'); continue; } seen.add(a.id);
      const vid=esVid(a[vidFrom]), eid=String(a.eid||'').trim();
      if(!vid && !eid){ noId.push(a.collar||a.brand1||label(a)); continue; }
      const fitted = c.aid>=0 && String(rows[r][c.aid]).trim() && !/unfitted/i.test(String(rows[r][c.aid]));
      setStr(r,c.action, fitted?'EDIT':'CREATE');
      setStr(r,c.vid, vid); setStr(r,c.eid, eid);
      if(a.breed) setStr(r,c.breed, a.breed.slice(0,50));
      setStr(r,c.cls, KIND[a.kind]||'Cow');
      if(a.birthDate) setDate(r,c.dob, a.birthDate);
      const br=[a.brand1,a.brand2].filter(Boolean).join(' / ').slice(0,50); if(br) setStr(r,c.brand, br);
      const pg=esPreg(a); if(pg) setStr(r,c.preg, pg);
      if(noteFrom!=='keep'){ const nv=String(noteFrom==='group'?a.group||'':a.notes||'').slice(0,300); if(nv) setStr(r,c.note, nv); }
      filled++;
    }
    msg(`<b>${filled}</b> neckbands filled.${noCow.length?` ${noCow.length} neckbands have no matching animal in Herd Book${noCow.length<=8?' ('+esc(noCow.join(', '))+')':''}. Give the collar its neckband serial in the Collars tab, or use the serial as the collar number.`:''}${noId.length?` <span class="warn-text">${noId.length} animals need a VID or EID first (${esc(noId.slice(0,8).join(', '))}${noId.length>8?'…':''}).</span>`:''}`);
    if(filled) saveFile(file.name.replace(/\.(csv|xlsx)$/i,'')+'-filled.xlsx', X.write(wb,{bookType:'xlsx',type:'array'}), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
}
document.addEventListener('click', e=>{ if(e.target.closest('[data-open-import]')) openImport(); if(e.target.closest('[data-open-export]')) openExport(); });


// ---------- collar photo scanning: runs on the phone, works with no signal once downloaded ----------
const CAM = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="vertical-align:-4px"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>';
let ocrWorker=null, ocrStarting=null;
const ocrReady = () => { try{ return localStorage.getItem('herdbook.ocrReady')==='1'; }catch{ return false; } };
function loadScript(src){ return new Promise((res,rej)=>{ if(window.Tesseract) return res(); const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
async function getOcr(){
  if(ocrWorker) return ocrWorker;
  if(ocrStarting) return ocrStarting;
  ocrStarting = (async()=>{
    await loadScript('./ocr/tesseract.min.js');
    const w = await Tesseract.createWorker('eng', 1, { workerPath:'./ocr/worker.min.js', corePath:'./ocr/', langPath:'./ocr', gzip:true, workerBlobURL:false });
    await w.setParameters({ tessedit_char_whitelist:'0123456789', tessedit_pageseg_mode:'11' });
    ocrWorker=w; try{ localStorage.setItem('herdbook.ocrReady','1'); }catch{}
    return w;
  })();
  try{ return await ocrStarting; } finally { ocrStarting=null; }
}
// Download the scanner in the background the first time the app has signal, so it's there in the yard.
function warmOcr(){
  if(ocrReady() || navigator.onLine===false) return;
  setTimeout(async ()=>{ if(ocrWorker || document.hidden) return; try{ const w=await getOcr(); if(w===ocrWorker && !scanning){ await w.terminate(); ocrWorker=null; } renderSetup(); }catch{} }, 20000);
}
async function photoCanvases(file){
  let src;
  try{ src = await createImageBitmap(file); }
  catch{ src = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=URL.createObjectURL(file); }); }
  const W=src.width, H=src.height, scale=Math.min(1, 1600/Math.max(W,H));
  const w=Math.max(1,Math.round(W*scale)), h=Math.max(1,Math.round(H*scale));
  const base=document.createElement('canvas'); base.width=w; base.height=h; base.getContext('2d').drawImage(src,0,0,w,h);
  const make = (invert, rot) => {
    const c=document.createElement('canvas'); const swap = rot%180!==0; c.width=swap?h:w; c.height=swap?w:h;
    const x=c.getContext('2d'); x.translate(c.width/2,c.height/2); x.rotate(rot*Math.PI/180); x.drawImage(base,-w/2,-h/2);
    const d=x.getImageData(0,0,c.width,c.height), p=d.data; let lo=255, hi=0; const g=new Uint8ClampedArray(p.length/4);
    for(let i=0,j=0;i<p.length;i+=4,j++){ const v=0.299*p[i]+0.587*p[i+1]+0.114*p[i+2]; g[j]=v; if(v<lo) lo=v; if(v>hi) hi=v; }
    const span=Math.max(1,hi-lo);
    for(let i=0,j=0;i<p.length;i+=4,j++){ let v=(g[j]-lo)*255/span; if(invert) v=255-v; p[i]=p[i+1]=p[i+2]=v; }
    x.setTransform(1,0,0,1,0,0); x.putImageData(d,0,0); return c;
  };
  return { thumb: base.toDataURL('image/jpeg',0.6), make };
}
function knownSerials(){ return [...new Set([...collarList().flatMap(c=>[c.number,c.neckband]), ...animals().map(a=>a.collar)].filter(Boolean).map(v=>String(v).trim()))]; }
function serialCandidates(texts){
  const known=new Set(knownSerials()), found=new Map();
  texts.forEach(t=>{ (String(t).replace(/[ \t]+/g,'').match(/\d{5,14}/g)||[]).forEach(n=>found.set(n,(found.get(n)||0)+1)); });
  const list=[...found.entries()].map(([n,c])=>{ const o={n, known:known.has(n), score:c+(n.length===10?3:0)+(known.has(n)?10:0)};
    if(!o.known){ const near=[...known].find(k=>k.length===n.length && [...k].filter((ch,i)=>ch!==n[i]).length===1); if(near){ o.near=near; o.score+=5; } }
    return o; });
  return list.sort((a,b)=>b.score-a.score).slice(0,5);
}
let scanning=false;
async function readSerial(file, show){
  scanning=true;
  try{
    show('Opening the scanner…');
    let w; try{ w=await getOcr(); }catch{ show(navigator.onLine===false && !ocrReady() ? 'The scanner downloads the first time the app has signal. Type the number for now.' : 'The scanner couldn’t start. Type the number for now.', true); return []; }
    const img=await photoCanvases(file);
    show(`<img src="${img.thumb}" alt="" class="scanthumb"> Reading the collar…`, false, true);
    const texts=[], passes=[[false,0],[true,0],[false,90],[false,270]];
    for(let i=0;i<passes.length;i++){
      const { data } = await w.recognize(img.make(passes[i][0], passes[i][1])); texts.push(data.text||'');
      const c=serialCandidates(texts); if(c.some(x=>x.known)) break; if(i>=1 && c.length) break;
    }
    return { thumb: img.thumb, cands: serialCandidates(texts) };
  } finally { scanning=false; }
}
// Hook a photo input to a result box; onPick gets the chosen serial.
function wireScan(inputSel, boxSel, onPick){
  const input=$(inputSel), box=$(boxSel); if(!input||!box) return;
  const show=(html, warn, raw)=>{ box.innerHTML = raw ? `<div class="scanbox">${html}</div>` : `<div class="notice ${warn?'warn':'ok'}">${esc(html)}</div>`; };
  input.addEventListener('change', async e=>{
    const file=e.target.files[0]; e.target.value=''; if(!file) return;
    let r; try{ r=await readSerial(file, show); }catch{ show('That photo couldn’t be read. Try again closer and in better light, or type the number.', true); return; }
    if(!r || !r.cands) return;
    if(!r.cands.length){ box.innerHTML=`<div class="scanbox"><img src="${r.thumb}" alt="" class="scanthumb"><div><b>No number found.</b> Try again closer, straight on and in good light, or type it.</div></div>`; return; }
    box.innerHTML=`<div class="scanbox"><img src="${r.thumb}" alt="" class="scanthumb"><div style="display:flex;flex-direction:column;gap:6px;min-width:0"><b>Tap the right number</b>
      ${r.cands.map(c=>`<button type="button" class="btn ${c.known?'primary':''} scanpick" data-pick="${esc(c.n)}">${esc(c.n)}${c.known?' · in your collar list':''}</button>${c.near?`<button type="button" class="btn scanpick" data-pick="${esc(c.near)}">Did you mean ${esc(c.near)}?</button>`:''}`).join('')}</div></div>`;
    onPick(r.cands[0].n);
  });
  box.addEventListener('click', e=>{ const b=e.target.closest('[data-pick]'); if(!b) return; onPick(b.dataset.pick); box.querySelectorAll('[data-pick]').forEach(x=>x.classList.toggle('primary', x===b)); });
}
function camButton(id){ return `<label class="btn cambtn" for="${id}" title="Take a photo of the collar number">${CAM}<span>Photo</span></label><input id="${id}" type="file" accept="image/*" capture="environment" hidden>`; }

// Fit a collar to an animal: type the serial or take a photo of it.
function openFitCollar(id){
  const a=S.animals.get(id); if(!a) return;
  openSheet(`<div id="fc" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>Fit collar · ${esc(label(a))}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="card">
      <div>${brandsHtml(a)||''} <span class="muted small">${esc(a.group||'')}</span>${a.collar?` · now ${collarHtml(a)}`:''}</div>
      <label class="f" for="fc-num">Collar serial</label>
      <div class="inrow"><input id="fc-num" type="text" inputmode="numeric" autocomplete="off" value="${esc(a.collar||'')}" placeholder="Type it or take a photo">${camButton('fc-photo')}</div>
      <div id="fc-scan"></div>
      <label class="check"><input id="fc-on" type="checkbox" checked> Collar is on the animal now</label>
      <div id="fc-warn"></div>
      <button class="btn primary" type="button" id="fc-save">Save</button>
    </div></div>`);
  const num=$('#fc-num');
  const check=()=>{ const v=num.value.trim(); const d=v && onHand().find(o=>o.id!==id && ckey(o.collar)===ckey(v)); const c=v && collarFor(v);
    $('#fc-warn').innerHTML = d ? `<div class="notice warn">Collar ${esc(v)} is on ${esc(label(d))}${d.brand1?' ('+esc(d.brand1)+')':''}. Saving moves it to this animal.</div>`
      : (c && c.status==='lost') ? `<div class="notice warn">Collar ${esc(v)} is marked lost.</div>`
      : (v && !c) ? `<div class="notice ok">New collar. It will be added to your collar list.</div>` : ''; };
  num.addEventListener('input', check); check();
  wireScan('#fc-photo', '#fc-scan', n=>{ num.value=n; check(); });
  $('#fc-save').addEventListener('click', ()=>{
    const v=num.value.trim(); if(!v){ toast('Enter or scan the collar serial'); return; }
    const on=$('#fc-on').checked, now=Date.now();
    const other=onHand().find(o=>o.id!==id && ckey(o.collar)===ckey(v));
    if(other){ patch('animals/'+other.id, {collar:'', collarOn:false, updatedAt:now, updatedBy:me()}); logChange(other.id,'animal',label(other),'collar moved to '+label(a),[{f:'collar',from:other.collar,to:''}]); }
    if(!collarFor(v)){ outbox.push({op:'set', path:'collars/'+cid(v), data:{number:v, neckband:/^\d{6,}$/.test(v)?v:'', note:'', status:'ok', createdAt:now, updatedAt:now, updatedBy:me()}, t:now}); saveOutbox(); }
    const ch=[]; if((a.collar||'')!==v) ch.push({f:'collar',from:a.collar||'',to:v}); if(!!a.collarOn!==on) ch.push({f:'collarOn',from:!!a.collarOn,to:on});
    if(ch.length){ patch('animals/'+id, {collar:v, collarOn:on, updatedAt:now, updatedBy:me()}); logChange(id,'animal',label({...a,collar:v}),'collar fitted',ch); } else recompute();
    closeSheet(); toast(`Collar ${v} ${on?'fitted to':'assigned to'} ${a.brand1||label(a)}`);
  });
}

// ---------- swap with a nearby phone (no signal): changes travel as QR codes, screen to camera ----------
const SWAP_CHUNK = 700;
const MONEY_KEYS = { animals:['purchasePrice','purchaseDate','salePrice','saleDate'], treatments:['cost'] };
const MONEY_F_ALL = ['purchasePrice','purchaseDate','salePrice','saleDate','cost','amount'];
let netDown = false;
const offlineNow = () => navigator.onLine===false || netDown;
function renderSwapBar(){
  const b=$('#swapBar'); if(!b) return;
  b.hidden = !(cfg.code && offlineNow());
  const n=outbox.length;
  b.innerHTML = `<span><b>No signal.</b> ${n?`${n} change${n>1?'s':''} on this phone.`:'Up to date as of last sync.'}</span><span class="btn">Swap with nearby phone</span>`;
}
// Changes this phone can pass on: never money, never expenses.
function shareableOps(){
  return outbox.filter(o=>{
    const col=o.path.slice(0,o.path.indexOf('/'));
    if(col==='expenses') return false;
    if(col==='history' && o.data && o.data.targetType==='expense') return false;
    return true;
  }).map(o=>{
    const col=o.path.slice(0,o.path.indexOf('/'));
    const strip = d => { if(!d) return d; const x={...d}; (MONEY_KEYS[col]||[]).forEach(k=>delete x[k]); delete x.sold;
      if(col==='history' && Array.isArray(x.changes)) x.changes=x.changes.filter(c=>MONEY_F_ALL.indexOf(c.f)<0); return x; };
    return [o.op, o.path, strip(o.data), strip(o.base), o.t, o.oid, o.from||me()];
  });
}
const b64 = u8 => { let s=''; for(let i=0;i<u8.length;i+=0x8000) s+=String.fromCharCode.apply(null, u8.subarray(i,i+0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
async function pack(obj){
  const raw=new TextEncoder().encode(JSON.stringify(obj));
  if(typeof CompressionStream==='function'){
    const out=await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z'+b64(new Uint8Array(out));
  }
  return 'j'+b64(raw);
}
async function unpack(s){
  const bytes=unb64(s.slice(1));
  if(s[0]==='z'){ const out=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(); return JSON.parse(new TextDecoder().decode(out)); }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function swapFrames(){
  saveOutbox();                                              // makes sure every change has its own id
  const ops=shareableOps();
  const data=await pack({v:1, from:me(), ranch:cfg.ranchName||'', at:Date.now(), ops});
  const sid=rid().slice(-6), n=Math.max(1, Math.ceil(data.length/SWAP_CHUNK)), frames=[];
  for(let i=0;i<n;i++) frames.push(`HB1|${sid}|${i+1}|${n}|${data.slice(i*SWAP_CHUNK,(i+1)*SWAP_CHUNK)}`);
  return { frames, count:ops.length };
}
// Receiving: frames arrive in any order, any number of times.
function swapCollector(){
  const got=new Map(); let sid='', n=0;
  return { add(text){ const m=String(text).match(/^HB1\|(\w+)\|(\d+)\|(\d+)\|(.*)$/s); if(!m) return {bad:true};
      if(sid && m[1]!==sid){ got.clear(); } sid=m[1]; n=Number(m[3]); got.set(Number(m[2]), m[4]);
      return { have:got.size, need:n, done:got.size===n }; },
    joined(){ let s=''; for(let i=1;i<=n;i++) s+=got.get(i)||''; return s; } };
}
async function swapReceive(payloadText){
  const p=await unpack(payloadText);
  if(!p || p.v!==1 || !Array.isArray(p.ops)) return { error:'That code isn’t from Herd Book.' };
  if(p.ranch && cfg.ranchName && p.ranch!==cfg.ranchName) return { error:`Those changes are from ${p.ranch}, not ${cfg.ranchName}. Nothing was added.` };
  if(syncing) return { error:'This phone is syncing. Try again in a moment.' };
  const have=new Set(outbox.map(o=>o.oid)); let added=0; const clashes=[];
  const norm = v => v===true?'true':v===false?'false':v==null?'':String(v);
  p.ops.forEach(([op,path,data,base,t,oid,from])=>{
    if(!oid || have.has(oid)) return;
    const col=path.slice(0,path.indexOf('/'));
    if(col==='expenses' || !['animals','exposures','collars','treatments','preg','history'].includes(col)) return;
    const entry={op, path, data:data||null, base:base||null, t:Number(t)||Date.now(), oid, via:'qr', from:from||p.from};
    // Same field changed differently on this phone? Ask which to keep, like normal sync.
    if(op==='update' && data) outbox.filter(o=>o.path===path && !o.via && o.data).forEach(own=>{
      Object.keys(data).forEach(k=>{ if(META.has(k) || !(k in own.data) || norm(own.data[k])===norm(data[k])) return;
        if(base && k in base && norm(base[k])===norm(own.data[k])) return;   // they already saw this phone's value and chose theirs
        const i=path.indexOf('/');
        clashes.push({ key:`${path}|${k}|qr`, local:true, col, id:path.slice(i+1), type:'field', field:k, mine:own.data[k], theirs:data[k], by:entry.from||'Other phone', at:entry.t, myAt:own.t, ownOid:own.oid, relOid:oid, what:whatOf(col, path.slice(i+1)) }); });
    });
    outbox.push(entry); have.add(oid); added++;
  });
  outbox.sort((a,b)=>(a.t||0)-(b.t||0));
  saveOutbox();
  if(clashes.length){ conflicts = conflicts.filter(x=>!clashes.some(c=>c.key===x.key)).concat(clashes); saveConflicts(); }
  recompute();
  return { added, from:p.from, clashes:clashes.length };
}
// Resolve a clash found during a swap, without asking again when the sheet sees both changes.
function resolveLocalClash(c, keep){
  const own=outbox.find(o=>o.oid===c.ownOid), rel=outbox.find(o=>o.oid===c.relOid);
  if(keep==='mine'){ if(own && own.op==='update'){ own.base={...(own.base||{}), [c.field]:c.theirs}; own.t=Date.now(); } if(rel){ delete rel.data[c.field]; if(rel.base) delete rel.base[c.field]; } outbox.sort((a,b)=>(a.t||0)-(b.t||0)); }
  else { if(own){ delete own.data[c.field]; if(own.base) delete own.base[c.field]; } }
  saveOutbox(); recompute();
}

let swapTimer=null, swapStream=null, swapRAF=null;
function stopSwap(){ clearInterval(swapTimer); swapTimer=null; if(swapRAF) cancelAnimationFrame(swapRAF); swapRAF=null; if(swapStream){ swapStream.getTracks().forEach(t=>t.stop()); swapStream=null; } }
function openSwap(){
  openSheet(`<div id="sw" style="display:flex;flex-direction:column;gap:14px">
    <div class="sheet-h"><h2>Swap with nearby phone</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="small">No signal needed. One phone shows its changes as a moving QR code and the other points its camera at it. Then swap over.${fin()?' Prices and expenses are never included.':''}</div>
    <div class="seg" id="sw-mode"><button type="button" data-m="show" aria-pressed="true">Show my changes</button><button type="button" data-m="scan" aria-pressed="false">Scan their changes</button></div>
    <div id="sw-body" style="display:flex;flex-direction:column;gap:10px;align-items:center"></div>
  </div>`);
  const body=$('#sw-body');
  const show = async () => {
    stopSwap();
    const { frames, count } = await swapFrames();
    if(!count){ body.innerHTML='<div class="notice ok">This phone has no unsent changes to share. You can still scan theirs.</div>'; return; }
    body.innerHTML=`<div class="qr swapqr" id="sw-qr"></div><div class="small"><b>${count}</b> change${count>1?'s':''} · code <span id="sw-i">1</span> of ${frames.length}</div><div class="small muted">Hold steady until the other phone says it has everything. Turn your screen brightness up.</div>`;
    let i=0; const draw=()=>{ const el=$('#sw-qr'); if(!el){ stopSwap(); return; } const q=qrcode(0,'L'); q.addData(frames[i]); q.make(); el.innerHTML=q.createSvgTag({cellSize:4, margin:4, scalable:true}); $('#sw-i').textContent=i+1; i=(i+1)%frames.length; };
    draw(); if(frames.length>1) swapTimer=setInterval(draw, 450);
    frames.length && outbox.forEach(o=>{ if(!o.via) o.shared=true; }); saveOutbox();
  };
  const scan = async () => {
    stopSwap();
    body.innerHTML=`<video id="sw-vid" playsinline muted class="swapvid"></video><div class="progress"><div id="sw-bar"></div></div><div id="sw-msg" class="small">Point the camera at the other phone’s code.</div>`;
    try{
      await loadScript2('./jsqr.min.js');
      swapStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280}, height:{ideal:720} }, audio:false });
    }catch(e){ $('#sw-msg').innerHTML='<span class="warn-text">The camera couldn’t start. Allow camera access for Herd Book in your phone’s settings, then try again.</span>'; return; }
    const v=$('#sw-vid'); v.srcObject=swapStream; await v.play().catch(()=>{});
    const c=document.createElement('canvas'), x=c.getContext('2d', {willReadFrequently:true}); const col=swapCollector(); let last=0, busy=false;
    const tick = async ts => {
      if(!swapStream) return; swapRAF=requestAnimationFrame(tick);
      if(busy || ts-last<120 || !v.videoWidth) return; last=ts;
      const s=Math.min(1, 720/Math.max(v.videoWidth,v.videoHeight)); c.width=Math.round(v.videoWidth*s); c.height=Math.round(v.videoHeight*s);
      x.drawImage(v,0,0,c.width,c.height); const img=x.getImageData(0,0,c.width,c.height);
      const r=window.jsQR && jsQR(img.data, c.width, c.height, {inversionAttempts:'dontInvert'}); if(!r) return;
      const st=col.add(r.data); if(st.bad) return;
      $('#sw-bar').style.width=Math.round(st.have/st.need*100)+'%'; $('#sw-msg').textContent=`Got ${st.have} of ${st.need} codes…`;
      if(st.done){ busy=true; stopSwap();
        let res; try{ res=await swapReceive(col.joined()); }catch{ res={error:'Those codes couldn’t be read. Try again.'}; }
        body.innerHTML = res.error ? `<div class="notice warn">${esc(res.error)}</div>` : `<div class="notice ok">Added ${res.added} change${res.added===1?'':'s'} from ${esc(res.from||'the other phone')}.${res.clashes?` ${res.clashes} clash${res.clashes>1?'es':''} to sort out.`:''}</div><button type="button" class="btn primary" id="sw-flip">Now show mine</button>`;
        const f=$('#sw-flip'); f && f.addEventListener('click', ()=>$('#sw-mode [data-m=show]').click());
        if(res.clashes) setTimeout(openConflicts, 1200);
      }
    };
    swapRAF=requestAnimationFrame(tick);
  };
  $('#sw-mode').addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; $('#sw-mode').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); (b.dataset.m==='show'?show:scan)(); });
  show();
}
function loadScript2(src){ return new Promise((res,rej)=>{ if(document.querySelector(`script[data-src="${src}"]`) && window.jsQR) return res(); const s=document.createElement('script'); s.src=src; s.dataset.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
$('#swapBar').addEventListener('click', openSwap);

// ---------- boot ----------
function renderAll(){
  if(S.tab==='herd') renderHerd(); else if(S.tab==='yard') renderYard(); else if(S.tab==='collars') renderCollars(); else if(S.tab==='breeding') renderBreeding(); else if(S.tab==='health') renderHealth(); else if(S.tab==='money') renderMoney(); else renderLog();
}
setTab(); recompute(); renderSetup();
if(!storageOk) toast('This browser isn’t keeping a copy on the phone. Use the home-screen app instead.');
openStart(false);
sync();
(()=>{ const y=$('#yq'); const wrap=document.createElement('div'); wrap.className='inrow'; y.parentNode.insertBefore(wrap,y); wrap.appendChild(y); wrap.insertAdjacentHTML('beforeend', camButton('yq-photo')); wrap.insertAdjacentHTML('afterend','<div id="yScan"></div>');
  wireScan('#yq-photo', '#yScan', n=>{ $('#yq').value=n; renderYard(); }); })();
warmOcr(); window.addEventListener('online', warmOcr);
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
window.__herdbook = { sync, state:S, outbox:()=>outbox, conflicts:()=>conflicts, cfg, swapFrames, swapCollector, swapReceive };
})();
