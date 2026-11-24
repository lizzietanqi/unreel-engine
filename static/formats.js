// Formats: browse every format card (formats.json, plus cards Studio made in cards.json) and hook (hooks.json), by type.
const fmOut=document.getElementById('fmOut'),fmToc=document.getElementById('fmToc'),fmFind=document.getElementById('fmFind');
let fmData=null,fmView=lsGet('fm:view','cards'); if(fmView==='beats') fmView='cards';
let fmPick=lsGet('fm:pick','');  // Format cards: the format shown (by name), or FM_ALL for every format. Search shows matches from every format.
const FM_ALL='*',FM_PEEK=5;  // All formats shows up to 5 cards a format in a sideways row; the rest are a click away in that format
async function fmShow(){
  try{ const r=await fetch('/formats'); fmData=await readJSON(r); if(!r.ok) throw new Error(fmData.error||'Something went wrong'); }
  catch(e){ fmOut.innerHTML='<div class="empty">Couldn\'t load the formats. '+esc(e.message)+'</div>'; return; }
  fmPaint();
}
function fmCards(f){ return f.cards.map(c=>({...c,studio:false})).concat(f.studio_cards.map(c=>({...c,studio:true}))); }
function fmCount(f){ return fmView==='cards'?fmCards(f).length:f.hooks.length; }
// A beat's job, cut to its first sentence and about 70 characters, for the card tile (the full job shows on hover)
function fmShort(j){
  let t=(j||'').replace(/^optional\.\s*/i,'').split(/\.\s/)[0].replace(/\.$/,'').trim();
  if(t.length>72){ t=t.slice(0,72); t=t.slice(0,t.lastIndexOf(' ')).replace(/[,;:]$/,'')+'…'; }
  return cap(t);
}
// A card tile: its name, when to use it, then its beats top to bottom, each with what it does
function fmCardTile(f,c,i,fi){
  const beats=c.beats||[];
  const list=beats.length?'<ol class="fmcBeats">'+beats.map((b,k)=>'<li class="f-'+hueOf(k+1)+(b.optional?' opt':'')+'" title="'+esc(b.name+': '+b.job.replace(/^optional\.\s*/i,'')+(b.optional?' (optional)':''))+'">'
      +'<span class="cn">'+(k+1)+'</span><span><b>'+esc(b.name)+'</b>'+esc(fmShort(b.job))+'</span></li>').join('')+'</ol>'
    :'<div class="fmcNone">Beats not written yet'+(c.needs?'. Needs '+esc(c.needs.replace(/\.$/,''))+'.':'.')+'</div>';
  return '<button class="fmCard cat-'+esc(f.category.toLowerCase())+'" data-f="'+fi+'" data-c="'+i+'">'
    +'<div class="fmcName">'+esc(c.name)+'</div>'
    +(c.use_when?'<div class="fmcUse">Use it when '+esc(c.use_when.replace(/\.$/,''))+'.</div>':'')
    +list+'</button>';
}
function fmHookRow(f,h,fi,hi,first){
  return '<div class="hkRow" data-f="'+fi+'" data-h="'+hi+'"'+(first?' id="fm-'+fi+'"':'')+' title="'+esc([h.title,h.length].filter(Boolean).join(' · '))+' · click to see it broken down"><span class="hkTag"><span class="fmPill">'+esc(f.short)+'</span></span>'
    +'<span class="hkLine">'+esc(h.hook)+'</span><button class="icon copy" title="Copy hook">'+ICON_COPY+'</button></div>';
}
function fmPaint(){
  if(!fmData) return;
  document.querySelectorAll('#fmView button').forEach(b=>b.classList.toggle('on',b.dataset.v===fmView));
  const q=fmFind.value.trim().toLowerCase();
  let html='',toc='',shown=0;
  fmData.categories.forEach(cat=>{
    let body='',items='',n=0;
    fmData.formats.forEach((f,fi)=>{
      if(f.category!==cat) return;
      const hit=t=>!q||t.toLowerCase().includes(q)||f.name.toLowerCase().includes(q)||f.short.toLowerCase().includes(q);
      let tiles='';
      if(fmView==='cards'){ const cs=fmCards(f).map((c,i)=>[c,i]).filter(([c])=>hit(JSON.stringify(c)));
        cs.slice(0,q?cs.length:FM_PEEK).forEach(([c,i])=>tiles+=fmCardTile(f,c,i,fi));
        if(!q&&cs.length>FM_PEEK) tiles+='<button class="fmMore" data-pick="'+fi+'"><b>See more</b><span>All '+cs.length+' '+esc(f.name)+' cards →</span></button>'; }
      else f.hooks.forEach((h,hi)=>{ if(hit(h.hook)) tiles+=fmHookRow(f,h,fi,hi,!tiles); });
      if((q||fmView==='hooks')&&!tiles) return;
      n++;
      const count=fmCount(f);
      if(fmView==='hooks') body+=tiles;
      else body+='<section class="fmSec" id="fm-'+fi+'"><div class="fmHead"><h3>'+esc(f.name)+'</h3>'
        +'</div>'
        +(f.idea_has?'<div class="fmIdea">For an idea with '+esc(f.idea_has.charAt(0).toLowerCase()+f.idea_has.slice(1))+'</div>':'')
        +'<div class="'+(q?'fmGrid':'fmRow')+'">'+tiles+'</div></section>';
      items+='<button class="tocItem" data-f="'+fi+'">'+esc(f.name)+'<span class="n">'+count+'</span></button>';
    });
    if(!n) return;
    shown+=n;
    html+='<h2 class="fmType t-'+esc(cat.toLowerCase())+'">'+esc(cat)+'<span class="meta">'+n+(n===1?' format':' formats')+'</span></h2>'
      +(fmView==='hooks'?'<div class="hkList cat-'+esc(cat.toLowerCase())+'">'+body+'</div>':body);
    toc+='<div class="tocType">'+esc(cat)+'</div>'+items;
  });
  const one=fmView==='cards'&&!q&&fmPick!==FM_ALL,all=fmView==='cards'&&!q&&fmPick===FM_ALL;
  if(one){ let fi=fmData.formats.findIndex(f=>f.name===fmPick); if(fi<0) fi=0; html=fmOneFormat(fi); fmPick=fmData.formats[fi].name; }
  fmOut.innerHTML=one||shown?html:!q&&fmView==='hooks'?'<div class="welcome"><b>No hooks yet</b>Hooks are the opening lines of sample reels, grouped by the format each reel follows. Click one to see the whole reel broken down line by line. The app comes with a few. To add your own, put them in hooks.json, or ask the chat to add the opening lines of reels in your library.</div>'
    :'<div class="empty">Nothing matches'+(q?' "'+esc(fmFind.value.trim())+'"':'')+'.</div>';
  fmToc.innerHTML=(fmView==='cards'?'<button class="tocItem tocAll'+(all?' on':'')+'" data-all>All formats<span class="n">'+fmData.formats.reduce((t,f)=>t+fmCards(f).length,0)+'</span></button>':'')+toc;
  const ab=fmToc.querySelector('[data-all]'); if(ab) ab.onclick=()=>fmPickFormat(-1);
  fmToc.querySelectorAll('.tocItem[data-f]').forEach(b=>{ if(one) b.classList.toggle('on',fmData.formats[+b.dataset.f].name===fmPick);
    b.onclick=()=>{ if(fmView==='cards'&&!q) return fmPickFormat(+b.dataset.f);
      const s=document.getElementById('fm-'+b.dataset.f); if(s) s.scrollIntoView({behavior:'smooth',block:'start'}); }; });
  fmOut.querySelectorAll('button.fmCard').forEach(b=>b.onclick=()=>fmOpenCard(+b.dataset.f,+b.dataset.c));
  fmOut.querySelectorAll('.fmRow,.fmRow>.fmCard').forEach(fmFade);
  fmOut.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>fmPickFormat(+b.dataset.pick));
  fmOut.querySelectorAll('.hkRow').forEach(r=>r.onclick=e=>{ const cp=e.target.closest('.copy');
    if(cp) copyText(cp,r.querySelector('.hkLine').textContent); else fmOpenSample(+r.dataset.f,+r.dataset.h); });
}
// Soft edges on the sideways rows and on square cards that hold more than fits: fade only the side with more to see
function fmFade(el){
  if(el.classList.contains('fmRow')){ const end=el.scrollWidth-el.clientWidth;
    el.classList.toggle('fadeL',el.scrollLeft>2); el.classList.toggle('fadeR',el.scrollLeft<end-2); }
  else el.classList.toggle('fadeB',el.scrollTop<el.scrollHeight-el.clientHeight-2);
}
fmOut.addEventListener('scroll',e=>{ const t=e.target; if(t.classList&&(t.classList.contains('fmRow')||t.classList.contains('fmCard'))) fmFade(t); },true);
// Over a card in a row: sideways swipes still move the row, up and down scrolls the card
fmOut.addEventListener('wheel',e=>{ const c=e.target.closest('.fmRow>.fmCard'); if(!c||Math.abs(e.deltaX)<=Math.abs(e.deltaY)) return;
  e.preventDefault(); c.parentElement.scrollLeft+=e.deltaX; fmFade(c.parentElement); },{passive:false});
