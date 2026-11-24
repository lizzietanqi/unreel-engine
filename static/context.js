// Context: everything the AI knows about you, in three tabs (contextdoc.py, angles.py).
// About you: context.md, section by section (who you are, what you offer, your audience, your voice, example scripts, the
//   content mix you aim for). A list of sections on the left to jump around; click a section to change it. Saves as you type.
// Pillars: your content pillars (pillars.json). Analytics files every reel under one, Content direction suggests ideas across them.
// Angles: your angles on your topic or product (angles.js draws them).
const cxOut=document.getElementById('cxOut'),cxToc=document.getElementById('cxToc');
let cx=null,cxEdit=-1,cxTimer=0,cxSaving=false,cxAgain=false,cxStatus='',cxConflict=null,cxGoto='';
// What reads each section, shown as a small note on it
const CX_USES=[[/who the reels are for/i,'Content direction checks every reel against this'],[/content mix/i,'The dashed line on Content direction, in Analytics']];
// What goes in a section, shown while it's empty (and as the hint in its box)
const CX_HINTS=[
  [/who you are/i,'Your name, what you do, and anything about you the AI should know when it writes as you. A few lines is plenty.\nLike: I\'m Sam, a nurse in Leeds. I post about saving money on a normal salary.'],
  [/what you offer/i,'What you\'d like viewers to buy, try or sign up for, in plain words: a product, a course, a service, a newsletter. Add a short list of true things it does, so the AI never makes things up.\nLeave it empty if you just post content.'],
  [/who the reels are for/i,'Who you want watching: what they do, what they want, what they\'re stuck on.\nLike: People in their 20s on their first full-time salary who want to stop living paycheck to paycheck.'],
  [/voice|sound/i,'How you talk. Words you use, words you\'d never say, how long your sentences are.\nLike: Casual and warm. Short sentences. No swearing. Never says "game-changer" or "let that sink in".'],
  [/scripts/i,'Paste 2 or 3 scripts of reels you\'ve posted, word for word. The AI picks up how you actually talk from these.'],
  [/content mix/i,'The share of reels you want at each stage. Analytics draws it as a dashed line so you can see the gaps. Write it like this:\n- Top: 60%\n- Middle: 30%\n- Bottom: 10%\n\n- Unaware: 20%\n- Problem aware: 35%\n- Solution aware: 25%\n- Product aware: 15%\n- Most aware: 5%'],
];
const cxHint=t=>(CX_HINTS.find(([re])=>re.test(t))||[0,''])[1];
let cxTab=lsGet('cx:tab','about');
// From the nav or a link: #angles and #pillars open that tab; a link to a section of About you opens About you
function cxShow(){
  const h=location.hash.slice(1);
  if(h==='angles'||h==='pillars') cxTab=h; else if(cxGoto) cxTab='about';
  cxOpen();
}
function cxOpen(){
  lsSet('cx:tab',cxTab); history.replaceState(null,'','#'+(cxTab==='about'?'context':cxTab));
  document.querySelectorAll('#cxTabs button').forEach(b=>b.classList.toggle('on',b.dataset.t===cxTab));
  document.querySelectorAll('.cxPane').forEach(p=>p.classList.toggle('on',p.dataset.pane===cxTab));
  if(cxTab==='angles') agShow(); else if(cxTab==='pillars') plShow(); else cxAbout();
}
document.getElementById('cxTabs').addEventListener('click',async e=>{ const b=e.target.closest('button'); if(!b||b.dataset.t===cxTab) return;
  if(cxEdit>=0) await cxDone(); cxTab=b.dataset.t; document.getElementById('main').scrollTop=0; cxOpen(); });
