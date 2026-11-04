// Fit collars screen: pick a collar and a cow, Fit, Undo. Runs the app alone (no sheet) with made-up cattle.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/json'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')+'; charset=utf-8'}); r.end(d); }); }).listen(8766);
const cow = (vid, more) => Object.assign({kind:'cow', brand1:'Bar 9', vid, group:'North', updatedAt:1}, more);
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, expenses:{}, preg:{},
  animals:{ a:cow('A1',{collar:'1001',collarOn:false}), b:cow('B2'), c:cow('C3',{collar:'1003',collarOn:true}), d:cow('D4',{collar:'1004',collarOn:false}),
            e:cow('E5',{kind:'calf'}), f:cow('F6'), g:cow('G7',{kind:'bull', brand1:'Bar 7', group:'South'}) },
  collars:Object.fromEntries([['1001','ok'],['1002','ok'],['1003','ok'],['1004','ok'],['1005','lost']].map(([n,st])=>['c-'+n,{number:n,status:st,note:''}])) };
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(5000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  const A = id => pg.evaluate(id=>window.__herdbook.state.animals.get(id), id);
  await pg.goto('http://localhost:8766/#collars'); await wait(300); await pg.click('#st-skip');
  ok(await pg.locator('nav a[data-tab=yard]').count()===0, 'Yard is gone from the menu');
  ok((await pg.textContent('#cChips')).replace(/\s+/g,' ').match(/All · 5.*Fitted · 1.*Not fitted · 3.*Lost · 1/), 'collar filters are All, Fitted, Not fitted, Lost: '+(await pg.textContent('#cChips')));
  ok(!/Unused|Yard/.test(await pg.textContent('main')), 'no “Unused” or “Yard” wording left');
  ok((await pg.textContent('#collarList')).includes('Last on: Bar 9 A1'), 'not-fitted collar shows the cow it was last on');
  ok(await pg.isVisible('#fitBig'), 'big Fit collars button on the Collars tab');
  await pg.goto('http://localhost:8766/#yard'); await wait(300);
  ok(await pg.isVisible('#fitGo') && await pg.evaluate(()=>window.__herdbook.state.tab)==='fit', 'old #yard link opens the fitting screen');
  // lists
  ok(!(await pg.textContent('#fCollars')).includes('1005') && !(await pg.textContent('#fCollars')).includes('1003'), 'lost and fitted collars are not offered for fitting');
  await pg.fill('#fq','1005'); await wait(100);
  ok((await pg.textContent('#fNotice')).includes('marked lost') && await pg.locator('#fNotice [data-num]').count()===0, 'typing a lost collar warns and can’t be picked');
  await pg.fill('#fq','1003'); await wait(100);
  ok((await pg.textContent('#fNotice')).includes('already fitted on Bar 9 C3'), 'typing a fitted collar warns which cow has it');
  await pg.fill('#fq',''); await pg.click('#fitSwitch [data-side=cow]'); await wait(100);
  ok(await pg.isVisible('#fCows') && !(await pg.isVisible('#fCollars')), 'phone shows one list at a time');
  const cowsText = await pg.textContent('#fCows');
  ok(!cowsText.includes('E5') && !cowsText.includes('C3') && cowsText.includes('A1'), 'calves without a collar and cows with one on are skipped');
  // one tap: her collar from last season is picked for her
  await pg.click('#fCows [data-cow=a]'); await wait(100);
  ok((await pg.textContent('#fitPair')).includes('Collar 1001 → Bar 9 A1') && !(await pg.isDisabled('#fitGo')), 'picking a cow picks her collar from last season');
  await pg.screenshot({path:path.join(OUT,'fit.png')});
  await pg.click('#fitGo'); await wait(200);
  let a = await A('a'); ok(a.collar==='1001' && a.collarOn===true, 'Fit gives the collar and marks it fitted in one step');
  ok((await pg.textContent('#toast')).includes('Collar 1001 fitted'), 'toast says what was fitted');
  { const t=await pg.locator('#toast').boundingBox(), f=await pg.locator('#fitGo').boundingBox(); ok(t.y+t.height<=f.y, 'Undo message sits above the Fit button, not over it'); }
  ok((await pg.textContent('#fitPair')).includes('Pick a collar and an animal'), 'picks clear after fitting');
  // undo
  await pg.click('#toast .undo'); await wait(200);
  a = await A('a'); ok(a.collar==='1001' && a.collarOn===false, 'Undo puts it back');
  // pick a collar first: the cow it was last on is picked
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#fCollars [data-num="1001"]'); await wait(100);
  ok((await pg.textContent('#fitPair')).includes('Collar 1001 → Bar 9 A1'), 'picking a collar picks the cow it was last on');
  await pg.click('#fitGo'); await wait(200);
  ok((await A('a')).collarOn===true, 'fitted again');
  // a new collar not in the list
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=b]'); await wait(100);
  ok(await pg.isVisible('#fq'), 'after picking a cow with no collar, the phone switches to the collar list');
  await pg.fill('#fq','2001'); await wait(100);
  ok((await pg.textContent('#fNotice')).includes('isn’t in your collar list'), 'new number warns it isn’t in the list');
  await pg.click('#fNotice [data-num="2001"]'); await pg.click('#fitGo'); await wait(200);
  const b = await A('b'); ok(b.collar==='2001' && b.collarOn===true, 'new collar fitted');
  ok(await pg.evaluate(()=>window.__herdbook.state.collars.has('c-2001')), 'new collar added to the list');
  // move a collar: 1004 was last on D4, fit it to F6 instead
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=f]'); await wait(100);
  await pg.click('#fCollars [data-num="1004"]'); await wait(100);
  ok((await pg.textContent('#fitPair')).includes('Collar 1004 → Bar 9 F6'), 'cow picked first keeps her pick');
  await pg.click('#fitGo'); await wait(200);
  const f = await A('f'), d = await A('d');
  ok(f.collar==='1004' && f.collarOn===true && d.collar==='', 'collar moved: on F6, cleared from D4');
  // replace: D4 gets 1002; a cow's old number is replaced
  await pg.click('#fitSwitch [data-side=cow]'); await pg.fill('#fcq','D4'); await pg.click('#fCows [data-cow=d]'); await pg.click('#fCollars [data-num="1002"]'); await pg.click('#fitGo'); await wait(200);
  ok((await A('d')).collar==='1002', 'cow gets the new collar number');
  // collar sheet: take off, lost/found
  await pg.goto('http://localhost:8766/#collars'); await wait(200);
  await pg.click('[data-c="c-1001"]'); await pg.click('[data-off]'); await wait(200);
  a = await A('a'); ok(a.collar==='1001' && a.collarOn===false, 'take off: collar stays remembered on the cow, not fitted');
  await pg.click('[data-lost]'); await wait(200);
  ok(await pg.evaluate(()=>window.__herdbook.state.collars.get('c-1001').status)==='lost' && (await A('a')).collar==='', 'mark lost: collar comes off the cow');
  await pg.click('[data-lost]'); await wait(200);
  ok(await pg.evaluate(()=>window.__herdbook.state.collars.get('c-1001').status)==='ok', 'found it: back in use');
  await pg.click('#sheet .x');
  // add collars from the collar maker's spreadsheet (made-up serials)
  const X=require('xlsx'); const ws=X.utils.aoa_to_sheet([['Order #','Device Serial','Model'],[1,'0012345678','EX-200'],[2,'0012345679','EX-200'],[3,'0012345680','EX-200']]);
  const wb=X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Shipment'); const XF=path.join(OUT,'maker.xlsx'); X.writeFile(wb, XF);
  await pg.click('#cAddBtn'); await pg.setInputFiles('#ca-file', XF); await pg.waitForSelector('#ca-col .notice');
  ok((await pg.textContent('#ca-col')).includes('Found 3 numbers in “Device Serial”'), 'spreadsheet: serial column found: '+(await pg.textContent('#ca-col')));
  ok((await pg.inputValue('#ca-nums')).startsWith('0012345678'), 'spreadsheet: leading zeros kept');
  await pg.click('#caf button[type=submit]'); await wait(200);
  ok(await pg.evaluate(()=>{ const c=window.__herdbook.state.collars.get('c-0012345678'); return c && c.neckband==='0012345678'; }), 'spreadsheet collars added, serial saved as the eShepherd neckband');
  const CF=path.join(OUT,'maker.csv'); fs.writeFileSync(CF, 'Serial,Note\n7700000001,box 1\n7700000002,box 1\n');
  await pg.click('#cAddBtn'); await pg.setInputFiles('#ca-file', CF); await pg.waitForSelector('#ca-col .notice'); await pg.click('#caf button[type=submit]'); await wait(200);
  ok(await pg.evaluate(()=>window.__herdbook.state.collars.has('c-7700000002')), 'CSV list from the collar maker works too');
  // ---- animal not known (lost ear tag) ----
  const C = n => pg.evaluate(n=>window.__herdbook.state.collars.get('c-'+n), n);
  const herdSize = await pg.evaluate(()=>window.__herdbook.state.animals.size);
  await pg.goto('http://localhost:8766/#fit'); await wait(200);
  ok((await pg.textContent('#fitSwitch')).includes('Animals') && !/\b(she|her|cows?)\b/i.test((await pg.textContent('#fitSwitch'))+(await pg.textContent('#fitPair'))+(await pg.textContent('section[data-view=fit] .help'))), 'fitting screen wording is neutral: Animals, no she/her/cow');
  await pg.click('#fitSwitch [data-side=collar]'); await pg.fill('#fq','1001'); await pg.click('#fCollars [data-num="1001"]');
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=unknown]'); await wait(100);
  ok((await pg.textContent('#fitPair')).includes('Collar 1001 → animal not known'), 'bottom bar: collar → animal not known');
  await pg.click('#fitGo'); await pg.selectOption('#fu-group','South'); await pg.fill('#fu-note','black, white face'); await pg.click('#fuf button[type=submit]'); await wait(200);
  let c1 = await C('1001'); ok(c1.unknownAt && c1.unknownGroup==='South' && c1.unknownNote==='black, white face', 'collar saved as on an unknown animal, with group and description');
  ok(await pg.evaluate(()=>window.__herdbook.state.animals.size)===herdSize, 'no placeholder animal added to the herd');
  await pg.click('#toast .undo'); await wait(200);
  ok(!(await C('1001')).unknownAt, 'Undo takes it back off the unknown animal');
  await pg.click('#fitSwitch [data-side=collar]'); await pg.fill('#fq','1001'); await pg.click('#fCollars [data-num="1001"]');
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=unknown]'); await pg.click('#fitGo');
  await pg.selectOption('#fu-group','South'); await pg.fill('#fu-note','black, white face'); await pg.click('#fuf button[type=submit]'); await wait(200);
  await pg.goto('http://localhost:8766/#collars'); await wait(200);
  ok((await pg.textContent('#cWarn')).includes('1 collar is on an unknown animal. Work out which one'), 'Collars tab notice: 1 collar is on an unknown animal');
  ok((await pg.textContent('#collarList')).includes('On: unknown animal · South'), 'collar tile: On: unknown animal plus group');
  ok(/Fitted · 5/.test(await pg.textContent('#cChips')), 'Fitted count includes the collar on the unknown animal: '+(await pg.textContent('#cChips')));
  // work it out: only the bull in South has no collar
  await pg.click('#cUnknown'); await wait(100);
  ok((await pg.textContent('#uk')).includes('Only one animal left without a collar: Bull Bar 7. Is this the one?'), 'elimination narrows to one and says so plainly');
  ok((await pg.textContent('#uk')).includes('black, white face'), 'helper shows the description');
  await pg.click('#uk [data-match]'); await wait(200);
  let g = await A('g'); c1 = await C('1001');
  ok(g.collar==='1001' && g.collarOn===true && !c1.unknownAt, 'This is the one: the bull gets the collar, fitted, unknown details cleared');
  ok(/Ear tag lost .+, needs a new tag\./.test(g.notes||''), 'note added: '+g.notes);
  await pg.click('#toast .undo'); await wait(200);
  g = await A('g'); ok(g.collar==='' || !g.collar, 'Undo: bull has no collar again'); ok(!(g.notes||'').includes('Ear tag'), 'Undo: note removed'); ok(!!(await C('1001')).unknownAt, 'Undo: collar back on the unknown animal');
  // no group given: all groups, not calves, not animals with a collar on
  await pg.goto('http://localhost:8766/#fit'); await wait(200);
  await pg.click('#fitSwitch [data-side=collar]'); await pg.fill('#fq','3001'); await pg.click('#fNotice [data-num="3001"]');
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=unknown]'); await pg.click('#fitGo'); await pg.click('#fuf button[type=submit]'); await wait(200);
  await pg.goto('http://localhost:8766/#collars'); await wait(200);
  ok((await pg.textContent('#cWarn')).includes('2 collars are on an unknown animal'), 'notice counts 2 collars');
  await pg.click('#cUnknown'); await wait(100);
  if(!(await pg.textContent('#uk')).includes('3001')){ await pg.click('#uk [data-skip]'); await wait(100); }
  const ukText = await pg.textContent('#uk');
  ok(ukText.includes('2 animals have no collar on') && !ukText.includes('E5') && ukText.includes('Bar 7'), 'no group: every group, bulls included, calves and collared animals left out');
  await pg.click('#uk [data-skip]'); await wait(100);
  ok(!!(await C('3001')).unknownAt, 'Not sure yet leaves it for another day');
  if(await pg.isVisible('#sheet .x')) await pg.click('#sheet .x');
  // new season clears unknown-animal collars too
  await pg.click('#seasonBtn'); await pg.click('#seasonBtn'); await wait(200);
  ok(!(await C('3001')).unknownAt && !(await C('1001')).unknownAt && (await A('b')).collarOn===false, 'new season clears collars on unknown animals as well as fitted ones');
  // wide screen: both lists side by side
  await pg.setViewportSize({width:1024, height:800}); await pg.goto('http://localhost:8766/#fit'); await wait(300);
  ok(await pg.isVisible('#fCollars') && await pg.isVisible('#fCows') && !(await pg.isVisible('#fitSwitch')), 'wide screen shows both lists side by side');
  const box = await pg.locator('#fitGo').boundingBox(); ok(box.height>=56 && box.width>=110, 'Fit button is glove-sized');
  await pg.screenshot({path:path.join(OUT,'fit-wide.png')});
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
