// Library: the panel on the left of Studio. Every reel you've pulled in.
// Click a reel to open it in the study (it's added first if it isn't in yet). The toggle on the frame's edge tucks it away.
// Also here: the option under Studio's link box (read on-screen text).
const hist=document.getElementById('hist'),find=document.getElementById('find');
function loadSide(){ return loadHistory(); }
function applyFind(){ const q=find.value.trim().toLowerCase();
  hist.querySelectorAll('.item').forEach(el=>el.style.display=!q||el.textContent.toLowerCase().includes(q)?'':'none'); }
find.addEventListener('input',applyFind);

// Reels: the one open in Studio is highlighted; the ones in the study get a dot
async function loadHistory(){
  const items=await (await fetch('/history')).json();
  document.getElementById('libCount').textContent=items.length||'';
  if(!items.length){ hist.innerHTML='<div class="empty libEmpty"><b>Your library is empty</b>Every reel or carousel you transcribe lands here, with its words and caption. Paste an Instagram link in the box on the right and press Transcribe to add your first one.</div>'; return; }
  hist.innerHTML=items.map(i=>'<div class="item" data-f="'+esc(i.file)+'">'+(i.thumb?'<img class="thumb" loading="lazy" src="'+esc(i.thumb)+'">':'<div class="thumb"></div>')
    +'<div class="info"><div class="who" title="'+esc(i.author)+'">'+esc(nameOf(i.author))+'<i class="inSt" title="In this study"></i></div><div class="meta">'+esc(i.when)+'</div><div class="prev">'+esc(i.preview)+'</div></div></div>').join('');
  libMark(); applyFind();
}
function libMark(){
  hist.querySelectorAll('.item[data-f]').forEach(el=>{ el.classList.toggle('active',el.dataset.f===cur); el.classList.toggle('in',inStudio(el.dataset.f)); });
}
hist.addEventListener('click',async e=>{
  const el=e.target.closest('.item'); if(!el) return;
  const f=el.dataset.f;
  try{ if(!inStudio(f)) await addToStudio(f); openPost(f); }
  catch(err){ say('Error: '+err.message); }
});

// Tuck the panel away, or bring it back (the toggle on the frame's edge, in page.html). Remembered between visits.
function libFoldPaint(){ const el=document.getElementById('side'); if(el.offsetWidth) el.style.setProperty('--w',el.offsetWidth+'px');
  document.body.classList.toggle('lib-noside',!!lsGet('lib:folded',false)); }
libFoldPaint();

// The option under the link box. Read on-screen text: skip the audio and read the words shown in the video.
const opt={screen:false};
document.getElementById('optScreen').onclick=e=>{ const b=e.currentTarget; opt.screen=!opt.screen; b.classList.toggle('on',opt.screen); b.setAttribute('aria-pressed',opt.screen); };
