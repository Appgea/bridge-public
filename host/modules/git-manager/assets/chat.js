/* git-manager module — chat/graph renderer. Self-contained: talks only to its own
   /m/git-manager/* endpoints and (optionally) window.showDiff if the host page has one.
   Exposes:
     window.GitManager.renderGraph(mountEl, graphData, opts)   — the sidebar rail calls this
     window.panelRenderers.git(el, data)                       — chat feed calls this for
                                                                    ```panel:git``` blocks
     window.GitManager.renderPanel(el, data, event)             — companion panel git scenes
   opts for renderGraph: {repo, onAfterCheckout?, onDiscuss?(repo,commit)}
   data.action for the chat renderer: "graph" | "commit" | "push" | "merge" — see AGENT.md
   for the exact payload schema each action expects. */
(function(){
"use strict";
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function jget(u){return (await fetch(u)).json()}
async function jpost(u,b){return (await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})})).json()}

const TYPE_BADGE={feat:"✨",fix:"🐛",refactor:"♻️",perf:"⚡",docs:"📝",chore:"🧹",test:"✅",style:"🎨",build:"📦",ci:"🤖",revert:"⏪",merge:"🔀"};
function commitBadge(subject){
 if(/^merge\b/i.test(subject||""))return TYPE_BADGE.merge;
 const m=/^([a-z]+)(\([^)]*\))?!?:/i.exec(subject||"");
 return (m&&TYPE_BADGE[m[1].toLowerCase()])||"•";
}

