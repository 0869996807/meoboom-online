const $=(id)=>document.getElementById(id);

const CARD={
BOOM:{name:"Mèo Boom 💥",desc:"Rút trúng mà không có Gỡ Boom → bị loại."},
DEFUSE:{name:"Gỡ Boom 🧯",desc:"Dùng khi rút trúng Boom, rồi đặt Boom lại."},
SOI:{name:"Soi 3 Lá 👀",desc:"Xem 3 lá trên cùng."},
XAO:{name:"Xáo Trộn 🔀",desc:"Xáo trộn chồng bài."},
NE:{name:"Né Lượt 🛑",desc:"Bỏ lượt."},
DAO:{name:"Đảo Chiều 🔁",desc:"Đổi chiều."},
CUOPN:{name:"Cướp Ngẫu Nhiên 🎯",desc:"Chọn người → cướp ngẫu nhiên. (MVP UI chưa hỗ trợ)"},
TAN2:{name:"Chỉ Định Rút 2 🧠",desc:"Người kế tiếp rút thêm 2."},
COMBO:{name:"Bộ Đôi 🐾🐾",desc:"(MVP) Online chưa đủ UI."},
RAC:{name:"Mèo Tấu Hài 😺",desc:"Không tác dụng."},
RADAR:{name:"Radar Vũ Trụ 👁",desc:"Xem 5 lá trên cùng."},
TOC:{name:"Tăng Tốc 🚀",desc:"Rút thêm 1 lá."},
DICH:{name:"Dịch Chuyển 🌀",desc:"Đảo 3 lá trên cùng."},
TAN3:{name:"Tấn Công 3 ⚡",desc:"Người kế tiếp rút thêm 3."},
NGUOC:{name:"Đảo Ngược ⏪",desc:"Quay lại lượt trước."},
BIEN:{name:"Biến Hình 🎭",desc:"Chọn biến thành 1 hành động."},
};

const LS_KEY = "meoboom_online_session_v4"; // {code, playerToken, name}
let session = null;

let ws=null, wsId=null, roomCode=null, playerToken=null, state=null, hand=[], selected=null, pending=null;
let countdownTimer=null;
let reconnectTimer=null;
let reconnectDelay=800;
let lastMyTurn=false;

function loadSession(){
  try{ session = JSON.parse(localStorage.getItem(LS_KEY) || "null"); }catch{ session=null; }
}
function saveSession(){
  localStorage.setItem(LS_KEY, JSON.stringify({code:roomCode, playerToken, name: ($("name")?.value||"").trim()}));
}
function clearSession(){
  localStorage.removeItem(LS_KEY);
  session=null;
}

function toast(msg, ms=2200){
  const el=$("toast");
  if(!el) return;
  el.textContent=msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.add("hidden"), ms);
  try{ if(navigator.vibrate) navigator.vibrate(40); }catch{}
}

function setConn(t,ok=false){ const el=$("conn"); el.textContent=t; el.classList.toggle("ok",ok); }

function wsUrl(){
  const proto = location.protocol==="https:" ? "wss":"ws";
  return `${proto}://${location.host}/ws`;
}

function connect(){
  if(ws && (ws.readyState===0 || ws.readyState===1)) return;

  ws = new WebSocket(wsUrl());

  ws.onopen=()=>{
    setConn("Đã kết nối",true);
    reconnectDelay=800;

    // auto resume if we have session
    if(session?.code && session?.playerToken){
      send({type:"resume", code: session.code, playerToken: session.playerToken});
    }
  };

  ws.onclose=()=>{
    setConn("Mất kết nối (đang nối lại…)");
    scheduleReconnect();
  };

  ws.onerror=()=>setConn("Lỗi kết nối");
  ws.onmessage=(ev)=>onMsg(JSON.parse(ev.data));
}

function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer=setTimeout(()=>{
    reconnectTimer=null;
    connect();
    reconnectDelay=Math.min(6000, Math.floor(reconnectDelay*1.4));
  }, reconnectDelay);
}

function send(o){ if(ws && ws.readyState===1) ws.send(JSON.stringify(o)); }

function showLobby(){ $("lobby").classList.remove("hidden"); $("game").classList.add("hidden"); }
function showGame(){ $("lobby").classList.add("hidden"); $("game").classList.remove("hidden"); }

