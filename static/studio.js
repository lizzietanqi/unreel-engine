// Studio: find out why posts that did well work, and write your own versions of them.
// A study is a saved set of posts; the page shows one, and Clear all starts a new empty one. The middle shows one post at a time: why it works, then the post
// line by line. With two or more posts, Overview shows them side by side.
// The panel on the right is the chat, on every page of the app, with suggested asks that fit the view you're on.
// The server side is studio.py. Chat is Claude Code or Codex working in the app's folder (engine.py). The chat and its session are kept
// in the browser, so they stay through page switches, study switches and refreshes, until New chat.
const cmpUrl=document.getElementById('cmpUrl'),cmpAddBtn=document.getElementById('cmpAdd'),cmpSt=document.getElementById('cmpStatus');
const strip=document.getElementById('strip'),stView=document.getElementById('stView');
const bBody=document.getElementById('bBody'),chatIn=document.getElementById('chatIn');
// The chat as saved last time; a Cleve save that was still going when the page closed can be tried again
const chatSaved=lsGet('chat',null)||{};
function chatSave(){ lsSet('chat',{items:chat.map(({noting,noteText,...t})=>t),session:chatSession}); }
let study=null,bds={},cur='',job='',pending='',chatErr='',chat=[],chatSession='',hidden=[];
chat=(chatSaved.items||[]).map(t=>{ Object.keys(t.saves||{}).forEach(k=>{ if(t.saves[k]==='sending') delete t.saves[k]; }); return t; });
chatSession=chatSaved.session||'';  // hidden: posts left out of side by side  // cur: open post file or 'overview'; job: ask
const posts={},working={},failed={};  // file -> transcript data; files being broken down; file -> error
let postTab=lsGet('postTab','beats');

const HUES=['open','pro','val','turn','ten','teal','pink'];  // beat colours, taken in turn
const CIRCLED=n=>n>=1&&n<=20?String.fromCharCode(9311+n):n;

async function api(method,path,data){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const d=await readJSON(r); if(!r.ok) throw new Error(d.error||'Something went wrong'); return d;
}
const files=()=>study?study.files:[];
const shownFiles=()=>{ const fs=files().filter(f=>!hidden.includes(f)); return fs.length?fs:files(); };  // side by side
function setHidden(h){ hidden=h; lsSet('sbsHide:'+study.id,h); paintOverview(); benchPaint(); }
function inStudio(f){ return files().includes(f); }
const who=f=>(posts[f]&&posts[f].author)||'Unknown creator';
const thumbImg=(f,cls)=>'<img'+(cls?' class="'+cls+'"':'')+' loading="lazy" src="/thumb/'+encodeURIComponent(f)+'" onerror="this.style.visibility=\'hidden\'">';
function say(t){ cmpSt.textContent=t; }

// --- The study on the page. Only the newest is shown; older ones stay on disk ---
async function stOpen(id){
  try{ stSet(await api('GET','/studies/'+id)); }
  catch(e){ say('Error: '+e.message); }
}
async function stInit(){
  const studies=await api('GET','/studies'),want=lsGet('studyId','');
  if(studies.some(s=>s.id===want)) return stOpen(want);
  if(studies.length) return stOpen(studies[0].id);
  stSet(await api('POST','/studies',{}));
}
let stReady=null;
function stShow(){ const first=!stReady; stReady=stReady||stInit(); return stReady.then(()=>!first&&study&&stOpen(study.id)); }  // refetch: posts may have been deleted meanwhile

async function stSet(view){
  const switched=!study||study.id!==view.study.id;
  study=view.study;
  Object.entries(view.breakdowns||{}).forEach(([f,bd])=>{ if(bd||!working[f]) bds[f]=bd; });
  lsSet('studyId',study.id);
  if(switched){ hidden=lsGet('sbsHide:'+study.id,[]); cur=lsGet('open:'+study.id,''); }
  const missing=files().filter(f=>!posts[f]);
  const got=await Promise.all(missing.map(f=>fetch('/history/'+encodeURIComponent(f)).then(r=>r.ok?r.json():null).catch(()=>null)));
  missing.forEach((f,i)=>{ if(got[i]) posts[f]=got[i]; });
  if(cur!=='overview'&&!inStudio(cur)||cur==='overview'&&files().length<2) cur=files().length>1?'overview':files()[0]||'';
  paint(); breakDownMissing();
}
async function stSaveFiles(list){
  study.files=list; paint();
  try{ stSet(await api('PATCH','/studies/'+study.id,{files:list})); }
  catch(e){ say('Error: '+e.message); }
}
async function addToStudio(f){
  await (stReady=stReady||stInit());
  if(!inStudio(f)) await stSaveFiles(files().concat(f));
  return study;
}
// Clear all: a new empty study. The old one stays on disk, so Undo can bring it back.
const stClear=document.getElementById('stClear');
stClear.onclick=async()=>{
  if(!study||job) return;
  const was=study.id;
  try{ cur=''; await stSet(await api('POST','/studies',{})); }
  catch(e){ say('Error: '+e.message); return; }
  cmpSt.innerHTML='Cleared. <button class="linkBtn" id="stUndo">Undo</button>';
  const made=study.id;
  document.getElementById('stUndo').onclick=async()=>{ say(''); await stOpen(was);
    if(study.id!==was) return;  // undo didn't take; keep where we are
    api('GET','/studies/'+made).then(v=>{ if(!v.study.files.length) api('DELETE','/studies/'+made); }).catch(()=>{}); };  // the empty one Clear made
};
// Every post gets broken down as soon as it's in a study, a few at a time
function breakDownMissing(redo){
  const todo=(redo?[redo]:files().filter(f=>(!bds[f]||bds[f].points_old)&&!failed[f])).filter(f=>!working[f]);  // points_old: only its points are redone
  todo.forEach(f=>{ working[f]=true; delete failed[f]; });
  if(todo.length) paint();
  const next=async()=>{ const f=todo.shift(); if(!f) return;
    try{ bds[f]=await api('POST','/breakdowns/'+encodeURIComponent(f),{redo:!!redo}); }
    catch(e){ failed[f]=e.message; }
    delete working[f]; paint(); return next(); };
  for(let i=0;i<3;i++) next();
}

