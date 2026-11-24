// Settings: which AI the app uses (engine.py), and Cleve. The gear at the bottom of the left bar opens it.
// The first time the app opens with no AI picked, it opens by itself.
// Also here: the Connect Cleve pop-up that Save to Cleve opens the first time (studio.js).
const setupPop=document.getElementById('setupPop'),setupBox=document.getElementById('setupBox');
const clevePop=document.getElementById('clevePop'),cleveBox=document.getElementById('cleveBox');
let AI={engine:'',claude:false,codex:false,key:false},suPick='',suBusy=false,cleveOn=false;
const AI_NAMES={claude:'Claude',claude_key:'Claude',chatgpt:'ChatGPT'};
function aiName(){ return AI_NAMES[AI.engine]||'the AI'; }
function aiPaint(){ document.getElementById('askLabel').textContent='Ask '+(AI_NAMES[AI.engine]||'AI'); }
const SU_OPTS=[
  ['claude','Your Claude account','No extra cost','Uses your Claude plan (Pro or Max) through Claude Code. What the app does counts toward your plan\'s usage, like any other chat.'],
  ['claude_key','An Anthropic API key','Pay as you go','You pay Anthropic for what you use. A breakdown or a script is about 1 to 3 cents. Handy if you already have API credits.'],
  ['chatgpt','Your ChatGPT account','No extra cost','Uses your ChatGPT plan through Codex, OpenAI\'s app for this kind of work. What the app does counts toward your plan\'s usage.'],
];
function suMore(id){
  if(id==='claude'&&!AI.claude) return '<div class="suMore"><b>Claude Code isn\'t on this computer yet.</b><ol>'
    +'<li>Go to <a href="https://claude.com/claude-code" target="_blank">claude.com/claude-code</a> and follow the install steps.</li>'
    +'<li>Open Terminal (Mac) or PowerShell (Windows), type <code>claude</code> and press Enter.</li>'
    +'<li>Sign in with your Claude account when it asks. Then close it.</li>'
    +'<li>Come back here and press Use this.</li></ol></div>';
  if(id==='claude_key') return '<div class="suMore"><ol>'
    +'<li>Go to <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a> and sign in.</li>'
    +'<li>Add a few dollars of credit (Billing). $5 lasts a long time here.</li>'
    +'<li>Open API keys, create a key and paste it below.</li></ol>'
    +'<div class="suKey"><input id="suKey" type="password" autocomplete="off" placeholder="'+(AI.key?'Key saved. Paste a new one to replace it':'sk-ant-...')+'"></div>'
    +'<div class="suFine">The chat runs through Claude Code, on this key. If Claude Code isn\'t installed, everything else still works and the chat tells you how to add it.</div></div>';
  if(id==='chatgpt'&&!AI.codex) return '<div class="suMore"><b>Codex isn\'t on this computer yet.</b><ol>'
    +'<li>Go to <a href="https://developers.openai.com/codex" target="_blank">developers.openai.com/codex</a> and install the Codex CLI. (On a Mac, the ChatGPT desktop app comes with it, so that works too.)</li>'
    +'<li>Open Terminal (Mac) or PowerShell (Windows), type <code>codex</code> and press Enter.</li>'
    +'<li>Pick Sign in with ChatGPT. Then close it.</li>'
    +'<li>Come back here and press Use this.</li></ol></div>';
  return '';
}
function suPaint(msg,ok){
  const first=!AI.engine;
  setupBox.innerHTML='<h3 id="suH">'+(first?'Welcome! First, pick your AI':'Which AI the app uses')+'</h3>'
    +'<p>The app uses AI to break posts down, read text off slides, write scripts and run the chat. Pick one. You can change it any time with the gear at the bottom of the left bar.</p>'
    +'<div class="suOpts">'+SU_OPTS.map(([id,name,tag,about])=>'<button class="suOpt'+(suPick===id?' on':'')+'" data-su="'+id+'">'
      +'<b>'+name+'<span class="suTag">'+tag+'</span>'+(AI.engine===id?'<span class="suTag">In use</span>':'')+'</b><span>'+about+'</span></button>'
      +(suPick===id?suMore(id):'')).join('')+'</div>'
    +'<div class="'+(ok?'suOk':'suErr')+'">'+esc(msg||'')+'</div>'
    +'<div class="suFoot">'+(first?'':'<button class="btn soft" data-su-close>Close</button>')+'<span class="sp"></span>'
      +'<button class="btn primary" data-su-use'+(suPick&&!suBusy?'':' disabled')+'>'+(suBusy?'Checking it works…':'Use this')+'</button></div>'
    +'<div class="suSec"><b>Cleve</b> <span class="meta">optional</span><p style="margin-top:6px">'+(cleveOn
      ?'Connected. Save to Cleve puts scripts in the Reel scripts folder in your Cleve. <button class="linkBtn" data-cl-off>Disconnect</button>'
      :'Not connected. Connect it to save scripts from the chat into your Cleve. <button class="linkBtn" data-cl-on>Connect Cleve</button>')+'</p></div>';
}
async function suLoad(){
  try{ AI=await readJSON(await fetch('/setup')); }catch(e){}
  try{ cleveOn=(await readJSON(await fetch('/cleve'))).connected; }catch(e){}
  aiPaint();
}
async function setupOpen(){ await suLoad(); suPick=AI.engine||''; suBusy=false; suPaint(); modalOpen(setupPop); }
function setupClose(){ if(!AI.engine) return; modalClose(setupPop); }
setupPop.dismiss=setupClose;
setupPop.onclick=e=>{ if(e.target===setupPop) setupClose(); };
document.getElementById('setupBtn').onclick=setupOpen;
setupBox.addEventListener('click',async e=>{
  const o=e.target.closest('[data-su]'); if(o&&!suBusy){ suPick=o.dataset.su; suPaint(); const k=document.getElementById('suKey'); if(k) k.focus(); return; }
  if(e.target.closest('[data-su-close]')) return setupClose();
  if(e.target.closest('[data-cl-on]')) return cleveConnect(()=>setupOpen());
  if(e.target.closest('[data-cl-off]')){ await fetch('/cleve/key',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"key":""}'}); cleveOn=false; return suPaint(); }
  if(!e.target.closest('[data-su-use]')||!suPick||suBusy) return;
  const k=document.getElementById('suKey'),key=k?k.value.trim():'';
  suBusy=true; suPaint();
  try{
    const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engine:suPick,key})});
    const d=await readJSON(r); suBusy=false;
    if(!r.ok){ suPaint(d.error||'That didn\'t work. Try again.'); if(key){ const k2=document.getElementById('suKey'); if(k2) k2.value=key; } return; }
    AI=d; aiPaint(); suPaint('All set. The app now uses '+aiName()+'.',true);
    setTimeout(()=>modalClose(setupPop),900); if(typeof benchPaint==='function') benchPaint();
  }catch(err){ suBusy=false; suPaint(err.message); }
});
setupBox.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.id==='suKey'){ e.preventDefault(); setupBox.querySelector('[data-su-use]').click(); } });