/* ---------- reusable game-like commit graph — used by the Git tab rail AND chat embeds ---------- */
function renderGraph(mount,data,opts){
 opts=opts||{};const commits=data.commits||[];
 const RH=64,LW=22,PADL=18,NR=8;
 const lanes=data.lanes||1,gw=PADL+lanes*LW+PADL;
 const idx={};commits.forEach((c,i)=>idx[c.sha]=i);
 const laneX=l=>PADL+l*LW,rowY=i=>i*RH+RH/2,delay=i=>Math.min(i*0.035,0.7);
 const uid="gg"+(window.__ggSeq=(window.__ggSeq||0)+1); // unique defs ids: multiple graphs can share one page
 const cont=document.createElement("div");cont.className="gitgraph";cont.style.minHeight=(commits.length*RH)+"px";
 const NS="http://www.w3.org/2000/svg";
 const svg=document.createElementNS(NS,"svg");svg.setAttribute("class","gsvg");
 svg.setAttribute("width",gw);svg.setAttribute("height",commits.length*RH);
 const defs=document.createElementNS(NS,"defs");
 // gem-glow filter (node blooms in its own color)
 const fl=document.createElementNS(NS,"filter");fl.id=uid+"glow";
 fl.setAttribute("x","-90%");fl.setAttribute("y","-90%");fl.setAttribute("width","280%");fl.setAttribute("height","280%");
 const fb=document.createElementNS(NS,"feGaussianBlur");fb.setAttribute("stdDeviation","2.3");fb.setAttribute("result","b");
 const fm=document.createElementNS(NS,"feMerge");
 const mn1=document.createElementNS(NS,"feMergeNode");mn1.setAttribute("in","b");
 const mn2=document.createElementNS(NS,"feMergeNode");mn2.setAttribute("in","SourceGraphic");
 fm.append(mn1,mn2);fl.append(fb,fm);defs.appendChild(fl);
 svg.appendChild(defs);
 // one radial-sheen gradient per distinct lane color
 const grads={};
 function gradId(col){
  if(grads[col])return grads[col];
  const id=uid+"lg"+Object.keys(grads).length;grads[col]=id;
  const g=document.createElementNS(NS,"radialGradient");g.id=id;g.setAttribute("cx","35%");g.setAttribute("cy","30%");
  const s1=document.createElementNS(NS,"stop");s1.setAttribute("offset","0%");s1.setAttribute("stop-color","#fff");s1.setAttribute("stop-opacity",".7");
  const s2=document.createElementNS(NS,"stop");s2.setAttribute("offset","45%");s2.setAttribute("stop-color",col);
  const s3=document.createElementNS(NS,"stop");s3.setAttribute("offset","100%");s3.setAttribute("stop-color",col);s3.setAttribute("stop-opacity",".85");
  g.append(s1,s2,s3);defs.appendChild(g);return id;
 }
 // edges — flowing, colored conduits
 const eg=document.createElementNS(NS,"g");eg.setAttribute("class","gedges");
 commits.forEach((c,i)=>{
  const x=laneX(c.lane),y=rowY(i);
  (c.parents||[]).forEach(p=>{
   const pj=idx[p],pa=document.createElementNS(NS,"path");pa.setAttribute("class","gedge");
   if(pj===undefined){pa.setAttribute("d","M"+x+" "+y+" L"+x+" "+(y+RH/2));pa.setAttribute("opacity",".4");pa.setAttribute("stroke",c.color)}
   else{const x2=laneX(commits[pj].lane),y2=rowY(pj),my=(y+y2)/2;
    pa.setAttribute("d",x===x2?("M"+x+" "+y+" L"+x2+" "+y2):("M"+x+" "+y+" C"+x+" "+my+","+x2+" "+my+","+x2+" "+y2));
    pa.setAttribute("stroke",commits[pj].color)}
   eg.appendChild(pa);
  });
 });
 svg.appendChild(eg);
 // nodes — glowing orbs; merges are gems; HEAD radiates; ref-tips get a ring
 commits.forEach((c,i)=>{
  const x=laneX(c.lane),y=rowY(i),isHead=c.sha===data.head,isMerge=(c.parents||[]).length>=2,hasRef=(c.refs||[]).length>0;
  const halo=document.createElementNS(NS,"circle");halo.setAttribute("class","ghalo");
  halo.setAttribute("cx",x);halo.setAttribute("cy",y);halo.setAttribute("r",NR+5);
  halo.setAttribute("fill",c.color);halo.setAttribute("opacity",isHead?".34":".22");svg.appendChild(halo);
  if(isHead){[0,1].forEach(k=>{const r=document.createElementNS(NS,"circle");
   r.setAttribute("class","ghead-pulse"+(k?" b":""));r.setAttribute("cx",x);r.setAttribute("cy",y);
   r.setAttribute("r",NR);r.setAttribute("stroke",c.color);svg.appendChild(r)})}
  if(hasRef){const ring=document.createElementNS(NS,"circle");ring.setAttribute("class","gring");
   ring.setAttribute("cx",x);ring.setAttribute("cy",y);ring.setAttribute("r",NR+3);ring.setAttribute("stroke",c.color);svg.appendChild(ring)}
  let node;
  if(isMerge){node=document.createElementNS(NS,"rect");const s=NR*2.0;
   node.setAttribute("x",x-s/2);node.setAttribute("y",y-s/2);node.setAttribute("width",s);node.setAttribute("height",s);
   node.setAttribute("rx",2.5);node.setAttribute("transform","rotate(45 "+x+" "+y+")")}
  else{node=document.createElementNS(NS,"circle");node.setAttribute("cx",x);node.setAttribute("cy",y);node.setAttribute("r",isHead?NR+1:NR)}
  node.setAttribute("class","gnode");node.style.setProperty("--d",delay(i)+"s");
  node.setAttribute("filter","url(#"+uid+"glow)");node.setAttribute("fill","url(#"+gradId(c.color)+")");
  node.setAttribute("stroke",isHead?"#fff":"rgba(255,255,255,.4)");node.setAttribute("stroke-width",isHead?"2":"1.4");
  node.dataset.sha=c.sha;node.onclick=(e)=>openCommitFromGraph(e,c,opts);
  svg.appendChild(node);
 });
 cont.appendChild(svg);
 commits.forEach((c,i)=>{
  const row=document.createElement("div");row.className="grow";row.style.marginLeft=gw+"px";row.style.setProperty("--d",delay(i)+"s");
  const glyph={remote:"☁ ",tag:"◆ "};
  const refs=(c.refs||[]).map(r=>'<span class="gref '+r.type+'" data-ref="'+esc(r.name)+'" data-rtype="'+r.type+'" style="--rc:'+c.color+'">'+(glyph[r.type]||"")+esc(r.name)+'</span>').join("");
  const kw=(c.keywords&&c.keywords.length)?' · <span class="gkw" style="color:'+c.color+'">'+esc(c.keywords[0])+'</span>':"";
  row.innerHTML='<span class="gbadge" title="'+esc(c.subject)+'">'+commitBadge(c.subject)+'</span>'+
   '<div class="gtext"><div class="gsub">'+esc(c.subject)+'</div>'+
   '<div class="gmeta"><code class="gsha">'+esc(c.short)+'</code> · '+esc(c.author)+' · '+esc(c.age)+kw+'</div></div>'+
   (refs?'<div class="grefs">'+refs+'</div>':'');
  row.onclick=(e)=>openCommitFromGraph(e,c,opts);
  cont.appendChild(row);
 });
 mount.appendChild(cont);
}

/* Click routing for a graph node/row: a ref pill routes to the branch drawer, the body routes
   to the host's rich commit drawer (opts.onCommit) — falling back to the legacy popover for chat
   embeds that don't pass those hooks. Keeps the module reusable in both surfaces. */
