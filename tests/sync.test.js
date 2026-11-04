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
  const A = await phone('Dave', {start:'Willow Creek'});
  const CODE = await A.page.evaluate(()=>window.__herdbook.cfg.code);
  ok(/^[a-z]+-[a-z]+-\d{3}$/.test(CODE), 'new ranch got a code: '+CODE);
  ok(admin.tabs['Ranches'] && admin.tabs['Ranches'].grid[1][0]==='Willow Creek' && admin.tabs['Ranches'].grid[1][3]===true, 'ranch listed and active in Ranches tab');
  const B = await phone('Sue', {code: CODE});
  const pa = A.page, pb = B.page;

  // A adds an animal and collars
  await pa.click('#addBtn');
  await pa.fill('#a-collar', '12'); await pa.fill('#a-b1', 'Bar T'); await pa.fill('#a-group', 'Home herd');
  await pa.fill('#a-pp', '2,450'); await pa.click('#af button[type=submit]');
  await pa.click('#addBtn'); await pa.selectOption('#a-kind','bull'); await pa.fill('#a-collar','B1'); await pa.fill('#a-b1','Lazy J'); await pa.click('#af button[type=submit]');
  await pa.goto('http://localhost:8765/?s='+encodeURIComponent(SYNC)+'&k='+CODE+'#collars');
  await pa.click('#cAddBtn'); await pa.fill('#ca-nums','1-20, 007'); await pa.click('#caf button[type=submit]');
  await wait(2500);
  ok(await pa.evaluate(()=>window.__herdbook.outbox().length)===0, 'phone A sent everything');
  ok(ranchBooks()[0].tabs['Animals'] && ranchBooks()[0].tabs['Animals'].getLastRow()===3, 'sheet has 2 animals');
  ok(ranchBooks()[0].tabs['Collars'].getLastRow()===22, 'sheet has 21 collars (incl. leading-zero 007)');
  ok(ranchBooks()[0].tabs['Collars'].grid.some(r=>r[1]==='007'), 'collar 007 kept its zeros');

  // B pulls
  await pb.evaluate(()=>window.__herdbook.sync()); await wait(500);
  ok(await pb.evaluate(()=>window.__herdbook.state.animals.size)===2, 'phone B sees both animals');
  ok(await pb.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='12').purchasePrice)===2450, 'price came through as a number');

  // B goes offline, fits collar 12 and reloads (app must still open)
  await B.context.setOffline(true);
  await pb.goto('http://localhost:8765/?s='+encodeURIComponent(SYNC)+'&k='+CODE+'#yard').catch(e=>console.log('offline nav error', e.message));
  ok(await pb.locator('#yardList').count()===1, 'app opens with no signal (service worker)');
  await pb.fill('#yq','12'); await pb.click('[data-fit]');
  ok(await pb.evaluate(()=>window.__herdbook.outbox().length)>0, 'offline change held on phone B');
  ok((await pb.textContent('#sync')).includes('No signal'), 'status says no signal: '+(await pb.textContent('#sync')));
  ok((await pb.textContent('#net'))==='Offline', 'header says Offline');
  // reload offline again: change must survive
  await pb.reload(); await wait(300);
  ok(await pb.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='12').collarOn)===true, 'offline change survives reload');

  // Meanwhile A edits notes on same cow (field-level merge)
  await pa.goto('http://localhost:8765/?s='+encodeURIComponent(SYNC)+'&k='+CODE+'#herd');
  await pa.click('.row[data-id]:has-text("Bar T")'); await pa.fill('#a-notes','Limps on left hind'); await pa.click('#af button[type=submit]');
  await wait(2500);

  // B back online
  await B.context.setOffline(false);
  await pb.evaluate(()=>window.dispatchEvent(new Event('online'))); await wait(1500);
  await pb.evaluate(()=>window.__herdbook.sync()); await wait(500);
  ok(await pb.evaluate(()=>window.__herdbook.outbox().length)===0, 'phone B sent its offline change');
  await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  const cowA = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='12'));
  ok(cowA.collarOn===true && cowA.notes==='Limps on left hind', 'both edits kept on phone A (fitted + note)');
  const hist = await pa.evaluate(()=>window.__herdbook.state.history.map(h=>h.by+': '+h.text));
  ok(hist.some(h=>h.startsWith('Sue'))&&hist.some(h=>h.startsWith('Dave')), 'change log shows both people');

  // ---- clash: same field edited on two phones while both offline ----
  const editCow = async (page, fill) => {
    await page.goto('http://localhost:8765/#herd'); await page.click('.x').catch(()=>{});
    await page.click('.row[data-id]:has-text("Bar T")'); await fill(page); await page.click('#af button[type=submit]');
  };
  await A.context.setOffline(true); await B.context.setOffline(true);
  await editCow(pa, p=>p.fill('#a-notes','Calved early'));
  await editCow(pb, p=>p.fill('#a-notes','Open, cull'));
  await editCow(pa, p=>p.fill('#a-group','North'));
  await editCow(pb, p=>p.fill('#a-group','North'));            // same value on both: not a clash
  await A.context.setOffline(false); await pa.evaluate(()=>window.__herdbook.sync()); await wait(800);
  await B.context.setOffline(false); await pb.evaluate(()=>window.__herdbook.sync()); await wait(800);
  const cx = await pb.evaluate(()=>window.__herdbook.conflicts());
  ok(cx.length===1 && cx[0].field==='notes' && cx[0].theirs==='Calved early' && cx[0].mine==='Open, cull' && cx[0].by==='Dave', 'phone B is asked about the notes clash only: '+JSON.stringify(cx.map(c=>[c.field,c.mine,c.theirs,c.by])));
  ok(await pa.evaluate(()=>window.__herdbook.conflicts().length)===0, 'phone A (synced first) is not asked');
  ok(await pb.locator('#cx').count()===1, 'choice screen opened on phone B');
  await pb.screenshot({path:path.join(OUT,'clash.png')});
  await pb.click('#cx [data-keep="mine"]'); await wait(2200);
  await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  const cow2 = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='12'));
  ok(cow2.notes==='Open, cull' && cow2.group==='North', 'Keep mine wins on both phones');

  // ---- clash: deleted on one phone, edited on the other ----
  await A.context.setOffline(true); await B.context.setOffline(true);
  await pa.goto('http://localhost:8765/#herd'); await pa.click('.row[data-id]:has-text("Lazy J")'); await pa.click('#a-del'); await pa.click('#a-del');
  await pb.goto('http://localhost:8765/#herd'); await pb.click('.row[data-id]:has-text("Lazy J")'); await pb.fill('#a-notes','Sound'); await pb.click('#af button[type=submit]');
  await A.context.setOffline(false); await pa.evaluate(()=>window.__herdbook.sync()); await wait(800);
  await B.context.setOffline(false); await pb.evaluate(()=>window.__herdbook.sync()); await wait(800);
  const cx2 = await pb.evaluate(()=>window.__herdbook.conflicts());
  ok(cx2.length===1 && cx2[0].type==='deleted', 'phone B told the bull was deleted');
  await pb.click('#cx [data-keep="restore"]'); await wait(2200);
  await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  ok(await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].some(a=>a.collar==='B1' && a.notes==='Sound')), 'bull brought back with B’s note');

  // ---- crew access: no prices ----
  await pa.goto('http://localhost:8765/#herd'); await wait(300);
  await pa.click('#addBtn'); await pa.selectOption('#a-kind','heifer'); await pa.fill('#a-collar','30'); await pa.fill('#a-b1','Rocking R');
  await pa.fill('#a-pp','1800'); await pa.fill('#a-sp','2600'); await pa.fill('#a-sd','2026-10-20'); await pa.click('#af button[type=submit]'); await wait(2200);
  await pa.goto('http://localhost:8765/#log'); await wait(200); await pa.click('#shareBtn'); await wait(200);
  ok((await pa.textContent('#sh-body')).includes('never see purchase or sale prices'), 'share opens on crew (no prices) by default');
  await pa.screenshot({path:path.join(OUT,'share.png')});
  const CREW = await pa.evaluate(()=>window.__herdbook.cfg.crewCode);
  ok(CREW && CREW!==CODE, 'ranch has a separate crew code: '+CREW);
  await pa.click('.x');
  const E = await phone('Farmhand', {code: CREW}); const pe = E.page; await wait(1200);
  const crewAnimals = await pe.evaluate(()=>[...window.__herdbook.state.animals.values()]);
  ok(crewAnimals.length===3, 'crew phone sees the herd ('+crewAnimals.length+')');
  ok(crewAnimals.every(a=>!('purchasePrice' in a) && !('salePrice' in a) && !('saleDate' in a)), 'crew phone received no prices at all');
  ok(crewAnimals.find(a=>a.collar==='30').sold===true, 'crew still knows the sold heifer is gone');
  const crewHist = JSON.stringify(await pe.evaluate(()=>window.__herdbook.state.history));
  ok(!/purchasePrice|salePrice|2450|1800|2600/.test(crewHist), 'crew change log has no prices');
  await pe.goto('http://localhost:8765/#herd'); await wait(300);
  ok(!(await pe.textContent('#stats')).includes('$'), 'crew herd totals show no money');
  await pe.click('.row[data-id]:has-text("Bar T")');
  ok(await pe.locator('#a-pp').count()===0, 'crew edit form has no price fields');
  await pe.fill('#a-notes','Checked by farmhand'); await pe.click('#af button[type=submit]'); await wait(2200);
  doPost(JSON.stringify({code:CREW, since:0, ops:[{col:'animals', id:crewAnimals.find(a=>a.collar==='12').id, patch:{purchasePrice:1, notes:'Checked by farmhand'}}]}));
  await pa.evaluate(()=>window.__herdbook.sync()); await wait(500);
  const cow3 = await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.collar==='12'));
  ok(cow3.notes==='Checked by farmhand' && cow3.purchasePrice===2450, 'crew edit arrives; price untouched even by a crafted request');
  ok(await pe.evaluate(()=>window.__herdbook.cfg.role)==='crew' && !(await pe.isVisible('#sh-mode').catch(()=>false)), 'crew phone is crew role');
  await pa.goto('http://localhost:8765/#log'); await wait(200); await pa.click('#shareBtn'); await pa.click('#sh-reset'); await pa.click('#sh-reset'); await wait(600);
  const CREW2 = await pa.evaluate(()=>window.__herdbook.cfg.crewCode);
  ok(CREW2 && CREW2!==CREW, 'new crew link made');
  await pa.click('.x');
  await pe.evaluate(()=>window.__herdbook.sync()); await wait(500);
  await pe.goto('http://localhost:8765/#log'); await wait(300);
  ok((await pe.textContent('#cfg-status')).includes('no longer works'), 'old crew link stops working');

  // ---- new features: health, breeding, money (phone A full access, phone E crew) ----
  await pa.goto('http://localhost:8765/#health'); await wait(300);
  await pa.click('#treatBtn'); await pa.fill('#t-product','Bovi-Shield Gold'); await pa.fill('#t-dose','2 mL'); await pa.fill('#t-wd','30'); await pa.fill('#t-cost','45');
  await pa.selectOption('#t-group','North'); await pa.click('#tf button[type=submit]'); await wait(2200);
  ok((await pa.textContent('#healthList')).includes('Bovi-Shield Gold'), 'treatment recorded for the North group');
  ok((await pa.textContent('#healthDue')).includes('On withdrawal'), 'withdrawal list shows the treated cow');
  await pa.goto('http://localhost:8765/#herd'); await wait(300);
  ok((await pa.textContent('#herdList')).includes('Withdrawal'), 'herd list flags withdrawal');
  await pa.goto('http://localhost:8765/#breeding'); await wait(300);
  await pa.click('#expBtn'); await pa.selectOption('#e-bull',''); await pa.click('#e-mode [data-m=pick]');
  await pa.check('#e-pick input[value="'+cow3.id+'"]'); await pa.fill('#e-start','2026-06-01'); await pa.fill('#e-end','2026-07-15'); await pa.click('#ef button[type=submit]'); await wait(300);
  ok((await pa.textContent('#breedList')).includes('Mar 11') && (await pa.textContent('#breedList')).includes('Apr 24'), 'calving window Mar 11 – Apr 24 from Jun 1 – Jul 15 exposure');
  await pa.click('[data-breed]'); await pa.click('[data-act=check]'); await pa.fill('#pg-date','2026-10-01'); await pa.fill('#pg-days','120');
  ok((await pa.textContent('#pg-due')).includes('2027') , 'preg check shows a due date: '+await pa.textContent('#pg-due'));
  await pa.click('#pgf button[type=submit]'); await wait(300);
  ok((await pa.textContent('#bc')).includes('from preg check'), 'due window refined by preg check');
  await pa.click('#bc [data-act=calving]'); await pa.selectOption('#pg-sex','Heifer calf'); await pa.click('#pgf button[type=submit]'); await wait(2200);
  ok(await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].some(a=>a.kind==='calf' && a.damId)), 'calving added a calf to the herd');
  await pa.click('.x');
  await pa.goto('http://localhost:8765/#money'); await wait(300);
  await pa.click('#expAdd'); await pa.fill('#x-amt','500'); await pa.fill('#x-cat','Feed'); await pa.click('#xf button[type=submit]'); await wait(2200);
  const mt = await pa.textContent('#moneyBody');
  ok(mt.includes('2,195') && mt.includes('2,600') && mt.includes('4,250'), 'money: sales 2,600, purchases 4,250, net −2,195 incl. expense and treatment cost');
  ok(mt.includes('800') && mt.includes('44.4%'), 'sold heifer profit $800 (+44.4%)');
  await pa.screenshot({path:path.join(OUT,'money.png'), fullPage:true});
  // crew phone
  const E2 = await phone('Hand2', {code: CREW2}); const pe2=E2.page; await wait(1200);
  const st2 = await pe2.evaluate(()=>({tr:[...window.__herdbook.state.treatments.values()], ex:window.__herdbook.state.expenses.size, hist:JSON.stringify(window.__herdbook.state.history)}));
  ok(st2.tr.length===1 && !('cost' in st2.tr[0]), 'crew sees the treatment but not its cost');
  ok(st2.ex===0 && !/Expense|"amount"/.test(st2.hist), 'crew gets no expenses at all');
  ok(await pe2.isHidden('#navMoney'), 'crew has no Money tab');
  await pe2.goto('http://localhost:8765/#breeding'); await wait(300);
  ok((await pe2.textContent('#breedList')).length>20, 'crew can see breeding');

  // ---- import the real eShepherd file, then fill it back in ----
  const F = await phone('Imp', {start:'Import Ranch'}); const pf=F.page;
  await pf.goto('http://localhost:8765/#herd'); await wait(200);
  await pf.click('[data-open-import] >> nth=0'); await pf.setInputFiles('#imp-file',path.join(FIX,'eshepherd-sample.xlsx')); await pf.waitForSelector('#imp-go');
  ok((await pf.textContent('#imp-map')).includes('eShepherd file'), 'import recognises the eShepherd file');
  const prevTxt = await pf.textContent('#imp-preview');
  ok(prevTxt.includes('93 new'), 'import preview: '+prevTxt.trim());
  await pf.click('#imp-go'); await wait(2500);
  const imp = await pf.evaluate(()=>[...window.__herdbook.state.animals.values()]);
  ok(imp.length===93 && imp.some(a=>a.collar==='0550002222' && a.vid==='T205' && a.brand1==='X-2'), 'imported 93 with neckband kept as text (leading zero), VID and brand');
  await pf.click('[data-open-export] >> nth=0');
  const [dl] = await Promise.all([ pf.waitForEvent('download'), pf.setInputFiles('#ex-esfile',path.join(FIX,'eshepherd-sample.xlsx')) ]);
  await dl.saveAs(path.join(OUT,'filled.xlsx'));
  ok((await pf.textContent('#ex-msg')).includes('93'), 'eShepherd fill: '+(await pf.textContent('#ex-msg')).trim().slice(0,120));
  const X=require('xlsx'); const fr=X.utils.sheet_to_json(X.readFile(path.join(OUT,'filled.xlsx')).Sheets.Sheet1,{header:1,raw:false,defval:''});
  ok(fr[1][0]==='Action' && fr[1][2]==='Neckband', 'filled file keeps eShepherd’s header layout');
  const rT205=fr.find(r=>r[2]==='0550002222');
  ok(rT205 && rT205[0]==='CREATE' && rT205[4]==='T205' && rT205[6]==='Cow', 'filled row: CREATE, VID T205, Stock Class Cow, neckband 0550002222');
  ok(fr.filter(r=>r[0]==='NO ACTION').length===31, 'rows with no animal left as NO ACTION');

  // ---- a second ranch stays separate; wrong sign-up code refused; switched-off ranch blocked ----
  const D = await phone('Ann', {start:'Second Ranch', signup:'nope', expectFail:true});
  await wait(500);
  ok((await D.page.textContent('#st-msg')).includes('sign-up code'), 'wrong sign-up code refused');
  await D.page.fill('#st-signup',SIGNUP); await D.page.click('#stf button[type=submit]');
  await D.page.waitForSelector('#sheet [data-qr] svg'); await D.page.click('#sheet .x'); await wait(800);
  ok(ranchBooks().length===3, 'second ranch got its own sheet');
  ok(await D.page.evaluate(()=>window.__herdbook.state.animals.size)===0, 'second ranch sees none of Willow Creek’s cattle');
  ok((await D.page.textContent('#sync')).startsWith('Second Ranch'), 'ranch name shown: '+(await D.page.textContent('#sync')));
  admin.tabs['Ranches'].grid.find(r=>r&&r[0]==='Second Ranch')[3] = false;
  await D.page.evaluate(()=>window.__herdbook.sync()); await wait(500);
  ok((await D.page.evaluate(()=>document.querySelector('#sync').textContent)).includes('problem'), 'switched-off ranch can’t sync');
  await D.page.goto('http://localhost:8765/#log'); await wait(300);
  ok((await D.page.textContent('#cfg-status')).includes('switched off'), 'phone says the ranch is switched off');
  await pa.goto('http://localhost:8765/#log'); await wait(400);
  await pa.screenshot({path:path.join(OUT,'setup.png'), fullPage:true});

  // bad code
  const C = await browser.newContext(); await C.route(SYNC, r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(doPost(r.request().postData()))}));
  const pc = await C.newPage(); await pc.goto(`http://localhost:8765/?s=${encodeURIComponent(SYNC)}&k=wrong`); await pc.fill('#st-name','X'); await pc.click('#stf button[type=submit]'); await wait(800);
  ok(await pc.evaluate(()=>window.__herdbook.state.animals.size)===0, 'wrong farm code gets nothing');

  await pa.goto('http://localhost:8765/#collars'); await wait(300);
  await pa.screenshot({path:path.join(OUT,'collars.png')});
  await pb.goto('http://localhost:8765/#log'); await wait(300);
  await pb.screenshot({path:path.join(OUT,'log.png'), fullPage:false});
  console.log('sync calls:', calls);
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