async function cxAbout(){
  try{ const r=await fetch('/context'); cx=await readJSON(r); if(!r.ok) throw new Error(cx.error); }
  catch(e){ cxOut.innerHTML='<div class="empty">Couldn\'t open context.md. '+esc(e.message||'')+'</div>'; return; }
  cxEdit=-1; cxConflict=null; cxPaint();
  if(cxGoto){ const i=cx.sections.findIndex(s=>s.title.toLowerCase().includes(cxGoto.toLowerCase())); cxGoto='';
    if(i>=0) requestAnimationFrame(()=>{ cxJump(i); const el=document.getElementById('cx-'+i); el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),1600); }); }
}
const cxName=t=>t.replace(/^\d+[.)]\s*/,'');
// Just enough markdown for this file: ## headings, - and 1. lists, **bold**, *italic*, and paragraphs
function cxMd(s,i){
  let out='',list=null,para=[],h=0;
  const inl=t=>esc(t).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g,'$1<i>$2</i>');
  const flushP=()=>{ if(para.length){ out+='<p>'+para.map(inl).join('<br>')+'</p>'; para=[]; } };
  const flushL=()=>{ if(list){ out+='<'+list.t+(list.start>1?' start="'+list.start+'"':'')+'>'+list.items.map(x=>'<li>'+inl(x)+'</li>').join('')+'</'+list.t+'>'; list=null; } };
  for(const ln of s.split('\n')){
    let m;
    if((m=ln.match(/^#{2,6}\s+(.*)/))){ flushP(); flushL(); out+='<h3 id="cx-'+i+'-'+(h++)+'">'+inl(m[1])+'</h3>'; continue; }
    if((m=ln.match(/^\s*[-*]\s+(.*)/))){ flushP(); if(!list||list.t!=='ul'){ flushL(); list={t:'ul',items:[]}; } list.items.push(m[1]); continue; }
    if((m=ln.match(/^\s*(\d+)[.)]\s+(.*)/))){ flushP(); if(!list||list.t!=='ol'){ flushL(); list={t:'ol',items:[],start:+m[1]}; } list.items.push(m[2]); continue; }
    if(!ln.trim()){ flushP(); flushL(); continue; }
    flushL(); para.push(ln);
  }
  flushP(); flushL(); return out||'<p class="meta">Empty. Click to write it.</p>';
}
function cxPaint(){
  if(!cx) return;
  cxToc.innerHTML='<div class="cxTocHead">Sections</div>'+cx.sections.map((s,i)=>'<button data-jump="'+i+'">'+esc(cxName(s.title))+'</button>'
    +[...s.body.matchAll(/^#{2,6}\s+(.*)$/gm)].map((m,j)=>'<button class="sub" data-jump="'+i+'-'+j+'">'+esc(m[1])+'</button>').join('')).join('');
  cxOut.innerHTML=(cx.intro?'<div class="cxSec"><div class="cxBody">'+cxMd(cx.intro,'x')+'</div></div>':'')
    +cx.sections.map((s,i)=>{ const use=CX_USES.find(([re])=>re.test(s.title)),ed=i===cxEdit;
      return '<section class="cxSec'+(ed?' editing':'')+'" id="cx-'+i+'" data-i="'+i+'"><div class="cxSecHead"><h2>'+esc(cxName(s.title))+'</h2>'
        +(use?'<span class="cxUse">'+esc(use[1])+'</span>':'')+'<span class="sp"></span>'
        +(ed?'<span class="cxSaved meta" id="cxStatus">'+esc(cxStatus)+'</span><button class="btn primary sm" data-cx="done">Done</button>':'<button class="icon" data-cx="edit">Edit</button>')+'</div>'
        +(ed&&cxConflict?'<div class="note cxNote">'+esc(cxConflict.error)+' Your edit wasn\'t saved. <button class="linkBtn" data-cx="copymine">Copy your edit</button> to paste it back in.</div>':'')
        +(ed?'<textarea class="cxTa" spellcheck="true" placeholder="'+esc(cxHint(s.title))+'">'+esc(s.body)+'</textarea>'
          :'<div class="cxBody" data-cx="edit" title="Click to edit">'+(s.body.trim()||!cxHint(s.title)?cxMd(s.body,i)
            :'<p class="cxHint">'+esc(cxHint(s.title)).replace(/\n/g,'<br>')+'</p><p class="meta">Empty. Click to write it.</p>')+'</div>')+'</section>'; }).join('');
  const ta=cxOut.querySelector('.cxTa'); if(ta){ cxGrow(ta); ta.focus(); ta.setSelectionRange(0,0); }
  cxSpy();
}
function cxGrow(ta){ ta.style.height='auto'; ta.style.height=(ta.scrollHeight+4)+'px'; }
function cxJump(id){ const el=document.getElementById('cx-'+id); if(!el) return;
  const m=document.getElementById('main'); m.scrollTo({top:el.getBoundingClientRect().top-m.getBoundingClientRect().top+m.scrollTop-24,behavior:'smooth'}); }
// The section on screen is marked in the list
function cxSpy(){
  if(tool!=='context'||!cx) return;
  const m=document.getElementById('main'),top=m.getBoundingClientRect().top+90; let on=0;
  cxOut.querySelectorAll('section.cxSec').forEach(el=>{ if(el.getBoundingClientRect().top<=top) on=+el.dataset.i; });
  if(m.scrollTop>0&&m.scrollTop+m.clientHeight>=m.scrollHeight-4) on=cx.sections.length-1;  // at the very bottom: the last one
  cxToc.querySelectorAll('button:not(.sub)').forEach(b=>b.classList.toggle('on',+b.dataset.jump===on));
}
document.getElementById('main').addEventListener('scroll',()=>{ if(tool==='context') cxSpy(); },{passive:true});
function cxSetStatus(t){ cxStatus=t; const el=document.getElementById('cxStatus'); if(el) el.textContent=t; }
// Save the section being edited: only if it changed, one save at a time
async function cxSave(){
  const ta=cxOut.querySelector('.cxTa'); if(!ta||cxEdit<0) return;
  const s=cx.sections[cxEdit],body=ta.value.replace(/^\n+|\n+$/g,'');
  if(body===s.body) return cxSetStatus(cxStatus==='Saving…'?'Saved':cxStatus);
  if(cxSaving){ cxAgain=true; return; }
  cxSaving=true; cxSetStatus('Saving…');
  try{
    const r=await fetch('/context',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:s.title,old:s.body,body})});
    const d=await readJSON(r);
    if(r.status===409){ cx=d; cxConflict={error:d.error,mine:ta.value}; cxSaving=false; cxPaint(); return cxSetStatus('Not saved'); }
    if(!r.ok) throw new Error(d.error||'Couldn\'t save');
    cx.sections[cxEdit].body=body; cxSetStatus('Saved to context.md');
  }catch(e){ cxSetStatus('Couldn\'t save: '+e.message); }
  cxSaving=false; if(cxAgain){ cxAgain=false; cxSave(); }
}
async function cxDone(){ clearTimeout(cxTimer); await cxSave(); if(cxConflict) return; cxEdit=-1; cxStatus=''; cxPaint(); }
cxOut.addEventListener('input',e=>{ if(!e.target.classList.contains('cxTa')) return; cxGrow(e.target); cxSetStatus('Editing…'); clearTimeout(cxTimer); cxTimer=setTimeout(cxSave,700); });
cxOut.addEventListener('focusout',e=>{ if(e.target.classList.contains('cxTa')){ clearTimeout(cxTimer); cxSave(); } });
cxOut.addEventListener('keydown',e=>{ if(e.target.classList.contains('cxTa')&&(e.key==='Escape'||(e.key==='Enter'&&(e.metaKey||e.ctrlKey)))){ e.preventDefault(); cxDone(); } });
cxOut.addEventListener('click',async e=>{
  const b=e.target.closest('[data-cx]'); if(!b) return;
  const w=b.dataset.cx,i=+b.closest('section').dataset.i;
  if(w==='done') return cxDone();
  if(w==='copymine'){ navigator.clipboard.writeText(cxConflict.mine); b.textContent='copied'; return; }
  if(w==='edit'&&!getSelection().toString()){ if(cxEdit>=0&&cxEdit!==i){ clearTimeout(cxTimer); await cxSave(); }
    cxEdit=i; cxConflict=null; cxStatus=''; cxPaint(); }
});
cxToc.addEventListener('click',e=>{ const b=e.target.closest('[data-jump]'); if(b) cxJump(b.dataset.jump); });

// --- Pillars: name and what each covers, in your order. Saves the whole list as you type. ---
const plOut=document.getElementById('plOut');
let pl=null,plTimer=0,plSaving=false,plAgain=false,plStatus='',plErr='';
async function plShow(){
  try{ const r=await fetch('/pillars'),d=await readJSON(r); if(!r.ok) throw new Error(d.error); pl=d.pillars; }
  catch(e){ plOut.innerHTML='<div class="empty">Couldn\'t load your pillars. '+esc(e.message||'')+'</div>'; return; }
  plPaint();
}
function plPaint(focus){
  plOut.innerHTML=(pl.length?'':'<div class="welcome" style="margin-bottom:14px"><b>No pillars yet</b>Pillars are the 3 to 6 themes you post about, like "Saving money", "Side hustles" and "My life". Analytics files every reel under one, so you can see which themes do best, and Content direction suggests ideas across them. Press Add pillar to make your first one.</div>')
    +'<div class="plList">'+pl.map((p,i)=>'<div class="pl" data-i="'+i+'"><span class="plNum">'+(i+1)+'</span>'
      +'<input data-f="name" maxlength="80" placeholder="Name it, like: Saving money" value="'+esc(p.name)+'">'
      +'<div class="plActs"><button class="icon" data-pl="up" title="Move up"'+(i?'':' disabled')+'>↑</button><button class="icon" data-pl="down" title="Move down"'+(i<pl.length-1?'':' disabled')+'>↓</button>'
      +'<button class="icon del" data-pl="del" title="Delete">'+ICON_DEL+'</button></div>'
      +'<textarea data-f="about" rows="1" placeholder="What it covers, and what these reels do for your viewer">'+esc(p.about)+'</textarea></div>').join('')+'</div>'
    +'<div class="plBar"><button class="btn soft sm" data-pl="add"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Add pillar</button>'
    +'<span class="sp"></span><span class="meta" id="plStatus">'+esc(plErr||plStatus)+'</span></div>';
  plGrowAll();
  if(focus!=null){ const el=plOut.querySelector('.pl[data-i="'+focus+'"] input'); if(el) el.focus(); }
}
// Size each box to its text once the page has laid out, and again when the width changes
function plGrowAll(){ requestAnimationFrame(()=>plOut.querySelectorAll('textarea').forEach(cxGrow)); }
new ResizeObserver(()=>{ if(tool==='context'&&cxTab==='pillars') plGrowAll(); }).observe(plOut);
function plSetStatus(t){ plStatus=t; const el=document.getElementById('plStatus'); if(el) el.textContent=plErr||t; }
async function plSave(){
  if(plSaving){ plAgain=true; return; }
  plSaving=true; plErr=''; plSetStatus('Saving…');
  try{
    const r=await fetch('/pillars',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({pillars:pl})}),d=await readJSON(r);
    if(!r.ok) throw new Error(d.error||'Couldn\'t save');
    d.pillars.forEach((x,i)=>{ if(pl[i]) pl[i].id=x.id; });  // keep what's being typed; just take the ids of new ones
    plSetStatus('Saved. Your reels get sorted again a couple of minutes after you stop editing.');
  }catch(e){ plErr=e.message; plSetStatus(''); }
  plSaving=false; if(plAgain){ plAgain=false; plSave(); }
}
const plSoon=()=>{ clearTimeout(plTimer); plSetStatus('Editing…'); plTimer=setTimeout(plSave,700); };
plOut.addEventListener('input',e=>{ const f=e.target.dataset.f,row=e.target.closest('.pl'); if(!f||!row) return;
  pl[+row.dataset.i][f]=e.target.value; if(f==='about') cxGrow(e.target); plSoon(); });
plOut.addEventListener('click',e=>{
  const b=e.target.closest('[data-pl]'); if(!b) return;
  const w=b.dataset.pl,i=+(b.closest('.pl')||{dataset:{i:-1}}).dataset.i;
  if(w==='add'){ pl.push({id:'',name:'',about:''}); plPaint(pl.length-1); return; }  // saved once it has a name
  if(w==='del'){ if(pl[i].name&&!confirm('Delete the pillar "'+pl[i].name+'"? Reels filed under it get sorted into the others.')) return; pl.splice(i,1); }
  if(w==='up'&&i>0) [pl[i-1],pl[i]]=[pl[i],pl[i-1]];
  if(w==='down'&&i<pl.length-1) [pl[i+1],pl[i]]=[pl[i],pl[i+1]];
  plPaint(); clearTimeout(plTimer); plSave();
});
