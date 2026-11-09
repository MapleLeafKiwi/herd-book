// Copy data for AI (Money tab): the text holds the question, herd, sales, monthly averages and costs. Made-up data.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/json'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')+'; charset=utf-8'}); r.end(d); }); }).listen(8771);
const h = (vid, more) => Object.assign({kind:'heifer', brand1:'Bar 9', vid, group:'North', purchaseDate:'2024-04-10', purchasePrice:2000}, more);
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, preg:{}, collars:{},
  animals:{ s1:h('T1',{salePrice:3000, saleDate:'2024-10-05', weight:1100, weighedAt:'2024-10-01'}), s2:h('T2',{salePrice:3200, saleDate:'2024-10-20', weight:1100}),
            s3:h('T9',{group:'South', purchaseDate:'2025-04-02', purchasePrice:2100, salePrice:3500, saleDate:'2025-11-12', buyer:'Smith Feedlot'}),
            n1:h('N1',{purchaseDate:'2026-04-01', purchasePrice:2200, weight:1000, weighedAt:'2026-10-01'}), n2:h('N2',{purchaseDate:'2026-04-01', purchasePrice:2300}),
            d1:h('D1',{purchaseDate:'2026-04-01', died:'2026-07-01'}) },
  expenses:{ x1:{date:'2025-12-01', category:'Extra feed', amount:1000, group:''} } };
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, acceptDownloads:true, permissions:['clipboard-read','clipboard-write'] });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess', ranchName:'Made-up Ranch', carry:{fall:'3200', spring:'3600', months:'6'}})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(6000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  await pg.goto('http://localhost:8771/#money'); await wait(300); await pg.click('#st-skip');
  await pg.click('#aiBtn');
  let t = await pg.inputValue('#ai-text');
  ok(t.includes('## What I’d like help with') && t.includes('Help me decide when to sell.'), 'starts with the question: when to sell');
  ok(/## Herd on hand today[\s\S]*North,2,0,2,0,0,0,0,2250,2026-04-01,2026-04-01,1000,1/.test(t), 'herd on hand by group with average purchase price and weight');
  ok(/2024-10,2,3100,3000,3200,1100,2\.82/.test(t), 'sales by month worked out exactly (Oct 2024: 2 head, avg 3100, profit 1100, $/lb)');
  ok(t.includes('2025-11,1,3500,3500,3500,1400,'), 'one line per sale month');
  ok(/## Deaths[\s\S]*2026-07-01,Heifer,North,2000/.test(t), 'deaths listed');
  ok(t.includes('2025,Extra feed,Whole herd,1000') && t.includes('2024,2,4000,2000'), 'costs by year and purchases by year');
  ok(t.includes('Expected spring price per head: 3600'), 'carry-over numbers included');
  ok(!t.includes('Smith Feedlot') && !t.includes('T9') && !t.includes('Made-up Ranch'), 'ranch name, tags and buyers left out by default');
  await pg.uncheck('#ai-hide'); t = await pg.inputValue('#ai-text');
  ok(t.includes('Smith Feedlot') && t.includes('T9') && t.includes('Made-up Ranch'), 'unticking includes them');
  await pg.check('#ai-hide');
  await pg.click('[data-ask=carry]'); t = await pg.inputValue('#ai-text');
  ok(t.includes('should I sell now or carry them over the winter?'), 'question changes with the choice');
  await pg.click('[data-ask=own]'); await pg.fill('#ai-own','Do heifers bought earlier sell better?'); t = await pg.inputValue('#ai-text');
  ok(t.includes('Do heifers bought earlier sell better?'), 'own question goes at the top');
  await pg.selectOption('#ai-group','South'); await pg.click('[data-ask=sell]'); t = await pg.inputValue('#ai-text');
  ok(t.includes('when to sell the South group') && !/^North,/m.test(t), 'group choice narrows the herd and the question');
  await pg.fill('#ai-about','We buy heifers in spring and sell them bred in the fall.'); t = await pg.inputValue('#ai-text');
  ok(t.includes('We buy heifers in spring and sell them bred in the fall.') && await pg.evaluate(()=>window.__herdbook.cfg.aiAbout.startsWith('We buy')), 'about your operation goes in and is kept on the phone');
  await pg.click('#ai-copy'); await wait(200);
  ok((await pg.evaluate(()=>navigator.clipboard.readText())).includes('## Every animal sold') && (await pg.textContent('#ai-msg')).includes('Copied'), 'Copy puts it on the clipboard');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#ai-save')]);
  ok(dl.suggestedFilename().startsWith('herd-for-ai-') && dl.suggestedFilename().endsWith('.txt'), 'Save as a file gives a text file');
  ok(await pg.evaluate(()=>window.__herdbook.outbox().length)===0, 'nothing is sent or saved to the sheet');
  // crew phone: no Money tab, no button
  const c2 = await browser.newContext({ viewport:{width:390,height:844} }); await c2.route(/script\.google/, r=>r.abort());
  await c2.addInitScript(m=>{ localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Crew', code:'crewcode', role:'crew'})); localStorage.setItem('herdbook.app.mirror@crewcode', JSON.stringify(m)); }, mirror);
  const p2 = await c2.newPage(); await p2.goto('http://localhost:8771/#money'); await wait(300);
  ok(await p2.isHidden('#navMoney') && await p2.locator('#aiBtn').count()===0, 'crew phones don’t get Copy data for AI');
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