function onMsg(m){
  if(m.type==="hello_ok"){ wsId=m.wsId; return; }
  if(m.type==="error"){ alert(m.message); return; }
  if(m.type==="room_ok"){
    roomCode=m.code;
    playerToken=m.playerToken;
    $("roomInfo").textContent=`Đang ở phòng: ${roomCode}`;
    saveSession();
    showInviteUI(roomCode);
    showGame();
    if(m.state){ state=m.state; renderState(true); }
    return;
  }
  if(m.type==="state"){ state=m.state; renderState(false); return; }
  if(m.type==="hand"){ hand=m.hand||[]; renderHand(); return; }
  if(m.type==="peek"){ promptChoice("Lá trên cùng", `<p>${(m.cards||[]).map((c,i)=>`${i+1}. ${c}`).join("<br/>")||"Không đủ bài."}</p>`, false); return; }
  if(m.type==="prompt"){ pending=m.prompt; handlePrompt(pending); return; }
}

function myTurn(){
  if(!state || !state.started) return false;
  const turn = state.players[state.turnIndex];
  return turn && turn.alive && turn.playerToken===playerToken;
}

function renderState(first=false){
  if(!state) return;

  $("pillRoom").textContent=`Phòng: ${state.code}`;
  $("pillMode").textContent=state.modeKey==="space"?"Bộ 2":"Bộ 1";
  $("pillPlayers").textContent=`Người: ${state.players.length}`;
  $("pillAlive").textContent=`Còn sống: ${state.players.filter(p=>p.alive).length}`;
  $("deckCount").textContent=state.deckCount;

  const turn=state.players[state.turnIndex];
  const deadline = state.turnDeadline || 0;
  const secondsLeft = deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : 0;

  $("turnTitle").textContent=turn?`Đến lượt: ${turn.name}`:"—";
  $("turnSub").textContent=turn?`Tự bốc sau ${secondsLeft}s`:"—";

  const isHost = state.hostPlayerToken===playerToken;
  $("btnStartGame").classList.toggle("hidden", !(isHost && !state.started));

  const canDraw = myTurn() && !pending;
  $("btnDraw").disabled=!canDraw;

  // notify when it becomes your turn
  const nowMyTurn = myTurn();
  if(nowMyTurn && !lastMyTurn && !first){
    toast("Đến lượt bạn bốc bài!");
  }
  lastMyTurn = nowMyTurn;

  renderLog();
  startCountdownUI();
}

function renderLog(){
  const el=$("log"); el.innerHTML="";
  (state.log||[]).forEach(e=>{
    const div=document.createElement("div"); div.className="entry";
    const t=document.createElement("div"); t.className="time"; t.textContent=e.t;
    const msg=document.createElement("div"); msg.className="msg "+(e.cls||""); msg.textContent=e.msg;
    div.appendChild(t); div.appendChild(msg); el.appendChild(div);
  });
}

function renderHand(){
  const el=$("hand"); el.innerHTML="";
  hand.forEach(c=>{
    const def=CARD[c.key]||{name:c.key,desc:""};
    const div=document.createElement("div");
    div.className="cardItem"+(selected===c.id?" selected":"");
    const badge=document.createElement("div"); badge.className="badge"; badge.textContent=c.key;
    const name=document.createElement("div"); name.className="name"; name.textContent=def.name;
    const desc=document.createElement("div"); desc.className="desc"; desc.textContent=def.desc;
    div.appendChild(badge); div.appendChild(name); div.appendChild(desc);

    let timer=null;
    div.addEventListener("touchstart",()=>{ timer=setTimeout(()=>showCard(c.key),450); },{passive:true});
    div.addEventListener("touchend",()=>{ if(timer) clearTimeout(timer); timer=null; });
    div.addEventListener("click",()=>{ selected=(selected===c.id?null:c.id); renderHand(); });

    el.appendChild(div);
  });
}

function showCard(k){ $("cardName").textContent=(CARD[k]?.name||k); $("cardDesc").textContent=(CARD[k]?.desc||""); $("dlgCard").showModal(); }

function promptChoice(title, bodyHtml, withCancel=true){
  return new Promise((resolve)=>{
    $("promptTitle").textContent=title;
    $("promptBody").innerHTML=bodyHtml;
    $("promptCancel").style.display=withCancel?"":"none";
    $("promptCancel").onclick=()=>{ $("dlgPrompt").close(); resolve(null); };
    $("promptOk").onclick=()=>{ $("dlgPrompt").close(); resolve(true); };
    $("dlgPrompt").showModal();
  });
}

