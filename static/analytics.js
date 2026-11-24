// Analytics: your own Instagram numbers, pulled from Instagram's official API twice a day (analytics.py).
// One time range drives the whole page: the headline numbers (against the period before), the chart over time,
// the top posts with quick sort buttons, what's working by topic/format/hook, and every post in a table.
// The chat can read the same numbers to feed back on your content.
const anOut=document.getElementById('anOut');
let anData=null,anOpen='',anTimer=0,anBusy=false;
let anKind=lsGet('an:kind','reel'),anGroup=lsGet('an:group','topic'),anSort=lsGet('an:sort',{k:'posted',d:-1});
let anRange=lsGet('an:range','30'),anMetric=lsGet('an:metric','views'),anStep=lsGet('an:step',''),anTop=lsGet('an:top','views');
let anTopN=10,anTable=false,anGroupOpen='',anAnim='';  // anGroupOpen: the What's working row showing its posts; anAnim: what just opened, so only it animates
async function anShow(){
  clearTimeout(anTimer);
  try{ const r=await fetch('/analytics'); anData=await readJSON(r); if(!r.ok) throw new Error(anData.error||'Something went wrong'); }
  catch(e){ anOut.innerHTML='<div class="empty">Couldn\'t load your analytics. '+esc(e.message)+'</div>'; return; }
  anPaint();
  anWait();
}
// While the numbers are still coming in, check back. While only words are, just update the little progress note,
// so the page doesn't jump under her.
function anWait(){
  if(!anData.connected) return;
  if(anData.syncing||!anData.updated) return anTimer=setTimeout(()=>{ if(tool==='analytics') anShow(); },6000);
  if(!anData.words) anTimer=setTimeout(anRecheck,300000);
  if(anData.words) anTimer=setTimeout(async()=>{ if(tool!=='analytics') return;
    try{ const d=await (await fetch('/analytics')).json(); const w=anOut.querySelector('.anWords');
      if(!d.words&&w) w.remove(); else if(w) w.textContent=d.words;
      anData.words=d.words; anData.posts.forEach(p=>{ const n=d.posts.find(x=>x.id===p.id); if(n) p.words=n.words; }); }catch(e){}
    anWait(); },20000);
}
// Every 5 minutes while the tab is open: if a background update landed, show it, unless a post is open
async function anRecheck(){
  if(tool!=='analytics') return;
  try{ const d=await (await fetch('/analytics')).json();
    if(d.updated!==anData.updated||d.error!==anData.error){ if(!anOpen){ anData=d; anPaint(); } } }catch(e){}
  anTimer=setTimeout(anRecheck,300000);
}
const AN_DAY=86400000;
function anDate(iso){ return new Date(iso).toLocaleDateString(undefined,{day:'numeric',month:'short'}); }
function anDateY(t){ return new Date(t).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }
function anAgo(iso){ const m=Math.round((Date.now()-new Date(iso))/60000);
  return m<2?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' days ago'; }
// The reel's opening line: what you say first, else the caption's first line
function anHook(p){ const w=(p.words||'').split(/(?<=[.!?])\s+|\n/)[0],c=(p.caption||'').split('\n')[0];
  return (w||c||'(no caption)').trim(); }