// --- Middle: the strip of posts, then the open post or the overview ---
function openPost(f){ cur=f; lsSet('open:'+study.id,f); paint(); document.getElementById('main').scrollTo({top:0}); }
function paint(){ stClear.disabled=!files().length; paintStrip(); paintView(); benchPaint(); libMark(); }
// One pill per post; its ✕ takes the post out of this study (it stays in the library)
function paintStrip(){
  const fs=files();
  strip.innerHTML=!fs.length?'':(fs.length>1?'<button class="pc'+(cur==='overview'?' on':'')+'" data-open="overview"><span class="ph">'+ICON_CMP+'</span><span>Side by side</span></button>':'')
    +fs.map(f=>'<button class="pc'+(cur===f?' on':'')+'" data-open="'+esc(f)+'" title="'+esc(who(f))+'">'+thumbImg(f)+'<span>'+esc(nameOf(who(f)))+'</span>'+(working[f]?'<i class="dot" title="Breaking it down"></i>':'')
      +'<i class="pcX" data-drop="'+esc(f)+'" role="button" title="Take out of this study (stays in your library)">✕</i></button>').join('');
}
strip.addEventListener('click',e=>{
  const x=e.target.closest('[data-drop]'); if(x) return stSaveFiles(files().filter(f=>f!==x.dataset.drop));
  const b=e.target.closest('[data-open]'); if(b) openPost(b.dataset.open); });

function paintView(){
  if(!study) return;
  if(!files().length){ stView.innerHTML='<div class="welcome"><b>Nothing in this study yet</b>This is where you pull apart reels that did well. For each one you get its words, the format it follows, what keeps people watching line by line, and the main points it makes. Then the chat helps you write your own version.<br><br>To start, paste an Instagram reel or carousel link in the box above and press Transcribe. Or click a reel in your library on the left. Paste a few links at once to compare them side by side.</div>'; return; }
  dockShow(cur==='overview'&&files().length>0);
  if(cur==='overview') return paintOverview();
  // Keep the video if the same post is still open, so it doesn't reload. A just-added post is drawn before its
  // details arrive, so draw it again once they do (data-ready), or it shows no video and no creator until a refresh.
  let shell=stView.querySelector('.post');
  const ready=posts[cur]?'1':'';
  if(!shell||shell.dataset.f!==cur||shell.dataset.ready!==ready){
    const d=posts[cur]||{},e=embed(d.link);
    stView.innerHTML='<div class="post" data-f="'+esc(cur)+'" data-ready="'+ready+'"><div class="pVid">'
      +(e?igEmbed(d.link):'<div class="novid">No preview for this post.</div>')
      +(e?'<div class="vidBar"><button class="icon" data-p="replay" title="Play the video from the start">↻ Replay</button>'
        +(d.link?'<a class="icon" href="'+esc(d.link)+'" target="_blank">Instagram ↗</a>':'')+'</div>':'')
      +'<div class="pMeta"><div class="pHead"><div class="who"><b title="'+esc(who(cur))+'">'+esc(nameOf(who(cur)))+'</b><div class="meta">'+(d.kind==='carousel'?'Carousel':'Reel')+(statsText(d.stats)?' · '+statsText(d.stats):'')+'</div></div>'
      +'<div class="chatPick"><button class="chatBtn" data-menu title="Send part of this post to chat">'+ICON_CHAT+'Chat<span class="car">▾</span></button>'
      +'<div class="menu"><div class="mHint">Send to chat</div><button data-p="usescript">Script<small>Its full script</small></button>'
      +'<button data-p="usepoints">Points<small>Its core points</small></button><button data-p="usecard">Structure<small>Its format card</small></button></div></div>'
      +'<div class="chatPick"><button class="icon moreBtn" data-menu title="More" aria-label="More">⋯</button>'
      +'<div class="menu"><button data-p="redo">↻ Redo<small>Break this post down again</small></button>'
      +'<button data-p="reread">'+(d.kind==='carousel'?'Re-read slides<small>Clean up the slide text again</small>':'Read on-screen text<small>For reels whose message is on screen. About a minute</small>')+'</button>'
      +'<button class="del" data-p="remove">Remove<small>Take out of this study (stays in your history)</small></button></div></div>'
      +'</div></div></div>'
      +'<div class="pMain"></div></div>';
    shell=stView.querySelector('.post');
  }
  shell.querySelector('.pMain').innerHTML=postMain(cur);
  shell.querySelectorAll('.pVid [data-p=redo],.pVid [data-p=reread]').forEach(b=>b.disabled=!!working[cur]||!!rereading[cur]);
}
// Read the on-screen text of a post already in the study, then break it down again with the new words
const rereading={};
async function reread(f){
  if(rereading[f]||working[f]) return;
  rereading[f]=true; paintView(); cmpSt.classList.add('busy');
  say(posts[f]&&posts[f].kind==='carousel'?'Cleaning up the slide text…':'Reading the on-screen text. About a minute…');
  try{ posts[f]=await api('POST','/history/'+encodeURIComponent(f)+'/reread'); say(''); delete rereading[f]; breakDownMissing(f); }
  catch(e){ say('Error: '+e.message); delete rereading[f]; paintView(); }
  cmpSt.classList.remove('busy');
}