async function handlePrompt(p){
  if(p.type==="insert_boom"){
    const ok=await promptChoice("Gỡ Boom 🧯",`
      <p>Đặt Boom lại?</p>
      <div class="promptList">
        <label class="opt"><input type="radio" name="pos" value="top" checked/> Trên</label>
        <label class="opt"><input type="radio" name="pos" value="middle"/> Giữa</label>
        <label class="opt"><input type="radio" name="pos" value="bottom"/> Dưới</label>
      </div>
      <style>.promptList{display:flex;flex-direction:column;gap:8px;margin:10px 0}
      .opt{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:14px}</style>
    `);
    if(!ok) return;
    const pos=document.querySelector('input[name="pos"]:checked')?.value||"top";
    send({type:"prompt_reply",code:roomCode,promptId:p.id,payload:{pos}});
    pending=null; return;
  }
  if(p.type==="bien_hinh"){
    const keys=Object.keys(CARD).filter(k=>!["BOOM","DEFUSE"].includes(k));
    const opts=keys.map((k,i)=>`<label class="opt"><input type="radio" name="k" value="${k}" ${i===0?"checked":""}/> ${CARD[k].name}</label>`).join("");
    const ok=await promptChoice("Biến Hình 🎭",`
      <p>Chọn hành động:</p><div class="promptList">${opts}</div>
      <style>.promptList{display:flex;flex-direction:column;gap:8px;margin:10px 0;max-height:50vh;overflow:auto}
      .opt{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:14px}</style>
    `);
    if(!ok) return;
    const key=document.querySelector('input[name="k"]:checked')?.value;
    send({type:"prompt_reply",code:roomCode,promptId:p.id,payload:{key}});
    pending=null; return;
  }
}

function startCountdownUI(){
  if(countdownTimer) return;
  countdownTimer = setInterval(()=>{
    if(!state || !state.started) return;
    const turn=state.players[state.turnIndex];
    const deadline = state.turnDeadline || 0;
    const secondsLeft = deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : 0;
    if(turn) $("turnSub").textContent=`Tự bốc sau ${secondsLeft}s`;
  }, 250);
}

/** Hand view toggle */
function setHandView(mode){
  const el=$("hand");
  $("viewFan").classList.toggle("active", mode==="fan");
  $("viewCompact").classList.toggle("active", mode==="compact");
  el.classList.toggle("fan", mode==="fan");
  el.classList.toggle("compact", mode==="compact");
  localStorage.setItem("meoboom_hand_view", mode);
}
function loadHandView(){
  const v = localStorage.getItem("meoboom_hand_view") || "fan";
  setHandView(v==="compact"?"compact":"fan");
}

/** Invite UI */
function inviteLink(code){
  const u = new URL(location.href);
  u.searchParams.set("room", code);
  return u.toString();
}
function showInviteUI(code){
  $("inviteBox").classList.remove("hidden");
  $("inviteCode").textContent=code;
}
async function copyText(txt){
  try{
    await navigator.clipboard.writeText(txt);
    toast("Đã copy!");
  }catch{
    // fallback
    const ta=document.createElement("textarea");
    ta.value=txt; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy");
    document.body.removeChild(ta);
    toast("Đã copy!");
  }
}


/** Ranking & History (SQLite on same server) */

let roomsTimer=null;

function roomModeLabel(modeKey){ return modeKey==="space" ? "Bộ 2" : "Bộ 1"; }

