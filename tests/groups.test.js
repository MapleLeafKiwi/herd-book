// Groups: select mode on the Herd tab, bulk move, manage groups, the Group pick list. App alone, made-up cattle.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const REPO = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, {recursive:true});
const ok = (c, m) => { if(!c){ console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const types = {'.html':'text/html','.js':'application/javascript','.png':'image/png','.webmanifest':'application/json'};
const srv = http.createServer((q,r)=>{ let p=path.join(REPO, decodeURIComponent(q.url.split('?')[0])); if(p.endsWith('/')) p+='index.html';
  fs.readFile(p,(e,d)=>{ if(e){ r.writeHead(404); r.end(); return; } r.writeHead(200,{'Content-Type':(types[path.extname(p)]||'application/octet-stream')+'; charset=utf-8'}); r.end(d); }); }).listen(8767);
const cow = (vid, more) => Object.assign({kind:'cow', brand1:'Bar 9', vid, updatedAt:1}, more);
const mirror = { rev:0, history:[], exposures:{}, treatments:{}, expenses:{}, preg:{}, collars:{},
  animals:{ a1:cow('A1',{group:'North',collar:'101'}), a2:cow('A2',{group:'North',collar:'102'}), a3:cow('A3',{group:'South',collar:'103'}), a4:cow('A4',{group:'South',collar:'104'}),
            a5:cow('A5',{collar:'105'}), a6:cow('A6'), s1:cow('S1',{group:'North', saleDate:'2026-01-10'}) } };
(async()=>{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await ctx.route(/script\.google/, r=>r.abort());
  await ctx.addInitScript(m=>{ if(!localStorage.getItem('herdbook.app.mirror')){ localStorage.setItem('herdbook.app.mirror', JSON.stringify(m)); localStorage.setItem('herdbook.app.config', JSON.stringify({name:'Tess'})); } }, mirror);
  const pg = await ctx.newPage(); pg.setDefaultTimeout(5000);
  pg.on('pageerror', e=>{ console.log('PAGE ERROR', e.message); process.exitCode=1; });
  const G = id => pg.evaluate(id=>(window.__herdbook.state.animals.get(id)||{}).group||'', id);
  const groupLines = () => pg.evaluate(()=>window.__herdbook.state.history.filter(h=>h.targetType==='group').length);
  const row = id => `#herdList [data-id="${id}"]`;
  await pg.goto('http://localhost:8767/#herd'); await wait(300); await pg.click('#st-skip');
  // No group chip, group on the right of each row, blank when none
  ok((await pg.textContent('#groupChips')).includes('No group · 2'), 'No group chip shows when some animals have no group');
  await pg.click('#groupChips [data-g="__none"]');
  ok(await pg.locator('#herdList [data-id]').count()===2 && await pg.locator(row('a5')).count()===1, 'No group chip filters to animals with no group');
  await pg.click('#groupChips [data-g=""]');
  ok((await pg.textContent(row('a1')+' .rgroup'))==='North' && !(await pg.textContent('#herdList')).includes('ago') && !(await pg.textContent('#herdList')).includes('No group'), 'row shows its group where the time was, and nothing when it has no group');
  await pg.click('#addBtn'); ok(await pg.inputValue('#a-group')==='', 'new animal starts with No group'); await pg.click('#sheet .x');
  // select mode
  await pg.click('#selBtn');
  ok(await pg.isVisible('#selBar') && await pg.locator('#herdList .tick').count()===6, 'Select: every row gets a tick box and the bottom bar shows');
  const tb = await pg.locator('#herdList .tick').first().boundingBox(); ok(tb.width>=36 && tb.height>=36, 'tick boxes are glove-sized');
  await pg.click(row('a6')); await wait(50);
  ok(await pg.locator('#sheet #af').count()===0 && (await pg.getAttribute(row('a6'),'aria-pressed'))==='true' && (await pg.textContent('#selCount'))==='1 selected', 'tapping a row ticks it instead of opening it');
  await pg.click('#selClear');
  await pg.click('#groupChips [data-g="North"]'); await pg.click('#selAll');
  ok((await pg.textContent('#selCount'))==='2 selected', 'group chip filters, Select all shown ticks only those shown');
  await pg.click('#selClear'); await pg.click('#groupChips [data-g=""]');
  ok((await pg.textContent('#selCount'))==='0 selected', 'Clear unticks everything');
  // tick by collar range
  await pg.fill('#selRange','101-103, 999'); await pg.click('#selRangeGo');
  ok((await pg.textContent('#selCount'))==='3 selected' && (await pg.textContent('#selRangeMsg')).includes('999'), 'collar range ticks 101-103 and lists 999 as not found');
  // move to group with the sheet
  const lines0 = await groupLines();
  await pg.click('#selMove'); await pg.click('#mv .gpick[data-g="South"]');
  ok((await pg.textContent('#mv-go'))==='Move 3 animals to South', 'confirm reads “Move 3 animals to South”');
  await pg.click('#mv-go'); await wait(200);
  ok(await G('a1')==='South' && await G('a2')==='South' && await G('a3')==='South', 'bulk move: all three now in South');
  ok(await groupLines()===lines0+1, 'one change-log line for the whole move');
  ok(!(await pg.isVisible('#selBar')), 'select mode ends after the move');
  await pg.click('#toast .undo'); await wait(200);
  ok(await G('a1')==='North' && await G('a2')==='North' && await G('a3')==='South', 'Undo puts each animal back in its old group');
  // new group, then add cattle
  await pg.click('#mgBtn'); await pg.click('#mg-newbtn');
  ok((await pg.textContent('#mg-newbox')).includes('The group is saved once you move cattle into it.'), 'new group explains it is saved once cattle are moved in');
  await pg.fill('#mg-new','Heifers 27'); await pg.click('#mg-next'); await wait(100);
  ok((await pg.textContent('#selMove'))==='Move to Heifers 27' && !(await pg.textContent('#groupChips')).includes('Heifers 27'), 'new group: select mode with “Move to Heifers 27”, group not saved yet');
  await pg.click(row('a5')); await pg.click(row('a6')); await pg.click('#selMove'); await wait(200);
  ok(await G('a5')==='Heifers 27' && await G('a6')==='Heifers 27' && (await pg.textContent('#groupChips')).includes('Heifers 27'), 'new group then add cattle: both moved, group now shows');
  // backing out of a new group saves nothing
  const ob = await pg.evaluate(()=>window.__herdbook.outbox().length);
  await pg.click('#mgBtn'); await pg.click('#mg-newbtn'); await pg.fill('#mg-new','Ghost'); await pg.click('#mg-next'); await pg.click('#selDone'); await wait(100);
  ok(await pg.evaluate(()=>window.__herdbook.outbox().length)===ob && !(await pg.textContent('#groupChips')).includes('Ghost'), 'backing out of a new group saves nothing');
  // add cattle to an existing group: its animals start ticked
  await pg.click('#mgBtn'); await pg.click('#mg [data-gadd="Heifers 27"]'); await wait(100);
  ok((await pg.getAttribute(row('a5'),'aria-pressed'))==='true' && (await pg.getAttribute(row('a6'),'aria-pressed'))==='true' && (await pg.textContent('#selMove'))==='Move to Heifers 27', 'Add cattle: animals already in the group show ticked');
  await pg.click(row('a4')); await pg.click('#selMove'); await wait(200);
  ok(await G('a4')==='Heifers 27', 'Add cattle moves the newly ticked animal in');
  // rename (sold ones too)
  await pg.click('#mgBtn'); await pg.click('#mg [data-gren="North"]'); await pg.fill('#mg [data-row="North"] [data-renin]','Northern'); await pg.click('#mg [data-rengo="North"]'); await wait(200);
  ok(await G('a1')==='Northern' && await G('a2')==='Northern' && await G('s1')==='Northern', 'rename moves every animal in the group, sold ones included');
  // merge (ignoring capitals and spaces)
  await pg.click('#mgBtn'); await pg.click('#mg [data-gren="Northern"]'); await pg.fill('#mg [data-row="Northern"] [data-renin]','  south '); await pg.click('#mg [data-rengo="Northern"]');
  ok((await pg.textContent('#mg [data-row="Northern"]')).includes('Merge into South?'), 'renaming to an existing name asks “Merge into South?”');
  await pg.click('#mg [data-rengo="Northern"]'); await wait(200);
  ok(await G('a1')==='South' && await G('s1')==='South' && !(await pg.textContent('#groupChips')).includes('Northern'), 'merge: everyone now in South');
  // empty group
  await pg.click('#mgBtn'); await pg.click('#mg [data-gempty="Heifers 27"]');
  ok(await G('a4')==='Heifers 27', 'Empty group asks to confirm first');
  await pg.click('#mg [data-gempty="Heifers 27"]'); await wait(200);
  ok(await G('a4')==='' && await G('a5')==='' && await G('a6')==='', 'Empty group moves its animals to No group');
  // animal form: pick list, typed name matching an existing group uses it
  await pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.click(row('a6')); await pg.selectOption('#a-group','__new'); await pg.fill('#a-gnew',' SOUTH'); await pg.click('#af button[type=submit]'); await wait(200);
  ok(await G('a6')==='South', 'animal form: typing “ SOUTH” as a new group uses the existing South');
  await pg.click(row('a6')); ok(await pg.locator('#a-group option').count()>=3 && (await pg.inputValue('#a-group'))==='South', 'animal form Group is a pick list with No group and + New group');
  await pg.click('#sheet .x');
  // when no animal has a group, the No group chip isn't needed
  await pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.click('#selBtn'); await pg.click('#groupChips [data-g=""]'); await pg.click('#selAll'); await pg.click('#selMove'); await pg.click('#mv .gpick[data-g=""]'); await pg.click('#mv-go'); await wait(200);
  ok(!(await pg.textContent('#groupChips')).includes('No group'), 'no No group chip when none of the cattle are grouped');
  // importing a sheet with only Tag and Group updates the animals already in the book, matched by tag
  const X=require('xlsx'); const wb=X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Tag','Group'],['A1','Imported'],['A2','Imported'],['Z9','Imported']]), 'U');
  const UF=path.join(OUT,'tag-update.xlsx'); X.writeFile(wb, UF); const n0=await pg.evaluate(()=>window.__herdbook.state.animals.size);
  await pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.click('[data-open-import] >> nth=0'); await pg.setInputFiles('#imp-file', UF); await pg.waitForSelector('#imp-go');
  ok(await pg.inputValue('#imp-match')==='vid' && (await pg.textContent('#imp-preview')).includes('1 new animals, 2 existing animals updated'), 'import with a Tag column matches existing animals by tag');
  await pg.evaluate(()=>{ const b=document.querySelector('[data-q=fitted] [data-v=no]'); if(b) b.click(); }); await pg.click('#imp-go'); await wait(300);
  ok(await G('a1')==='Imported' && await pg.evaluate(()=>window.__herdbook.state.animals.size)===n0+1, 'tag-matched rows update in place, no duplicates');
  // importing tags with collar serials: the collar is fitted to that animal and goes in the collar list
  const wb2=X.utils.book_new(); X.utils.book_append_sheet(wb2, X.utils.aoa_to_sheet([['Tag','Brand','Collar','Collar fitted'],['C1','XX','0406112301',''],['C2','XX','0406112302','No'],['C3','XX','0406112303','']]), 'C');
  const CF2=path.join(OUT,'tag-collar.xlsx'); X.writeFile(wb2, CF2);
  await pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.click('[data-open-import] >> nth=0'); await pg.setInputFiles('#imp-file', CF2); await pg.waitForSelector('#imp-go'); await pg.evaluate(()=>{ const b=document.querySelector('[data-q=fitted] [data-v=no]'); if(b) b.click(); }); await pg.click('#imp-go'); await wait(300);
  const byVid = v => pg.evaluate(v=>[...window.__herdbook.state.animals.values()].find(a=>a.vid===v), v);
  ok((await byVid('C1')).collar==='0406112301' && (await byVid('C1')).collarOn===true && (await byVid('C3')).collarOn===true, 'imported collar serials are fitted to their animals');
  ok((await byVid('C2')).collarOn===false, 'a Collar fitted column saying No keeps it not fitted');
  // no Collar fitted column: it asks, and Import waits for the answer; No adds no collars to the list
  const wb3=X.utils.book_new(); X.utils.book_append_sheet(wb3, X.utils.aoa_to_sheet([['Tag','Brand','Collar'],['D1','XX','0406112311'],['D2','XX','0406112312']]), 'D');
  const CF3=path.join(OUT,'tag-collar-ask.xlsx'); X.writeFile(wb3, CF3); await pg.evaluate(()=>{ document.querySelector('#toast').hidden=true; });
  await pg.click('[data-open-import] >> nth=0'); await pg.setInputFiles('#imp-file', CF3); await pg.waitForSelector('#imp-go');
  ok((await pg.textContent('#imp-collars')).includes('This sheet has 2 collars') && (await pg.textContent('#imp-collars')).includes('Are these collars on the animals now?') && await pg.isDisabled('#imp-go'), 'collars in the sheet: asks to add them and whether they’re fitted, Import waits');
  await pg.click('[data-q=fitted] [data-v=yes]'); await pg.click('[data-q=add] [data-v=no]');
  ok(!(await pg.isDisabled('#imp-go')), 'Import is ready once answered'); await pg.click('#imp-go'); await wait(300);
  ok((await byVid('D1')).collarOn===true && !(await pg.evaluate(()=>window.__herdbook.state.collars.has('c-0406112311'))), 'answered Yes, fitted and No to the list: fitted, collar list unchanged');
  await pg.goto('http://localhost:8767/#collars'); await wait(200);
  ok((await pg.textContent('#collarList')).includes('0406112301') && /Fitted · 2/.test(await pg.textContent('#cChips')) && !(await pg.textContent('#cWarn')).includes('0406112301'), 'the collars go into the collar list, showing as Fitted');
  await pg.goto('http://localhost:8767/#herd'); await wait(200);
  await pg.screenshot({path:path.join(OUT,'groups.png')});
  await browser.close(); srv.close();
})().catch(e=>{ console.error(e); process.exit(1); });