// Connect Cleve: once, the first time you press Save to Cleve. after: what to do once it's connected (the save).
let cleveAfter=null;
function cleveConnect(after,err){
  cleveAfter=after||null;
  cleveBox.innerHTML='<h3 id="clH">Save your scripts to Cleve</h3>'
    +'<p>Cleve is a second brain that plugs into Claude. Your scripts, notes and research sit in one place, and Claude can read them whenever you write with it.</p>'
    +'<p>Connect it once and Save to Cleve puts each script in a folder called Reel scripts in your Cleve. Nothing else in this app needs Cleve.</p>'
    +'<ol><li>Make a free account at <a href="https://cleve.ai" target="_blank">cleve.ai</a>.</li>'
    +'<li>In Cleve, open Settings, then Developer, then API keys, and create a key.</li>'
    +'<li>Paste it here.</li></ol>'
    +'<div class="suKey"><input id="clKey" type="password" autocomplete="off" placeholder="Your Cleve API key"><button class="btn primary" id="clGo">Connect</button></div>'
    +'<div class="suErr" id="clErr">'+esc(err||'')+'</div>'
    +'<div class="suFine">The key stays on this computer, in the .env file in the app\'s folder. Not using Cleve? Copy script works just as well.</div>'
    +'<div class="suFoot"><span class="sp"></span><button class="btn soft" id="clX">Not now</button></div>';
  modalOpen(clevePop); document.getElementById('clKey').focus();
}
function cleveClose(){ cleveAfter=null; modalClose(clevePop); }
clevePop.dismiss=cleveClose;
clevePop.onclick=e=>{ if(e.target===clevePop) cleveClose(); };
cleveBox.addEventListener('click',async e=>{
  if(e.target.id==='clX') return cleveClose();
  if(e.target.id!=='clGo') return;
  const key=document.getElementById('clKey').value.trim(),errEl=document.getElementById('clErr');
  if(!key){ errEl.textContent='Paste the key first.'; return; }
  e.target.disabled=true; e.target.textContent='Checking…';
  try{
    const r=await fetch('/cleve/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const d=await readJSON(r); if(!r.ok) throw new Error(d.error||'That didn\'t work.');
    cleveOn=true; const after=cleveAfter; cleveAfter=null; modalClose(clevePop); if(after) after();
  }catch(err){ errEl.textContent=err.message; e.target.disabled=false; e.target.textContent='Connect'; }
});
cleveBox.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.id==='clKey'){ e.preventDefault(); document.getElementById('clGo').click(); } });
document.addEventListener('keydown',e=>{ if(e.key!=='Escape') return;
  if(clevePop.classList.contains('on')) cleveClose(); else if(setupPop.classList.contains('on')) setupClose(); });

// On load: no AI picked yet means a first run, so the setup opens by itself
suLoad().then(()=>{ if(!AI.engine) setupOpen(); });
