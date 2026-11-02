// Herd Book — offline-first cattle tracker. Data lives on the phone and syncs to a Google Sheet when there is signal.
(() => {
// Paste the Google Apps Script web app URL here (or enter it in Log › Phone setup).
const SYNC_URL = window.HERDBOOK_SYNC_URL || '';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const byCollar = (a,b) => String(a.collar||'~').localeCompare(String(b.collar||'~'), undefined, {numeric:true});
const KIND = {cow:'Cow', heifer:'Heifer', bull:'Bull'};
const FIELDS = [['kind','Type'],['collar','Collar'],['group','Group'],['brand1','Brand'],['brand2','2nd brand'],['collarOn','Collar fitted'],['notes','Notes'],
  ['purchasePrice','Purchase price'],['purchaseDate','Purchase date'],['salePrice','Sale price'],['saleDate','Sale date']];
const MONEY = new Set(['purchasePrice','salePrice']);
const DATES = new Set(['purchaseDate','saleDate']);
const money = n => (n===''||n==null||isNaN(n)) ? '' : Number(n).toLocaleString('en-CA',{style:'currency',currency:'CAD',maximumFractionDigits:2});
const parseMoney = v => { v=String(v||'').replace(/[$,\s]/g,''); if(v==='') return ''; const n=Number(v); return isNaN(n)?null:Math.round(n*100)/100; };
const rid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,10);
const canWrite = true;

const S = { animals:new Map(), exposures:new Map(), collars:new Map(), cFilter:'all', history:[], loaded:true, tab:'herd', group:'', yGroup:'', yFilter:'need', showSold:false, lastSync:0 };

// ---------- local storage ----------
const LS = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch{ return false; } }
};
const K = { mirror:'herdbook.app.mirror', outbox:'herdbook.app.outbox', cfg:'herdbook.app.config' };
const mirror = LS.get(K.mirror, {});
mirror.animals = mirror.animals || {}; mirror.exposures = mirror.exposures || {}; mirror.collars = mirror.collars || {};
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
function saveOutbox(){ if(!LS.set(K.outbox,outbox)){ storageOk=false; toast('This phone is out of storage space. Get signal and sync before making more changes.'); } }

function recompute(){
  const an = {...mirror.animals}, ex = {...mirror.exposures}, co = {...mirror.collars}, pendingHist=[];
  for(const op of outbox){
    const [col,id] = op.path.split('/');
    if(col==='history'){ if(op.op==='set') pendingHist.push({...op.data, pending:true}); continue; }
    const tgt = col==='animals'?an : col==='exposures'?ex : col==='collars'?co : null;
    if(!tgt) continue;
    if(op.op==='set') tgt[id]={...op.data};
    else if(op.op==='update'){ tgt[id]={...(tgt[id]||{}),...op.data}; }
    else if(op.op==='delete') delete tgt[id];
  }
  S.animals = new Map(Object.entries(an).map(([id,d])=>[id,{...d,id}]));
  S.exposures = new Map(Object.entries(ex).map(([id,d])=>[id,{...d,id}]));
  S.collars = new Map(Object.entries(co).map(([id,d])=>[id,{...d,id}]));
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
  ['animals','exposures','collars'].forEach(col=>(ch[col]||[]).forEach(r=>{
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
      const ops = batch.map(o=>{ const i=o.path.indexOf('/'); return {col:o.path.slice(0,i), id:o.path.slice(i+1), patch:o.data, base:o.base||null, create:o.op==='set', del:o.op==='delete'}; });
      let res;
      try{ res = await post({code:cfg.code, since:mirror.rev||0, ops}); } finally { inflight = 0; }
      if(res && res.ok && Array.isArray(res.conflicts) && res.conflicts.length) takeConflicts(res.conflicts, batch);
      if(!res || !res.ok){
        lastErr = res && res.error==='bad_code' ? 'The farm code is wrong. Check it in Log › Phone setup.' : res && res.error==='busy' ? 'The sheet is busy. Trying again shortly.' : 'The sheet couldn’t take the changes. Trying again shortly.';
        break;
      }
      outbox.splice(0, batch.length); saveOutbox();
      mergeChanges(res.changes); mirror.rev = res.rev || mirror.rev;
      S.lastSync = Date.now(); lastErr=''; saveMirror();
    } while(outbox.length);
  }catch(e){
    lastErr = navigator.onLine===false ? '' : 'Couldn’t reach the sheet. Trying again shortly.';
  }finally{
    syncing=false; recompute(); renderSetup();
  }
}
window.addEventListener('online', ()=>{ updateSync(); sync(); });
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
  el.textContent=t; el.classList.toggle('off',off);
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
const isSold = a => !!(a.saleDate || (a.salePrice!==''&&a.salePrice!=null));
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
  const hay = [a.collar,a.brand1,a.brand2,a.group,a.notes,KIND[a.kind]].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t=>hay.includes(t));
}

