// Work Cattle: day setup, the working screen, every job, finish; Settings gear; Health bulk treatments. App alone, made-up data.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const X = require('xlsx');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/json'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')+'; charset=utf-8'}); r.end(d); }); }).listen(8769);
const an = (vid, more) => Object.assign({kind:'cow', brand1:'Bar 9', vid, group:'North', updatedAt:1}, more);
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, expenses:{}, preg:{},
  animals:{ c1:an('C1',{collar:'101',collarOn:false}), c2:an('C2',{eid:'982000111'}), h3:an('H3',{kind:'heifer', brand1:''}), b1:an('B1',{kind:'bull'}),
            k1:an('K1',{kind:'calf', brand1:'', damId:'c1'}), s1:an('S1',{group:'South'}) },
  collars:Object.fromEntries(['101','102','103'].map(n=>['c-'+n,{number:n,status:'ok',note:''}])) };
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, acceptDownloads:true });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(6000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  const A = id => pg.evaluate(id=>window.__herdbook.state.animals.get(id), id);
  const st = () => pg.evaluate(()=>{ const s=window.__herdbook.state; return { treat:[...s.treatments.values()], preg:[...s.preg.values()], exp:[...s.exposures.values()], hist:s.history }; });
  const today = await pg.evaluate(()=>new Date().toLocaleDateString('en-CA'));
  const hideToast = () => pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.goto('http://localhost:8769/#herd'); await wait(300); await pg.click('#st-skip');

  // ---- tabs and the Settings gear ----
  const navText = (await pg.locator('nav a:not([hidden])').allTextContents()).map(t=>t.trim().toLowerCase()).join(' · ');
  ok(navText==='herd · work cattle · collars · breeding · health · money', 'tabs: '+navText);
  ok(await pg.getAttribute('#gearBtn','aria-label')==='Settings', 'gear button labelled Settings');
  await pg.click('#gearBtn'); await wait(100);
  ok(await pg.isVisible('section[data-view=settings]') && (await pg.textContent('section[data-view=settings] .settings-h'))==='Settings' && await pg.isVisible('#setupCard'), 'gear opens Settings with ranch and phone setup');
  await pg.goto('http://localhost:8769/#log'); await wait(100);
  ok(await pg.isVisible('section[data-view=settings]'), 'old #log link opens Settings');
  ok((await pg.textContent('#setupBanner')).includes('Settings ›') && !(await pg.textContent('body')).includes('Log ›'), 'banner says Settings ›, nothing says Log ›');
  for(const w of [360, 320]){ await pg.setViewportSize({width:w, height:740}); await wait(100);
    ok(await pg.evaluate(()=>{ const n=document.querySelector('nav'), h=document.querySelector('.hrow'), g=document.querySelector('#gearBtn').getBoundingClientRect(); return n.scrollWidth<=n.clientWidth+1 && h.offsetHeight<70 && g.right<=innerWidth; }), `tabs and gear fit without wrapping at ${w}px`); }
  await pg.setViewportSize({width:390, height:844});

  // ---- collars only: exactly the old fitting screen ----
  await pg.goto('http://localhost:8769/#collars'); await wait(150); await pg.click('#fitBig'); await wait(150);
  ok(await pg.isVisible('#fitTop') && !(await pg.isVisible('#wDay')) && (await pg.textContent('#fitGo'))==='Fit' && !(await pg.isVisible('#wPanel')), 'Collars › Fit collars: the familiar fitting screen');
  await pg.click('#fitSwitch [data-side=cow]');
  ok(!(await pg.textContent('#fCows')).includes('New animal here') && await pg.locator('#fCows [data-cow=unknown]').count()===1, 'collars only: lost-tag option, no new-animal button');
  await pg.click('#fCows [data-cow=c1]');
  ok((await pg.textContent('#fitPair')).includes('Collar 101 → Bar 9 C1'), 'collars only: last season’s collar pre-picked');
  await pg.click('#fitGo'); await wait(150);
  ok((await A('c1')).collarOn===true && !(await A('c1')).lastWorked && await pg.locator('#toast .undo').count()===1, 'collars only: Fit fits it, with Undo, and nothing else');
  await pg.click('#toast .undo'); await wait(150);

  // ---- set up a day: collar + two vaccines in North ----
  const startDay = async (setup) => { await pg.goto('http://localhost:8769/#work'); await wait(150); await setup(); await pg.click('#d-start'); await wait(150); };
  await pg.goto('http://localhost:8769/#work'); await wait(150);
  ok(await pg.isVisible('#wSetup') && (await pg.textContent('#wSetup')).includes('What are you doing today?'), 'Work Cattle opens on “What are you doing today?”');
  await startDay(async ()=>{
    await pg.check('#wSetup [data-job=collar]'); await pg.check('#wSetup [data-job=treat]');
    await pg.fill('#d0-product','Vac A'); await pg.fill('#d0-wd','21'); await pg.fill('#d0-cost','40');
    await pg.click('#d-addprod'); await pg.fill('#d1-product','Vac B'); await pg.selectOption('#d1-kind','medicine');
    ok(await pg.inputValue('#d0-product')==='Vac A', 'adding a product keeps what was typed');
    await pg.check('#d-groups input[value="North"]'); });
  ok((await pg.textContent('#wDay')).includes('0 of 5 done'), 'progress: 0 of 5 done in North');
  // setup survives closing the app
  await pg.reload(); await wait(300); await pg.click('#st-skip');
  ok(!(await pg.isVisible('#wSetup')) && (await pg.textContent('#wDay')).includes('Vac A'), 'the day setup is still there after closing and reopening');
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=c2]'); await wait(50);
  await pg.click('#fCollars [data-num="102"]'); await wait(50);
  const pt = await pg.textContent('#wPanel');
  ok(pt.includes('Collar 102') && pt.includes('Vac A') && pt.includes('Vac B') && (await pg.textContent('#fitGo'))==='Done', 'bar shows the collar pair and every job, with Done');
  await pg.click('#fitGo'); await wait(200); await hideToast();
  let c2=await A('c2'); let s=await st();
  ok(c2.collar==='102' && c2.collarOn && c2.lastWorked===today, 'collar fitted and animal marked done');
  const vacA=s.treat.find(t=>t.product==='Vac A'), vacB=s.treat.find(t=>t.product==='Vac B');
  ok(vacA && vacB && vacA.animalIds.join()==='c2' && vacA.date===today && vacA.withdrawalDays===21 && vacA.cost===40, 'both vaccines recorded as treatment records');
  ok((await pg.textContent('#wDay')).includes('1 of 5 done') && !(await pg.textContent('#fCows')).includes('C2'), 'animal leaves the list; 1 of 5 done');
  // untick a job for one animal
  await pg.click('#fCows [data-cow=h3]'); await pg.click('#wPanel [data-tk=collar]'); await pg.click('#wPanel [data-tk=t1]'); await pg.click('#fitGo'); await wait(200); await hideToast();
  s=await st(); const h3=await A('h3');
  ok(s.treat.find(t=>t.product==='Vac A').animalIds.join()==='c2,h3' && s.treat.find(t=>t.product==='Vac B').animalIds.join()==='c2' && !h3.collarOn, 'unticked jobs are skipped for that animal; one record per product');
  await pg.goto('http://localhost:8769/#health'); await wait(100);
  ok((await pg.textContent('#healthList')).includes('Vac A') && (await pg.textContent('#healthList')).includes('2 head') && (await pg.textContent('#healthDue')).includes('withdrawal'), 'Health shows the treatment with its withdrawal');
  // going back to an animal done
  await pg.goto('http://localhost:8769/#work'); await wait(100);
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#wShow [data-w=done]'); await pg.click('#fCows [data-cow=h3]');
  ok((await pg.textContent('#wPanel')).includes('Already done today') && (await pg.getAttribute('#wPanel [data-tk=t1]','aria-checked'))==='false', 'going back to an animal shows what was ticked');
  await pg.click('#wPanel [data-tk=t1]'); await pg.click('#fitGo'); await wait(200); await hideToast();
  s=await st(); ok(s.treat.find(t=>t.product==='Vac B').animalIds.join()==='c2,h3' && s.treat.find(t=>t.product==='Vac A').animalIds.join()==='c2,h3', 'changing it saves the new ticks without doubling up');
  // finish
  await pg.click('#wShow [data-w=todo]'); await pg.click('#wFinish');
  const fin = await pg.textContent('#fin');
  ok(fin.includes('2 head processed') && /Vac A\s*2/.test(fin) && /Vac B\s*2/.test(fin) && /Collars fitted\s*1/.test(fin) && fin.includes('Not processed · 3') && fin.includes('B1') && /Vac A[\s\S]*until/.test(fin), 'finish: head, per-job counts, not processed, withdrawal date');
  await pg.click('#fin-go'); await wait(100);
  ok(await pg.isVisible('#wSetup'), 'Finish clears the day');

  // ---- preg check only ----
  await startDay(async ()=>{ await pg.check('#wSetup [data-job=preg]'); });
  ok(await pg.evaluate(()=>document.querySelector('section[data-view=work]').dataset.nocollar==='1') && await pg.isVisible('#fCows') && !(await pg.isVisible('#fCollars')), 'no collar job: collar side hidden, animal list fills the screen');
  await pg.click('#fCows [data-cow=b1]');
  ok((await pg.textContent('#wPanel')).includes('Preg check is for cows and heifers only') && await pg.locator('#wPanel [data-tk=preg]').count()===0, 'preg not offered for a bull');
  await pg.click('#fCows [data-cow=c1]'); await pg.click('#fitGo'); await wait(50);
  ok((await pg.textContent('#wp-err')).includes('preg result'), 'Done asks for the preg result');
  await pg.click('#wPanel [data-r=open]'); await pg.click('#fitGo'); await wait(150); await hideToast();
  s=await st(); ok(s.preg.some(p=>p.cowId==='c1' && p.type==='check' && p.result==='open' && p.date===today), 'preg check saved as a preg record');
  await pg.click('#wFinish'); await pg.click('#fin-go');

  // ---- branding only, with the duplicate warning ----
  await startDay(async ()=>{ await pg.check('#wSetup [data-job=brand]'); await pg.fill('#d-brand','Bar 9'); });
  await pg.click('#fCows [data-cow=c1]');
  ok((await pg.textContent('#wPanel')).includes('Already has brand Bar 9') && (await pg.getAttribute('#wPanel [data-tk=brand]','aria-checked'))==='false', 'duplicate brand: warning, not ticked');
  await pg.click('#fitGo'); await wait(150); await hideToast();
  ok(!(await A('c1')).brand2, 'brand not added twice');
  await pg.click('#fCows [data-cow=h3]'); await pg.click('#fitGo'); await wait(150); await hideToast();
  ok((await A('h3')).brand1==='Bar 9', 'brand saved to an unbranded animal');
  await pg.click('#wFinish'); await pg.click('#fin-go');

  // ---- weigh + ear tag (replacing an old EID) + custom job with a value ----
  await startDay(async ()=>{ await pg.check('#wSetup [data-job=weigh]'); await pg.check('#wSetup [data-job=tag]'); await pg.check('#wSetup [data-job=custom]'); await pg.fill('#dc0-name','Body condition score'); await pg.check('#dc0-box'); });
  await pg.click('#fCows [data-cow=c2]'); await pg.fill('#wp-weight','1050'); await pg.fill('#wp-eid','982000222'); await pg.fill('#wp-c0','6');
  ok((await pg.textContent('#wPanel')).includes('Already has EID 982000111'), 'ear tag: shows the old tag');
  await pg.click('#fitGo'); await wait(50);
  ok((await pg.textContent('#wp-err')).includes('Replace it') && (await A('c2')).eid==='982000111', 'ear tag: asks before replacing');
  await pg.check('#wp-tagok'); await pg.click('#fitGo'); await wait(150); await hideToast();
  c2=await A('c2'); ok(c2.eid==='982000222' && Number(c2.weight)===1050 && c2.weighedAt===today, 'weight and new EID saved');
  ok(/Body condition score: 6/.test(c2.notes) && (await st()).hist.some(h=>h.targetId==='c2' && (h.changes||[]).some(c=>/Body condition score 6/.test(c.to))), 'custom job with its value goes to notes and the change log');
  // eShepherd export fills weight
  const ws=X.utils.aoa_to_sheet([['Fill in the rows below'],['Action','Animal ID','Neckband','EID*','VID*','Breed','Stock Class','Date of Birth','Tattoo or Brand','Weight (lb)','Weighed date','Expected Weight Gain (lb)','Pregnancy Status','Note'],['','','102']]);
  const wb=X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Sheet1'); const ESF=path.join(OUT,'es-blank.xlsx'); X.writeFile(wb, ESF);
  await pg.click('#gearBtn'); await pg.click('[data-open-export] >> nth=-1');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.setInputFiles('#ex-esfile', ESF)]);
  const got=path.join(OUT,'es-filled.xlsx'); await dl.saveAs(got);
  const rows=X.utils.sheet_to_json(X.readFile(got).Sheets.Sheet1,{header:1,raw:false,defval:''});
  ok(String(rows[2][9])==='1050' && rows[2][10]===today.split('-').reverse().join('-'), 'eShepherd export fills Weight (lb) and Weighed date: '+rows[2][9]+' '+rows[2][10]);
  await pg.click('#sheet .x');
  await pg.goto('http://localhost:8769/#herd'); await wait(100); await pg.click('#herdList [data-id=c2]');
  ok((await pg.textContent('#sheet')).includes('1,050 lb'), 'animal details show the latest weight');
  await pg.click('#sheet .x');
  // going back: untick weigh puts the old weight back
  await pg.goto('http://localhost:8769/#work'); await wait(100);
  await pg.click('#wShow [data-w=done]'); await pg.click('#fCows [data-cow=c2]'); await pg.click('#wPanel [data-tk=weigh]'); await pg.click('#fitGo'); await wait(150); await hideToast();
  ok(!(await A('c2')).weight, 'going back and unticking Weigh removes that weight');
  await pg.click('#wShow [data-w=todo]'); await pg.click('#wFinish'); await pg.click('#fin-go');

  // ---- AI breeding and castrate ----
  await startDay(async ()=>{ await pg.check('#wSetup [data-job=ai]'); await pg.fill('#d-sire','Sire X'); await pg.check('#wSetup [data-job=castrate]'); });
  await pg.click('#fCows [data-cow=b1]');
  ok((await pg.textContent('#fCows [data-cow=b1]')).includes('No AI') && await pg.locator('#wPanel [data-tk=ai]').count()===0 && await pg.locator('#wPanel [data-tk=castrate]').count()===1, 'bull: castrate offered, AI not (note on the card)');
  await pg.click('#fitGo'); await wait(150); await hideToast();
  ok((await A('b1')).kind==='steer', 'castrate changes the type to steer');
  await pg.click('#fCows [data-cow=c1]');
  ok(await pg.locator('#wPanel [data-tk=castrate]').count()===0, 'castrate not offered for a cow');
  await pg.click('#fCows [data-cow=h3]'); await pg.click('#fitGo'); await wait(150); await hideToast();
  s=await st(); ok(s.exp.some(x=>!x.bullId && x.cowIds.includes('h3') && x.start===today && /Sire X/.test(x.note)), 'AI saved as an AI breeding record');
  await pg.goto('http://localhost:8769/#breeding'); await wait(100);
  ok(/H3[\s\S]*Due /.test(await pg.textContent('#breedList')), 'AI breeding shows a calving window in Breeding');
  await pg.goto('http://localhost:8769/#work'); await wait(100); await pg.click('#wFinish'); await pg.click('#fin-go');

  // ---- a new calf at the chute, found by its mother; unknown animal ----
  await startDay(async ()=>{ await pg.check('#wSetup [data-job=collar]'); await pg.check('#wSetup [data-job=note]'); });
  await pg.click('#fitSwitch [data-side=cow]'); await pg.fill('#fcq','101');
  ok((await pg.textContent('#fCows')).includes('K1') && (await pg.textContent('#fCows')).includes('Calf of Bar 9 C1'), 'calf found by its mother’s collar number, card shows the mother');
  await pg.fill('#fcq',''); await pg.click('#fCows [data-newhere]');
  await pg.fill('#nh-vid','K9'); await pg.fill('#nh-damq','C1'); await pg.click('#nh-dams [data-dam=c1]'); await pg.click('#nh-go'); await wait(150);
  const k9=await pg.evaluate(()=>[...window.__herdbook.state.animals.values()].find(a=>a.vid==='K9'));
  ok(k9 && k9.kind==='calf' && k9.damId==='c1' && (await pg.textContent('#wPanel')).includes('calf of Bar 9 C1'), 'new calf added at the chute and picked straight away');
  await pg.click('#wPanel [data-tk=collar]'); await pg.fill('#wp-note','Born in the paddock'); await pg.click('#fitGo'); await wait(150); await hideToast();
  ok(/Born in the paddock/.test((await pg.evaluate(id=>window.__herdbook.state.animals.get(id), k9.id)).notes), 'carried on with the day’s jobs for the new calf');
  await pg.click('#wShow [data-w=done]'); await pg.fill('#fcq','C1');
  ok((await pg.textContent('#fCows')).includes('K9'), 'new calf found by its mother’s tag'); await pg.fill('#fcq',''); await pg.click('#wShow [data-w=todo]');
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#fCollars [data-num="103"]'); await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=unknown]');
  await pg.click('#fitGo'); await pg.click('#fuf button[type=submit]'); await wait(150); await hideToast();
  ok(!!(await pg.evaluate(()=>window.__herdbook.state.collars.get('c-103').unknownAt)), 'unknown animal: collar fitted to an animal not known');
  ok(!/\b(she|her|hers|he|his|him)\b/i.test(await pg.textContent('section[data-view=work]')), 'no gender-specific wording on the working screen');
  await pg.click('#wFinish'); await pg.click('#fin-go');

  // ---- Health: multi-group, pick list, Herd select mode ----
  await pg.goto('http://localhost:8769/#health'); await wait(100); await hideToast(); await pg.click('#treatBtn');
  await pg.fill('#t-product','Pour-on'); await pg.check('#t-groups input[value="North"]'); await pg.check('#t-groups input[value="South"]');
  ok((await pg.textContent('#t-count')).startsWith('6 head'), 'Whole group takes more than one group: '+(await pg.textContent('#t-count')));
  await pg.click('#tf button[type=submit]'); await wait(150);
  s=await st(); const po=s.treat.find(t=>t.product==='Pour-on'); ok(po && po.animalIds.length===6 && po.group==='North, South', 'multi-group treatment saved');
  await hideToast(); await pg.click('#treatBtn'); await pg.click('#t-mode [data-m=pick]'); await pg.fill('#t-pick-filter','South'); await pg.click('[data-pickall="t-pick"]');
  ok((await pg.textContent('#t-pick-n'))==='1 ticked', 'Pick animals: Select all shown ticks only the filtered ones');
  const bx=await pg.locator('#t-pick label:not([hidden]) input').first().boundingBox(); ok(bx.width>=28, 'Pick animals has big tick boxes');
  await pg.click('[data-pickclear="t-pick"]'); ok((await pg.textContent('#t-pick-n'))==='0 ticked', 'Clear unticks'); await pg.click('#sheet .x');
  await pg.goto('http://localhost:8769/#herd'); await wait(100); await pg.click('#selBtn'); await pg.click('#herdList [data-id=c1]'); await pg.click('#herdList [data-id=s1]');
  await pg.click('#selTreat'); await wait(100);
  ok(await pg.isChecked('#t-pick input[value=c1]') && await pg.isChecked('#t-pick input[value=s1]') && !(await pg.isChecked('#t-pick input[value=c2]')), 'Record treatment from Herd select mode picks the selected animals');
  await pg.fill('#t-product','Drench'); await pg.click('#tf button[type=submit]'); await wait(150);
  s=await st(); ok(s.treat.find(t=>t.product==='Drench').animalIds.sort().join()==='c1,s1', 'treatment saved for the selected animals');
  await pg.screenshot({path:path.join(OUT,'work.png')});
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
