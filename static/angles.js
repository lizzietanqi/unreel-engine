// Angles: your context packets, each one angle to talk about your topic or product in (angles.py). One can be the focus:
// the chat and the script writer frame what they write through it. The circle in the nav rail switches the focus from any page.
const agOut=document.getElementById('agOut'),angleBtn=document.getElementById('angleBtn'),anglePop=document.getElementById('anglePop');
const ICON_ANGLE='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6" fill="currentColor"/></svg>';
let ag={focus:null,packets:[]},agEditing='',agOpen=new Set(),agErr='';
async function agCall(method,url,body){
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const d=await readJSON(r); if(!r.ok) throw new Error(d.error||'Something went wrong'); ag=d; agPaintAll();
}
async function agLoad(){ try{ ag=await readJSON(await fetch('/angles')); }catch(e){} agPaintAll(); }
async function agShow(){ await agLoad(); }
function agPaintAll(){ agBtnPaint(); if(anglePop.classList.contains('on')) agPopPaint(); if(tool==='context') agPaint(); }
const agFocus=()=>ag.packets.find(p=>p.id===ag.focus);

// --- The page ---
function agEditor(p){
  return '<div class="ag on agEdit" data-ag="'+(p?p.id:'new')+'">'
    +'<input id="agName" maxlength="120" placeholder="Name it, like: Budgeting is a weekly habit" value="'+esc(p?p.name:'')+'">'
    +'<textarea id="agBodyIn" placeholder="The problem, who has it, what they\'re feeling, how you (or what you offer) solve it, the words to use and avoid, proof points, example hooks...">'+esc(p?p.body:'')+'</textarea>'
    +(agErr?'<div class="agErr">'+esc(agErr)+'</div>':'')
    +'<div class="agActs"><button class="btn soft sm" data-agw="cancel">Cancel</button><button class="btn primary sm" data-agw="save">'+(p?'Save':'Add angle')+'</button></div></div>';
}
function agPaint(){
  const list=ag.packets.map(p=>p.id===agEditing?agEditor(p):
    '<div class="ag'+(p.id===ag.focus?' on':'')+'" data-ag="'+p.id+'"><div class="agTop"><span class="agName">'+esc(p.name)+'</span>'
    +(p.id===ag.focus?'<span class="agPill">Focus</span>':'')+'</div>'
    +(p.body?'<div class="agBody'+(agOpen.has(p.id)?' open':'')+'" data-agw="more" title="Click to show all">'+esc(p.body)+'</div>':'<div class="agBody meta">No context yet. Edit to add some.</div>')
    +'<div class="agActs">'+(p.id===ag.focus?'<button class="icon" data-agw="unfocus">Clear focus</button>':'<button class="icon" data-agw="focus">Make it the focus</button>')
    +'<button class="icon" data-agw="edit">Edit</button><button class="icon del" data-agw="del">'+ICON_DEL+' Delete</button></div></div>').join('');
  agOut.innerHTML='<div class="agBar"><span class="meta">'+(agFocus()?'Focus: <b style="color:var(--ink)">'+esc(agFocus().name)+'</b>':'No focus. The chat picks the angle itself.')+'</span><span class="sp"></span>'
    +(agEditing==='new'?'':'<button class="btn primary sm" data-agw="new"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New angle</button>')+'</div>'
    +'<div class="agList">'+(agEditing==='new'?agEditor(null):'')+(list||(agEditing==='new'?'':'<div class="welcome"><b>No angles yet</b>An angle is one way you talk about your topic, like "Budgeting is a weekly habit, not a monthly one". Write the problem, who has it and how you solve it. Make one the focus and every script the chat or script writer makes leans that way. Press New angle to add one.</div>'))+'</div>';
  if(agEditing){ const n=document.getElementById('agName'); if(n&&!n.value) n.focus(); }
}
agOut.addEventListener('click',async e=>{
  const b=e.target.closest('[data-agw]'); if(!b) return;
  const w=b.dataset.agw,id=(b.closest('[data-ag]')||{}).dataset?.ag;
  try{
    if(w==='new'){ agEditing='new'; agErr=''; return agPaint(); }
    if(w==='cancel'){ agEditing=''; agErr=''; return agPaint(); }
    if(w==='edit'){ agEditing=id; agErr=''; return agPaint(); }
    if(w==='more'){ agOpen.has(id)?agOpen.delete(id):agOpen.add(id); return b.classList.toggle('open'); }
    if(w==='save'){ const body={name:document.getElementById('agName').value,body:document.getElementById('agBodyIn').value};
      b.disabled=true; const was=agEditing; agEditing='';
      try{ await (was==='new'?agCall('POST','/angles',body):agCall('PUT','/angles/'+was,body)); agErr=''; }
      catch(err){ agEditing=was; agErr=err.message; agPaint(); const n=document.getElementById('agName'),t=document.getElementById('agBodyIn'); n.value=body.name; t.value=body.body; }
      return; }
    if(w==='focus') return agCall('POST','/angles/focus',{id});
    if(w==='unfocus') return agCall('POST','/angles/focus',{id:null});
    if(w==='del'){ const p=ag.packets.find(x=>x.id===id); if(!confirm('Delete the angle "'+(p?p.name:'')+'"?')) return;
      return agCall('DELETE','/angles/'+id); }
  }catch(err){ alert(err.message); }
});