// ---------- tabs ----------
function setTab(){
  const t = (location.hash||'#herd').slice(1);
  S.tab = ['herd','yard','collars','bulls','log'].includes(t) ? t : 'herd';
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
  const bought = sum(inGroup,'purchasePrice'), soldFor = sum(sold,'salePrice');
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
          ${isSold(a)?'<span class="pill sold">Sold</span>': a.collar ? (a.collarOn?'<span class="pill ok">Fitted</span>':'<span class="pill warn">Not fitted</span>') : ''}</span>
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
  if(S.yFilter==='need') rows = rows.filter(a=>a.collar && !a.collarOn);
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
        ${a.collar ? `<button type="button" class="btn ${a.collarOn?'':'tag'}" data-fit="${esc(a.id)}">${a.collarOn?'Undo fitted':'Collar fitted ✓'}</button>`:''}
        <button type="button" class="btn" data-open="${esc(a.id)}">Details</button>
      </div>
    </div>`).join('');
}
$('#yq').addEventListener('input', renderYard);
$('#yGroup').addEventListener('change', e=>{ S.yGroup=e.target.value; renderYard(); });
$('#yFilter').addEventListener('click', e=>{ const b=e.target.closest('[data-f]'); if(!b) return; S.yFilter=b.dataset.f; document.querySelectorAll('#yFilter button').forEach(x=>x.setAttribute('aria-pressed', x===b)); renderYard(); });
$('#yardList').addEventListener('click', e=>{
  const o=e.target.closest('[data-open]'); if(o) return openAnimal(o.dataset.open);
  const f=e.target.closest('[data-fit]'); if(f) toggleFit(S.animals.get(f.dataset.fit));
});

// ---------- bulls ----------
const expsForBull = id => [...S.exposures.values()].filter(x=>x.bullId===id).sort((a,b)=>(b.start||'').localeCompare(a.start||''));
const expsForCow = id => [...S.exposures.values()].filter(x=>(x.cowIds||[]).includes(id)).sort((a,b)=>(b.start||'').localeCompare(a.start||''));
function expLine(x, showBull){
  const b = S.animals.get(x.bullId);
  const range = `${fmtDate(x.start)} – ${x.end?fmtDate(x.end):'<b>still in</b>'}`;
  return `<div class="exp"><span class="who">${showBull?esc(label(b)):''}${x.group?`${showBull?' · ':''}${esc(x.group)}`:''} · ${(x.cowIds||[]).length} cows</span><span class="muted">${range}</span></div>`;
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
    const note=$('#c-note').value.trim(), status=$('#c-lost').checked?'lost':'ok', ch=[];
    if(note!==(c.note||'')) ch.push({f:'Collar note',from:c.note||'',to:note});
    if(status!==(c.status||'ok')) ch.push({f:'Collar status',from:c.status==='lost'?'lost':'in use',to:status==='lost'?'lost':'in use'});
    if(!ch.length){ closeSheet(); return; }
    patch('collars/'+id, {note, status, updatedAt:Date.now(), updatedBy:me()});
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
  const x = rec || S.exposures.get(id); return x ? `${label(S.animals.get(x.bullId))} with ${x.group||'selected cows'}` : 'Bull with cows';
}
function takeConflicts(list, batch){
  const times = {}; batch.forEach(o=>{ times[o.path]=o.t; });
  list.forEach(c=>{
    const path = c.col+'/'+c.id;
    const coll = c.col==='animals'?S.animals : c.col==='collars'?S.collars : S.exposures;
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
    if(b.dataset.keep==='mine'){
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

// ---------- phone setup ----------
function shareLink(){
  if(!syncUrl() || !cfg.code) return '';
  return location.origin + location.pathname + '?s=' + encodeURIComponent(syncUrl()) + '&k=' + encodeURIComponent(cfg.code);
}
function renderSetup(){
  const st=$('#cfg-status'); if(!st) return;
  const nameEl=$('#cfg-name'), urlEl=$('#cfg-url'), codeEl=$('#cfg-code');
  if(document.activeElement!==nameEl) nameEl.value = cfg.name||'';
  if(document.activeElement!==urlEl) urlEl.value = cfg.url||SYNC_URL||'';
  if(document.activeElement!==codeEl) codeEl.value = cfg.code||'';
  st.textContent = !(syncUrl()&&cfg.code) ? 'Not connected. Changes are kept on this phone only.'
    : lastErr ? lastErr
    : S.lastSync ? `Connected. Last synced ${new Date(S.lastSync).toLocaleString()}.` : 'Connected. Tap “Sync now” to load the herd.';
  const link=shareLink(); $('#shareBox').hidden=!link; $('#shareLink').value=link;
}
$('#cfg-save').addEventListener('click', ()=>{
  cfg.name=$('#cfg-name').value.trim(); cfg.url=$('#cfg-url').value.trim(); cfg.code=$('#cfg-code').value.trim();
  if(cfg.url===SYNC_URL) delete cfg.url;
  LS.set(K.cfg,cfg); lastErr=''; renderSetup(); updateSync(); toast('Saved'); sync();
});
$('#syncNow').addEventListener('click', ()=>{ if(!(syncUrl()&&cfg.code)){ toast('Enter the farm code first'); return; } sync(); });
$('#copyLink').addEventListener('click', async ()=>{
  const el=$('#shareLink');
  try{ await navigator.clipboard.writeText(el.value); toast('Link copied'); }
  catch{ el.focus(); el.select(); toast('Link selected. Copy it from the menu.'); }
});
function firstRun(){
  if(cfg.name && cfg.code) return;
  openSheet(`<div style="display:flex;flex-direction:column;gap:14px"><div class="sheet-h"><h2>Set up this phone</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="fr" class="card">
      <label class="f">Your name<input id="fr-name" type="text" autocomplete="name" value="${esc(cfg.name||'')}" placeholder="Shown next to the changes you make"></label>
      <label class="f">Farm code<input id="fr-code" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(cfg.code||'')}" placeholder="From whoever set up the herd"></label>
      ${!syncUrl()?`<label class="f">Sync address<input id="fr-url" type="url" placeholder="https://script.google.com/…"></label>`:''}
      <div class="small muted">The farm code connects this phone to the herd’s Google Sheet. You only enter it once.</div>
      <button class="btn primary" type="submit">Start</button>
    </form></div>`);
  $('#fr').addEventListener('submit', e=>{ e.preventDefault();
    cfg.name=$('#fr-name').value.trim(); cfg.code=$('#fr-code').value.trim();
    const u=$('#fr-url'); if(u && u.value.trim()) cfg.url=u.value.trim();
    LS.set(K.cfg,cfg); closeSheet(); updateSync(); renderSetup(); sync(); });
}

// ---------- sheet ----------
function openSheet(html){ $('#sheet').innerHTML=html; $('#scrim').hidden=false; }
function closeSheet(){ $('#scrim').hidden=true; $('#sheet').innerHTML=''; }
$('#scrim').addEventListener('click', e=>{ if(e.target.id==='scrim' || e.target.closest('.x')) closeSheet(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && !$('#scrim').hidden) closeSheet(); });

function openAnimal(id){
  const a = id ? S.animals.get(id) : {kind:'cow', group:S.group||'', collarOn:false};
  if(id && !a) return;
  const xs = id ? (a.kind==='bull'?expsForBull(id):expsForCow(id)) : [];
  const mv = k => a[k]===''||a[k]==null ? '' : Number(a[k]).toFixed(2).replace(/\.00$/,'');
  openSheet(`
    <div class="sheet-h"><h2>${id?esc(label(a)):'New animal'}${id&&isSold(a)?' <span class="pill sold">Sold</span>':''}</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="af" class="card" autocomplete="off">
      <div class="grid2">
        <label class="f">Type<select id="a-kind">${Object.entries(KIND).map(([k,v])=>`<option value="${k}" ${a.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="f">Collar #<input id="a-collar" type="text" inputmode="numeric" list="collarlist" value="${esc(a.collar||'')}"><datalist id="collarlist">${freeCollars().map(c=>`<option value="${esc(c.number)}">`).join('')}</datalist></label>
        <label class="f">Group<input id="a-group" type="text" list="grouplist" value="${esc(a.group||'')}"><datalist id="grouplist">${groups().map(g=>`<option value="${esc(g)}">`).join('')}</datalist></label>
        <label class="check"><input id="a-on" type="checkbox" ${a.collarOn?'checked':''}> Collar fitted</label>
        <label class="f">Brand<input id="a-b1" type="text" value="${esc(a.brand1||'')}"></label>
        <label class="f">Second brand (optional)<input id="a-b2" type="text" value="${esc(a.brand2||'')}"></label>
      </div>
      <label class="f">Notes<textarea id="a-notes">${esc(a.notes||'')}</textarea></label>
      <div class="grid2">
        <label class="f">Purchase price ($)<input id="a-pp" type="text" inputmode="decimal" value="${esc(mv('purchasePrice'))}"></label>
        <label class="f">Purchase date<input id="a-pd" type="date" value="${esc(a.purchaseDate||'')}"></label>
        <label class="f">Sale price ($)<input id="a-sp" type="text" inputmode="decimal" value="${esc(mv('salePrice'))}"></label>
        <label class="f">Sale date<input id="a-sd" type="date" value="${esc(a.saleDate||'')}"></label>
      </div>
      <div class="small muted" id="a-margin"></div>
      <div id="a-warn"></div>
      <div class="bar"><button class="btn primary" type="submit" style="flex:1">${id?'Save changes':'Add animal'}</button>${id?'<button class="btn danger" type="button" id="a-del">Delete</button>':''}</div>
    </form>
    ${id?`<div class="card">
      <button type="button" class="updated" id="a-hist">Last updated ${esc(ago(a.updatedAt))}${a.updatedBy?` by ${esc(a.updatedBy)}`:''} · show changes</button>
      <div id="a-histlist" hidden></div>
    </div>
    <div class="card"><b>${a.kind==='bull'?'Cows he has been with':'Bulls she has been with'}</b>
      ${xs.length? xs.map(x=> a.kind==='bull' ? expLine(x,false) : expLine(x,true)).join('') : '<div class="small muted">None recorded.</div>'}
    </div>`:''}
  `);
  const margin=()=>{ const p=parseMoney($('#a-pp').value), s=parseMoney($('#a-sp').value);
    $('#a-margin').textContent = (typeof p==='number' && typeof s==='number') ? `Difference: ${money(s-p)}` : ''; };
  $('#a-pp').addEventListener('input',margin); $('#a-sp').addEventListener('input',margin); margin();
  const collarInput=$('#a-collar');
  const checkDup=()=>{ const v=collarInput.value.trim(); const d=v && onHand().find(o=>o.id!==id && ckey(o.collar)===ckey(v)); const c=v && collarFor(v);
    $('#a-warn').innerHTML = d?`<div class="notice warn">Collar ${esc(v)} is already on ${esc(label(d))}${d.group?' in '+esc(d.group):''}.</div>`
      : (c && c.status==='lost') ? `<div class="notice warn">Collar ${esc(v)} is marked lost in the collar list.</div>`
      : (v && !c && S.collars.size) ? `<div class="notice warn">Collar ${esc(v)} isn’t in your collar list. You can add it from the Collars tab.</div>` : ''; };
  collarInput.addEventListener('input', checkDup);
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
    const pp=parseMoney($('#a-pp').value), sp=parseMoney($('#a-sp').value);
    if(pp===null || sp===null){ $('#a-warn').innerHTML='<div class="notice warn">Prices should be numbers, like 2450 or 2450.50.</div>'; return; }
    const v={ kind:$('#a-kind').value, collar:collarInput.value.trim(), group:$('#a-group').value.trim(), brand1:$('#a-b1').value.trim(), brand2:$('#a-b2').value.trim(), collarOn:$('#a-on').checked, notes:$('#a-notes').value.trim(),
      purchasePrice:pp, purchaseDate:$('#a-pd').value, salePrice:sp, saleDate:$('#a-sd').value };
    if(!v.collar && !v.brand1){ $('#a-warn').innerHTML='<div class="notice warn">Enter a collar number or a brand so you can find this animal later.</div>'; return; }
    const now=Date.now();
    if(!id){
      const nid=rid();
      put('animals/'+nid, {...v, createdAt:now, updatedAt:now, updatedBy:me()});
      logChange(nid,'animal',label(v),'added',FIELDS.filter(([k])=>v[k]!==''&&v[k]!==false).map(([k])=>({f:k,to:v[k]})));
      closeSheet(); toast('Added '+label(v));
    } else {
      const blank = k => k==='collarOn'?false:'';
      const changes=FIELDS.filter(([k])=>(a[k]??blank(k))!==v[k]).map(([k])=>({f:k,from:a[k]??'',to:v[k]}));
      if(!changes.length){ closeSheet(); return; }
      const upd={updatedAt:now, updatedBy:me()}; changes.forEach(c=>upd[c.f]=v[c.f]);
      patch('animals/'+id, upd);
      logChange(id,'animal',label(v),'edited',changes);
      closeSheet(); toast('Saved');
    }
  });
}

