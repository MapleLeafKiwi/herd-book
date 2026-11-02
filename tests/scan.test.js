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

  const types2 = 1;
  const F = await phone('Scan', {start:'Scan Ranch'}); const pf=F.page;
  pf.on('console', m=>{ if(m.type()==='error') console.log('console:', m.text()); }); pf.on('requestfailed', r=>console.log('failed:', r.url().slice(0,90)));
  await pf.goto('http://localhost:8765/#herd'); await wait(200);
  await pf.click('[data-open-import] >> nth=0'); await pf.setInputFiles('#imp-file',path.join(FIX,'eshepherd-sample.xlsx')); await pf.waitForSelector('#imp-go'); await pf.click('#imp-go'); await wait(2500);
  // new cow with no collar, fit by photo
  await pf.click('#addBtn'); await pf.fill('#a-b1','Lazy H'); await pf.fill('#a-group','Group 9'); await pf.click('#af button[type=submit]'); await wait(300);
  await pf.goto('http://localhost:8765/#yard'); await wait(300);
  await pf.fill('#yq','Lazy H'); await pf.click('[data-fitc]');
  const t0=Date.now();
  await pf.setInputFiles('#fc-photo',path.join(FIX,'collar-new.jpg'));
  await pf.waitForFunction(()=>{ const t=document.querySelector('#fc-scan').textContent; return document.querySelector('#fc-scan [data-pick]') || /No number|couldn|downloads/.test(t); }, null, {timeout:120000});
  console.log('scan took', Date.now()-t0, 'ms; result:', (await pf.textContent('#fc-scan')).trim().slice(0,160));
  ok((await pf.inputValue('#fc-num'))==='3049917265', 'photo of a new collar filled 3049917265: '+await pf.inputValue('#fc-num'));
  ok((await pf.textContent('#fc-warn')).includes('New collar'), 'new collar will be added to the list');
  await pf.screenshot({path:path.join(OUT,'scan.png')});
  await pf.click('#fc-save'); await wait(400);
  const cow = await pf.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.brand1==='Lazy H'));
  ok(cow.collar==='3049917265' && cow.collarOn===true, 'cow now wears collar 3049917265, fitted');
  ok(await pf.evaluate(()=>[...window.__herdbook.state.collars.values()].some(c=>c.number==='3049917265' && c.neckband==='3049917265')), 'collar added to the collar list with its neckband serial');
  // no signal: reload and scan a known collar from the yard search
  await F.context.setOffline(true);
  await pf.goto('http://localhost:8765/#yard'); await wait(800);
  const t1=Date.now();
  await pf.setInputFiles('#yq-photo',path.join(FIX,'collar-known.png'));
  await pf.waitForFunction(()=>{ const t=document.querySelector('#yScan').textContent; return document.querySelector('#yScan [data-pick]') || /No number|couldn|downloads/.test(t); }, null, {timeout:120000});
  console.log('offline scan took', Date.now()-t1, 'ms; result:', (await pf.textContent('#yScan')).trim().slice(0,160));
  ok((await pf.inputValue('#yq'))==='7203418856', 'offline photo found known collar 7203418856: '+await pf.inputValue('#yq'));
  ok((await pf.textContent('#yardList')).includes('T100L') || (await pf.textContent('#yardList')).includes('X-1'), 'yard shows the cow wearing it');
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