// --- The switcher: the circle in the nav rail and its little menu ---
function agBtnPaint(){
  const f=agFocus(); angleBtn.classList.toggle('set',!!f); angleBtn.innerHTML=ICON_ANGLE;
  angleBtn.title=f?'Focus angle: '+f.name+'. Click to switch':'No focus angle. Click to pick one';
}
function agPopPaint(){
  const item=(id,name)=>'<button class="apItem'+((ag.focus||'')===(id||'')?' on':'')+'" data-ap="'+(id||'')+'"><span class="apDot"></span><span>'+esc(name)+'</span></button>';
  anglePop.innerHTML='<div class="eyebrow">Focus angle</div>'
    +(ag.packets.length?ag.packets.map(p=>item(p.id,p.name)).join('')+item('','No focus'):'<div class="empty" style="padding:14px">No angles yet. Add one on the Context page, in the Angles tab.</div>')
    +'<div class="apFoot"><button class="apItem" data-ap-go>'+(ag.packets.length?'Manage angles':'Add an angle')+' →</button></div>';
}
function agPopPlace(){
  const r=angleBtn.getBoundingClientRect(),w=anglePop.offsetWidth,h=anglePop.offsetHeight;
  if(innerWidth<=820){ anglePop.style.left=Math.max(16,Math.min(r.right-w,innerWidth-w-16))+'px'; anglePop.style.top=(r.bottom+8)+'px'; }
  else{ anglePop.style.left=(r.right+12)+'px'; anglePop.style.top=Math.max(20,Math.min(r.bottom-h,innerHeight-h-20))+'px'; }
}
function agPopClose(){ anglePop.classList.remove('on'); }
angleBtn.onclick=async e=>{
  e.stopPropagation();
  if(anglePop.classList.contains('on')) return agPopClose();
  agPopPaint(); anglePop.classList.add('on'); agPopPlace();
  await agLoad(); agPopPlace();  // in case it changed in another tab
};
anglePop.addEventListener('click',async e=>{
  e.stopPropagation();
  if(e.target.closest('[data-ap-go]')){ agPopClose(); location.hash='#angles'; return; }
  const b=e.target.closest('[data-ap]'); if(!b) return;
  try{ await agCall('POST','/angles/focus',{id:b.dataset.ap||null}); setTimeout(agPopClose,180); }catch(err){ alert(err.message); }
});
document.addEventListener('click',e=>{ if(anglePop.classList.contains('on')&&!anglePop.contains(e.target)) agPopClose(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') agPopClose(); });
addEventListener('resize',()=>{ if(anglePop.classList.contains('on')) agPopPlace(); });
agLoad();
