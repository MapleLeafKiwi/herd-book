// Scan in order (Order collars): photos keep their place in line however long each takes to read. App alone, made-up data.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'), FIX = path.join(__dirname, 'fixtures'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/json','.wasm':'application/wasm'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')}); r.end(d); }); }).listen(8770);
const col = (n, more) => ['c-'+n, Object.assign({number:String(n), status:'ok', note:''}, more)];
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, expenses:{}, preg:{},
  animals:{ a1:{kind:'cow', vid:'A1', brand1:'Bar 9', group:'North'}, x:{kind:'cow', vid:'X1', collar:'105', collarOn:true} },
  collars:Object.fromEntries([col(101),col(102),col(103),col(104,{neckband:'0099887766'}),col(105),col(106,{status:'lost'}),col('7203418856')]) };
(async()=>{
  const browser = await chromium.launch({ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(8000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  const line = () => pg.evaluate(()=>[...window.__herdbook.state.collars.values()].filter(c=>c.seq!==''&&c.seq!=null).sort((a,b)=>a.seq-b.seq).map(c=>c.number).join());
  const rowsText = () => pg.evaluate(()=>[...document.querySelectorAll('#sr-rows .srrow')].reverse().map(r=>r.className.split(' ')[1]+':'+r.querySelector('.srmain').textContent.replace(/\s+/g,' ').trim()));
  // stand-in reader: a text blob "T:<number>|<ms>" reads as that number after that long; a camera photo reads as no number
  const stubReader = () => pg.evaluate(()=>window.__herdbook.scanRun.setReader(async b=>{ const t=b.type.startsWith('text')?await b.text():''; if(!t.startsWith('T:')) return {cands:[]};
    const [n,ms]=t.slice(2).split('|'); await new Promise(r=>setTimeout(r, Number(ms))); return {cands: n?[{n}]:[]}; }));
  const add = (n, ms) => pg.evaluate(([n,ms])=>window.__herdbook.scanRun.add(new Blob([`T:${n}|${ms}`],{type:'text/plain'})), [n,ms]);
  await pg.goto('http://localhost:8770/#fit'); await wait(300); await pg.click('#st-skip');
  await pg.click('#ordBtn'); await pg.click('#ord-run'); await stubReader();
  await pg.waitForFunction(()=>{ const v=document.querySelector('#sr-vid'); return v && v.videoWidth>0; });
  ok(true, 'Scan in order opens a camera view inside the app');
  const sb=await pg.locator('#sr-shot').boundingBox(); ok(sb.width>=72 && sb.height>=72, 'one big shutter button');
  await pg.click('#sr-shot'); await wait(400);
  ok(await pg.isVisible('#sr-vid') && (await rowsText())[0].startsWith('check:1') && (await rowsText())[0].includes('No number found'), 'a photo with no number keeps its place marked Check: No number found');
  // a run of photos: the first reads slowly, the next ones quickly
  await add('101',600); await add('102',10); await add('999',10); await add('101',10); await add('0099887766',10);
  await wait(150);
  const mid=await rowsText();
  ok(mid[1].includes('Reading') && mid[2].includes('Reading') && mid.length===6, 'each photo takes the next place straight away, shown as Reading…');
  await pg.waitForFunction(()=>!document.querySelector('#sr-rows .srrow.reading'), null, {timeout:8000});
  const rt=await rowsText();
  ok(rt[1].startsWith('ok:2') && rt[1].includes('101') && rt[2].startsWith('ok:3') && rt[2].includes('102'), 'photo order kept even though the later photo read faster');
  ok(rt[3].startsWith('check:4') && rt[3].includes('Not in the collar list (999)'), 'a number not in the list: Check with the reason');
  ok(rt[4].startsWith('check:5') && rt[4].includes('already in the line'), 'the same collar scanned twice: Check, already in the line');
  ok(rt[5].startsWith('ok:6') && rt[5].includes('104'), 'a neckband serial reads as its collar with no tap needed');
  ok((await pg.textContent('#sr-count')).replace(/\s+/g,' ').includes('6 scanned, 3 to check'), 'running count: 6 scanned, 3 to check');
  await pg.screenshot({path:path.join(OUT,'scanrun.png')});
  // fix a Check row: type the number
  await pg.click('#sr-rows .srrow:nth-last-child(4) .srmain');
  ok(await pg.isVisible('#sr-rows .srbig') && await pg.isVisible('[data-srtype]') && await pg.isVisible('[data-srrm]'), 'tapping a Check row shows the photo, a box to type it and Remove');
  await pg.fill('[data-srtype]','103'); await pg.click('[data-sruse]'); await wait(100);
  ok((await rowsText())[3].startsWith('ok:4') && (await rowsText())[3].includes('103'), 'fixed by typing the number');
  // remove the no-number photo
  await pg.click('#sr-rows .srrow:last-child .srmain'); await pg.click('[data-srrm]'); await wait(100);
  ok((await rowsText()).length===5 && (await pg.textContent('#sr-count')).replace(/\s+/g,' ').includes('5 scanned, 1 to check'), 'Remove takes a photo out');
  // Done with one still to check
  await pg.click('#sr-done');
  ok((await pg.textContent('#sr-ask')).includes('1 photo still needs checking') && await pg.isVisible('#sr-fixthem') && await pg.isVisible('#sr-leave'), 'Done asks: Fix them or Leave them out');
  await pg.click('#sr-fixthem');
  ok(await pg.isVisible('[data-srtype]'), 'Fix them opens the row that needs checking');
  await pg.click('#sr-done'); await pg.click('#sr-leave'); await wait(300);
  ok(await line()==='101,102,103,104', 'Done adds the collars to the end of the line in photo order: '+(await line()));
  ok(await pg.isVisible('#ord') && (await pg.textContent('#ord-msg')).includes('4 collars added'), 'back on Order collars with a message');
  ok(await pg.evaluate(()=>!JSON.stringify(window.__herdbook.outbox()).includes('blob:') && !/data:image|T:10/.test(JSON.stringify(window.__herdbook.outbox()))), 'photos are not saved or synced');
  // a run appends after what's already in line; fitted and lost collars need checking; the real scanner reads a collar photo
  await pg.click('#ord-run'); await pg.evaluate(()=>window.__herdbook.scanRun.setReader(null));
  await pg.waitForFunction(()=>{ const v=document.querySelector('#sr-vid'); return v && v.videoWidth>0; });
  const png=fs.readFileSync(path.join(FIX,'collar-known.png')).toString('base64');
  await pg.evaluate(b64=>{ const u=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)); window.__herdbook.scanRun.add(new Blob([u],{type:'image/png'})); }, png);
  await pg.waitForFunction(()=>!document.querySelector('#sr-rows .srrow.reading'), null, {timeout:120000});
  ok((await rowsText())[0].startsWith('ok:1') && (await rowsText())[0].includes('7203418856'), 'the real scanner reads a collar photo in the run: '+(await rowsText())[0]);
  await stubReader(); await add('105',5); await add('106',5); await pg.waitForFunction(()=>!document.querySelector('#sr-rows .srrow.reading'));
  const rt2=await rowsText(); ok(rt2[1].includes('is fitted') && rt2[2].includes('is lost'), 'fitted or lost collars: Check with the reason');
  await pg.click('#sr-done'); await pg.click('#sr-leave'); await wait(300);
  ok(await line()==='101,102,103,104,7203418856', 'second run goes on the end: '+(await line()));
  await pg.click('#sheet .x');
  // the photo button on the fitting screen still works as before
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await pg.click('#ord-clear'); await pg.click('#ord-clear'); await pg.click('#sheet .x');
  await pg.setInputFiles('#fq-photo', path.join(FIX,'collar-known.png'));
  await pg.waitForFunction(()=>document.querySelector('#fScan [data-pick]') || /No number|couldn/.test(document.querySelector('#fScan').textContent), null, {timeout:120000});
  ok((await pg.textContent('#fScan')).includes('Tap the right number') && await pg.inputValue('#fq')==='7203418856', 'fitting screen photo button: one photo, then tap the right number, as before');
  // camera refused: fall back to the photo button on the Order screen
  const ctx2 = await browser.newContext({ viewport:{width:390,height:844} });
  await ctx2.route(/script\.google/, r=>r.abort());
  await ctx2.addInitScript(m=>{ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'}));
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotAllowedError')); }, mirror);
  const p2 = await ctx2.newPage(); await p2.goto('http://localhost:8770/#fit'); await wait(300); await p2.click('#st-skip');
  await p2.click('#ordBtn'); await p2.click('#ord-run'); await wait(300);
  ok(await p2.isVisible('#ord') && (await p2.textContent('#ord-msg')).includes('camera couldn’t open') && await p2.isVisible('label[for="ord-photo"]'), 'camera refused: back to Order collars with the Photo button');
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