function postMain(f){
  const d=posts[f]||{},bd=bds[f];
  if(working[f]&&!(bd&&bd.points_old)) return '<div class="card busyCard spin">Working out why it works. About 15 seconds.</div>';
  if(failed[f]) return '<div class="card busyCard">Couldn’t break this one down. '+esc(failed[f])+' <button class="btn soft sm" data-p="redo">Try again</button></div>';
  if(!bd) return '<div class="card busyCard">Not broken down yet. <button class="btn primary sm" data-p="redo">Break it down</button></div>';
  if(!bd.lines.length||!bd.card) return '<div class="card busyCard">'+(d.kind==='carousel'?'No text found on the slides.':'No speech found in this reel, so there’s nothing to break down.')+'</div>';
  let h=cardHtml(bd);
  h+='<div class="pTabs"><span class="seg">'+[['beats','Structure'],['points','Points'],['caption','Caption']].map(([k,l])=>'<button data-tab="'+k+'"'+(postTab===k?' class="on"':'')+'>'+l+'</button>').join('')+'</span>'
    +'<span class="sp"></span><button class="icon" data-p="copy" title="Copy the transcript">'+ICON_COPY+'</button></div>';
  h+='<div class="card pBody">'+(postTab==='points'?pointsHtml(bd,d.kind==='carousel',f):postTab==='caption'?'<div class="raw">'+esc(d.caption||'(No caption.)')+'</div>':beatsHtml(bd,d.kind==='carousel'))+'</div>';
  return h;
}
// The format card: its beats and what can flex. (When to use it, what it needs, length and reframe stay in the data for Claude.)
// Each beat has a colour; the script below highlights the lines that fill it in the same colour.
const cap=s=>(s||'').charAt(0).toUpperCase()+(s||'').slice(1);
// The (i) on a card: hover it for the 14 beats every card is built from
let BEAT_LIST=null;
async function beatPop(e){ const i=e.target.closest&&e.target.closest('.bInfo'); if(!i) return; const pop=i.querySelector('.bPop'); if(pop.childElementCount) return;
  if(!BEAT_LIST) BEAT_LIST=await fetch('/beats').then(r=>r.json()).catch(()=>null); if(!BEAT_LIST) return;
  pop.innerHTML='<b class="bpH">The 14 beats</b>'+BEAT_LIST.map(b=>'<span><b>'+esc(b.name)+'</b> '+esc(b.about)+'</span>').join('');
}
document.addEventListener('mouseover',beatPop); document.addEventListener('focusin',beatPop);
function cardTitle(c){ return c.name.toLowerCase()===c.format.toLowerCase()?c.format:cap(c.short)+': '+c.name; }
const hueOf=n=>n?HUES[(n-1)%HUES.length]:'neu';
function cardHtml(bd){
  const c=bd.card,where={};
  bd.chunks.forEach(k=>{ if(!k.beat) return; const w=where[k.beat]; where[k.beat]=w?{start:w.start,end:k.end}:{start:k.start,end:k.end}; });
  const rf=+((c.reframe||'').match(/beat (\d+)/i)||[])[1]||0;
  return '<section class="card fcard"><div class="fcCrumb"><span class="cat cat-'+esc(c.category.toLowerCase())+'">'+esc(c.category)+'</span>'+esc(c.format)
      +'<span class="bInfo" tabindex="0" aria-label="The 14 beats">i<span class="bPop"></span></span>'
      +(c.status==='Parked'?'<span class="fcTag">Parked format</span>':'')+'</div>'
    +'<h2>'+esc(cardTitle(c))+'</h2>'
    +'<div class="eyebrow">Beats</div><ol class="cbeats">'+c.beats.map((b,i)=>{ const n=i+1,w=where[n],job=b.job.replace(/^optional\.\s*/i,''),said=w&&(bd.said||[])[i];
      return '<li class="f-'+hueOf(n)+(w?'':' skip')+'"'+(w?' data-line="'+w.start+'" title="'+(said?esc(cap(job))+' Click to see it in the post':'See it in the post')+'"':'')+'><span class="cn">'+n+'</span><div>'
        +'<div><b>'+esc(b.name)+'</b> '+esc(said||job)+(b.optional?'<span class="sopt">optional</span>':'')+(n===rf?'<span class="rf">reframe</span>':'')+'</div>'
        +'<div class="cm">'+(b.sources||[]).map(esc).join(' · ')+((b.sources||[]).length?'<i>·</i>':'')
        +(w?'<span class="jl">'+(w.end>w.start?'lines '+w.start+'–'+w.end:'line '+w.start)+'</span>':'not in this post')+'</div></div></li>'; }).join('')+'</ol>'
    +(c.flex.length?'<div class="eyebrow">Flex</div><ul class="flexl">'+c.flex.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul>':'')+'</section>';
}
function lineDiv(line,car,n){ return car&&/^slide \d+$/i.test(line)?'<p class="ln slide" data-ln="'+n+'">'+esc(line)+'</p>':'<p class="ln" data-ln="'+n+'"><span>'+esc(line)+'</span></p>'; }

// A chunk's beat. One beat of the card that takes several chunks is numbered: Step 1, Step 2.
function chunkBeat(card,n,i,total){ const b=card.beats[n-1]; if(!b) return 'Filler'; if(total<2) return b.name;
  return b.kind&&b.name!==b.kind?b.name+' ('+i+')':(b.one||b.name)+' '+i; }  // a beat the card already numbers keeps its number
// The script, one line per paragraph. Lines that fill one beat of the card share its colour, with the beat,
// its job and device on the right.
function beatsHtml(bd,car){
  const total={},seen={};
  bd.chunks.forEach(c=>total[c.beat]=(total[c.beat]||0)+1);
  return '<div class="script">'+bd.chunks.map(c=>{
    seen[c.beat]=(seen[c.beat]||0)+1;
    const name=c.beat?chunkBeat(bd.card,c.beat,seen[c.beat],total[c.beat]):'Filler';
    const loops=(c.opens?'<span class="loop" title="Raises a question the viewer waits to get answered">opens '+CIRCLED(c.opens)+'</span>':'')
      +(c.closes?'<span class="loop" title="Answers the question raised earlier">answers '+CIRCLED(c.closes)+'</span>':'');
    return '<div class="chunk f-'+hueOf(c.beat)+'" data-beat="'+(c.beat||0)+'"><div class="lns">'+bd.lines.slice(c.start-1,c.end).map((l,j)=>lineDiv(l,car,c.start+j)).join('')+'</div>'
      +'<div class="side"><div class="bl">'+(c.beat?'<span class="bn">'+c.beat+'</span>':'')+'<span class="bname">'+esc(name)+'</span>'+loops+'</div>'
      +(c.job?'<div class="bjob"><b>Job</b> '+esc(c.job)+'</div>':'')+(c.device?'<div class="bjob"><b>Device</b> '+esc(c.device)+'</div>':'')
      +(c.wonder?'<div class="wonder" title="What the viewer wonders next">'+esc(c.wonder)+'</div>':'')+'</div></div>';
  }).join('')+'</div>';
}
// Points: a card with what the post argues, main point first, each with what backs it up (each jumps to its lines),
// on top of the transcript with the lines that state a point highlighted
function pointsHtml(bd,car,f){
  if(f&&working[f]&&bd.points_old) return '<div class="meta spin">Rethinking the points…</div>';
  if(!bd.points.length) return '<div class="meta">No clear points in this one.</div>';
  const at=n=>bd.points.find(p=>n>=p.start&&n<=p.end);
  return '<div class="ptsCard"><div class="eyebrow">Points</div><ol>'+bd.points.map(p=>'<li data-line="'+p.start+'"'+(p.main?' class="main" title="The main point"':'')+'><span class="pt">'+esc(p.summary)+'</span>'
      +(p.proof?'<span class="pproof">'+esc(p.proof)+'</span>':'')+'</li>').join('')+'</ol></div>'
    +'<div class="ptText">'+bd.lines.map((l,i)=>{ const n=i+1,p=at(n);
      return car&&/^slide \d+$/i.test(l)?'<p class="ln slide" data-ln="'+n+'">'+esc(l)+'</p>'
        :'<p class="ln'+(p?p.main?' hl main':' hl':'')+'" data-ln="'+n+'"><span>'+esc(l)+'</span></p>'; }).join('')+'</div>';
}
// Jump to a line: switch to Line by line, scroll there, flash it
function jumpLine(n,col){
  let el;
  if(cur==='overview'&&col){
    if(!rows.s){ rows.s=true; lsSet('cmpRows',rows); paintOverview(); }
    el=stView.querySelector('.cs[data-f="'+CSS.escape(col.dataset.f)+'"] .ln[data-ln="'+n+'"]');
  } else {
    if(postTab==='caption'){ postTab='beats'; lsSet('postTab',postTab); paintView(); }
    el=stView.querySelector('.ln[data-ln="'+n+'"]');
  }
  if(!el) return;
  el.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'}); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// Side by side: one column per post, rows lined up across columns (header, video, card, script, caption).
// Columns are kept between paints and only their contents change, so videos don't reload; order and hidden rows are CSS only.
const ROWS=[['v','Video'],['k','Card'],['s','Script'],['c','Caption']];
let dockOpen=lsGet('dockOpen',true);
// The dock floats over the page like the Ask Claude button. It lives on <body>: inside the page's columns (CSS
// containers) a fixed element would scroll with them. Kept centred on the main column as that column changes size.
const stMainEl=document.querySelector('.stMain'),stDock=document.createElement('div');
stDock.className='dock off'; stDock.id='stDock'; document.body.appendChild(stDock);
const dockShow=on=>stDock.classList.toggle('off',!on);
function dockPlace(){ const d=stDock,m=stMainEl.getBoundingClientRect(); if(!m.width) return;
  d.style.setProperty('--dockX',(m.left+m.width/2)+'px'); d.style.setProperty('--dockW',(m.width-40)+'px'); }
new ResizeObserver(dockPlace).observe(stMainEl); addEventListener('resize',dockPlace);
let rows=Object.assign({v:true,k:true,s:true,c:false},lsGet('cmpRows',{}));
function paintOverview(){
  const fs=shownFiles(),out=files().filter(f=>!fs.includes(f));
  let ov=stView.querySelector('.ovWrap');
  if(!ov){ stView.innerHTML='<div class="ovWrap"><div class="ovBar"></div><div class="cmpScroll"><div class="cmp"></div></div></div>'; ov=stView.querySelector('.ovWrap'); }
  const bar=ov.querySelector('.ovBar'); bar.style.display=out.length?'':'none';
  bar.innerHTML=out.length?'<span class="lab">Left out</span>'+out.map(f=>'<button class="outChip" data-unhide="'+esc(f)+'" title="Bring back into side by side">'+thumbImg(f)+esc(who(f))+' <i>+</i></button>').join(''):'';
  // The dock floats at the bottom right while you scroll: highlight structure or points, and which rows to show
  const dock=stDock; dock.classList.toggle('shut',!dockOpen); dockShow(true);
  dock.innerHTML='<button class="dockBtn" data-dock title="'+(dockOpen?'Hide these controls':'Show what to highlight and which rows to show')+'">'+(dockOpen?'✕':ICON_SLIDERS)+'</button>'
    +'<span class="dockIn"><span class="seg">'
    +[['beats','Structure'],['points','Points']].map(([k,n])=>'<button data-hl="'+k+'"'+((postTab==='points')===(k==='points')?' class="on"':'')+'>'+n+'</button>').join('')+'</span>'
    +'<span class="dv"></span><span class="lab">Show</span>'
    +ROWS.map(([k,n])=>'<button class="toggle'+(rows[k]?' on':'')+'" data-show="'+k+'">'+n+'</button>').join('')+'</span>';
  const grid=ov.querySelector('.cmp'),cell=(f,c)=>grid.querySelector('.'+c+'[data-f="'+CSS.escape(f)+'"]');
  grid.querySelectorAll('[data-f]').forEach(el=>{ if(!fs.includes(el.dataset.f)) el.remove(); });
  fs.forEach(f=>{ if(!cell(f,'cv')){ const e=embed((posts[f]||{}).link);
    grid.insertAdjacentHTML('beforeend','<div class="col chd" data-f="'+esc(f)+'"></div><div class="col cv" data-f="'+esc(f)+'">'
      +(e?igEmbed((posts[f]||{}).link):'<div class="novid">No preview for this post.</div>')+'</div>'
      +'<div class="col ck" data-f="'+esc(f)+'"></div><div class="col cs" data-f="'+esc(f)+'"></div><div class="col cc" data-f="'+esc(f)+'"></div>'); } });
  fs.forEach((f,i)=>{
    cell(f,'chd').innerHTML=thumbImg(f)+'<div class="who"><b title="'+esc(who(f))+'">'+esc(nameOf(who(f)))+'</b><div class="meta">'+((posts[f]||{}).kind==='carousel'?'Carousel':'Reel')
      +(statsText((posts[f]||{}).stats)?' · '+statsText(posts[f].stats):'')+'</div></div>'
      +'<div class="chatPick"><button class="chatBtn" data-menu title="Send part of this post to chat">'+ICON_CHAT+'Chat<span class="car">▾</span></button>'
      +'<div class="menu"><div class="mHint">Send to chat</div><button data-p="usescript">Script<small>Its full script</small></button>'
      +'<button data-p="usepoints">Points<small>Its core points</small></button><button data-p="usecard">Structure<small>Its format card</small></button></div></div>'
      +'<span class="nudge"><button class="icon" data-p="left" title="Move left"'+(i?'':' disabled')+'>←</button><button class="icon" data-p="right" title="Move right"'+(i<fs.length-1?'':' disabled')+'>→</button>'
      +'<button class="icon" data-p="hide" title="Leave out of side by side (stays in the study)"'+(fs.length>1?'':' disabled')+'>✕</button></span>';
    cell(f,'ck').innerHTML=cardMini(f); cell(f,'cs').innerHTML=postTab==='points'?pointsMini(f):scriptMini(f);
    cell(f,'cc').innerHTML='<div class="eyebrow">Caption</div><div class="raw">'+esc((posts[f]||{}).caption||'(No caption.)')+'</div>';
    grid.querySelectorAll('[data-f="'+CSS.escape(f)+'"]').forEach(el=>el.style.order=i);
  });
  dockPlace();
  ROWS.forEach(([k])=>grid.classList.toggle('no-'+k,!rows[k]));
  grid.style.gridTemplateRows='repeat('+(1+ROWS.filter(([k])=>rows[k]).length)+',auto)';
}
function busyNote(f){
  return working[f]?'<div class="meta spin">Working out why it works…</div>'
    :failed[f]?'<div class="meta">Couldn’t break this one down. <button class="btn soft sm" data-p="redo">Try again</button></div>'
    :!bds[f]?'<div class="meta">Not broken down yet.</div>':'<div class="meta">Nothing to break down in this one.</div>';
}
function beatWhere(bd){ const where={};
  bd.chunks.forEach(k=>{ if(!k.beat) return; const w=where[k.beat]; where[k.beat]=w?{start:w.start,end:k.end}:{start:k.start,end:k.end}; }); return where; }
// The card, short: which card it is, how this post uses it, and its beats
function cardMini(f){
  const bd=bds[f]; if(!bd||!bd.card) return busyNote(f);
  const c=bd.card,where=beatWhere(bd);
  return '<div class="fcCrumb"><span class="cat cat-'+esc(c.category.toLowerCase())+'">'+esc(c.category)+'</span>'+esc(c.format)+'</div>'
    +'<div class="mTitle">'+esc(cardTitle(c))+'</div>'
    +'<ol class="mbeats">'+c.beats.map((b,i)=>{ const n=i+1,w=where[n],one=(w&&(bd.said||[])[i])||b.job.replace(/^optional\.\s*/i,'');
      return '<li class="f-'+hueOf(n)+(w?'':' skip')+'"'+(w?' data-line="'+w.start+'"':'')+'><span class="cn">'+n+'</span>'
        +'<div class="nmw"><span class="nm">'+esc(b.name)+'</span>'+(one?'<span class="one">'+esc(one)+'</span>':'')+'</div></li>'; }).join('')+'</ol>'
    +'<div class="mActs"><button class="more" data-open="'+esc(f)+'">Full card →</button></div>';
}
// The script, short: each chunk's beat, job and device above its lines
function scriptMini(f){
  const bd=bds[f]; if(!bd||!bd.card) return busyNote(f);
  const car=(posts[f]||{}).kind==='carousel',total={},seen={};
  bd.chunks.forEach(c=>total[c.beat]=(total[c.beat]||0)+1);
  return bd.chunks.map(c=>(seen[c.beat]=(seen[c.beat]||0)+1,'<div class="mchunk f-'+hueOf(c.beat)+'"><div class="mlab">'
    +(c.beat?'<span class="bn">'+c.beat+'</span><b>'+esc(chunkBeat(bd.card,c.beat,seen[c.beat],total[c.beat]))+'</b>':'<b>Filler</b>')
    +'<span>'+esc([c.job,c.device].filter(Boolean).join(' · '))+'</span></div>'
    +bd.lines.slice(c.start-1,c.end).map((l,j)=>lineDiv(l,car,c.start+j)).join('')+'</div>')).join('');
}
function pointsMini(f){
  const bd=bds[f]; return !bd||!bd.card?busyNote(f):pointsHtml(bd,(posts[f]||{}).kind==='carousel',f);
}

// Quick ways to bring a post into the chat: its points or its format card go in the chat box, ready for a question
function toChat(text){
  openChat();
  chatIn.value=(chatIn.value.trim()?chatIn.value.trim()+'\n\n':'')+text+'\n\n';
  grow(); chatIn.focus(); chatIn.setSelectionRange(chatIn.value.length,chatIn.value.length); chatIn.scrollTop=chatIn.scrollHeight;
}
const postLabel=f=>'[P'+(files().indexOf(f)+1)+'] ('+who(f)+')';
const linesOf=x=>x.end>x.start?'lines '+x.start+'-'+x.end:'line '+x.start;
function pointsForChat(f){
  const bd=bds[f];
  return 'Use the points of this piece, '+postLabel(f)+':\n'+bd.points.map(p=>p.n+'. '+p.summary).join('\n');
}
function scriptForChat(f){
  return 'Use the script of this piece, '+postLabel(f)+':\n'+((posts[f]||{}).transcript||'').trim();
}
function cardForChat(f){
  const bd=bds[f],c=bd.card,where=beatWhere(bd);
  return 'Use the structure of this piece, '+postLabel(f)+':\n'+cardTitle(c)+' ('+c.format+', '+({index:'from my format docs',studio:'made in Studio',new:'new card'}[c.source]||'')+')\n'
    +'Use when: '+c.use_when+'\nNeeds: '+c.needs+'\nLength: '+c.length+'\nReframe goes in: '+c.reframe+'\nBeats:\n'
    +c.beats.map((b,i)=>(i+1)+'. '+b.name+': '+b.job+(where[i+1]?' ('+linesOf(where[i+1])+')':' (not in this post)')).join('\n')
    +(c.flex.length?'\nFlex: '+c.flex.join(' '):'');
}

// The Chat menu on each post in side by side
function closeMenus(except){ stView.querySelectorAll('.chatPick.open').forEach(m=>{ if(m!==except) m.classList.remove('open'); }); }
document.addEventListener('click',e=>{ if(!e.target.closest('.chatPick')) closeMenus(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeMenus(); });
// Redo asks first, since it replaces the breakdown she's looking at
const redoPop=document.getElementById('redoPop');
let redoFor='';
function redoAsk(f){ redoFor=f; modalOpen(redoPop); document.getElementById('redoYes').focus(); }
function redoClose(){ modalClose(redoPop); }
redoPop.dismiss=redoClose;
redoPop.onclick=e=>{ if(e.target===redoPop) redoClose(); };
document.getElementById('redoNo').onclick=redoClose;
document.getElementById('redoYes').onclick=()=>{ redoClose(); if(redoFor) breakDownMissing(redoFor); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&redoPop.classList.contains('on')) redoClose(); });
stDock.addEventListener('click',e=>{
  if(e.target.closest('[data-dock]')){ dockOpen=!dockOpen; lsSet('dockOpen',dockOpen); return paintOverview(); }
  const hb=e.target.closest('[data-hl]'); if(hb){ postTab=hb.dataset.hl; lsSet('postTab',postTab); return paintOverview(); }
  const sh=e.target.closest('[data-show]'); if(sh){ rows[sh.dataset.show]=!rows[sh.dataset.show]; lsSet('cmpRows',rows); return paintOverview(); }
});
stView.addEventListener('click',e=>{
  const mb=e.target.closest('[data-menu]'); if(mb){ const m=mb.parentNode; closeMenus(m); return m.classList.toggle('open'); }
  if(e.target.closest('.menu [data-p]')) closeMenus();
  const uh=e.target.closest('[data-unhide]'); if(uh) return setHidden(hidden.filter(x=>x!==uh.dataset.unhide));
  const ln=e.target.closest('[data-line]'); if(ln) return jumpLine(+ln.dataset.line,ln.closest('[data-f]'));
  const ch=e.target.closest('[data-go]'); if(ch) return openPost(ch.dataset.go);
  const o=e.target.closest('[data-open]'); if(o) return openPost(o.dataset.open);
  const t=e.target.closest('[data-tab]'); if(t){ postTab=t.dataset.tab; lsSet('postTab',postTab); return paintView(); }
  const b=e.target.closest('[data-p]'); if(!b) return;
  const a=b.dataset.p;
  const col=b.closest('[data-f]'),f=col&&cur==='overview'?col.dataset.f:cur;
  if(a==='redo') bds[f]&&!failed[f]?redoAsk(f):breakDownMissing(f);
  else if(a==='replay'){ const fr=b.closest('.pVid').querySelector('iframe'); if(fr) fr.src=fr.src; }
  else if(a==='remove') stSaveFiles(files().filter(x=>x!==f));
  else if(a==='reread') reread(f);
  else if(a==='usescript') toChat(scriptForChat(f));
  else if(a==='usepoints'||a==='usecard'){ if(bds[f]&&bds[f].card) toChat(a==='usepoints'?pointsForChat(f):cardForChat(f)); }
  else if(a==='left'||a==='right'){ const sh=shownFiles(),k=sh.indexOf(f),g=sh[a==='left'?k-1:k+1]; if(!g) return;
    const fs=files().slice(),i=fs.indexOf(f),j=fs.indexOf(g); [fs[i],fs[j]]=[fs[j],fs[i]]; stSaveFiles(fs); }
  else if(a==='hide') setHidden(hidden.concat(f));
  else if(a==='copy') copyText(b,posts[cur].transcript||'');
});

// Saved text marks posts as [[file]]: show a numbered chip (click opens the post), or "post N" when copied
function pchip(f){
  const at=files().indexOf(f);
  return at<0?'<span class="pchip gone" title="Not in this study now">–</span>':'<span class="pchip" data-go="'+esc(f)+'" title="'+esc(who(f))+'">'+(at+1)+'</span>';
}
function richText(s){ return esc(s).replace(/\[\[([^\]]+)\]\]/g,(m,f)=>pchip(f)); }
function scriptHtml(s){ return richText(s).replace(/\[([^\[\]<>]{1,80})\]/g,'<span class="fill" title="Fill this in with your own">[$1]</span>'); }
function plainText(s){ return (s||'').replace(/\[\[([^\]]+)\]\]/g,(m,f)=>{ const at=files().indexOf(f); return at<0?'a post':'post '+(at+1); }); }