function openCommitFromGraph(e,c,opts){
 opts=opts||{};
 const rf=e.target&&e.target.closest&&e.target.closest(".gref");
 if(rf&&opts.onBranch){e.stopPropagation();return opts.onBranch(rf.dataset.ref,rf.dataset.rtype);}
 e.stopPropagation();
 if(opts.onCommit)return opts.onCommit(c);
 gitNodePopover(c,opts,e.clientX,e.clientY);
}

function gitNodePopover(c,opts,x,y){
 opts=opts||{};const repo=opts.repo;
 document.querySelectorAll(".gpop").forEach(p=>p.remove());
 const p=document.createElement("div");p.className="gpop";
 p.style.left=Math.min(x,window.innerWidth-200)+"px";p.style.top=(y+6)+"px";
 p.innerHTML='<div class="gpsha">'+esc(c.short)+' · '+esc(c.author)+'</div>'+
  '<button data-a="checkout">⎇ Checkout this commit</button>'+
  '<button data-a="copy">⧉ Copy SHA</button>'+
  '<button data-a="diff">🔍 View diff</button>'+
  (opts.onDiscuss?'<button data-a="discuss">💬 Discuss with agent</button>':'');
 p.onclick=async(e)=>{
  const a=e.target.dataset.a;if(!a)return;p.remove();
  if(a==="copy"){try{await navigator.clipboard.writeText(c.sha)}catch(_){}return}
  if(a==="checkout"){
   if(repo&&confirm("Checkout "+c.short+"? (detaches HEAD)")){
    await jpost("/m/git-manager/checkout",{repo,ref:c.sha});
    if(opts.onAfterCheckout)opts.onAfterCheckout();
   }
   return;
  }
  if(a==="diff"){
   const d=await jget("/m/git-manager/diff?repo="+encodeURIComponent(repo)+"&sha="+c.sha);
   const title=c.short+" "+c.subject,patch=d.error?d.error:(d.patch||"");
   if(window.showDiff)window.showDiff(title,patch);else alert(title+"\n\n"+patch.slice(0,4000));
   return;
  }
  if(a==="discuss"){opts.onDiscuss&&opts.onDiscuss(repo,c);return}
 };
 document.body.appendChild(p);
 setTimeout(()=>{const close=(ev)=>{if(!p.contains(ev.target)){p.remove();document.removeEventListener("click",close)}};document.addEventListener("click",close)},0);
}

/* ---------- chat feed entry point: ```panel:git {"action":...}``` ---------- */
function renderGitChat(el,data){
 data=data||{};
 if(data.action==="commit")return renderCommitCard(el,data);
 if(data.action==="push")return renderPushCard(el,data);
 if(data.action==="merge")return renderMergeCard(el,data);
 // "graph"/tree embeds are intentionally NOT rendered in the conversation — the animated tree
 // belongs to the Git tab rail only. Swallow the block so no stray card appears in the feed.
 if(data.action==="graph"){el.style.display="none";return;}
 el.innerHTML='<div class="bc-err">unknown git action: '+esc(data.action||"?")+'</div>';
}

function renderCommitCard(el,d){
 el.className="bgit bgit-commit";
 el.innerHTML='<div class="bgc-badge">'+commitBadge(d.subject||d.message||"")+'</div>'+
  '<div class="bgc-body"><div class="bgc-sub">'+esc(d.subject||d.message||"commit")+'</div>'+
  '<div class="bgc-meta">'+(d.branch?'<code>'+esc(d.branch)+'</code> · ':'')+esc((d.sha||"").slice(0,7))+'</div></div>';
}

function renderPushCard(el,d){
 el.className="bgit bgit-push";
 // the packet crosses the wire twice, then the card settles: remote lights green and a "done"
 // chip fades in. No looping — the animation plays, resolves, and holds a still illustration.
 el.innerHTML='<div class="bgp-row"><span class="bgp-node local"></span><span class="bgp-track"><span class="bgp-pkt"></span></span><span class="bgp-node remote"></span>'+
  '<span class="bgp-done">✓ done</span></div>'+
  '<div class="bgp-label">pushed <code>'+esc(d.branch||"")+'</code> to <b>'+esc(d.remote||"origin")+'</b>'+
  (d.ahead?' · '+d.ahead+' commit'+(d.ahead===1?'':'s'):'')+'</div>';
}