new ResizeObserver(()=>fmOut.querySelectorAll('.fmRow,.fmRow>.fmCard').forEach(fmFade)).observe(fmOut);  // also runs when the page is first shown
// Show one format on its own (or every format, for -1)
function fmPickFormat(fi){ fmPick=fi<0?FM_ALL:fmData.formats[fi].name; lsSet('fm:pick',fmPick); fmPaint(); document.getElementById('main').scrollTo({top:0}); }
// Format cards: the picked format on its own, with its cards
function fmOneFormat(fi){
  const f=fmData.formats[fi],cards=fmCards(f);
  return '<section class="fmOne cat-'+esc(f.category.toLowerCase())+'"><div class="fmOneTop"><span class="fmCat">'+esc(f.category)+'</span>'
    +'</div>'
    +'<h2>'+esc(f.name)+'</h2>'
    +(f.idea_has?'<p class="fmIdea">For an idea with '+esc(f.idea_has.charAt(0).toLowerCase()+f.idea_has.slice(1).replace(/\.$/,''))+'. Click a card to see it on a real script.</p>':'')
    +'<div class="fmGrid">'+cards.map((c,i)=>fmCardTile(f,c,i,fi)).join('')+'</div></section>';
}
// One card in full, as text
function fmCardText(f,c){
  const L=['FORMAT: '+f.name+(c.name!==f.name?', '+c.name:''),'USE WHEN: '+c.use_when,'NEEDS: '+c.needs];
  if(c.length) L.push('LENGTH: '+c.length);
  if(c.reframe) L.push('REFRAME GOES IN: '+c.reframe);
  if((c.beats||[]).length){ L.push('','SLOTS (pull from these angle doc sections)');
    c.beats.forEach((b,i)=>{ L.push((i+1)+'. '+b.name+': '+b.job); if((b.sources||[]).length) L.push('   ('+b.sources.join(', ')+')'); }); }
  if((c.flex||[]).length){ L.push('','FLEX'); c.flex.forEach(x=>L.push('- '+x)); }
  return L.join('\n');
}
// The pop-up: laid out like a post in Studio. The video (when there is one) next to the card, then the script
// line by line with each chunk's beat, job and device. Hover a line to light up its beat.
const fmModal=document.getElementById('fmModal'),fmMBody=document.getElementById('fmMBody');
document.getElementById('fmMStruct').innerHTML=ICON_CHAT+'Structure → chat';
let fmCur=null,fmTicket=0;
function fmCardObj(f,c,beats){  // a card the way Studio's card view reads it
  return {category:f.category,format:f.name,short:f.short,name:c.name,source:c.studio?'studio':'index',status:f.status,
    use_when:c.use_when||'',needs:c.needs||'',length:c.length||'',reframe:c.reframe||'',flex:c.flex||[],
    beats:(beats||c.beats||[]).map(b=>({...b,optional:!!b.optional,sources:b.sources||[]}))};
}
function fmRender(){
  const st=fmCur; if(!st) return;
  const card=fmCardObj(st.f,st.c,st.beats),bd={card,chunks:st.chunks||[],lines:st.lines||[]};
  document.getElementById('fmMMeta').textContent=st.f.category+' · '+st.f.name;
  document.getElementById('fmMStruct').onclick=()=>toChat(fmStructForChat(st,card));
  const cp=document.getElementById('fmMCopy'); delete cp.dataset.l; cp.textContent='Copy card'; cp.onclick=()=>copyText(cp,fmCardText(st.f,card));
  const note=st.state==='loading'?'<div class="meta spin" style="margin-bottom:14px">'+esc(st.wait)+'</div>'
    :st.state==='error'?'<div class="meta" style="margin-bottom:14px">'+esc(st.err)+' <button class="btn soft sm" data-retry>Try again</button></div>':'';
  const body=bd.chunks.length&&card.beats.length?beatsHtml(bd,st.kind==='carousel')
    :bd.lines.length?'<div class="fmPlain">'+bd.lines.map((l,i)=>'<p class="ln" data-ln="'+(i+1)+'"><span>'+esc(l)+'</span></p>').join('')+'</div>'
    :'<div class="meta">'+(st.state==='none'?'No sample reel for this card yet. When Studio breaks down a reel that follows this card, you can open it from here.':'')+'</div>';
  fmMBody.innerHTML='<div class="fmTop'+(st.link?'':' novid')+'">'
      +(st.link?'<div class="fmVid">'+igEmbed(st.link)+'<a class="igLink" href="'+esc(st.link)+'" target="_blank">Open on Instagram ↗</a></div>':'')
      +'<div>'+cardHtml(bd)+'</div></div>'
    +(st.title?'<div class="fmSHead"><b>'+esc(st.title)+'</b><span class="meta">'+esc(st.sub||'')+'</span><span class="sp"></span>'
      +(bd.lines.length?'<button class="icon toChat" data-send="script" title="Put this script in the chat box">'+ICON_CHAT+'Script → chat</button>':'')+'</div>':'')
    +'<div class="card pBody">'+note+body+'</div>';
}
function fmShowModal(st){ fmCur=st; fmRender(); modalOpen(fmModal); fmMBody.scrollTop=0; return ++fmTicket; }
// A card: Studio cards come with the post they were made from; other cards with a sample reel that uses them, if there is one
function fmOpenCard(fi,ci){
  const f=fmData.formats[fi],c=fmCards(f)[ci];
  const hp=f.hooks.findIndex(h=>h.post&&h.card_name===c.name);
  if(!c.studio&&hp>=0) return fmOpenSample(fi,hp);
  if(c.studio){
    const t=fmShowModal({f,c,state:c.first_post?'loading':'none',wait:'Loading the post it was made from…',title:'The post it was made from'});
    if(!c.first_post) return;
    fetch('/formats/post/'+encodeURIComponent(c.first_post)+'?card='+encodeURIComponent(c.name)).then(readJSON).then(d=>{ if(t!==fmTicket) return;
      if(d.error) return Object.assign(fmCur,{state:'error',err:d.error}),fmRender();
      Object.assign(fmCur,{state:'ok',link:d.link,kind:d.kind,lines:d.lines,chunks:d.chunks,title:d.author||'The post it was made from',
        sub:d.chunks.length?'':'Not broken down with this card yet. Open it in Studio to break it down.'}); fmRender(); }).catch(e=>{ if(t===fmTicket){ Object.assign(fmCur,{state:'error',err:e.message}); fmRender(); } });
    return;
  }
  const letter=f.cards.length>1?'Card '+String.fromCharCode(65+ci)+':':'';
  const hi=f.hooks.findIndex(h=>h.from==='format doc'&&(!letter||(h.card||'').startsWith(letter)));
  if(hi<0) return fmShowModal({f,c,state:'none'});
  fmOpenSample(fi,hi,ci);
}
// A sample reel that came with the app: open it the way Studio broke it down
function fmOpenPost(fi,hi){
  const f=fmData.formats[fi],h=f.hooks[hi],cs=fmCards(f);
  const c=cs.find(x=>x.name===h.card_name)||{name:h.card_name||f.name,beats:[],studio:true};
  const t=fmShowModal({f,c,state:'loading',wait:'Loading the reel…',title:h.title,link:h.link});
  fetch('/formats/post/'+encodeURIComponent(h.post)+'?card='+encodeURIComponent(c.name)).then(readJSON).then(d=>{ if(t!==fmTicket) return;
    if(d.error) return Object.assign(fmCur,{state:'error',err:d.error}),fmRender();
    Object.assign(fmCur,{state:'ok',link:d.link,kind:d.kind,lines:d.lines,chunks:d.chunks,sub:'Sample reel'}); fmRender(); })
    .catch(e=>{ if(t===fmTicket){ Object.assign(fmCur,{state:'error',err:e.message}); fmRender(); } });
}
// A sample script, broken down against its card (the AI does it once, then it's saved)
function fmOpenSample(fi,hi,ci){
  const f=fmData.formats[fi],h=f.hooks[hi];
  if(h.post) return fmOpenPost(fi,hi);
  const m=(h.card||'').match(/^Card ([A-Z]):/);
  if(ci==null) ci=m?m[1].charCodeAt(0)-65:0;
  const st={f,c:f.cards[ci]||f.cards[0],lines:h.lines||[h.hook],state:'loading',wait:'Breaking down this script, line by line. About 15 seconds the first time.',
    title:h.title,sub:[h.length,h.from==='format doc'?'Sample from the format doc':'From Format examples'].filter(Boolean).join(' · '),retry:()=>fmOpenSample(fi,hi,ci)};
  const t=fmShowModal(st);
  fetch('/formats/sample',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:f.name,hook:hi})}).then(async r=>{ const d=await readJSON(r);
    if(t!==fmTicket) return;
    if(!r.ok) return Object.assign(fmCur,{state:'error',err:d.error||'Something went wrong'}),fmRender();
    Object.assign(fmCur,{state:'ok',c:f.cards[d.card]||fmCur.c,beats:d.beats,lines:d.lines,chunks:d.chunks}); fmRender(); })
    .catch(e=>{ if(t===fmTicket){ Object.assign(fmCur,{state:'error',err:e.message}); fmRender(); } });
}
// What goes in the chat box from a card: its structure, or the script under it
function fmStructForChat(st,card){
  return 'Use the structure of this format card, '+cardTitle(card)+' ('+card.format+', '+(card.source==='studio'?'made in Studio':'from formats.json')+'):\n'
    +(card.use_when?'Use when: '+card.use_when+'\n':'')+(card.needs?'Needs: '+card.needs+'\n':'')+(card.length?'Length: '+card.length+'\n':'')
    +(card.reframe?'Reframe goes in: '+card.reframe+'\n':'')
    +(card.beats.length?'Beats:\n'+card.beats.map((b,i)=>(i+1)+'. '+b.name+': '+b.job+(b.optional?' (optional)':'')).join('\n'):'(No beats written yet.)')
    +(card.flex.length?'\nFlex: '+card.flex.join(' '):'');
}
function fmScriptForChat(st){
  return 'Use the script of '+(st.c.studio?'the post this card was made from, by '+st.title:'this sample, "'+st.title+'"')+' ('+st.f.name+'):\n'+st.lines.join('\n');
}
// Where you are, for the chat
function fmWhere(){
  if(!fmCur) return 'the Formats page, with the format cards and hooks';
  return 'the Formats page, looking at the format card "'+fmCur.c.name+'" of '+fmCur.f.name+(fmCur.title?', with the script "'+fmCur.title+'" under it':'');
}
fmMBody.addEventListener('click',e=>{
  if(e.target.closest('[data-send=script]')&&fmCur) return toChat(fmScriptForChat(fmCur));
  if(e.target.closest('[data-retry]')&&fmCur&&fmCur.retry) return fmCur.retry();
  const b=e.target.closest('[data-line]'); if(!b) return;  // a beat in the card: jump to its lines
  const el=fmMBody.querySelector('.ln[data-ln="'+b.dataset.line+'"]'); if(!el) return;
  el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
});
function fmClose(){ fmCur=null; fmTicket++; modalClose(fmModal,()=>{ if(!fmCur) fmMBody.innerHTML=''; }); }  // empty it so a playing video stops
document.getElementById('fmMClose').onclick=fmClose;
fmModal.dismiss=fmClose;  // closed when something opens the chat
fmModal.onclick=e=>{ if(e.target===fmModal) fmClose(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&fmModal.classList.contains('on')) fmClose(); });
document.querySelectorAll('#fmView button').forEach(b=>b.onclick=()=>{ fmView=b.dataset.v; lsSet('fm:view',fmView); fmPaint(); });
fmFind.addEventListener('input',fmPaint);
// Hide or show the formats list (the toggle on the frame's edge, in page.html); remembered between visits
function fmFoldPaint(){ const el=document.getElementById('fmSide'); if(el.offsetWidth) el.style.setProperty('--w',el.offsetWidth+'px');
  document.body.classList.toggle('fm-noside',!!lsGet('fm:folded',false)); }
fmFoldPaint();
