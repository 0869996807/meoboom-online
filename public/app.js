const $=(id)=>document.getElementById(id);
const CARD={
BOOM:{name:"Mèo Boom 💥",desc:"Rút trúng mà không có Gỡ Boom → bị loại."},
DEFUSE:{name:"Gỡ Boom 🧯",desc:"Dùng khi rút trúng Boom, rồi đặt Boom lại."},
SOI:{name:"Soi 3 Lá 👀",desc:"Xem 3 lá trên cùng."},
XAO:{name:"Xáo Trộn 🔀",desc:"Xáo trộn chồng bài."},
NE:{name:"Né Lượt 🛑",desc:"Bỏ lượt."},
DAO:{name:"Đảo Chiều 🔁",desc:"Đổi chiều."},
CUOPN:{name:"Cướp Ngẫu Nhiên 🎯",desc:"Chọn người → cướp ngẫu nhiên."},
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

let ws=null, clientId=null, roomCode=null, state=null, hand=[], selected=null, pending=null;

function setConn(t,ok=false){ const el=$("conn"); el.textContent=t; el.classList.toggle("ok",ok); }
function connect(){
  const proto = location.protocol==="https:" ? "wss":"ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen=()=>setConn("Đã kết nối",true);
  ws.onclose=()=>setConn("Mất kết nối");
  ws.onerror=()=>setConn("Lỗi kết nối");
  ws.onmessage=(ev)=>onMsg(JSON.parse(ev.data));
}
function send(o){ if(ws && ws.readyState===1) ws.send(JSON.stringify(o)); }

function showLobby(){ $("lobby").classList.remove("hidden"); $("game").classList.add("hidden"); }
function showGame(){ $("lobby").classList.add("hidden"); $("game").classList.remove("hidden"); }

function onMsg(m){
  if(m.type==="hello_ok"){ clientId=m.clientId; return; }
  if(m.type==="error"){ alert(m.message); return; }
  if(m.type==="room_ok"){ roomCode=m.code; $("roomInfo").textContent=`Đang ở phòng: ${roomCode}`; showGame(); return; }
  if(m.type==="state"){ state=m.state; renderState(); return; }
  if(m.type==="hand"){ hand=m.hand||[]; renderHand(); return; }
  if(m.type==="peek"){ promptChoice("Lá trên cùng", `<p>${(m.cards||[]).map((c,i)=>`${i+1}. ${c}`).join("<br/>")||"Không đủ bài."}</p>`, false); return; }
  if(m.type==="prompt"){ pending=m.prompt; handlePrompt(pending); return; }
}

function renderState(){
  if(!state) return;
  $("pillRoom").textContent=`Phòng: ${state.code}`;
  $("pillMode").textContent=state.modeKey==="space"?"Bộ 2":"Bộ 1";
  $("pillPlayers").textContent=`Người: ${state.players.length}`;
  $("pillAlive").textContent=`Còn sống: ${state.players.filter(p=>p.alive).length}`;
  $("deckCount").textContent=state.deckCount;

  const turn=state.players[state.turnIndex];
  $("turnTitle").textContent=turn?`Lượt: ${turn.name}`:"—";
  $("turnSub").textContent=turn?`${turn.name} cần rút ${turn.mustDraw} lá.`:"—";

  const isHost = state.hostId===clientId;
  $("btnStartGame").classList.toggle("hidden", !(isHost && !state.started));
  const myTurn = state.started && turn && turn.id===clientId && turn.alive;
  $("btnDraw").disabled=!myTurn;
  $("btnEnd").disabled=!myTurn;

  renderLog();
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
    div.addEventListener("touchstart",()=>{ timer=setTimeout(()=>showCard(c.key),500); },{passive:true});
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

function bind(){
  $("btnCloseCard").onclick=()=>$("dlgCard").close();
  $("btnCreate").onclick=()=>{
    const name=($("name").value||"Host").trim().slice(0,24);
    const modeKey=$("mode").value==="space"?"space":"classic";
    send({type:"create_room",name,modeKey});
  };
  $("btnJoin").onclick=()=>{
    const name=($("name").value||"Khách").trim().slice(0,24);
    const code=($("code").value||"").trim().toUpperCase();
    if(!code) return alert("Nhập mã phòng");
    send({type:"join_room",name,code});
  };
  $("btnStartGame").onclick=()=>send({type:"start_game",code:roomCode});
  $("btnDraw").onclick=()=>send({type:"action",code:roomCode,kind:"draw"});
  $("btnEnd").onclick=()=>send({type:"action",code:roomCode,kind:"end"});
  $("btnPeek").onclick=()=>send({type:"action",code:roomCode,kind:"peek"});
  $("btnPlay").onclick=()=>{
    if(!selected) return alert("Chưa chọn lá");
    send({type:"action",code:roomCode,kind:"play",payload:{cardId:selected}});
    selected=null; renderHand();
  };
  $("btnLeave").onclick=()=>location.reload();
}

connect(); bind(); showLobby();
