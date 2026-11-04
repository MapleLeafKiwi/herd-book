// Collar order on the fitting screen: line up collars, next one picked, Skip, Lost, out of order. App alone, made-up data.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'), FIX = path.join(__dirname, 'fixtures'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/json','.wasm':'application/wasm','.gz':'application/gzip'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')}); r.end(d); }); }).listen(8768);
const cow = (vid, more) => Object.assign({kind:'cow', brand1:'Bar 9', vid, group:'North', updatedAt:1}, more);
const col = (n, st) => ['c-'+n, {number:String(n), status:st||'ok', note:''}];
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, expenses:{}, preg:{},
  animals:{ a1:cow('A1'), a2:cow('A2'), a3:cow('A3'), a4:cow('A4'), a5:cow('A5'), a7:cow('A7',{collar:'105',collarOn:false}), x:cow('X1',{collar:'112',collarOn:true}) },
  collars:Object.fromEntries([101,102,103,104,105,106,107,108,109,110].map(n=>col(n)).concat([col(111,'lost'), col(112), col('7203418856')])) };
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(8000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  const A = id => pg.evaluate(id=>window.__herdbook.state.animals.get(id), id);
  const line = () => pg.evaluate(()=>[...window.__herdbook.state.collars.values()].filter(c=>c.seq!==''&&c.seq!=null&&c.status!=='lost').sort((a,b)=>a.seq-b.seq).map(c=>c.number).filter(n=>{ const a=[...window.__herdbook.state.animals.values()].find(x=>x.collar===n && x.collarOn); return !a; }));
  const hideToast = () => pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.goto('http://localhost:8768/#fit'); await wait(300); await pg.click('#st-skip');
  ok(!(await pg.textContent('main')).toLowerCase().includes('fence'), 'no mention of fences');
  ok(await pg.evaluate(()=>{ const q=document.querySelector('#fq').getBoundingClientRect(), b=document.querySelector('#ordBtn').getBoundingClientRect(); return b.top>=q.bottom && b.top-q.bottom<30 && document.querySelector('#ordBtn').closest('.fit-col[data-side=collar]'); }), 'Order collars button sits under the collar search box');
  // no order: last season's collar is still pre-picked
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=a7]');
  ok((await pg.textContent('#fitPair')).includes('Collar 105 → Bar 9 A7'), 'no order set: picking an animal still pre-picks last season’s collar');
  await pg.click('#fCows [data-cow=a7]'); await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#fCollars [data-num="105"]');
  // type a range
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await pg.fill('#ord-nums','103-101, 111, 112, 999'); await pg.click('#ord-add');
  ok(JSON.stringify(await line())==='["103","102","101"]', 'typed range sets the order 103, 102, 101: '+JSON.stringify(await line()));
  const msg = await pg.textContent('#ord-msg');
  ok(msg.includes('Not in your collar list: 999') && msg.includes('Already fitted: 112') && msg.includes('Marked lost: 111'), 'numbers not in the list, fitted or lost are listed: '+msg);
  // scan a collar: it goes to the end
  await pg.setInputFiles('#ord-photo', path.join(FIX,'collar-known.png'));
  await pg.waitForFunction(()=>/in line|can’t go|downloads|couldn|No number/.test(document.querySelector('#ord-msg').textContent+document.querySelector('#ord-scan').textContent), null, {timeout:120000});
  ok((await line()).join()==='103,102,101,7203418856', 'scanned collar goes to the end of the line: '+(await line()).join());
  // drag by the grab handle
  ok(await pg.locator('#ord-line [data-o="front"], #ord-line [data-o="up"]').count()===0, 'no arrow or To front/To back buttons, just grab handles');
  const dragTo = async (fromId, toId) => {
    const hb=await pg.locator(`#ord-line [data-oc="${fromId}"] [data-grip]`).boundingBox(), tb=await pg.locator(`#ord-line [data-oc="${toId}"]`).boundingBox();
    const x=hb.x+hb.width/2, y=hb.y+hb.height/2, ty=tb.y+tb.height/2+(tb.y>hb.y?12:-12);
    await pg.mouse.move(x,y); await pg.mouse.down(); await pg.mouse.move(x,ty,{steps:15}); await pg.mouse.up(); await wait(450); };
  await dragTo('c-101','c-103');
  ok((await line()).join()==='101,103,102,7203418856', 'drag a collar up to the front: '+(await line()).join());
  await dragTo('c-101','c-103');
  ok((await line()).join()==='103,101,102,7203418856', 'drag it back down one place: '+(await line()).join());
  await dragTo('c-7203418856','c-101');
  ok((await line()).join()==='103,7203418856,101,102', 'drag the last collar up two places: '+(await line()).join());
  await pg.focus('#ord-line [data-oc="c-7203418856"] [data-grip]'); await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('ArrowDown'); await wait(100);
  ok((await line()).join()==='103,101,102,7203418856', 'arrow keys on a handle move it too: '+(await line()).join());
  const bb = await pg.locator('#ord-line [data-grip]').first().boundingBox(); ok(bb.height>=48 && bb.width>=48, 'grab handles are glove-sized');
  // add from Not in the order
  ok((await pg.textContent('#ord-out')).includes('Not in the order') && (await pg.textContent('#ord-out')).includes('104'), 'collars not in the order are listed underneath');
  await pg.click('#ord-out [data-oc="c-104"] [data-o="add"]');
  ok((await line()).join()==='103,101,102,7203418856,104', 'added from Not in the order to the end');
  await pg.screenshot({path:path.join(OUT,'order.png')}); await pg.click('#sheet .x');
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await wait(300); await dragTo('c-101','c-103'); await pg.click('#sheet .x');
  ok((await pg.textContent('#fitPair')).includes('Collar 101'), 'after reordering, the new front collar is the one picked');
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await wait(300); await dragTo('c-101','c-103'); await pg.click('#sheet .x');
  // fitting several in a row
  ok((await pg.textContent('#fCollars')).includes('Next collar') && (await pg.textContent('#fitPair')).includes('Collar 103'), 'next collar in line is picked and labelled “Next collar”');
  await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=a1]'); await pg.click('#fitGo'); await hideToast();
  ok((await A('a1')).collar==='103' && (await pg.textContent('#fitPair')).includes('Collar 101'), 'fit: collar 103 on A1, collar 101 picked next');
  await pg.click('#fCows [data-cow=a2]'); await pg.click('#fitGo'); await hideToast();
  ok((await A('a2')).collar==='101' && (await pg.textContent('#fitPair')).includes('Collar 102'), 'fit again: 101 on A2, 102 picked next');
  // order set: no pre-pick from last season; it shows as a note
  await pg.click('#fCows [data-cow=a7]');
  ok((await pg.textContent('#fitPair')).includes('Collar 102 → Bar 9 A7') && (await pg.textContent('#fCows [data-cow=a7]')).includes('Last collar: 105'), 'with an order, the animal keeps the next collar; last season’s number shows as a note');
  await pg.click('#fitGo'); await hideToast();
  ok((await A('a7')).collar==='102', 'third in a row fitted');
  // skip and lost
  await pg.click('#fitSwitch [data-side=collar]');
  ok((await pg.textContent('#fitPair')).includes('Collar 7203418856'), 'next is 7203418856');
  await pg.click('#fCollars [data-fskip]'); await hideToast();
  ok((await line()).join()==='104,7203418856' && (await pg.textContent('#fitPair')).includes('Collar 104'), 'Skip sends it to the back; 104 is next');
  await pg.click('#fCollars [data-flost]'); await hideToast();
  ok(await pg.evaluate(()=>window.__herdbook.state.collars.get('c-104').status)==='lost' && (await line()).join()==='7203418856', 'Lost marks it lost and takes it out of the line');
  // out of order
  await pg.click('#fCollars [data-num="106"]'); await pg.click('#fitSwitch [data-side=cow]'); await pg.click('#fCows [data-cow=a3]'); await pg.click('#fitGo');
  ok((await A('a3')).collar==='106' && (await line()).join()==='7203418856', 'a collar out of order can still be used; the line is unchanged');
  // undo puts it back in line
  await pg.click('#fCows [data-cow=a4]'); await pg.click('#fitGo');
  ok((await A('a4')).collar==='7203418856' && (await line()).length===0, 'last collar in line fitted');
  await pg.click('#toast .undo'); await wait(200);
  ok((await line()).join()==='7203418856' && !(await A('a4')).collar, 'Undo puts the collar back in the line');
  // clear collar order
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await pg.click('#ord-clear'); await pg.click('#ord-clear'); await pg.click('#sheet .x');
  ok((await line()).length===0 && !(await pg.textContent('#fCollars')).includes('Next collar'), 'Clear collar order');
  // new season clears it
  await pg.click('#fitSwitch [data-side=collar]'); await pg.click('#ordBtn'); await pg.fill('#ord-nums','108-109'); await pg.click('#ord-add'); await pg.click('#sheet .x');
  await pg.goto('http://localhost:8768/#collars'); await wait(200); await pg.click('#seasonBtn'); await pg.click('#seasonBtn'); await wait(200);
  ok(await pg.evaluate(()=>[...window.__herdbook.state.collars.values()].every(c=>c.seq===''||c.seq==null)), 'new season clears the collar order');
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
