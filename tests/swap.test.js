// End-to-end test: two phones, a fake Google Sheet running the real Code.gs, offline then online.
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');
const REPO = path.join(__dirname, '..'), FIX = path.join(__dirname, 'fixtures'), OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, {recursive:true});
const SIGNUP = 'test-signup';
const { chromium } = require('playwright');

// ---- fake Apps Script services ----
function makeSheet(name){
  const grid = []; let maxR = 1000, maxC = 26;
  const sh = {
    name, grid,
    getLastRow(){ let n=0; grid.forEach((r,i)=>{ if(r && r.some(v=>v!==''&&v!=null)) n=i+1; }); return n; },
    getLastColumn(){ let n=0; grid.forEach(r=>r&&r.forEach((v,j)=>{ if(v!==''&&v!=null) n=Math.max(n,j+1); })); return n; },
    getMaxRows(){ return maxR; }, getMaxColumns(){ return maxC; },
    insertRowsAfter(a,n){ maxR+=n; }, insertColumnsAfter(a,n){ maxC+=n; },
    setFrozenRows(){},
    getRange(r,c,nr,nc){
      if(r+nr-1>maxR || c+nc-1>maxC) throw new Error('out of bounds');
      return {
        setValues(v){ for(let i=0;i<nr;i++){ grid[r-1+i]=grid[r-1+i]||[]; for(let j=0;j<nc;j++) grid[r-1+i][c-1+j]=v[i][j]; } return this; },
        getValues(){ const o=[]; for(let i=0;i<nr;i++){ const row=[]; for(let j=0;j<nc;j++) row.push(((grid[r-1+i]||[])[c-1+j])??''); o.push(row);} return o; },
        setNumberFormat(){ return this; }, setFontWeight(){ return this; }, insertCheckboxes(){ return this; }, setValue(v){ grid[r-1]=grid[r-1]||[]; grid[r-1][c-1]=v; return this; }
      };
    }
  };
  return sh;
}
const props = {}; const books = {}; let nid = 0;
function makeSS(title){
  const id = 'ss'+(++nid); const tabs = {}; const order = [];
  const ss = { id, title, tabs,
    getId(){ return id; }, getUrl(){ return 'https://docs.google.com/spreadsheets/d/'+id; },
    getSheetByName: n => tabs[n] || null,
    insertSheet: (n) => { tabs[n] = makeSheet(n); order.push(n); return tabs[n]; },
    getSheets: () => order.map(n=>tabs[n]), deleteSheet: sh => { delete tabs[sh.name]; order.splice(order.indexOf(sh.name),1); } };
  books[id] = ss; return ss;
}
const admin = makeSS('admin');
const ranchBooks = () => Object.values(books).filter(b=>b!==admin);
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => admin, create: t => { const s = makeSS(t); s.insertSheet('Sheet1'); return s; }, openById: id => books[id] },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k,v) => { props[k]=v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock(){} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType(){ return this; } }), MimeType: { JSON: 'json' } },
  Utilities: { formatDate: d => d.toISOString().slice(0,10) }, Session: { getScriptTimeZone: () => 'UTC' },
  Date, JSON, Math, String, Number, Array, Object
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(REPO,'sheet-script','Code.gs'),'utf8').replace(/const SIGNUP_CODE = '[^']*';/, `const SIGNUP_CODE = '${SIGNUP}';`), ctx);
let calls = 0;
const doPost = body => { calls++; return JSON.parse(ctx.doPost({ postData: { contents: body } }).s); };

