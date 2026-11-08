// Rancher feedback batch: died/missing, calves need collars, sell several at once, sell-or-carry calculator, text size, calf size, gestation shared through the sheet.
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
}).listen(8767);

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
    await page.goto(`http://localhost:8767/?s=${encodeURIComponent(SYNC)}` + (how.code ? `&k=${how.code}` : ''));
    await page.fill('#st-name', name);
    if(how.start){
      await page.click('#st-mode [data-m=start]'); await page.fill('#st-ranch', how.start); await page.fill('#st-signup', how.signup || SIGNUP);
      await page.click('#stf button[type=submit]');
      if(how.expectFail) return { context, page };
      await page.waitForSelector('#sheet [data-qr] svg'); await page.click('#sheet .x');
    } else await page.click('#stf button[type=submit]');
    return { context, page };
  }
  const U = 'http://localhost:8767/';
  const A = await phone('Dave', {start:'Test Ranch'}); const pa = A.page;
  const CODE = await pa.evaluate(()=>window.__herdbook.cfg.code);
  const byVid = (pg, v) => pg.evaluate(v=>[...window.__herdbook.state.animals.values()].find(a=>a.vid===v), v);
  async function add(vid, kind, group){
    await pa.click('#addBtn'); await pa.selectOption('#a-kind', kind); await pa.fill('#a-vid', vid);
    if(group){ const has = await pa.locator(`#a-group option:text-is("${group}")`).count(); if(has) await pa.selectOption('#a-group', group); else { await pa.selectOption('#a-group','__new'); await pa.fill('#a-gnew', group); } }
    await pa.click('#af button[type=submit]'); await wait(80);
  }
  await pa.goto(U+'#herd'); await wait(200);
  await add('H1','heifer','Pasture A'); await add('H2','heifer','Pasture A'); await add('H3','heifer','Pasture A'); await add('H4','heifer','Pasture A'); await add('C1','calf','Pasture A');
  ok(!!(await byVid(pa,'H1')), 'an animal can be added with just its ear tag');

  // every animal wears a collar, calves too
  await pa.goto(U+'#fit'); await wait(200); await pa.click('#fitSwitch [data-side=cow]'); await wait(100);
  ok((await pa.textContent('#fCows')).includes('C1'), 'calf with no collar is offered on the fitting screen');

  // missing, then died
  await pa.goto(U+'#herd'); await wait(150);
  await pa.click('.row[data-id]:has-text("H1")'); await pa.selectOption('#a-status','missing');
  ok(await pa.isVisible('#a-sdate') && (await pa.inputValue('#a-sdate'))!=='', 'picking Missing shows a date, filled with today');
  await pa.click('#af button[type=submit]'); await wait(150);
  ok((await pa.textContent('#herdList')).includes('Missing') && (await pa.textContent('#stats')).includes('1missing'), 'missing animal stays in the herd with a Missing flag and count: '+(await pa.textContent('#stats')));
  await pa.click('.row[data-id]:has-text("H2")'); await pa.selectOption('#a-status','died'); await pa.fill('#a-sdate','2026-11-01'); await pa.click('#af button[type=submit]'); await wait(150);
  ok((await pa.textContent('#toast')).includes('marked as died'), 'toast says it was marked as died');
  ok(!(await pa.textContent('#herdList')).includes('H2') && (await byVid(pa,'H2')).died==='2026-11-01', 'dead animal leaves the herd list, date saved');
  await pa.check('#showSold'); await wait(100);
  ok((await pa.textContent('#herdList')).includes('Died') && (await pa.textContent('#stats')).includes('1died'), 'Show sold and dead shows it with a Died flag');
  await pa.uncheck('#showSold');
  ok(!(await pa.evaluate(()=>[...window.__herdbook.state.animals.values()].filter(a=>!a.died).length===0)), 'others still on hand');

  // sell several at once, total split evenly
  await pa.setViewportSize({width:360, height:740});
  await pa.click('#selBtn'); await pa.click('.row[data-id]:has-text("H1")'); await pa.click('.row[data-id]:has-text("H3")');
  ok(await pa.isVisible('#selSell'), 'full-access phone has Mark sold in select mode');
  { const bar=await pa.locator('#selBar').boundingBox(); ok(bar.width<=360, 'select bar fits a 360px phone'); }
  { const bar=await pa.locator('#selBar').boundingBox(); ok(bar.height<=160, 'select bar is two rows on a phone ('+Math.round(bar.height)+'px)');
    const t=await pa.locator('#toast').boundingBox(); if(t && await pa.isVisible('#toast')) ok(t.y+t.height<=bar.y, 'message pops up above the select bar, not over it'); }
  await pa.screenshot({path:path.join(OUT,'ranch-selbar.png')});
  await pa.click('#selSell'); await pa.click('#sm-mode [data-m=total]'); await pa.fill('#sm-amt','6,400'); await pa.fill('#sm-buyer','Private buyer');
  ok((await pa.textContent('#sm-sum')).includes('2 head at $3,200.00 each = $6,400.00'), 'total is split evenly: '+(await pa.textContent('#sm-sum')));
  await pa.screenshot({path:path.join(OUT,'ranch-sell.png')});
  await pa.click('#sm button[type=submit]'); await wait(150);
  let h1=await byVid(pa,'H1'), h3=await byVid(pa,'H3');
  ok(h1.salePrice===3200 && h3.salePrice===3200 && h3.buyer==='Private buyer' && !!h3.saleDate, 'both marked sold at $3,200 each with the buyer');
  ok(!(await pa.textContent('#herdList')).includes('H3'), 'sold animals leave the herd list');
  await pa.click('#toast .undo'); await wait(150);
  ok((await byVid(pa,'H3')).salePrice==='' && !(await byVid(pa,'H3')).saleDate, 'Undo puts them back on hand');
  await pa.click('#selBtn'); await pa.click('.row[data-id]:has-text("H3")'); await pa.click('#selSell'); await pa.fill('#sm-amt','3150'); await pa.click('#sm button[type=submit]'); await wait(2500);
  ok((await byVid(pa,'H3')).salePrice===3150, 'sold again at a per-head price');

  // money: deaths line and the sell-or-carry calculator
  await pa.goto(U+'#money'); await wait(200);
  ok((await pa.textContent('#moneyBody')).includes('1 animal died'), 'Money tab counts deaths');
  await pa.click('#expAdd'); ok((await pa.innerHTML('#x-cats')).includes('Bull rental') && (await pa.innerHTML('#x-cats')).includes('Salt &amp; mineral'), 'expense list has his costs'); await pa.click('#sheet .x');
  await pa.click('#carryBtn');
  for(const [k,v] of Object.entries({head:'10', fall:'3000', spring:'3500', months:'6', feed:'60', other:'50', rate:'6', death:'1'})){ await pa.fill(`#cy [data-k=${k}]`, v); }
  await wait(100);
  const cy = (await pa.textContent('#cy-out')).replace(/\s+/g,' ');
  ok(cy.includes('Selling now comes out about $350.00 ahead ($35.00 a head)'), 'calculator: '+cy.slice(0,120));
  ok(cy.includes('$3,536.00'), 'calculator gives the break-even spring price');
  await pa.screenshot({path:path.join(OUT,'ranch-carry.png'), fullPage:true});
  await pa.fill('#cy [data-k=spring]','3700'); await wait(50);
  ok((await pa.textContent('#cy-out')).includes('Carrying over comes out'), 'a higher spring price flips the answer');
  await pa.click('#sheet .x');

  // calf size and ear tag at calving
  await pa.goto(U+'#herd'); await wait(150);
  await pa.click('.row[data-id]:has-text("H4")'); await pa.click('[data-goto=breed]'); await pa.click('#bc [data-act=calving]');
  await pa.selectOption('#pg-sex','Heifer calf'); await pa.selectOption('#pg-size','Big'); await pa.fill('#pg-calftag','T9'); await pa.click('#pgf button[type=submit]'); await wait(150);
  const t9 = await byVid(pa,'T9');
  ok(t9 && t9.kind==='calf' && /^Big heifer calf of/.test(t9.notes), 'calf added with its ear tag and size: '+(t9&&t9.notes));
  if(await pa.isVisible('#sheet .x')) await pa.click('#sheet .x');

  // gestation is shared through the sheet
  await pa.goto(U+'#breeding'); await wait(150); await pa.click('#gestBtn'); await pa.fill('#g-days','285'); await pa.click('#gf button[type=submit]'); await wait(2500);
  ok(ranchBooks()[0].tabs['Settings'] && ranchBooks()[0].tabs['Settings'].grid.some(r=>r[0]==='gestation' && Number(r[1])===285), 'gestation saved in the sheet’s Settings tab');
  const B = await phone('Sue', {code: CODE}); const pb = B.page; await wait(1500);
  await pb.goto(U+'#breeding'); await wait(200);
  ok((await pb.textContent('#gestNote')).includes('285-day'), 'second phone uses the ranch’s gestation: '+(await pb.textContent('#gestNote')));

  // crew: no Mark sold, but they still see who has gone
  const CREW = await pa.evaluate(()=>window.__herdbook.cfg.crewCode);
  const E = await phone('Hand', {code: CREW}); const pe = E.page; await wait(1500);
  await pe.goto(U+'#herd'); await wait(200); await pe.click('#selBtn'); await pe.click('.row[data-id]:has-text("H4")');
  ok(!(await pe.isVisible('#selSell')), 'crew phone has no Mark sold');
  const crewH3 = await byVid(pe,'H3');
  ok(crewH3.sold===true && !('salePrice' in crewH3) && !('saleDate' in crewH3), 'crew knows H3 is sold but gets no price');
  ok(!(await pe.textContent('#herdList')).includes('H2') && !(await pe.textContent('#herdList')).includes('H3'), 'crew herd list leaves out the dead and the sold');

  // text size
  await pb.goto(U+'#settings'); await wait(150); await pb.click('#textSize [data-t="2"]');
  ok(await pb.evaluate(()=>document.documentElement.dataset.text)==='2', 'Biggest text applies at once');
  await pb.reload(); await wait(300);
  ok(await pb.evaluate(()=>document.documentElement.dataset.text)==='2', 'text size is remembered on the phone');
  await pb.goto(U+'#herd'); await wait(200);
  ok(await pb.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1), 'no sideways scrolling with Biggest text');
  { const g=await pb.locator('#gearBtn').boundingBox(); ok(g && g.x+g.width<=390, 'settings gear still on screen with Biggest text'); }
  await pb.screenshot({path:path.join(OUT,'ranch-bigtext.png')});
  await pb.click('.row[data-id]:has-text("H4")'); await wait(150);
  ok(await pb.evaluate(()=>{ const s=document.querySelector('#sheet'); return s.scrollWidth<=s.clientWidth+1 && s.getBoundingClientRect().right<=window.innerWidth+1; }), 'animal form fits the screen with Biggest text');
  await pb.screenshot({path:path.join(OUT,'ranch-bigtext-form.png')});
  await pb.click('#sheet .x');
  ok(await pa.evaluate(()=>document.documentElement.dataset.text||'')==='', 'other phones keep their own text size');

  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exitCode=1; srv.close(); process.exit(1); });