async function loadRoomsOnce(){
  const listEl = $("roomList");
  if(!listEl) return;
  try{
    const r = await fetch("/api/rooms");
    const j = await r.json();
    const items = j.items || [];
    if(items.length===0){
      listEl.innerHTML = `<div class="note">Chưa có phòng nào đang mở.</div>`;
      return;
    }
    listEl.innerHTML = items.map(it=>{
      const code = it.code;
      const sub = `${roomModeLabel(it.modeKey)} • ${it.players}/${it.maxPlayers}`;
      return `
        <div class="roomItem">
          <div class="roomMeta">
            <div class="roomCode">${code}</div>
            <div class="roomSub">${sub}</div>
          </div>
          <button class="btn primary" data-join="${code}">Vào</button>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll("button[data-join]").forEach(btn=>{
      btn.onclick=()=>{
        const code = btn.getAttribute("data-join");
        $("code").value = code;
        $("btnJoin").click();
      };
    });
  }catch(e){
    listEl.innerHTML = `<div class="note">Không tải được danh sách phòng.</div>`;
  }
}

function startRoomsPolling(){
  if(roomsTimer) return;
  loadRoomsOnce();
  roomsTimer = setInterval(()=>{
    // only poll when lobby visible
    const lobbyHidden = $("lobby")?.classList.contains("hidden");
    if(!lobbyHidden) loadRoomsOnce();
  }, 2000);
}

async function loadRanking(){
  const dlg=$("dlgRanking"); const body=$("rankingBody");
  body.textContent="Đang tải…";
  dlg.showModal();
  try{
    const r=await fetch("/api/ranking?limit=50");
    const j=await r.json();
    const rows=(j.items||[]).map((x,i)=>`<div class="entry"><div class="time">#${i+1}</div><div class="msg">${x.display_name} • ${x.rating}đ • W${x.wins}/L${x.losses} • ${x.games} trận</div></div>`).join("");
    body.innerHTML = rows || "<div class='msg'>Chưa có dữ liệu.</div>";
  }catch{
    body.textContent="Lỗi tải xếp hạng";
  }
}
async function loadHistory(){
  const dlg=$("dlgHistory"); const body=$("historyBody");
  body.textContent="Đang tải…";
  dlg.showModal();
  try{
    if(!playerToken) return body.textContent="Bạn chưa vào phòng.";
    const r=await fetch("/api/history?player_token="+encodeURIComponent(playerToken)+"&limit=30");
    const j=await r.json();
    const rows=(j.items||[]).map((x)=>`<div class="entry"><div class="time">${(x.ended_at||"").slice(0,16).replace("T"," ")}</div><div class="msg">Phòng ${x.room_code} • ${x.mode} • hạng ${x.placement} • ${x.exploded? "💥 nổ":"✅ sống"} • ${x.delta>=0?"+":""}${x.delta}đ</div></div>`).join("");
    body.innerHTML = rows || "<div class='msg'>Chưa có lịch sử.</div>";
  }catch{
    body.textContent="Lỗi tải lịch sử";
  }
}

function bind(){
  $("btnCloseCard").onclick=()=>$("dlgCard").close();
  if($("closeRanking")) $("closeRanking").onclick=()=>$("dlgRanking").close();
  if($("closeHistory")) $("closeHistory").onclick=()=>$("dlgHistory").close();

  $("btnCreate").onclick=()=>{
    const name=($("name").value||"Host").trim().slice(0,24);
    const modeKey=$("mode").value==="space"?"space":"classic";
    clearSession();
    send({type:"create_room",name,modeKey});
  };

  $("btnJoin").onclick=()=>{
    const name=($("name").value||"Khách").trim().slice(0,24);
    const code=($("code").value||"").trim().toUpperCase();
    if(!code) return alert("Nhập mã phòng");
    clearSession();
    send({type:"join_room",name,code});
  };

  $("btnStartGame").onclick=()=>send({type:"start_game",code:roomCode});
  $("btnDraw").onclick=()=>send({type:"action",code:roomCode,kind:"draw"});
  $("btnPeek").onclick=()=>send({type:"action",code:roomCode,kind:"peek"});

  $("btnPlay").onclick=()=>{
    if(!selected) return alert("Chưa chọn lá");
    send({type:"action",code:roomCode,kind:"play",payload:{cardId:selected}});
    selected=null; renderHand();
  };

  if($("btnRanking")) $("btnRanking").onclick=loadRanking;
  if($("btnHistory")) $("btnHistory").onclick=loadHistory;

  $("btnLeave").onclick=()=>{
    // Keep session so can come back
    toast("Bạn có thể vào lại link, không mất!");
    location.reload();
  };

  $("viewFan").onclick=()=>setHandView("fan");
  $("viewCompact").onclick=()=>setHandView("compact");

  $("btnCopyCode").onclick=()=>copyText($("inviteCode").textContent.trim());
  $("btnCopyLink").onclick=()=>copyText(inviteLink($("inviteCode").textContent.trim()));

  // iOS/Safari: when app returns from background, re-connect if needed
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible"){
      if(!ws || ws.readyState===3) connect();
    }
  });
}

function initFromUrl(){
  const u = new URL(location.href);
  const code = (u.searchParams.get("room")||"").trim().toUpperCase();
  if(code) $("code").value = code;
}

function init(){
  loadSession();
  if(session?.name) $("name").value = session.name;
  if(session?.code) $("code").value = session.code;

  initFromUrl();
  loadHandView();

  connect();
  bind();
  startRoomsPolling();
  showLobby();
}

init();