// ---- static server for the app ----
const root = REPO;
const types = { '.html':'text/html', '.js':'text/javascript', '.png':'image/png', '.webmanifest':'application/manifest+json', '.gz':'application/gzip' };
const srv = http.createServer((req,res)=>{
  let p = decodeURIComponent(new URL(req.url,'http://x').pathname); if(p.endsWith('/')) p+='index.html';
  const f = path.join(root, p);
  if(!f.startsWith(root) || !fs.existsSync(f)){ res.writeHead(404); return res.end(); }
  res.writeHead(200, {'Content-Type': types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);
}).listen(8765);

const SYNC = 'https://script.google.com/macros/s/TEST/exec';
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  const browser = await chromium.launch();
  async function phone(name, how){
    const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
    await context.route(SYNC, route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(doPost(route.request().postData())) }));
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => { console.log(name, 'PAGE ERROR', e.message); process.exitCode = 1; });
    await page.goto(`http://localhost:8765/?s=${encodeURIComponent(SYNC)}` + (how.code ? `&k=${how.code}` : ''));
    await page.fill('#st-name', name);
    if(how.start){
      await page.click('#st-mode [data-m=start]'); await page.fill('#st-ranch', how.start); await page.fill('#st-signup', how.signup || SIGNUP);
      await page.click('#stf button[type=submit]');
      if(how.expectFail) return { context, page };
      await page.waitForSelector('#sheet [data-qr] svg'); await page.click('#sheet .x');
    } else await page.click('#stf button[type=submit]');
    return { context, page };
  }

  const A = await phone('Dave', {start:'Swap Ranch'}); const pa=A.page;
  const CODE = await pa.evaluate(()=>window.__herdbook.cfg.code);
  for(const [c,b] of [['111','Bar T'],['222','Lazy J']]){ await pa.click('#addBtn'); await pa.fill('#a-collar',c); await pa.fill('#a-b1',b); await pa.fill('#a-group','North'); await pa.click('#af button[type=submit]'); }
  await wait(2200);
  const B = await phone('Sue', {code: CODE}); const pb=B.page; await wait(1200);
  ok(await pb.evaluate(()=>window.__herdbook.state.animals.size)===2, 'phone B has the herd');
  ok(await pa.isHidden('#swapBar'), 'swap option hidden while there is signal');
  await A.context.setOffline(true); await B.context.setOffline(true);
  await pa.evaluate(()=>window.dispatchEvent(new Event('offline'))); await pb.evaluate(()=>window.dispatchEvent(new Event('offline')));
  const edit = async (page, brand, fill) => { await page.goto('http://localhost:8765/#herd'); await page.click('.x').catch(()=>{}); await page.click(`.row[data-id]:has-text("${brand}")`); await fill(page); await page.click('#af button[type=submit]'); await wait(200); };
  await edit(pa,'Bar T', async p=>{ await p.fill('#a-notes','Limping'); await p.check('#a-on'); await p.fill('#a-pp','2450'); });
  await edit(pb,'Bar T', async p=>{ await p.fill('#a-notes','Fine now'); });
  await edit(pb,'Lazy J', async p=>{ await p.fill('#a-group','South'); });
  ok(await pa.isVisible('#swapBar'), 'swap option shows with no signal: '+(await pa.textContent('#swapBar')).trim());
  await pa.screenshot({path:path.join(OUT,'swapbar.png')});
  // A shows, B "scans" (frames decoded straight from A's real QR on screen for frame 1, the rest fed directly)
  await pa.click('#swapBar'); await pa.waitForSelector('#sw-qr svg');
  const { frames } = await pa.evaluate(()=>window.__herdbook.swapFrames());
  const shot = await pa.locator('#sw-qr').screenshot();
  const { PNG } = require('pngjs'); const jsQR=require('jsqr');
  const png = PNG.sync.read(shot); const dec = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  ok(dec && /^HB1\|/.test(dec.data), 'QR on screen decodes with the camera reader ('+frames.length+' code'+(frames.length>1?'s':'')+')');
  await pa.screenshot({path:path.join(OUT,'swapshow.png')});
  ok(!frames.join('').includes('2450'), 'price never leaves the phone in a swap (payload checked)');
  const resB = await pb.evaluate(async fr=>{ const h=window.__herdbook, c=h.swapCollector(); let st; for(const f of fr.slice().reverse()) st=c.add(f); return st.done ? await h.swapReceive(c.joined()) : {error:'incomplete'}; }, frames);
  ok(resB.added>0 && resB.clashes===1, 'phone B got A’s changes, 1 clash (notes): '+JSON.stringify(resB));
  const cowOnB = await pb.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='111'));
  ok(cowOnB.collarOn===true && !('purchasePrice' in cowOnB && cowOnB.purchasePrice===2450), 'B now sees the collar fitted, without the price');
  await pb.waitForSelector('#cx', {timeout:4000}).catch(()=>{});
  await pb.evaluate(()=>{ document.querySelector('#scrim').hidden=true; });
  await pb.evaluate(()=>window.__herdbook.conflicts().length) && await pb.evaluate(()=>{ const b=document.querySelector('#conflictBar'); b.click(); });
  await pb.click('#cx [data-keep="mine"]'); await wait(200);
  // B shows back to A
  const framesB = (await pb.evaluate(()=>window.__herdbook.swapFrames())).frames;
  const resA = await pa.evaluate(async fr=>{ const h=window.__herdbook, c=h.swapCollector(); fr.forEach(f=>c.add(f)); return await h.swapReceive(c.joined()); }, framesB);
  ok(resA.added>0 && !resA.error, 'phone A got B’s changes: '+JSON.stringify(resA));
  const notesA = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='111').notes);
  const groupA = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='222').group);
  ok(groupA==='South', 'A sees B’s group change with no signal');
  console.log('A notes after swap (before sync):', notesA);
  // signal back: A syncs first, then B
  await A.context.setOffline(false); await pa.evaluate(()=>window.dispatchEvent(new Event('online'))); await wait(1500); await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  await B.context.setOffline(false); await pb.evaluate(()=>window.dispatchEvent(new Event('online'))); await wait(1500); await pb.evaluate(()=>window.__herdbook.sync()); await wait(500);
  await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  const fin = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].map(a=>({c:a.collar, n:a.notes, on:a.collarOn, g:a.group, p:a.purchasePrice})));
  console.log('final on A:', JSON.stringify(fin));
  const cow = fin.find(x=>x.c==='111');
  ok(cow.n==='Fine now' && cow.on===true && cow.p===2450, 'final: Sue’s note kept (her choice), collar fitted, price kept');
  ok(fin.find(x=>x.c==='222').g==='South', 'final: group change kept');
  ok(await pa.evaluate(()=>window.__herdbook.conflicts().length)===0 && await pb.evaluate(()=>window.__herdbook.conflicts().length)===0, 'nobody asked twice after syncing');
  const hist = await pa.evaluate(()=>window.__herdbook.state.history.filter(h=>/edited/.test(h.action) && h.text.includes('111')).length);
  const sheetHist = ranchBooks()[0].tabs['Change log'].getLastRow()-1;
  const ids = ranchBooks()[0].tabs['Change log'].grid.slice(1).map(r=>r[0]); 
  ok(new Set(ids).size===ids.length, 'change log has no duplicates in the sheet ('+sheetHist+' rows)');
  ok(await pa.isHidden('#swapBar'), 'swap option hides again with signal');
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