// Add links: each is transcribed, joins the library and the study, and gets broken down. Posts already in the library are
// reused instead of transcribed again (unless "Read on-screen text" is ticked, which needs the video).
async function cmpAddLinks(){
  // Links can be on separate lines, or run together when pasted without spaces
  const links=[...new Set(cmpUrl.value.match(/https?:\/\/(?:www\.)?instagram\.com\/\S+?(?=https?:\/\/|[\s,]|$)/g)||[])];
  if(!links.length){ say('Paste one or more Instagram links.'); cmpUrl.focus(); return; }
  cmpAddBtn.disabled=true; cmpSt.classList.add('busy');
  let known=[]; try{ known=await (await fetch('/history')).json(); }catch(e){}
  const bad=[],slow=opt.screen?' About a minute…':'…';
  for(const [i,u] of links.entries()){
    const which=links.length>1?(i+1)+' of '+links.length:'it';
    const code=shortcode(u),old=code&&known.find(h=>shortcode(h.link)===code);
    let f=old&&old.file,redo=false;
    try{
      if(!f){
        say((opt.screen?'Reading the on-screen text of ':'Transcribing ')+which+'.'+slow);
        const d=await api('POST','/process',{url:u,screen:opt.screen});
        f=d.file;
      } else if(opt.screen){
        say('Reading the on-screen text of '+which+'.'+slow);
        posts[f]=await api('POST','/history/'+encodeURIComponent(f)+'/reread'); redo=true;  // new words, so a new breakdown
      }
    }catch(e){ bad.push([u,e.message]); continue; }
    if(!inStudio(f)) await stSaveFiles(files().concat(f));
    if(redo) breakDownMissing(f);
    openPost(f);
  }
  cmpUrl.value=bad.map(x=>x[0]).join('\n'); cmpFit();  // leave failed links in the box to retry
  cmpSt.classList.remove('busy'); cmpAddBtn.disabled=false;
  say(bad.length?'Couldn’t add '+bad.length+' of '+links.length+'. '+bad.map(x=>x[1]).join(' '):'');
  loadSide();
}
cmpAddBtn.onclick=cmpAddLinks;
// The link box grows with each line pasted
function cmpFit(){ cmpUrl.style.height='auto'; cmpUrl.style.height=cmpUrl.scrollHeight+'px'; }
cmpUrl.addEventListener('input',cmpFit);
// The option slides in while you're in the link box, and out when you click away (unless one is ticked, so you can see it's on)
const linkBox=document.getElementById('linkBox');
function linkBoxPaint(){ linkBox.classList.toggle('open',linkBox.contains(document.activeElement)||opt.screen); }
linkBox.addEventListener('focusin',linkBoxPaint);
linkBox.addEventListener('focusout',()=>setTimeout(linkBoxPaint,0));
linkBox.querySelectorAll('.choice').forEach(b=>{ b.addEventListener('mousedown',e=>e.preventDefault()); b.addEventListener('click',()=>setTimeout(linkBoxPaint,0)); });  // keep the box focused while ticking
cmpUrl.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); cmpAddLinks(); } });  // Shift+Enter for a new line