function openExposure(bullId){
  const bs=bulls();
  if(!bs.length){ toast('Add a bull first (set the type to Bull)'); return; }
  const g=groups();
  let mode='group';
  openSheet(`
    <div class="sheet-h"><h2>Bull with cows</h2><button class="x" type="button" aria-label="Close">×</button></div>
    <form id="ef" class="card">
      <label class="f">Bull<select id="e-bull">${bs.map(b=>`<option value="${esc(b.id)}" ${b.id===bullId?'selected':''}>${esc(label(b))}${b.brand1?' · '+esc(b.brand1):''}</option>`).join('')}</select></label>
      <div class="seg" id="e-mode"><button type="button" data-m="group" aria-pressed="true">Whole group</button><button type="button" data-m="pick" aria-pressed="false">Pick cows</button></div>
      <div id="e-groupbox"><label class="f">Group<select id="e-group">${g.map(x=>`<option>${esc(x)}</option>`).join('')||'<option value="">No groups yet</option>'}</select></label></div>
      <div id="e-pickbox" hidden>
        <input id="e-filter" type="search" placeholder="Filter by collar, brand or group">
        <div class="picklist" id="e-pick" style="margin-top:8px">${females().sort(byCollar).map(c=>`<label data-s="${esc([c.collar,c.brand1,c.brand2,c.group].join(' ').toLowerCase())}"><input type="checkbox" value="${esc(c.id)}"> <span>${esc(label(c))} ${c.brand1?'· '+esc(c.brand1):''} <span class="muted small">${esc(c.group||'')}</span></span></label>`).join('')}</div>
      </div>
      <div class="small muted" id="e-count"></div>
      <div class="grid2">
        <label class="f">Put in<input id="e-start" type="date" value="${today()}"></label>
        <label class="f">Pulled (leave blank if still in)<input id="e-end" type="date"></label>
      </div>
      <label class="f">Note<input id="e-note" type="text" placeholder="Pasture, field, etc."></label>
      <button class="btn primary" type="submit">Save</button>
    </form>`);
  const pickIds=()=> mode==='group' ? females().filter(c=>c.group && c.group===$('#e-group').value).map(c=>c.id) : [...document.querySelectorAll('#e-pick input:checked')].map(i=>i.value);
  const count=()=>{ $('#e-count').textContent = `${pickIds().length} cows and heifers will be recorded with this bull.`; };
  $('#e-mode').addEventListener('click', e=>{ const b=e.target.closest('[data-m]'); if(!b) return; mode=b.dataset.m;
    document.querySelectorAll('#e-mode button').forEach(x=>x.setAttribute('aria-pressed',x===b)); $('#e-groupbox').hidden=mode!=='group'; $('#e-pickbox').hidden=mode!=='pick'; count(); });
  $('#e-group').addEventListener('change',count); $('#e-pick').addEventListener('change',count);
  $('#e-filter').addEventListener('input', e=>{ const q=e.target.value.toLowerCase().trim(); document.querySelectorAll('#e-pick label').forEach(l=>l.hidden = !!q && !l.dataset.s.includes(q)); });
  count();
  $('#ef').addEventListener('submit', e=>{
    e.preventDefault();
    const ids=pickIds(); if(!ids.length){ toast('Choose at least one cow'); return; }
    const bull=S.animals.get($('#e-bull').value);
    const rec={ bullId:bull.id, cowIds:ids, group: mode==='group'?$('#e-group').value:'', start:$('#e-start').value||today(), end:$('#e-end').value||'', note:$('#e-note').value.trim(), updatedAt:Date.now(), updatedBy:me() };
    const xid=rid();
    put('exposures/'+xid, rec);
    logChange(xid,'exposure',`${label(bull)} put with ${rec.group||'selected cows'} (${ids.length} head)`,'added',[{f:'Put in',to:fmtDate(rec.start)}].concat(rec.end?[{f:'Pulled',to:fmtDate(rec.end)}]:[]));
    logChange(bull.id,'animal',label(bull),'put with cows',[{f:'Cows',to:`${rec.group||'selected cows'} · ${ids.length} head from ${fmtDate(rec.start)}`}]);
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
$('#exportCsv').addEventListener('click', ()=>{
  const rows=[['type','collar','group','brand1','brand2','collar_fitted','notes','purchase_price','purchase_date','sale_price','sale_date','bulls_with','last_updated']];
  animals().sort(byCollar).forEach(a=>{
    const bw = a.kind==='bull' ? '' : expsForCow(a.id).map(x=>`${label(S.animals.get(x.bullId))} ${x.start}${x.end?' to '+x.end:''}`).join('; ');
    rows.push([KIND[a.kind]||'Cow',a.collar,a.group,a.brand1,a.brand2,a.collarOn?'yes':'no',a.notes,a.purchasePrice??'',a.purchaseDate||'',a.salePrice??'',a.saleDate||'',bw,a.updatedAt?new Date(a.updatedAt).toISOString():'']);
  });
  saveFile(`herd-${today()}.csv`, rows.map(r=>r.map(csvCell).join(',')).join('\n'), 'text/csv');
});
$('#exportJson').addEventListener('click', ()=>{
  saveFile(`herd-backup-${today()}.json`, JSON.stringify({exported:new Date().toISOString(), animals:animals(), exposures:[...S.exposures.values()], collars:[...S.collars.values()]},null,2), 'application/json');
});
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
$('#importFile').addEventListener('change', async e=>{
  const file=e.target.files[0]; e.target.value=''; if(!file) return;
  const rows=parseCsv(await file.text()); const msg=$('#importMsg');
  if(rows.length<2){ msg.textContent='That file has no rows to import.'; return; }
  const head=rows[0].map(h=>h.trim().toLowerCase().replace(/[^a-z0-9]/g,''));
  const col=(...n)=>head.findIndex(h=>n.includes(h));
  const ix={kind:col('type','kind','class'),collar:col('collar','collarnumber','collarno'),group:col('group','herd','pasture'),b1:col('brand1','brand','firstbrand'),b2:col('brand2','secondbrand'),notes:col('notes','note','comments'),on:col('collarfitted','fitted','collaron'),
    pp:col('purchaseprice','price','cost','boughtfor'),pd:col('purchasedate','bought','datebought'),sp:col('saleprice','soldfor'),sd:col('saledate','sold','datesold')};
  if(ix.collar<0 && ix.b1<0){ msg.textContent='No “collar” or “brand” column found. Check the first row has column names.'; return; }
  const existing=new Set(onHand().map(a=>String(a.collar).toLowerCase()).filter(Boolean));
  const get=(r,i)=>i>=0?String(r[i]??'').trim():'';
  const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v:'';
  let added=0, skipped=0; const now=Date.now();
  for(const r of rows.slice(1)){
    const k=get(r,ix.kind).toLowerCase(); const kind = k.startsWith('b')?'bull':k.startsWith('h')?'heifer':'cow';
    const pp=parseMoney(get(r,ix.pp)), sp=parseMoney(get(r,ix.sp));
    const v={kind, collar:get(r,ix.collar), group:get(r,ix.group), brand1:get(r,ix.b1), brand2:get(r,ix.b2), notes:get(r,ix.notes), collarOn:/^(y|yes|true|1)$/i.test(get(r,ix.on)),
      purchasePrice:pp??'', purchaseDate:date(get(r,ix.pd)), salePrice:sp??'', saleDate:date(get(r,ix.sd))};
    if((!v.collar&&!v.brand1) || (v.collar && existing.has(v.collar.toLowerCase()))){ skipped++; continue; }
    outbox.push({op:'set', path:'animals/'+rid(), data:{...v, createdAt:now, updatedAt:now, updatedBy:me()}, t:now});
    added++; if(v.collar) existing.add(v.collar.toLowerCase());
  }
  saveOutbox();
  if(added) logChange('import','import',`Imported ${added} animals from ${file.name}`,'imported',[]); else recompute();
  msg.textContent=`Imported ${added} animals.${skipped?` Skipped ${skipped} rows (no collar or brand, or collar already in the herd).`:''}`;
});

// ---------- boot ----------
function renderAll(){
  if(S.tab==='herd') renderHerd(); else if(S.tab==='yard') renderYard(); else if(S.tab==='collars') renderCollars(); else if(S.tab==='bulls') renderBulls(); else renderLog();
}
setTab(); recompute(); renderSetup();
if(!storageOk) toast('This browser isn’t keeping a copy on the phone. Use the home-screen app instead.');
firstRun();
sync();
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
window.__herdbook = { sync, state:S, outbox:()=>outbox, conflicts:()=>conflicts, cfg };
})();