const anMedian=a=>{ const s=a.filter(v=>v!=null).sort((x,y)=>x-y); if(!s.length) return null; const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const anSum=a=>a.reduce((t,v)=>t+(v||0),0);
const an1=v=>Math.round(v*10)/10;  // at most one decimal

// --- The time range ---
const AN_RANGES=[['7','7 days'],['30','30 days'],['60','60 days'],['90','90 days'],['month','This month'],['lastmonth','Last month'],['all','All time']];
// The range as times, and the period before it of the same length (what the ▲▼ compare against)
function anSpan(){
  const now=Date.now(),d=new Date(),m0=new Date(d.getFullYear(),d.getMonth(),1).getTime();
  if(anRange==='month'){ const pm=new Date(d.getFullYear(),d.getMonth()-1,1).getTime();
    return {a:m0,b:now,pa:pm,pb:pm+(now-m0),prev:'the same days last month'}; }
  if(anRange==='lastmonth'){ const pm=new Date(d.getFullYear(),d.getMonth()-1,1).getTime(),pp=new Date(d.getFullYear(),d.getMonth()-2,1).getTime();
    return {a:pm,b:m0,pa:pp,pb:pm,prev:'the month before'}; }
  if(anRange==='all') return {a:0,b:now,pa:null,pb:null,prev:''};
  const k=+anRange*AN_DAY; return {a:now-k,b:now,pa:now-2*k,pb:now-k,prev:'the '+anRange+' days before'};
}
const anIn=(p,a,b)=>{ const t=new Date(p.posted).getTime(); return t>=a&&t<b; };
function anPool(){ return anData.posts.filter(p=>(anKind==='all'||p.kind==='reel')&&p.stats&&p.stats.views!=null); }
function anRangeLabel(){ return (AN_RANGES.find(r=>r[0]===anRange)||AN_RANGES[1])[1].replace(/^(\d+) days$/,'the last $1 days').replace(/^This month$/,'this month').replace(/^Last month$/,'last month').replace(/^All time$/,'all time'); }

// --- Headline numbers ---
function anDelta(cur,prev,lowerBetter){
  if(prev==null||cur==null) return '';
  if(!prev) return cur>0?'<span class="anDelta good">new</span>':'';
  const pc=Math.round((cur-prev)/Math.abs(prev)*100); if(!pc) return '<span class="anDelta flat">same</span>';
  const good=lowerBetter?pc<0:pc>0;
  return '<span class="anDelta '+(good?'good':'bad')+'">'+(pc>0?'▲ ':'▼ ')+Math.abs(pc)+'%</span>';
}
function anKpi(label,value,delta,sub,tip,big){
  return '<div class="anTile'+(big?' big':'')+'" title="'+esc(tip||'')+'"><span class="anTL">'+esc(label)+'</span><b class="anTV">'+value+'</b>'
    +'<span class="anTS">'+delta+(sub?'<span>'+esc(sub)+'</span>':'')+'</span></div>';
}
// Followers gained between two times, from the daily counts (only kept since the app started counting)
function anFollowers(a,b){
  const f=(anData.followers||[]).map(x=>({t:new Date(x.date+'T23:59:59').getTime(),n:x.n})); if(f.length<2) return null;
  const before=f.filter(x=>x.t<a),upto=f.filter(x=>x.t<b); if(!upto.length) return null;
  const start=before.length?before[before.length-1]:f[0];
  return {n:upto[upto.length-1].n-start.n,partial:!before.length,since:f[0].t};
}
function anKpis(){
  const s=anSpan(),pool=anPool(),cur=pool.filter(p=>anIn(p,s.a,s.b)),prev=s.pa==null?null:pool.filter(p=>anIn(p,s.pa,s.pb));
  const tot=(list,k)=>list&&anSum(list.map(p=>p.stats[k]));
  const med=(list,f)=>list&&list.length?anMedian(list.map(f)):null;
  const vs=s.prev?'vs '+s.prev:'';
  const fl=anFollowers(s.a,s.b),flp=s.pa==null?null:anFollowers(s.pa,s.pb);
  const big=[
    anKpi('Views',fmtNum(tot(cur,'views')),anDelta(tot(cur,'views'),prev&&tot(prev,'views')),vs,'Plays of the posts you posted in this range',1),
    anKpi('Shares',fmtNum(tot(cur,'shares')),anDelta(tot(cur,'shares'),prev&&tot(prev,'shares')),vs,'People sending your posts on. The strongest signal for reach',1),
    anKpi('Saves',fmtNum(tot(cur,'saves')),anDelta(tot(cur,'saves'),prev&&tot(prev,'saves')),vs,'People keeping your posts to come back to',1),
    anKpi('Comments',fmtNum(tot(cur,'comments')),anDelta(tot(cur,'comments'),prev&&tot(prev,'comments')),vs,'',1),
    anKpi('Followers',fl?(fl.n>=0?'+':'')+fmtNum(fl.n):'–',fl&&!fl.partial&&flp&&!flp.partial?anDelta(fl.n,flp.n):'',
      fl&&fl.partial?'counted since '+anDate(new Date(fl.since).toISOString()):fl?vs:'counted once a day while the app runs',
      'Followers gained in this range. The app counts them once a day, so this only goes back to '+((anData.followers||[])[0]||{}).date,1)];
  const typ=med(cur,p=>p.stats.views),pct=med(cur,p=>p.pct),skip=med(cur,p=>p.stats.skip_rate),keep=med(cur,p=>p.keep);
  const small=[
    anKpi('Posts',cur.length,prev?anDelta(cur.length,prev.length):'',s.prev?(prev?prev.length+' before':''):'','How many you posted in this range'),
    anKpi('Typical views',typ==null?'–':fmtNum(Math.round(typ)),anDelta(typ,med(prev,p=>p.stats.views)),'per '+(anKind==='reel'?'reel':'post'),'The middle post: half did better, half did worse. Fairer than an average, which one viral post can skew'),
    anKpi('Watched',pct==null?'–':Math.round(pct)+'%',anDelta(pct,med(prev,p=>p.pct)),'of the reel, typical','How much of a reel people watch'),
    anKpi('Swiped away',skip==null?'–':Math.round(skip)+'%',anDelta(skip,med(prev,p=>p.stats.skip_rate),true),'lower is better','People gone in the first seconds. Your hook\'s job is to bring this down'),
    anKpi('Saves + shares',keep==null?'–':an1(keep),anDelta(keep,med(prev,p=>p.keep)),'per 1,000 views','How worth keeping people find your posts')];
  return '<div class="anTiles big">'+big.join('')+'</div><div class="anTiles small">'+small.join('')+'</div>';
}

// --- Over time: one bar per day, week or month, summing the posts posted in it ---
const AN_METRICS={views:'Views',shares:'Shares',saves:'Saves',comments:'Comments',likes:'Likes',posts:'Posts'};
const AN_STEPS={day:'Daily',week:'Weekly',month:'Monthly'};
function anStepFor(){ return anStep&&AN_STEPS[anStep]?anStep:{'7':'day','30':'day','60':'week','90':'week',month:'day',lastmonth:'day',all:'month'}[anRange]; }
function anFloor(t,step){ const d=new Date(t);
  if(step==='month') return new Date(d.getFullYear(),d.getMonth(),1).getTime();
  const day=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  if(step==='week') day.setDate(day.getDate()-((day.getDay()+6)%7));  // weeks start on Monday
  return day.getTime(); }
function anNext(t,step){ const d=new Date(t);
  if(step==='month') return new Date(d.getFullYear(),d.getMonth()+1,1).getTime();
  d.setDate(d.getDate()+(step==='week'?7:1)); return d.getTime(); }
function anBuckets(){
  const s=anSpan(),pool=anPool().filter(p=>anIn(p,s.a,s.b));
  let step=anStepFor(),a=s.a;
  if(anRange==='all'){ a=pool.length?Math.min(...pool.map(p=>new Date(p.posted).getTime())):s.b;
    a=Math.max(a,new Date(new Date().getFullYear()-3,new Date().getMonth(),1).getTime()); }  // all time: at most the last 3 years on the chart
  const count=st=>Math.ceil((s.b-a)/({day:1,week:7,month:30}[st]*AN_DAY));
  if(count(step)>120) step=count('week')>120?'month':'week';
  const out=[]; for(let t=anFloor(a,step);t<s.b;t=anNext(t,step)){ const e=anNext(t,step); out.push({a:t,b:e,posts:pool.filter(p=>anIn(p,t,e))}); }
  return {step,out,cut:anRange==='all'&&pool.some(p=>new Date(p.posted).getTime()<a)};
}
function anBucketLabel(t,step){ const d=new Date(t);
  return step==='month'?d.toLocaleDateString(undefined,{month:'short',year:'numeric'}):(step==='week'?'Week of ':'')+d.toLocaleDateString(undefined,{day:'numeric',month:'short'}); }
const anVal=(list,m)=>m==='posts'?list.length:anSum(list.map(p=>p.stats[m]));
function anChartCard(){
  const step=anStepFor();
  return '<div class="card anChart"><div class="anCHead"><b>Over time</b><span class="meta" id="anChartNote"></span><span class="sp"></span>'
    +'<div class="seg sm" id="anMetric">'+Object.entries(AN_METRICS).map(([k,l])=>'<button data-m="'+k+'"'+(anMetric===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div>'
    +'<div class="seg sm" id="anStep">'+Object.entries(AN_STEPS).map(([k,l])=>'<button data-s="'+k+'"'+(step===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div></div>'
    +'<div class="anPlot" id="anPlot"></div><div class="anTip" id="anTip"></div></div>';
}
function anChart(){
  const el=document.getElementById('anPlot'); if(!el) return;
  const {step,out,cut}=anBuckets(),m=anMetric;
  document.getElementById('anChartNote').textContent=AN_METRICS[m]+(m==='posts'?'':' of the posts made')+' each '+{day:'day',week:'week',month:'month'}[step]+(cut?' · last 3 years':'');
  document.querySelectorAll('#anStep button').forEach(b=>b.classList.toggle('on',b.dataset.s===step));
  if(!out.some(b=>b.posts.length)){ el.innerHTML='<div class="empty">Nothing posted in '+esc(anRangeLabel())+'.</div>'; return; }
  const W=el.clientWidth||700,H=230,L=44,B=24,T=10,vals=out.map(b=>anVal(b.posts,m)),max=Math.max(1,...vals)*1.08;
  const step_=(W-L)/out.length,bw=Math.max(2,Math.min(34,step_*0.72)),y=v=>T+(H-T-B)*(1-v/max);
  const nice=[1,2,2.5,5,10],mag=10**Math.floor(Math.log10(Math.max(1,max/4))),tick=Math.max(1,mag*(nice.find(n=>n*mag*4>=max/1.2)||10));
  let s='<svg width="'+W+'" height="'+H+'" role="img" aria-label="'+AN_METRICS[m]+' over time">';
  for(let v=0;v<=max;v+=tick) s+='<line x1="'+L+'" x2="'+W+'" y1="'+y(v)+'" y2="'+y(v)+'" class="anGrid"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" class="anAx" text-anchor="end">'+fmtNum(v)+'</text>';
  out.forEach((b,i)=>{ const v=vals[i]; if(!v) return; const x=L+i*step_+(step_-bw)/2,top=y(v),h=Math.max(2,H-B-top),r=Math.min(4,bw/2,h);
    s+='<g class="anBarG" data-i="'+i+'"><rect x="'+(L+i*step_)+'" y="'+T+'" width="'+step_+'" height="'+(H-T-B)+'" fill="transparent"/>'
      +'<path class="anB up" d="M'+x+','+(H-B)+'V'+(top+r)+'q0,-'+r+' '+r+',-'+r+'h'+(bw-2*r)+'q'+r+',0 '+r+','+r+'V'+(H-B)+'z"/></g>'; });
  const ticks=out.length<3?[...out.keys()]:[0,out.length>>1,out.length-1];
  ticks.forEach((i,k)=>s+='<text x="'+(L+i*step_+step_/2)+'" y="'+(H-6)+'" class="anAx" text-anchor="'+(k===0?'start':k===ticks.length-1?'end':'middle')+'">'+esc(anBucketLabel(out[i].a,step))+'</text>');
  el.innerHTML=s+'</svg>';
  const tip=document.getElementById('anTip');
  el.querySelectorAll('.anBarG').forEach(g=>{
    g.onmouseenter=()=>{ const b=out[+g.dataset.i],best=b.posts.slice().sort((x,z)=>(z.stats.views||0)-(x.stats.views||0))[0];
      const bx=g.querySelector('.anB').getBoundingClientRect(),cx=el.parentNode.getBoundingClientRect(); g.classList.add('hot');
      tip.innerHTML='<b>'+fmtNum(vals[+g.dataset.i])+' '+AN_METRICS[m].toLowerCase()+'</b> <span class="meta">'+esc(anBucketLabel(b.a,step))+'</span>'
        +'<div class="meta">'+b.posts.length+(b.posts.length===1?' post':' posts')+'</div>'+(best?'<div>Best: '+esc(anHook(best))+'</div>':'');
      tip.style.display='block'; tip.style.left=Math.max(8,Math.min(cx.width-tip.offsetWidth-8,bx.left-cx.left+bx.width/2-tip.offsetWidth/2))+'px'; tip.style.top=Math.max(8,bx.top-cx.top-tip.offsetHeight-8)+'px'; };
    g.onmouseleave=()=>{ g.classList.remove('hot'); tip.style.display='none'; };
  });
}

// --- Top posts, with quick buttons for what "top" means ---
// [key, button, value, how to show it, what it means, lowest first?, only posts with at least this many views]
const AN_TOPS=[
  ['views','Views',p=>p.stats.views,v=>fmtNum(v)+' views','Most played'],
  ['shares','Shares',p=>p.stats.shares,v=>fmtNum(v)+' shares','Most sent on'],
  ['saves','Saves',p=>p.stats.saves,v=>fmtNum(v)+' saves','Most saved'],
  ['comments','Comments',p=>p.stats.comments,v=>fmtNum(v)+' comments','Most talked about'],
  ['likes','Likes',p=>p.stats.likes,v=>fmtNum(v)+' likes','Most liked'],
  ['pct','Most watched',p=>p.pct,v=>v+'% watched','Highest share of the reel watched'],
  ['vs','Beat typical',p=>p.growing?null:p.vs,v=>v.toFixed(v<10?1:0)+'× typical','Most views against your typical reel at the time'],
  ['skip','Best hooks',p=>p.stats.views>=300?p.stats.skip_rate:null,v=>Math.round(v)+'% swiped','Fewest people swiping away in the first seconds (posts with 300+ views)',true],
];
function anTopCard(){
  const s=anSpan(),t=AN_TOPS.find(x=>x[0]===anTop)||AN_TOPS[0],[,,val,show,,low]=t;
  const list=anPool().filter(p=>anIn(p,s.a,s.b)&&val(p)!=null).sort((x,y)=>low?val(x)-val(y):val(y)-val(x));
  const rows=list.slice(0,anTopN).map((p,i)=>{ const st=p.stats;
    return '<div class="anTopRow" data-post="'+p.id+'"><span class="anRank">'+(i+1)+'</span>'
      +(p.thumb?'<img src="'+p.thumb+'" loading="lazy">':'<span class="anNo"></span>')
      +'<div class="anTopMain"><div class="anHook">'+esc(anHook(p))+'</div>'
      +'<div class="meta">'+anDate(p.posted)+(p.kind!=='reel'?' · '+esc(p.kind):'')+(p.growing?' · <span class="anGrow">still growing</span>':'')+(p.tags?' · '+esc(p.tags.topic):'')+'</div>'
      +'<div class="anMini">'+[['views',st.views],['shares',st.shares],['saves',st.saves],['comments',st.comments]].filter(([k])=>k!==anTop).map(([k,v])=>'<span>'+fmtNum(v||0)+' '+k+'</span>').join('')+'</div></div>'
      +'<span class="anBig">'+show(val(p))+'</span></div>'; }).join('');
  return '<div class="card anTop"><div class="anCHead"><b>Top posts</b><span class="meta">'+esc(t[4])+', '+esc(anRangeLabel())+'</span></div>'
    +'<div class="anChips" id="anTopBy">'+AN_TOPS.map(([k,l,,,tip])=>'<button data-t="'+k+'" title="'+esc(tip)+'"'+(anTop===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div>'
    +(rows||'<div class="empty">Nothing posted in '+esc(anRangeLabel())+'.</div>')
    +(list.length>anTopN?'<button class="btn soft sm anMore" data-more>Show '+Math.min(10,list.length-anTopN)+' more</button>':'')+'</div>';
}

// --- What's working: posts in the range grouped by what the app labelled them, best first ---
const AN_GROUPS={topic:'Topic',format:'Format',hook:'Hook type'};
function anPatterns(){
  const s=anSpan(),list=anPool().filter(p=>anIn(p,s.a,s.b)&&p.tags);
  if(!list.length) return '<div class="card anPat"><div class="anCHead"><b>What\'s working</b><span class="meta">'
    +(anData.words?'Coming once your reels are transcribed and labelled.':'Your reels get labelled by topic, format and hook type, then grouped here.')+'</span></div></div>';
  const g={}; list.forEach(p=>{ const k=p.tags[anGroup]||'Other'; (g[k]=g[k]||[]).push(p); });
  const rows=Object.entries(g).map(([name,ps])=>({name,ps,n:ps.length,views:anMedian(ps.map(p=>p.stats.views)),vs:anMedian(ps.filter(p=>!p.growing).map(p=>p.vs)),
    shares:anSum(ps.map(p=>p.stats.shares))/ps.length,pct:anMedian(ps.map(p=>p.pct)),keep:anMedian(ps.map(p=>p.keep))}))
    .sort((a,b)=>(b.n>=3)-(a.n>=3)||(b.vs??-1)-(a.vs??-1));
  const num=(v,f)=>v==null?'<span class="meta">–</span>':f(v);
  return '<div class="card anPat"><div class="anCHead"><b>What\'s working</b><span class="meta">Grouped, best first. Click one to see its posts. Under 3 is a hunch, not a pattern</span><span class="sp"></span>'
    +'<div class="seg sm" id="anGroup">'+Object.entries(AN_GROUPS).map(([k,l])=>'<button data-g="'+k+'"'+(anGroup===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div></div>'
    +'<div class="anTWrap"><table class="anT anPT"><thead><tr><th class="anPost">'+AN_GROUPS[anGroup]+'</th><th>Posts</th><th title="The middle post in this group">Typical views</th><th title="The middle post in this group, against your typical reel">vs typical</th><th>Shares / post</th><th>% watched</th><th>Saves + shares</th></tr></thead><tbody>'
    +rows.map(r=>{ const open=anGroupOpen===r.name;
      return '<tr class="anGRow'+(r.n<3?' hunch':'')+(open?' open':'')+'" data-group="'+esc(r.name)+'"><td class="anPost"><span class="anCaret">'+(open?'▾':'▸')+'</span><b>'+esc(r.name)+'</b>'+(r.n<3?' <span class="meta">hunch</span>':'')+'</td><td>'+r.n+'</td>'
      +'<td>'+num(r.views,v=>fmtNum(Math.round(v)))+'</td><td>'+anVs({vs:r.vs})+'</td><td>'+num(r.shares,v=>v<10?an1(v):Math.round(v))+'</td>'
      +'<td>'+num(r.pct,v=>Math.round(v)+'%')+'</td><td>'+num(r.keep,an1)+'</td></tr>'
      +(open?'<tr class="anGPosts"><td colspan="7"><div class="'+(anAnim==='group'?'reveal':'')+'"><div class="anGIn">'+r.ps.slice().sort((a,b)=>(b.stats.views||0)-(a.stats.views||0)).map(anGPost).join('')+'</div></div></td></tr>':''); }).join('')
    +'</tbody></table></div></div>';
}

// One post inside an opened group: click it for the post pop-up
function anGPost(p){
  const sub=p.tags&&p.tags.subtopic&&p.tags.subtopic!==p.tags.topic&&anGroup==='topic'?p.tags.subtopic:'';
  return '<div class="anGPost" data-post="'+p.id+'">'+(p.thumb?'<img src="'+p.thumb+'" loading="lazy">':'<span class="anNo"></span>')
    +'<div class="anTopMain"><div class="anHook">'+esc(anHook(p))+'</div><div class="meta">'+anDate(p.posted)+(sub?' · '+esc(sub):'')+'</div></div>'
    +'<span class="anGNum">'+fmtNum(p.stats.views||0)+' views</span>'+anVs(p)+'</div>';
}
// --- Every post in the range, sortable; folded away until asked for ---
const AN_COLS=[  // key, heading, value, how to show it, what it means
  ['posted','Posted',p=>p.posted,null,''],
  ['views','Views',p=>p.stats.views,v=>fmtNum(v),'How many times it was played'],
  ['vs','vs typical',p=>p.vs,null,'Views against your typical reel (the middle of your last 20). 2× = twice as many'],
  ['shares','Shares',p=>p.stats.shares,v=>fmtNum(v),''],
  ['saves','Saves',p=>p.stats.saves,v=>fmtNum(v),''],
  ['comments','Comments',p=>p.stats.comments,v=>fmtNum(v),''],
  ['likes','Likes',p=>p.stats.likes,v=>fmtNum(v),''],
  ['pct','% watched',p=>p.pct,v=>v+'%','Average watch time out of the reel\'s length'],
  ['skip_rate','Swiped away',p=>p.stats.skip_rate,v=>Math.round(v)+'%','People who swiped away in the first seconds. Lower is better'],
];
function anVs(p){
  if(p.vs==null) return '<span class="meta">–</span>';
  const up=p.vs>=1,x=p.vs.toFixed(p.vs<10?1:0)+'×';
  if(p.growing) return '<span class="anVs grow" title="Under 3 days old, so too early to judge. '+x+' so far">new</span>';
  return '<span class="anVs '+(up?'up':'down')+'">'+(up?'▲ ':'▼ ')+x+'</span>';
}
function anTableCard(){
  const s=anSpan(),rows=anPool().filter(p=>anIn(p,s.a,s.b)).sort((x,y)=>{ const c=AN_COLS.find(c=>c[0]===anSort.k)||AN_COLS[0],a=c[2](x),b=c[2](y);
    return (a==null)-(b==null)||(a<b?-1:a>b?1:0)*anSort.d; });
  let h='<div class="anTHead"><h3>Every '+(anKind==='reel'?'reel':'post')+'<span class="meta">'+rows.length+'</span></h3><span class="sp"></span>'
    +'<button class="btn soft sm" data-table>'+(anTable?'Hide':'Show all')+'</button></div>';
  if(!anTable) return h;
  return h+'<div class="anTableBox'+(anAnim==='table'?' reveal':'')+'"><div><div class="card anTWrap"><table class="anT"><thead><tr><th class="anPost">'+(anKind==='reel'?'Reel':'Post')+'</th>'
    +AN_COLS.map(([k,l,,,tip])=>'<th data-sort="'+k+'"'+(tip?' title="'+esc(tip)+'"':'')+(anSort.k===k?' class="on"':'')+'>'+esc(l)+(anSort.k===k?(anSort.d<0?' ↓':' ↑'):'')+'</th>').join('')
    +'</tr></thead><tbody>'
    +rows.map(p=>'<tr class="anRow" data-post="'+p.id+'"><td class="anPost"><div class="anP">'
      +(p.thumb?'<img src="'+p.thumb+'" loading="lazy">':'<span class="anNo"></span>')
      +'<div><div class="anHook">'+esc(anHook(p))+'</div><div class="meta">'+(p.kind!=='reel'?esc(p.kind)+' · ':'')+anAgo(p.posted).replace(' ago','')+' ago'+(p.growing?' · <span class="anGrow">still growing</span>':'')+'</div>'
      +(p.tags?'<div class="anTags"><span>'+esc(p.tags.topic)+'</span><span>'+esc(p.tags.hook)+'</span></div>':'')+'</div></div></td>'
      +AN_COLS.map(([k,,val,show])=>{ const v=val(p);
        return '<td>'+(k==='posted'?anDate(p.posted):k==='vs'?anVs(p):v==null?'<span class="meta">–</span>':show(v))+'</td>'; }).join('')+'</tr>').join('')
    +'</tbody></table></div></div></div>';
}
// --- Content direction: always the last 14 days, whatever range the page shows. Top: a link to her full Context, and how many
// reels she posted, one square per reel (green on point for her ideal viewer, coral off, grey no words saved). Then a chart per tab:
// how many reels sit at each funnel or awareness stage, against the mix she aims for (the dashed line, from context.md, turned into reels).
// Click a bar to open that stage under the chart: its reels, then reel ideas for it on demand (/analytics/direction/ideas), each a sideways row.
// Labels (p.aim) and her targets (anData.mix) come from analytics.py.
let anDirView=lsGet('an:dirView','funnel');
let anStagePick=lsGet('an:stage',{}),anSIdeas=lsGet('an:sideas',{}),anSBusy={},anSErr={};  // ideas kept per "view:stage", newest first
const AN_DIR_VIEWS={
  funnel:['Funnel',p=>p.aim.funnel,['Top','Middle','Bottom']],
  awareness:['Awareness',p=>p.aim.awareness,['Unaware','Problem aware','Solution aware','Product aware','Most aware']],
  topic:['Pillars',p=>(p.tags&&p.tags.topic)||'Other',null]};
const anFitK=p=>p.aim.fit==='Unclear'?'unk':p.aim.fit==='On point'||p.aim.fit==='On target'?'on':'off';
function anDirReels(){ const n=Date.now(),a=n-(anData.direction_days||14)*AN_DAY;
  return {cur:anData.posts.filter(p=>p.kind==='reel'&&p.aim&&anIn(p,a,n)).sort((x,y)=>new Date(x.posted)-new Date(y.posted))}; }
function anDirection(){
  const days=anData.direction_days||14,{cur}=anDirReels(),any=anData.posts.some(p=>p.aim);
  const head='<div class="anCHead"><b>Content direction</b><span class="meta">Your last '+days+' days of reels</span></div>';
  if(!cur.length) return '<div class="card anDir">'+head+'<div class="empty">'+(any?'No reels in the last '+days+' days.'
    :'Your reels are being checked against your ideal viewer. This fills in by itself in a few minutes.')+'</div></div>';
  const unk=cur.some(p=>anFitK(p)==='unk');
  const top='<div class="anDirTop"><a class="anCxLink" href="#context">View your full context<span aria-hidden="true">→</span></a>'
    +'<div class="anDirCount"><div class="anDirNum"><b>'+cur.length+'</b><span>'+(cur.length===1?'reel':'reels')+' posted in the last '+days+' days</span></div>'
    +'<div class="anStrip">'+cur.map(p=>'<span class="d-'+anFitK(p)+'" data-post="'+p.id+'" title="'+esc(anDate(p.posted)+' · '+(anFitK(p)==='on'?'On point':anFitK(p)==='off'?'Off point':'Unclear')+' · for '+p.aim.audience+'\n'+anHook(p)+'\n'+p.aim.why)+'"></span>').join('')+'</div>'
    +'<div class="anStripAx meta"><span><i class="d-on"></i>on point <i class="d-off"></i>off'+(unk?' <i class="d-unk"></i>no words saved':'')+'</span></div></div></div>';
  const mix=anData.mix,hasT=anDirView!=='topic'&&mix&&mix[anDirView]&&Object.values(mix[anDirView]).some(v=>v!=null);
  const tabs='<div class="anDirTabs"><div class="seg sm" id="anDirView">'+Object.entries(AN_DIR_VIEWS).map(([k,[l]])=>'<button data-v="'+k+'"'+(anDirView===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div><span class="sp"></span>'
    +(anDirView==='topic'?'<a class="icon" href="#pillars">Edit pillars</a>':'<a class="icon" href="#context" data-cx-go="Content mix">Edit targets</a>')+'</div>';
  let body;
  if(anDirView==='topic'){  // her pillars in her order, even the ones with no reels (that's a gap too): green for on point, coral for off
    const g={}; cur.forEach(p=>{ const k=AN_DIR_VIEWS.topic[1](p); (g[k]=g[k]||[]).push(p); });
    const names=(anData.pillars||[]).concat(Object.keys(g).filter(k=>!(anData.pillars||[]).includes(k)));
    const rows=names.map(k=>[k,g[k]||[]]),most=Math.max(1,...rows.map(r=>r[1].length));
    body='<div class="anDirBars">'+rows.map(([k,ps])=>{ const n=t=>ps.filter(p=>anFitK(p)===t).length;
      return '<div class="anDirRow'+(ps.length?'':' none')+'"><div class="anDirName"><b>'+esc(k)+'</b>'+(ps.length?'':'<span>Nothing in '+days+' days</span>')+'</div><div class="anDirBar"><div style="width:'+(100*ps.length/most)+'%">'
        +['on','off','unk'].map(t=>n(t)?'<span class="d-'+t+'" style="flex:'+n(t)+'"></span>':'').join('')+'</div></div><span class="anDirN">'+ps.length+'</span></div>'; }).join('')+'</div>';
  } else {
    body='<div class="anMix" id="anMix"></div><div class="anTip" id="anMixTip"></div>'
      +'<div class="anMixLeg"><span><i class="bar"></i>Reels you posted</span>'+(hasT?'<span><i class="line"></i>What you aim for, from your target mix</span><span><b class="anGapUp">+</b> / <b class="anGapDn">−</b> reels over or short</span>'
        :'<span class="meta">No targets yet. <a href="#context" data-cx-go="Content mix">Add them in Context</a></span>')+'</div>';
  }
  return '<div class="card anDir">'+head+top+tabs+body+(anDirView!=='topic'?anStagePanel():'')+'</div>';
}
// One row per stage for the chart and the panel under it: its reels (ps), their share (a, %), her target share (t, %) and that target in reels (tn)
function anStageRows(){
  const [,key,stages]=AN_DIR_VIEWS[anDirView],{cur}=anDirReels(),tg=(anData.mix||{})[anDirView]||{},N=cur.length;
  return stages.map(k=>{ const ps=cur.filter(p=>key(p)===k),t=tg[k];
    return {k,ps,N,a:N?Math.round(100*ps.length/N):0,t,tn:t==null?null:Math.round(t*N/100)}; });
}
// The stage open under the chart: the one she picked, or at first the one furthest under its target
function anStageNow(rows){ const k=anStagePick[anDirView]; if(rows.some(r=>r.k===k)) return k;
  const short=rows.filter(r=>r.t!=null).sort((x,y)=>(y.t-y.a)-(x.t-x.a))[0];
  return (short&&short.t>short.a?short:rows[0]).k; }
const anStageName=k=>anDirView==='funnel'?k+' of funnel':k;
// The chart: one column per stage. Bar = how many reels she posted there; the dashed line = how many her target mix asks for; the gap on top.
// Hovering shows the numbers beside the bar (never over it); clicking opens that stage under the chart.
function anDirChart(){
  const el=document.getElementById('anMix'); if(!el) return;
  const rows=anStageRows(),sel=anStageNow(rows),N=rows.length?rows[0].N:0,tr=r=>r.t==null?null:r.t*N/100;
  const W=el.clientWidth||640,H=250,L=40,R=8,T=28,B=46,n=rows.length,cw=(W-L-R)/n,bw=Math.min(72,cw*0.46);
  const top=Math.max(3,...rows.map(r=>Math.max(r.ps.length,tr(r)||0)))*1.12,step=top<=7?1:top<=14?2:top<=35?5:10,max=Math.ceil(top/step)*step;
  const y=v=>T+(H-T-B)*(1-v/max),cx=i=>L+cw*i+cw/2;
  let s='<svg width="'+W+'" height="'+H+'" role="img" aria-label="Your reels at each stage against your target mix">';
  for(let v=0;v<=max;v+=step) s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" class="anGrid"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" class="anAx" text-anchor="end">'+v+'</text>';
  rows.forEach((r,i)=>{ const c=r.ps.length,x=cx(i)-bw/2,tp=y(c),h=H-B-tp,rr=Math.min(6,bw/2,h);
    s+='<g class="anMixCol'+(r.k===sel?' on':'')+'" data-i="'+i+'"><rect x="'+(L+cw*i)+'" y="'+T+'" width="'+cw+'" height="'+(H-T-B)+'" fill="transparent"/>'
      +(c?'<path class="anMixBar" d="M'+x+','+(H-B)+'V'+(tp+rr)+'q0,-'+rr+' '+rr+',-'+rr+'h'+(bw-2*rr)+'q'+rr+',0 '+rr+','+rr+'V'+(H-B)+'z"/>':'')
      +'<text x="'+cx(i)+'" y="'+(H-B+17)+'" class="anMixX" text-anchor="middle">'+esc(r.k)+'</text>'
      +'<text x="'+cx(i)+'" y="'+(H-B+33)+'" class="anAx" text-anchor="middle">'+c+(c===1?' reel':' reels')+'</text></g>'; });
  const pts=rows.map((r,i)=>r.t==null?null:[cx(i),y(tr(r))]).filter(Boolean);
  if(pts.length>1) s+='<polyline class="anMixLine" points="'+pts.map(p=>p.join(',')).join(' ')+'"/>';
  rows.forEach((r,i)=>{ if(r.t==null) return; s+='<circle class="anMixDot" cx="'+cx(i)+'" cy="'+y(tr(r))+'" r="4.5"/>';
    const g=r.ps.length-r.tn; if(g&&Math.abs(r.a-r.t)>=10) s+='<text x="'+cx(i)+'" y="'+(Math.min(y(r.ps.length),y(tr(r)))-10)+'" text-anchor="middle" class="anMixGap '+(g>0?'up':'dn')+'">'+(g>0?'+':'−')+Math.abs(g)+'</text>'; });
  el.innerHTML=s+'</svg>';
  const tip=document.getElementById('anMixTip');
  el.querySelectorAll('.anMixCol').forEach(g=>{
    g.onmouseenter=()=>{ const r=rows[+g.dataset.i],c=el.parentNode.getBoundingClientRect(),b=g.getBoundingClientRect(),gx=14;
      const gp=r.tn==null?0:r.ps.length-r.tn;
      tip.innerHTML='<b>'+esc(anStageName(r.k))+'</b><div>'+r.ps.length+' of your '+r.N+' reels</div>'
        +(r.t!=null?'<div>Aim: about '+r.tn+' ('+r.t+'%)'+(gp?', <b class="'+(gp>0?'anGapUp':'anGapDn')+'">'+Math.abs(gp)+(gp>0?' over':' short')+'</b>':', on target')+'</div>':'')
        +(r.k===sel?'':'<div class="meta">Click for the reels and ideas</div>');
      tip.style.display='block';
      const tw=tip.offsetWidth,bl=b.left-c.left+b.width/2-bw/2,br=bl+bw;  // beside the bar: right of it if it fits, else left
      let x=br+gx,ty=b.top-c.top+T;
      if(x+tw>c.width-8) x=bl-gx-tw;
      if(x<8){ x=Math.max(8,Math.min(c.width-tw-8,bl+bw/2-tw/2)); ty=b.bottom-c.top+4; }  // no room either side (phone): under the chart
      tip.style.left=x+'px'; tip.style.top=ty+'px'; };
    g.onmouseleave=()=>tip.style.display='none';
  });
}
// Under the chart: the open stage's reels from the last 14 days, then reel ideas for it on demand. Each is one sideways row of fixed-width cards.
function anStagePanel(){
  const rows=anStageRows(); if(!rows.length||!rows[0].N) return '';
  const k=anStageNow(rows),r=rows.find(x=>x.k===k),key=anDirView+':'+k,ideas=anSIdeas[key]||[],busy=anSBusy[key],days=anData.direction_days||14;
  const other=p=>anDirView==='funnel'?p.aim.awareness:p.aim.funnel+' of funnel',fit=p=>anFitK(p)==='on'?'on point':anFitK(p)==='off'?'off point':'no words saved';
  return '<div class="anStage"><div class="anStageIH"><div class="anGapH">Your reels from last '+days+' days</div></div>'
      +(r.ps.length?'<div class="anHRow">'+r.ps.slice().reverse().map(p=>'<div class="anSReel" data-post="'+p.id+'">'+(p.thumb?'<img src="'+p.thumb+'" loading="lazy" alt="">':'<span class="anNo"></span>')
          +'<div class="anHook">'+esc(anHook(p))+'</div><div class="meta">'+anDate(p.posted)+' · '+fmtNum(p.stats.views||0)+' views</div>'
          +'<div class="meta">'+esc(other(p))+'</div><div class="meta"><i class="d-'+anFitK(p)+'"></i>'+fit(p)+'</div></div>').join('')+'</div>'
        :'<div class="anStageEmpty">None in the last '+days+' days.</div>')
    +'<div class="anStageIH anStageIH2"><div class="anGapH">Ideas for '+esc(anStageName(k))+'</div><span class="sp"></span>'
      +(ideas.length&&!busy?'<button class="icon" data-sideas>More ideas</button>':'')+'</div>'
      +(busy?'<div class="anGapBusy"><span class="spin"></span>Coming up with '+esc(anStageName(k).toLowerCase())+' ideas for your ideal viewer…</div>':'')
      +(anSErr[key]?'<div class="note">'+esc(anSErr[key])+'</div>':'')
      +(ideas.length?'<div class="anHRow">'+ideas.map((x,i)=>'<div class="anIdea"><div class="anIdeaHook">“'+esc(x.hook)+'”</div>'+(x.angle?'<div class="anIdeaAngle">'+esc(x.angle)+'</div>':'')
          +'<div class="anIdeaTags"><span>'+esc(x.pillar)+'</span><span>'+esc(anDirView==='funnel'?x.awareness:x.funnel+' of funnel')+'</span></div>'
          +'<button class="icon" data-sidea="'+i+'" title="Ask the chat to write this reel">'+ICON_CHAT+'Write it</button></div>').join('')+'</div>':'')
      +(!ideas.length&&!busy?'<button class="btn primary sm" data-sideas>Get ideas for '+esc(k)+'</button>':'')
    +'</div>';
}
async function anStageLoad(){
  const view=anDirView,k=anStageNow(anStageRows()),key=view+':'+k,have=anSIdeas[key]||[];
  if(anSBusy[key]) return;
  anSBusy[key]=true; delete anSErr[key]; anRepaintKeep();
  try{ const r=await fetch('/analytics/direction/ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({view,stage:k,skip:have.map(x=>x.hook)})}),d=await readJSON(r);
    if(!r.ok) throw new Error(d.error||'Something went wrong');
    anSIdeas[key]=d.ideas.concat(have).slice(0,20); lsSet('an:sideas',anSIdeas); }
  catch(e){ anSErr[key]=e.message; }
  anSBusy[key]=false; if(tool==='analytics') anRepaintKeep();
}
const AN_DIR_ASK='Look at my content direction (my last 14 days of reels): the aim labels in analytics/meta.json (fit: on point or off for my ideal viewer, funnel, awareness, audience, why), my reels in analytics/reels.json and their words in analytics/words, and my ideal viewer and my target content mix in context.md. '
  +'Over the last 60 days, am I drifting away from my ideal viewer? On point means it speaks to my ideal viewer, at any funnel stage. Show it week by week, say which topics and hooks pull me off point and whether views reward that, and give me 3 reel ideas that are on point and likely to travel.';
// --- The post pop-up: the same one from Top posts, What's working and the table ---
const anModal=document.getElementById('anModal'),anMBox=document.getElementById('anMBox');
function anStat(label,value,extra){ return '<div class="anMStat"><span class="anTL">'+label+'</span><b>'+value+'</b>'+(extra||'')+'</div>'; }
function anOpenPost(id){
  const p=anData&&anData.posts.find(x=>x.id===id); if(!p) return;
  anOpen=id; const st=p.stats,t=p.tags||{};
  const tags=[t.topic,t.subtopic&&t.subtopic!==t.topic?t.subtopic:'',t.format&&t.format!=='Other'?t.format:'',t.hook,t.cta&&t.cta!=='None'?t.cta:''].filter(Boolean);
  anMBox.innerHTML='<div class="anMHead"><span class="meta">'+(p.kind==='reel'?'Reel':esc(cap(p.kind)))+' · '+anDateY(p.posted)+(p.growing?' · still growing':'')+'</span><span class="sp"></span>'
      +'<a class="icon" href="'+esc(p.link)+'" target="_blank">Open on Instagram ↗</a><button class="icon" data-an="close" title="Close">✕</button></div>'
    +'<div class="anMBody"><div class="anMVid">'+(igEmbed(p.link)||(p.thumb?'<img src="'+p.thumb+'">':''))+'</div><div class="anMMain">'
    +'<h2 class="anMHook">'+esc(anHook(p))+'</h2>'
    +(tags.length?'<div class="anTags">'+tags.map(x=>'<span>'+esc(x)+'</span>').join('')+'</div>':'')
    +(p.aim?'<div class="anMAim"><span class="anFit d-'+anFitK(p)+'">'+esc(anFitK(p)==='on'?'On point':anFitK(p)==='off'?'Off point':'Unclear')+'</span><span class="meta">'+esc(p.aim.funnel)+' of funnel · '+esc(p.aim.awareness||'')+' · for '+esc(p.aim.audience)+'</span><div class="meta">'+esc(p.aim.why)+'</div></div>':'')
    +'<div class="anMStats">'+anStat('Views',fmtNum(st.views||0),' '+anVs(p))+anStat('Shares',fmtNum(st.shares||0))+anStat('Saves',fmtNum(st.saves||0))
      +anStat('Comments',fmtNum(st.comments||0))+anStat('Likes',fmtNum(st.likes||0))+anStat('Reached',fmtNum(st.reach||0))
      +(st.watch_s!=null?anStat('Watched',st.watch_s+'s',p.pct!=null?'<span class="meta"> '+p.pct+'% of '+Math.round(p.length_s)+'s</span>':''):'')
      +(st.skip_rate!=null?anStat('Swiped away',Math.round(st.skip_rate)+'%'):'')+'</div>'
    +'<div class="acts anMActs"><button class="icon" data-an="ask">'+ICON_CHAT+'Why did this one do '+(p.vs==null||p.growing?'like this':p.vs>=1?'well':'worse')+'?</button>'
      +(p.words?'<button class="icon" data-an="words">'+ICON_CHAT+'Words → chat</button>':'')+'</div>'
    +'<div class="eyebrow">What you said</div><div class="anDText">'+(p.words?esc(p.words):'<span class="meta">'+(p.kind==='reel'?'Not transcribed.':'No video in this post.')+'</span>')+'</div>'
    +'<div class="eyebrow">Caption</div><div class="anDText">'+(esc(p.caption)||'<span class="meta">No caption</span>')+'</div>'
    +'</div></div>';
  modalOpen(anModal); anMBox.querySelector('.anMBody').scrollTop=0;
}
function anClosePost(){ anOpen=''; modalClose(anModal,()=>{ if(!anOpen) anMBox.innerHTML=''; }); }  // empty it so a playing video stops
anModal.onclick=e=>{ if(e.target===anModal) anClosePost(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&anModal.classList.contains('on')) anClosePost(); });
anMBox.addEventListener('click',e=>{
  const act=e.target.closest('[data-an]'),p=anOpen&&anData.posts.find(x=>x.id===anOpen); if(!act) return;
  if(act.dataset.an==='close') return anClosePost();
  if(!p) return;
  if(act.dataset.an==='words') return toChat('The words of my reel from '+anDate(p.posted)+':\n'+p.words);
  sendChat('Look at my reel from '+anDate(p.posted)+' (post id '+p.id+' in analytics/reels.json, words in analytics/words/'+p.id+'.txt). '
    +'Why did it do the way it did, against my typical reel? Compare it with 2 or 3 of my reels on a similar topic that did better or worse. Say what to keep and what to change, with the numbers.',
    'Why did my reel from '+anDate(p.posted)+' do like this?');
});
anModal.dismiss=anClosePost;  // closed when something opens the chat

// Not connected yet: what this page is for, and how to get the Instagram key, step by step
function anConnectHtml(err){
  return '<div class="anConnect"><h2>Connect your Instagram</h2>'
    +'<p>This page shows how your own reels are doing: views, how much of each reel people watch, how many swipe away, saves and shares. Each reel is held up against your typical one, so you can see what\'s working. The numbers come from Instagram\'s official API, so you need a key from Meta, once. It\'s free and takes about 10 minutes.</p>'
    +'<ol>'
    +'<li><b>Make your Instagram a professional account</b>, if it isn\'t one yet. In the Instagram app: Settings and activity, then Account type and tools, then Switch to professional account. Creator or Business both work.</li>'
    +'<li>Go to <a href="https://developers.facebook.com/apps" target="_blank">developers.facebook.com/apps</a> and log in with Facebook. Click <b>Create app</b>.</li>'
    +'<li>Give it any name, like "My reel numbers". When it asks what the app is for, pick <b>Manage messaging and content on Instagram</b>. If it asks about a business portfolio, skip it.</li>'
    +'<li>In your new app, open the Instagram use case and go to <b>API setup with Instagram login</b>.</li>'
    +'<li>Under <b>Generate access tokens</b>, click <b>Add account</b> and log in to your Instagram. Then click <b>Generate token</b> next to your account, allow what it asks, and copy the token.</li>'
    +'<li>Paste it here and press Connect.</li></ol>'
    +'<div class="suKey"><input id="anKey" type="password" autocomplete="off" placeholder="Your Instagram token"><button class="btn primary" id="anKeyGo">Connect</button></div>'
    +'<div class="suErr" id="anKeyErr">'+esc(err||'')+'</div>'
    +'<p class="suFine">Meta moves its buttons around now and then. If a step looks different, look for the closest match, or ask the chat on the right to help you connect Instagram. The key stays on this computer, in the .env file. It lasts 60 days, and the app renews it by itself every week while you use it.</p></div>';
}
anOut.addEventListener('click',async e=>{
  if(e.target.id!=='anKeyGo') return;
  const key=document.getElementById('anKey').value.trim(),errEl=document.getElementById('anKeyErr');
  if(!key){ errEl.textContent='Paste the token first.'; return; }
  e.target.disabled=true; e.target.textContent='Connecting…';
  try{ const r=await fetch('/analytics/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const d=await readJSON(r); if(!r.ok) throw new Error(d.error||'That didn\'t work.'); anData=d; anPaint(); }
  catch(err){ errEl.textContent=err.message; e.target.disabled=false; e.target.textContent='Connect'; }
});
anOut.addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.id==='anKey'){ e.preventDefault(); document.getElementById('anKeyGo').click(); } });
function anPaint(){
  const d=anData;
  if(!d.connected){ anOut.innerHTML=anConnectHtml(); return; }
  if(!d.updated){ anOut.innerHTML=d.error?'<div class="note">'+esc(d.error)+'</div>':'<div class="busyCard card"><span class="spin"></span>Pulling your numbers from Instagram for the first time. About 20 seconds.</div>'; return; }
  const a=d.account||{};
  // Up top: your profile the way Instagram's desktop site shows it (picture, handle, name, posts / followers / following)
  const igN=(n,w)=>'<span><b>'+(n||0).toLocaleString('en-US')+'</b> '+w+'</span>';
  anOut.innerHTML='<div class="igHead"><div class="igPic">'+(a.avatar?'<img src="'+esc(a.avatar)+'" alt="">':'<span>'+esc((a.username||'?')[0].toUpperCase())+'</span>')+'</div>'
      +'<div class="igInfo"><div class="igTop"><h1 class="igUser">'+esc(a.username||'')+'</h1>'
      +'<button class="btn soft sm" id="anRefresh"'+(anBusy||d.syncing?' disabled':'')+'>'+(anBusy||d.syncing?'Updating…':'Update now')+'</button>'
      +'<button class="btn primary sm" id="anReview">'+ICON_CHAT+'Review my content</button></div>'
      +(a.name?'<div class="igName">'+esc(a.name)+'</div>':'')
      +'<div class="igStats">'+igN(a.media_count,'posts')+igN(a.followers_count,'followers')+igN(a.follows_count,'following')+'</div>'
      +'<div class="igUpd">Updated '+anAgo(d.updated)+(d.words?'<span class="anWords spin">'+esc(d.words)+'</span>':'')+'</div></div></div>'
    +(d.error?'<div class="note">'+esc(d.error)+'</div>':'')
    +'<div class="anRange"><div class="anChips" id="anRangeBy">'+AN_RANGES.map(([k,l])=>'<button data-r="'+k+'"'+(anRange===k?' class="on"':'')+'>'+l+'</button>').join('')+'</div><span class="sp"></span>'
    +'<div class="seg sm" id="anKind"><button data-k="reel"'+(anKind==='reel'?' class="on"':'')+'>Reels</button><button data-k="all"'+(anKind==='all'?' class="on"':'')+'>All posts</button></div></div>'
    +anKpis()+anChartCard()+anTopCard()+anPatterns()+anTableCard()+anDirection();
  anChart(); anDirChart();
}
new ResizeObserver(()=>{ if(tool==='analytics'&&anData&&anData.updated){ anChart(); anDirChart(); } }).observe(anOut);
anOut.addEventListener('click',async e=>{
  const rb=e.target.closest('#anRangeBy button'); if(rb){ anRange=rb.dataset.r; anStep=''; anTopN=10; lsSet('an:range',anRange); lsSet('an:step',''); return anPaint(); }
  const kb=e.target.closest('#anKind button'); if(kb){ anKind=kb.dataset.k; lsSet('an:kind',anKind); return anPaint(); }
  const mb=e.target.closest('#anMetric button'); if(mb){ anMetric=mb.dataset.m; lsSet('an:metric',anMetric); document.querySelectorAll('#anMetric button').forEach(b=>b.classList.toggle('on',b===mb)); return anChart(); }
  const sb=e.target.closest('#anStep button'); if(sb){ anStep=sb.dataset.s; lsSet('an:step',anStep); return anChart(); }
  const tb=e.target.closest('#anTopBy button'); if(tb){ anTop=tb.dataset.t; anTopN=10; lsSet('an:top',anTop); return anRepaintKeep(); }
  if(e.target.closest('[data-more]')){ anTopN+=10; return anRepaintKeep(); }
  if(e.target.closest('[data-table]')){ if(anTable) return collapse(anOut.querySelector('.anTableBox'),()=>{ anTable=false; anRepaintKeep(); });
    anTable=true; anAnim='table'; return anRepaintKeep(); }
  const th=e.target.closest('th[data-sort]');
  if(th){ const k=th.dataset.sort; anSort={k,d:anSort.k===k?-anSort.d:-1}; lsSet('an:sort',anSort); return anRepaintKeep(); }
  const gb=e.target.closest('#anGroup button'); if(gb){ anGroup=gb.dataset.g; anGroupOpen=''; lsSet('an:group',anGroup); return anRepaintKeep(); }
  if(e.target.closest('#anReview')) return sendChat(AN_SUGS[0][1],'Review my content');
  const dv=e.target.closest('#anDirView button'); if(dv){ anDirView=dv.dataset.v; lsSet('an:dirView',anDirView); return anRepaintKeep(); }
  const col=e.target.closest('.anMixCol'); if(col){ anStagePick[anDirView]=anStageRows()[+col.dataset.i].k; lsSet('an:stage',anStagePick); return anRepaintKeep(); }
  if(e.target.closest('[data-sideas]')) return anStageLoad();
  const si=e.target.closest('[data-sidea]'); if(si){ const x=(anSIdeas[anDirView+':'+anStageNow(anStageRows())]||[])[+si.dataset.sidea]; if(!x) return;
    return sendChat('Write me a reel script for this idea, in my voice (context.md), using the format card from formats.json that fits it best. Pillar: '+x.pillar+'. First line: "'+x.hook+'". '
      +(x.angle?'The angle: '+x.angle+' ':'')+'It should sit at the '+x.funnel.toLowerCase()+' of the funnel and speak to someone who is '+x.awareness.toLowerCase()+'. Say which format card you used.','Write: '+x.hook); }
  const go=e.target.closest('[data-cx-go]'); if(go){ cxGoto=go.dataset.cxGo; return; }  // the link itself opens Context
  if(e.target.closest('#anRefresh')){ anBusy=true; anPaint();
    try{ const r=await fetch('/analytics/refresh',{method:'POST'}),d=await readJSON(r); if(!r.ok) throw new Error(d.error); anData=d; }
    catch(err){ anData.error=err.message; }
    anBusy=false; return anShow(); }
  if(e.target.closest('a,button')) return;
  const post=e.target.closest('[data-post]'); if(post) return anOpenPost(post.dataset.post);
  const gr=e.target.closest('[data-group]'); if(gr){ const next=anGroupOpen===gr.dataset.group?'':gr.dataset.group;  // close the open one smoothly, then open the next
    return collapse(anGroupOpen&&anOut.querySelector('.anGPosts .reveal,.anGPosts>td>div'),()=>{ anGroupOpen=next; anAnim=next?'group':''; anRepaintKeep(); }); }
});
// Repaint without the page jumping: keep the scroll where it was
function anRepaintKeep(){ const m=document.getElementById('main'),y=m.scrollTop; anPaint(); anAnim=''; m.scrollTop=y; }
// What the chat offers on this page
const AN_SUGS=[
  ['What\'s working, what isn\'t?','Review my content using my analytics (analytics/reels.json and analytics/words). Compare my best and worst reels of the last 30 days against my typical reel. What do the winners share (topic, hook, format, length, call to action) that the losers don\'t? Give me 3 things to keep doing and 3 to stop, each backed by numbers.'],
  ['Which hooks stop the scroll?','Using my analytics, rank the opening lines of my reels with at least 300 views by swipe-away rate, lowest first. What do the hooks that hold people have in common, and what do the worst ones do wrong? Then write 5 new hooks in the style of my best ones.'],
  ['What should I post next?','Based on what has done best for me (views against my typical reel, saves and shares per 1,000 views, watch time), suggest my next 3 reels: the topic, the hook, and a format card from formats.json, with the numbers behind each choice.'],
  ['Am I drifting from my audience?',AN_DIR_ASK],
  ['How did this week go?','How did my posts from the last 7 days do against my typical reel, and how did my followers change? Keep it short: the wins, the misses, and one thing to change next week.'],
];
function anSuggestions(){ return AN_SUGS; }
function anWhere(){
  const p=anOpen&&anData&&anData.posts.find(x=>x.id===anOpen);
  return 'the Analytics page, with their own Instagram numbers (analytics/reels.json), showing '+anRangeLabel()+(p?', looking at their reel from '+anDate(p.posted)+' that starts "'+anHook(p).slice(0,80)+'" (post id '+p.id+')':'');
}