// --- Right panel: the chat, with suggested asks for the view you're on ---
// Each suggestion is [what the button says, what it asks]; posts are named by their [P] label so the AI knows which
function suggestions(){
  if(tool==='analytics') return anSuggestions();
  if(!files().length) return [];
  if(cur==='overview') return [
    ['Remix these into one script','Remix these posts into one reel script for me: the strongest hook, format and proof from across them, in my voice. Say which post each part came from.'],
    ['Which hook is strongest, and why?','Which of these hooks is strongest, and why? Rank them, and say what makes the best one work.'],
    ['Why did these all work?','What is the pattern behind why these posts all worked? Look at their ideas, formats, hooks and beats.'],
    ['What has nobody said yet?','What angle does none of these posts cover that my audience would care about? Give me 3, each with a hook.'],
    ['Which format should I use next?','Which of these formats would work best for my next reel, and on what topic? Sketch its beats for me.'],
  ];
  const p=postLabel(cur);
  return [
    ['Same idea, my voice','Write a reel script with the same idea as '+p+', in my voice. Keep its big idea, belief shift and type of hook, but find my own way in, with my own hook and proof.'],
    ['Same format, new topic','Write a reel script that follows the format card of '+p+' beat by beat, with the reframe where the card puts it, on a new topic I would make a reel about. Don\'t reuse its idea, examples or wording. Tell me the topic you picked.'],
    ['What could I say that this doesn\'t?','What could I say about this topic that '+p+' doesn\'t say?'],
    ['What would make this even stronger?','What would make '+p+' even stronger?'],
    ['Give me 5 hooks like this for my audience','Give me 5 hooks like the one in '+p+', for my audience.'],
    ['Recreate this in another format','Recreate '+p+' in a different format, for variety. Pick another format card from formats.json or cards.json that suits its idea (not the card it uses now) and tell me which one and why in one line. Then write the script following that card\'s beats in order, with the reframe where the card puts it. Keep the big idea, in my voice.'],
  ];
}
function benchPaint(){
  if(!study){ bBody.innerHTML=''; (stReady=stReady||stInit()); return; }  // the chat runs in the open study: load it
  chatSave();
  chatIn.placeholder=tool==='studio'?'Ask anything about these reels':tool==='formats'?'Ask anything about your formats':tool==='analytics'?'Ask what\'s working':'Ask anything';
  const send=document.getElementById('chatSend');
  send.innerHTML=job==='ask'?ICON_STOP:ICON_SEND; send.title=job==='ask'?'Stop':'Send'; send.disabled=!!job&&job!=='ask'; send.classList.toggle('stop',job==='ask');
  bBody.innerHTML=paintChat();
  bBody.scrollTop=bBody.scrollHeight;
}
function paintChat(){
  if(tool==='analytics'&&!chat.length&&!pending&&!chatErr) return '<div class="bIntro"><span class="bHello">'+ICON_CHAT.replace(/13/g,'20')+'</span><b>How\'s your content doing?</b>I can read all your Instagram numbers and what you said in each reel. Ask what\'s working, or try one.</div>'
    +'<div class="eyebrow" style="margin-top:22px">Try one</div><div class="sugs" style="margin-top:0">'+suggestions().map(([l],i)=>'<button data-sug="'+i+'">'+esc(l)+'</button>').join('')+'</div>';
  if(tool!=='studio'&&!chat.length&&!pending&&!chatErr) return '<div class="bIntro"><span class="bHello">'+ICON_CHAT.replace(/13/g,'20')+'</span><b>Hi! What are we making?</b>'+(tool==='formats'
    ?'Ask anything about your formats. In a card, Structure → chat and Script → chat put it here.'
    :'Ask anything. This chat follows you to Studio, Formats and Analytics, and stays until you start a new one.')+'</div>';
  const sug=suggestions(),about=!files().length?'':cur==='overview'?'the '+shownFiles().length+' posts side by side':esc(nameOf(who(cur)))+'’s '+((posts[cur]||{}).kind==='carousel'?'carousel':'reel');
  const chips=sug.length?'<div class="sugs">'+sug.map(([l],i)=>'<button data-sug="'+i+'">'+esc(l)+'</button>').join('')+'</div>':'';
  if(!chat.length&&!pending&&!chatErr) return '<div class="bIntro"><span class="bHello">'+ICON_CHAT.replace(/13/g,'20')+'</span>'+(about?'About '+about+'. Ask anything, or ask it to change things, like fixing a card.':'Add a reel that did well, then ask anything about it.')+'</div>'+(chips?'<div class="eyebrow" style="margin-top:22px">Try one</div>'+chips.replace('class="sugs"','class="sugs" style="margin-top:0"'):'');
  return '<div class="chat">'+chat.map((t,i)=>'<div class="you">'+esc(t.q)+'</div><div>'
    +(t.stopped?'<div class="ans stopped">Stopped.</div>':answerHtml(t,i)
      +(t.changed&&t.changed.length?'<div class="changed">Changed '+t.changed.map(esc).join(', ')+'</div>':'')
      +'<div class="acts"><button class="icon" data-w="copychat" data-i="'+i+'">'+ICON_COPY+' Copy</button></div>')+'</div>').join('')
    +(pending?'<div class="you">'+esc(pending)+'</div><div class="bBusy spin">'+esc(aiName())+' is on it</div>':'')
    +(chatErr?'<div class="ans" style="color:#b42318">Didn’t send: '+esc(chatErr)+'</div>':'')+'</div>';
}
// A reply, with each script (between ===SCRIPT=== and ===END===) in its own box you can copy or save to Cleve
const SCRIPT_RE=/===SCRIPT===[ \t]*\n?([\s\S]*?)\n?[ \t]*===END===/g;
const scriptsOf=a=>[...(a||'').matchAll(SCRIPT_RE)].map(m=>m[1].trim());
const unmark=a=>(a||'').replace(SCRIPT_RE,(m,x)=>x.trim());
function answerHtml(t,i){
  let k=0;
  return (t.a||'').split(SCRIPT_RE).map((part,j)=>{ part=part.trim(); if(!part) return '';
    return j%2?scriptBox(part,t,i,k++):'<div class="ans">'+scriptHtml(part)+'</div>'; }).join('');
}
const SAVED={sending:'Saving to Cleve…',saved:'Saved to Cleve ✓',none:'Not saved. Try again'};
// Your edits to a script in the chat win over what the AI wrote; both Copy and Save to Cleve use them
const scriptText=(t,k,text)=>(t.edits&&t.edits[k]!=null)?t.edits[k]:plainText(text);
function scriptBox(text,t,i,k){
  const st=(t.saves||{})[k];
  return '<div class="scriptBox"><div class="eyebrow">Script</div><div class="sbText" contenteditable="plaintext-only" spellcheck="false" data-i="'+i+'" data-k="'+k+'" title="Click to edit before you copy or save it">'+esc(scriptText(t,k,text))+'</div><div class="acts">'
    +'<button class="icon" data-w="copyscript" data-i="'+i+'" data-k="'+k+'">'+ICON_COPY+' Copy script</button>'
    +(st==='saved'?'<a class="icon" href="'+esc(((t.links||{})[k])||'https://app.cleve.ai')+'" target="_blank" title="Open it in Cleve">'+SAVED.saved+' Open ↗</a></div></div>'
      :st==='sending'?'<button class="icon" disabled>'+SAVED.sending+'</button></div></div>'
      :'<button class="icon" data-w="cleve" data-i="'+i+'" data-k="'+k+'">'+(SAVED[st]||'Save to Cleve')+'</button>'
      +'<button class="icon" data-w="noteopen" data-i="'+i+'" data-k="'+k+'">Save to Cleve with a note</button></div>'
      +((t.noting===k)?'<div class="noteRow"><textarea class="noteIn" data-i="'+i+'" data-k="'+k+'" rows="2" placeholder="Your note. It goes under the script in Cleve.">'+esc(t.noteText||'')+'</textarea>'
        +'<div class="noteActs"><span class="meta">Enter to save · Shift+Enter for a new line</span><button class="btn soft sm" data-w="notecancel" data-i="'+i+'">Cancel</button>'
        +'<button class="btn dark sm" data-w="cleve" data-note="1" data-i="'+i+'" data-k="'+k+'">Save to Cleve</button></div></div>':'')+'</div>');
}
async function runBusy(kind,path,data){
  job=kind; paint();
  try{ const view=await api('POST','/studies/'+study.id+path,data); job=''; await stSet(view); }
  catch(e){ job=''; paint(); say('Error: '+e.message); }
}
// shown: what the chat shows for this ask (a suggestion's button text); the full ask goes to the AI.
async function sendChat(ask,shown){
  const q=(ask||chatIn.value).trim(); if(!q||job) return null;
  openChat(); shown=shown||q; pending=shown; chatErr=''; if(!ask){ chatIn.value=''; grow(); } job='ask'; benchPaint();
  let r=null;
  const post=()=>api('POST','/studies/'+study.id+'/ask',{question:q,session:chatSession,open:cur,shown:cur==='overview'?shownFiles():null,where:chatWhere()});
  try{ if(!study) await (stReady=stReady||stInit());
    try{ r=await post(); }
    catch(e){  // the open study was deleted (e.g. in another tab): open another one and send again
      if(!/study doesn.t exist/i.test(e.message)) throw e;
      study=null; await (stReady=stInit()); r=await post(); }
    chatSession=r.session||chatSession; chat.push(r.stopped?{q:shown,stopped:true}:{q:shown,a:r.answer,changed:r.changed});
    if(r.changed.length) await stSet(await api('GET','/studies/'+study.id)); }  // it may have changed cards or breakdowns
  catch(e){ if(!ask){ chatIn.value=q; grow(); } chatErr=e.message; say('Error: '+e.message); }
  job=''; pending=''; benchPaint(); return r;
}
// Where you are, when it isn't Studio: the chat is on every page
function chatWhere(){
  if(tool==='formats') return typeof fmWhere==='function'?fmWhere():'the Formats page';
  if(tool==='analytics') return typeof anWhere==='function'?anWhere():'the Analytics page';
  return '';
}
// The box grows with what you type, up to a point
function grow(){ chatIn.style.height='auto'; chatIn.style.height=Math.min(chatIn.scrollHeight+2,240)+'px'; }
chatIn.addEventListener('input',grow);
document.getElementById('chatNew').onclick=()=>{ if(job) return; chat=[]; chatSession=''; chatIn.value=''; grow(); benchPaint(); chatIn.focus(); };
document.getElementById('chatSend').onclick=()=>job==='ask'?api('POST','/studies/'+study.id+'/ask/stop').catch(()=>{}):sendChat();
chatIn.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendChat(); } });
bBody.addEventListener('click',e=>{
  const ch=e.target.closest('[data-go]'); if(ch) return openPost(ch.dataset.go);
  const s=e.target.closest('[data-sug]'); if(s){ const [l,ask]=suggestions()[+s.dataset.sug]; return sendChat(ask,l); }
  const b=e.target.closest('[data-w]'); if(!b) return;
  const t=chat[+b.dataset.i];
  const script=b.dataset.k!=null?scriptText(t,+b.dataset.k,scriptsOf(t.a)[+b.dataset.k]).trim():'';
  if(b.dataset.w==='copychat') copyText(b,plainText(unmark(t.a)));
  else if(b.dataset.w==='copyscript') copyText(b,script);
  else if(b.dataset.w==='noteopen'){ t.noting=+b.dataset.k; t.noteText=''; benchPaint(); const n=bBody.querySelector('.noteIn'); if(n) n.focus(); }
  else if(b.dataset.w==='notecancel'){ t.noting=null; benchPaint(); }
  else if(b.dataset.w==='cleve') addToCleve(t,+b.dataset.k,script,b.dataset.note?(t.noteText||'').trim():'');
});
// A script goes to your Cleve as written, in a folder called Reel scripts; your note, if any, goes underneath it.
// Not connected yet: the Connect Cleve pop-up (setup.js) opens, then the save goes ahead.
async function addToCleve(t,k,script,note){
  if(note==null) return;
  const body=note?script+'\n\nMy note: '+note:script;
  (t.saves=t.saves||{})[k]='sending'; t.noting=null; benchPaint();
  try{
    const r=await fetch('/cleve/save',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:script.split('\n')[0].slice(0,60),content:body})});
    const d=await readJSON(r);
    if(d.need_key){ delete t.saves[k]; benchPaint(); return cleveConnect(()=>addToCleve(t,k,script,note),r.status===409&&/key/i.test(d.error)?d.error:''); }
    if(!r.ok) throw new Error(d.error||'Something went wrong');
    t.saves[k]='saved'; (t.links=t.links||{})[k]=d.link;
  }catch(e){ t.saves[k]='none'; say('Error: '+e.message); }
  chatSave(); benchPaint();
}
bBody.addEventListener('input',e=>{ const n=e.target.closest('.noteIn'); if(n) chat[+n.dataset.i].noteText=n.value;
  const sb=e.target.closest('.sbText'); if(sb){ const t=chat[+sb.dataset.i]; (t.edits=t.edits||{})[+sb.dataset.k]=sb.innerText; chatSave(); } });
bBody.addEventListener('keydown',e=>{ const n=e.target.closest('.noteIn'); if(!n||e.key!=='Enter'||e.shiftKey) return;
  e.preventDefault(); const t=chat[+n.dataset.i],k=+n.dataset.k; addToCleve(t,k,scriptText(t,k,scriptsOf(t.a)[k]).trim(),n.value.trim());
});

// Hide or show the chat panel; remembered between visits. Anything that sends to the chat opens it first.
let folded=lsGet('folded',{});
const bench=document.querySelector('.bench');
function foldPaint(){ bench.style.setProperty('--w',bench.offsetWidth+'px'); document.body.classList.toggle('st-nobench',!!folded.bench); }
function openChat(){ modalsClose(); if(folded.bench){ folded.bench=false; lsSet('folded',folded); foldPaint(); } }  // a pop-up steps aside for the chat
document.addEventListener('click',e=>{ const b=e.target.closest('[data-fold]'); if(!b) return;
  folded[b.dataset.fold]=!folded[b.dataset.fold]; lsSet('folded',folded); foldPaint(); });
foldPaint();