function renderMergeCard(el,d){
 el.className="bgit bgit-merge";
 // lines converge once into the merge gem, then a "done" chip settles in — single-play, no loop.
 el.innerHTML='<div class="bgm-row"><span class="bgm-line a"></span><span class="bgm-line b"></span><span class="bgm-node"></span>'+
  '<span class="bgm-done">✓ done</span></div>'+
  '<div class="bgm-label">merged <code>'+esc(d.from||"")+'</code> into <b>'+esc(d.into||"")+'</b>'+
  (d.sha?' · <code>'+esc((d.sha||"").slice(0,7))+'</code>':'')+'</div>';
}

/* ---------- companion panel: compact, replayable stories rather than command diary rows ------- */
function commandParts(command){
 const raw=String(command||"");
 const m=/\bgit\s+pull(?:\s+--[^\s]+)*(?:\s+([^\s;&|]+))?(?:\s+([^\s;&|]+))?/i.exec(raw);
 return {remote:(m&&m[1]&&!m[1].startsWith("-"))?m[1]:"origin",
         branch:(m&&m[2]&&!m[2].startsWith("-"))?m[2]:"current branch"};
}
function repoName(d){
 const raw=d.repo||d.cwd||"repository";
 return String(raw).replace(/[\\/]+$/,"").split(/[\\/]/).pop()||"repository";
}
function resultLine(d){
 const lines=Array.isArray(d.out)?d.out:(typeof d.result==="string"?d.result.split("\n"):[]);
 const hit=lines.find(x=>/already up[ -]to[ -]date|fast-forward|files? changed|conflict|fatal|error/i.test(String(x)));
 return hit?String(hit).slice(0,100):"Remote checked · local branch reconciled";
}
function renderPullPanel(el,d){
 const bits=commandParts(d.command),failed=d.ok===false||Number(d.exit)>0;
 el.classList.add("pg-git","pg-pull",failed?"pg-failed":"pg-ok");
 el.innerHTML='<div class="pg-top"><span class="pg-mark">⑂</span><div><b>Pulling '+esc(repoName(d))+'</b><small>'+esc(bits.remote)+' / '+esc(bits.branch)+'</small></div><span class="pg-chip">'+(failed?'needs attention':'synced')+'</span></div>'+
  '<div class="pg-route"><div class="pg-node remote"><i>☁</i><span>'+esc(bits.remote)+'</span></div><div class="pg-wire"><i class="pg-packet a"></i><i class="pg-packet b"></i><i class="pg-packet c"></i></div><div class="pg-node local"><i>⌂</i><span>local</span></div></div>'+
  '<div class="pg-phases"><span style="--pg-d:.1s"><i></i>contact</span><span style="--pg-d:.55s"><i></i>receive</span><span style="--pg-d:1s"><i></i>integrate</span></div>'+
  '<div class="pg-result"><i>'+(failed?'!':'✓')+'</i><span>'+esc(failed?(d.error||"Pull did not complete"):resultLine(d))+'</span></div>';
}
function renderGitPanel(el,d,ev){
 d=d||{};ev=ev||{};
 const kind=d.kind||d.action||String(ev.type||"").replace(/^git-/,"")||"activity";
 const entered=el.classList.contains("in");
 el.className="pev"+(entered?" in":""); // preserve entry state when upgrading a late fallback
 if(kind==="pull")return renderPullPanel(el,d);
 const icons={commit:"◆",push:"↑",fetch:"↓",merge:"⑂",rebase:"⇶",checkout:"↪",branch:"⑂",stash:"◇",tag:"⌁",revert:"↶",reset:"↺","cherry-pick":"●"};
 el.classList.add("pg-git","pg-action");
 el.innerHTML='<div class="pg-action-icon">'+(icons[kind]||"↕")+'</div><div class="pg-action-copy"><small>git / '+esc(kind)+'</small><b>'+esc(d.subject||d.message||(kind.charAt(0).toUpperCase()+kind.slice(1)+" complete"))+'</b><span>'+esc(repoName(d))+(d.branch?' · '+esc(d.branch):'')+'</span></div><i class="pg-action-done">✓</i>';
}
function installPanelRenderer(){
 if(typeof window.registerAnim!=="function")return false;
 window.registerAnim("git",(p,el,ev)=>renderGitPanel(el,p,ev));
 document.querySelectorAll(".pev.git-awaiting").forEach(el=>{
  const ev=el.__panelEvent||{};renderGitPanel(el,ev.payload||{},ev);
 });
 return true;
}

window.GitManager={renderGraph:renderGraph,renderPanel:renderGitPanel};
window.panelRenderers=window.panelRenderers||{};
window.panelRenderers.git=renderGitChat;
if(!installPanelRenderer())window.addEventListener("panel:panel-ready",installPanelRenderer,{once:true});
})();
