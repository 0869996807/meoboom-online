import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** ===== Helpers ===== **/
function uuid(){ return crypto.randomUUID(); }
function token(){ return crypto.randomBytes(16).toString("hex"); }
function nowHHMM(){
  return new Date().toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"});
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function normName(s){
  return (s||"").toString().trim().replace(/\s+/g," ").slice(0,24);
}
function nameTaken(room, name, exceptPlayerToken=null){
  const n = name.toLowerCase();
  return room.players.some(p => p.name.toLowerCase()===n && p.playerToken!==exceptPlayerToken);
}

/** ===== Cards / Deck ===== **/
const CARD = {
  BOOM:{name:"Mèo Boom 💥",desc:"Rút trúng mà không có Gỡ Boom → bị loại."},
  DEFUSE:{name:"Gỡ Boom 🧯",desc:"Dùng khi rút trúng Boom, rồi đặt Boom lại."},
  SOI:{name:"Soi 3 Lá 👀",desc:"Xem 3 lá trên cùng."},
  XAO:{name:"Xáo Trộn 🔀",desc:"Xáo trộn chồng bài."},
  NE:{name:"Né Lượt 🛑",desc:"Bỏ lượt (không cần rút)."},
  DAO:{name:"Đảo Chiều 🔁",desc:"Đổi chiều chơi."},
  CUOPN:{name:"Cướp Ngẫu Nhiên 🎯",desc:"Chọn người → lấy ngẫu nhiên 1 lá."},
  TAN2:{name:"Chỉ Định Rút 2 🧠",desc:"Người kế tiếp rút thêm 2 lá."},
  COMBO:{name:"Bộ Đôi 🐾🐾",desc:"(MVP) Online chưa đủ UI."},
  RAC:{name:"Mèo Tấu Hài 😺",desc:"Không tác dụng."},
  RADAR:{name:"Radar Vũ Trụ 👁",desc:"Xem 5 lá trên cùng."},
  TOC:{name:"Tăng Tốc 🚀",desc:"Rút thêm 1 lá."},
  DICH:{name:"Dịch Chuyển 🌀",desc:"Đảo 3 lá trên cùng."},
  TAN3:{name:"Tấn Công 3 ⚡",desc:"Người kế tiếp rút thêm 3 lá."},
  NGUOC:{name:"Đảo Ngược ⏪",desc:"Quay lại lượt trước."},
  BIEN:{name:"Biến Hình 🎭",desc:"Chọn biến thành 1 hành động."},
};

function makeRoomCode(){
  const a="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c=""; for(let i=0;i<5;i++) c+=a[Math.floor(Math.random()*a.length)];
  return c;
}

function buildDeck(players, modeKey){
  const boom = players-1;
  const defuse = Math.max(8, Math.ceil(players));
  const base = modeKey==="space"
    ? [["RADAR",8],["TOC",6],["DICH",6],["TAN3",5],["NGUOC",6],["BIEN",12],["RAC",20]]
    : [["SOI",8],["XAO",6],["NE",8],["DAO",6],["CUOPN",8],["TAN2",5],["COMBO",10],["RAC",20]];
  const deck=[];
  base.forEach(([k,n])=>{ for(let i=0;i<n;i++) deck.push({key:k,id:uuid()}); });
  const boomPool = Array.from({length:boom},()=>({key:"BOOM",id:uuid()}));
  const defusePool = Array.from({length:defuse},()=>({key:"DEFUSE",id:uuid()}));
  shuffle(deck);
  return {deck, boomPool, defusePool};
}

function nextAliveIndex(players, from, step){
  const n=players.length; let idx=from;
  for(let t=0;t<n;t++){
    idx=(idx+step+n)%n;
    if(players[idx].alive) return idx;
  }
  return from;
}

/** ===== Rooms ===== **/
/**
room = {
  code, hostPlayerToken,
  modeKey, started,
  direction, turnIndex,
  deck, boomPool, defusePool,
  players: [{wsId, playerToken, name, alive, hand, mustDraw}],
  log: [],
  pending: null,
  turnDeadline: 0,
  turnTimer: NodeJS.Timeout|null
}
*/
const rooms=new Map();          // code -> room
const clients=new Map();        // wsId -> ws

function publicState(room){
  return {
    code: room.code,
    hostPlayerToken: room.hostPlayerToken,
    modeKey: room.modeKey,
    started: room.started,
    direction: room.direction,
    turnIndex: room.turnIndex,
    deckCount: room.deck.length,
    log: room.log.slice(0,80),
    turnDeadline: room.turnDeadline,
    players: room.players.map(p=>({
      playerToken: p.playerToken,
      name: p.name,
      alive: p.alive,
      handCount: p.hand.length,
      mustDraw: p.mustDraw,
      connected: !!clients.get(p.wsId)
    }))
  };
}

function send(ws,obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function sendToWsId(wsId,obj){ send(clients.get(wsId), obj); }
function broadcast(room,obj){ room.players.forEach(p=>sendToWsId(p.wsId,obj)); }
function sendPrivate(room, playerToken, obj){
  const p = room.players.find(x=>x.playerToken===playerToken);
  if(p) sendToWsId(p.wsId, obj);
}
function log(room,msg,cls=""){ room.log.unshift({t:nowHHMM(),msg,cls}); }

function currentPlayer(room){ return room.players[room.turnIndex]; }
function findPlayerByWs(room, wsId){ return room.players.find(p=>p.wsId===wsId); }
function findPlayerByToken(room, playerToken){ return room.players.find(p=>p.playerToken===playerToken); }

function sync(room){
  broadcast(room,{type:"state",state:publicState(room)});
  room.players.forEach(p=>sendToWsId(p.wsId,{type:"hand",hand:p.hand,youToken:p.playerToken}));
  if(room.pending) sendPrivate(room, room.pending.forPlayerToken, {type:"prompt", prompt: room.pending});
}

function deal(room){
  room.players.forEach(p=>{p.hand=[];p.alive=true;p.mustDraw=1;});
  // each gets 1 defuse
  room.players.forEach(p=>p.hand.push(room.defusePool.pop()));
  for(let r=0;r<7;r++) room.players.forEach(p=>p.hand.push(room.deck.pop()));
  room.deck.push(...room.defusePool, ...room.boomPool);
  room.defusePool=[]; room.boomPool=[];
  shuffle(room.deck);
}

function winCheck(room){
  const alive=room.players.filter(p=>p.alive);
  if(alive.length<=1){
    if(alive.length===1) log(room,`🎉 ${alive[0].name} thắng!`,"ok");
    else log(room,"Không còn ai sống...","bad");
    stopTurnTimer(room);
    return true;
  }
  return false;
}

/** ===== Turn countdown (20s auto-draw) ===== **/
const TURN_SECONDS = 20;

function stopTurnTimer(room){
  if(room.turnTimer){
    clearInterval(room.turnTimer);
    room.turnTimer = null;
  }
}

function startOrResetTurnTimer(room){
  // Called whenever it becomes a player's turn OR after they perform any action
  room.turnDeadline = Date.now() + TURN_SECONDS*1000;

  if(room.turnTimer) return;

  room.turnTimer = setInterval(()=>{
    if(!room.started) return;
    if(room.pending) return; // waiting for prompt
    if(winCheck(room)) return;

    const p = currentPlayer(room);
    if(!p || !p.alive) return;

    const remaining = room.turnDeadline - Date.now();
    if(remaining > 0) return;

    // Timeout: auto draw once if still needs to draw, otherwise auto end turn
    if(p.mustDraw > 0){
      actDraw(room, p.playerToken, true);
    }else{
      actEnd(room, p.playerToken, true);
    }
    // actDraw/actEnd will reset deadline
  }, 500);
}

/** ===== Actions ===== **/
function isMyTurn(room, playerToken){
  const p = currentPlayer(room);
  return p && p.alive && p.playerToken===playerToken;
}

function actPeek(room, playerToken){
  if(!isMyTurn(room, playerToken)) return sendPrivate(room, playerToken, {type:"error",message:"Chưa tới lượt bạn."});
  const n = room.modeKey==="space" ? 5 : 3;
  const top = room.deck.slice(-n).reverse().map(c=>CARD[c.key]?.name||c.key);
  sendPrivate(room, playerToken, {type:"peek",cards:top});
  startOrResetTurnTimer(room);
}

function actDraw(room, playerToken, auto=false){
  if(!isMyTurn(room, playerToken)) return;
  const p = currentPlayer(room);

  if(room.deck.length===0){
    log(room,"Hết bài!");
    sync(room);
    startOrResetTurnTimer(room);
    return;
  }

  const c=room.deck.pop();
  p.hand.push(c);
  log(room, `${auto?"⏱️ ":""}${p.name} rút: ${CARD[c.key]?.name||c.key}`);

  if(c.key==="BOOM"){
    const defIdx=p.hand.findIndex(x=>x.key==="DEFUSE");
    if(defIdx>=0){
      p.hand.splice(defIdx,1);
      p.hand=p.hand.filter(x=>x.id!==c.id);
      log(room, `${p.name} dùng Gỡ Boom 🧯`, "ok");
      room.pending={id:uuid(), type:"insert_boom", forPlayerToken: playerToken, data:{}};
      sync(room);
      // timer pauses while pending; will resume when resolved
      return;
    }else{
      p.alive=false;
      p.hand=p.hand.filter(x=>x.id!==c.id);
      log(room, `💥 ${p.name} bị loại.`, "bad");
      if(!winCheck(room)){
        room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
        startOrResetTurnTimer(room);
      }
      sync(room);
      return;
    }
  }

  p.mustDraw=Math.max(0,p.mustDraw-1);
  sync(room);
  startOrResetTurnTimer(room);
}

function actEnd(room, playerToken, auto=false){
  if(!isMyTurn(room, playerToken)) return;
  const p = currentPlayer(room);
  if(p.mustDraw>0){
    if(!auto) sendPrivate(room, playerToken, {type:"error",message:`Bạn chưa rút đủ (${p.mustDraw}).`});
    startOrResetTurnTimer(room);
    return;
  }
  p.mustDraw=1;
  room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
  log(room, `${auto?"⏱️ ":""}Kết thúc lượt → ${currentPlayer(room).name}`);
  sync(room);
  startOrResetTurnTimer(room);
}

function removeFromHand(p, cardId){
  const idx=p.hand.findIndex(x=>x.id===cardId);
  if(idx<0) return null;
  return p.hand.splice(idx,1)[0];
}

function actPlay(room, playerToken, payload){
  if(!isMyTurn(room, playerToken)) return sendPrivate(room, playerToken, {type:"error",message:"Chưa tới lượt bạn."});
  const p = currentPlayer(room);

  const cardId = payload?.cardId;
  if(!cardId) return;
  const card = removeFromHand(p, cardId);
  if(!card) return sendPrivate(room, playerToken, {type:"error",message:"Không tìm thấy lá."});
  if(["BOOM","DEFUSE"].includes(card.key)){
    p.hand.push(card);
    return sendPrivate(room, playerToken, {type:"error",message:"Không thể đánh lá này."});
  }

  log(room, `${p.name} đánh: ${CARD[card.key]?.name||card.key}`);

  switch(card.key){
    case "XAO": shuffle(room.deck); log(room,"Chồng bài đã xáo."); break;
    case "NE": p.mustDraw=0; log(room,`${p.name} né lượt.`); break;
    case "DAO": room.direction*=-1; log(room,`Đổi chiều: ${room.direction===1?"thuận":"ngược"}.`); break;
    case "TAN2":
    case "TAN3":{
      const n = card.key==="TAN3"?3:2;
      const ni = nextAliveIndex(room.players, room.turnIndex, room.direction);
      room.players[ni].mustDraw += n;
      log(room,`${room.players[ni].name} rút thêm ${n} lá.`,"bad");
      break;
    }
    case "DICH":{
      const n=Math.min(3,room.deck.length);
      const top=[]; for(let i=0;i<n;i++) top.push(room.deck.pop());
      shuffle(top); room.deck.push(...top);
      log(room,"Dịch chuyển 3 lá trên cùng."); break;
    }
    case "TOC": p.mustDraw += 1; log(room,`${p.name} tăng tốc: rút thêm 1 lá.`); break;
    case "SOI":
    case "RADAR":{
      const n = card.key==="RADAR"?5:3;
      const top = room.deck.slice(-n).reverse().map(x=>CARD[x.key]?.name||x.key);
      sendPrivate(room, playerToken, {type:"peek",cards:top});
      break;
    }
    case "NGUOC":{
      const prev = nextAliveIndex(room.players, room.turnIndex, -room.direction);
      room.turnIndex = prev;
      log(room,`Quay lại lượt ${room.players[prev].name}.`);
      break;
    }
    case "BIEN":{
      room.pending={id:uuid(),type:"bien_hinh",forPlayerToken:playerToken,data:{}};
      sync(room);
      return; // pause timer until prompt resolved
    }
    default:
      log(room,"(MVP) Lá này chưa có hiệu ứng online.");
      break;
  }

  sync(room);
  startOrResetTurnTimer(room);
}

function resolvePrompt(room, playerToken, promptId, payload){
  const pend = room.pending;
  if(!pend || pend.forPlayerToken!==playerToken || pend.id!==promptId) return;

  room.pending = null;

  if(pend.type==="insert_boom"){
    const pos = payload?.pos || "top";
    const boom={key:"BOOM",id:uuid()};
    if(pos==="top") room.deck.push(boom);
    else if(pos==="bottom") room.deck.unshift(boom);
    else {
      const mid=Math.floor(Math.random()*(room.deck.length+1));
      room.deck.splice(mid,0,boom);
    }
    log(room, `${currentPlayer(room).name} đặt Boom lại (${pos}).`);
    sync(room);
    startOrResetTurnTimer(room);
    return;
  }

  if(pend.type==="bien_hinh"){
    const chosen = payload?.key;
    if(!chosen || ["BOOM","DEFUSE"].includes(chosen) || !CARD[chosen]){
      sendPrivate(room, playerToken, {type:"error",message:"Chọn không hợp lệ."});
      sync(room);
      startOrResetTurnTimer(room);
      return;
    }
    log(room, `${currentPlayer(room).name} biến hình: ${CARD[chosen].name}`);
    // Apply a limited subset as above
    actPlay(room, playerToken, {cardId:null}); // no-op to satisfy structure
    // Manually apply same switch (without consuming a card)
    const p = currentPlayer(room);
    switch(chosen){
      case "XAO": shuffle(room.deck); log(room,"Chồng bài đã xáo."); break;
      case "NE": p.mustDraw=0; log(room,`${p.name} né lượt.`); break;
      case "DAO": room.direction*=-1; log(room,`Đổi chiều: ${room.direction===1?"thuận":"ngược"}.`); break;
      default: log(room,"(MVP) Biến hình: hiệu ứng chưa đầy đủ."); break;
    }
    sync(room);
    startOrResetTurnTimer(room);
    return;
  }
}

/** ===== WebSocket protocol =====
Client -> Server:
- create_room {name, modeKey}
- join_room {code, name}
- resume {code, playerToken}         // rejoin after disconnect
- start_game {code}
- action {code, kind, payload}
- prompt_reply {code, promptId, payload}

Server -> Client:
- hello_ok {wsId}
- room_ok {code, playerToken, state}
- state {state}
- hand {hand, youToken}
- prompt {prompt}
- error {message}
*/
wss.on("connection",(ws)=>{
  const wsId=uuid();
  clients.set(wsId,ws);
  send(ws,{type:"hello_ok",wsId});

  ws.on("message",(buf)=>{
    let msg; try{msg=JSON.parse(buf.toString("utf8"));}catch{return;}
    const t=msg.type;

    if(t==="create_room"){
      const modeKey = msg.modeKey==="space"?"space":"classic";
      let code=makeRoomCode(); while(rooms.has(code)) code=makeRoomCode();

      const room={
        code,
        hostPlayerToken: null,
        modeKey,
        started:false,
        direction:1,
        turnIndex:0,
        deck:[], boomPool:[], defusePool:[],
        players:[],
        log:[],
        pending:null,
        turnDeadline: 0,
        turnTimer: null
      };
      rooms.set(code,room);

      const name = normName(msg.name||"Host");
      const pTok = token();

      room.hostPlayerToken = pTok;
      room.players.push({wsId, playerToken:pTok, name, alive:true, hand:[], mustDraw:1});

      log(room,`Phòng ${code} được tạo bởi ${name}.`);
      send(ws,{type:"room_ok",code,playerToken:pTok,state:publicState(room)});
      sync(room);
      return;
    }

    if(t==="join_room"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng."});
      if(room.started) return send(ws,{type:"error",message:"Phòng đã bắt đầu."});
      if(room.players.length>=10) return send(ws,{type:"error",message:"Phòng đủ 10 người."});

      const name = normName(msg.name||`Người ${room.players.length+1}`);
      if(!name) return send(ws,{type:"error",message:"Tên không hợp lệ."});
      if(nameTaken(room, name)) return send(ws,{type:"error",message:"Tên đã có người dùng trong phòng. Hãy chọn tên khác."});

      const pTok = token();
      room.players.push({wsId, playerToken:pTok, name, alive:true, hand:[], mustDraw:1});
      log(room,`${name} vào phòng.`);
      send(ws,{type:"room_ok",code,playerToken:pTok,state:publicState(room)});
      sync(room);
      return;
    }

    if(t==="resume"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng để vào lại."});

      const pTok=(msg.playerToken||"").toString().trim();
      const p = findPlayerByToken(room, pTok);
      if(!p) return send(ws,{type:"error",message:"Không tìm thấy người chơi (token sai). Hãy vào phòng lại bằng tên mới."});

      // attach new wsId
      p.wsId = wsId;
      log(room, `${p.name} đã kết nối lại.`, "ok");
      send(ws,{type:"room_ok",code,playerToken:pTok,state:publicState(room)});
      sync(room);
      // ensure timer running if game started
      if(room.started) startOrResetTurnTimer(room);
      return;
    }

    if(t==="start_game"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng."});
      const me = findPlayerByWs(room, wsId);
      if(!me) return send(ws,{type:"error",message:"Bạn chưa ở trong phòng."});
      if(me.playerToken!==room.hostPlayerToken) return send(ws,{type:"error",message:"Chỉ host được bắt đầu."});
      if(room.players.length<4) return send(ws,{type:"error",message:"Cần ít nhất 4 người."});
      if(room.started) return;

      const {deck,boomPool,defusePool}=buildDeck(room.players.length, room.modeKey);
      room.deck=deck; room.boomPool=boomPool; room.defusePool=defusePool;
      room.started=true; room.direction=1; room.turnIndex=0; room.pending=null;
      deal(room);
      log(room,`Bắt đầu ván • ${room.players.length} người.`);
      sync(room);
      startOrResetTurnTimer(room);
      return;
    }

    if(t==="action"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.started) return send(ws,{type:"error",message:"Phòng chưa bắt đầu."});
      const me = findPlayerByWs(room, wsId);
      if(!me) return send(ws,{type:"error",message:"Bạn chưa ở trong phòng."});
      if(room.pending) return send(ws,{type:"error",message:"Đang chờ lựa chọn."});

      const kind=msg.kind;
      if(kind==="peek") return actPeek(room, me.playerToken);
      if(kind==="draw") return actDraw(room, me.playerToken, false);
      if(kind==="end")  return actEnd(room, me.playerToken, false);
      if(kind==="play") return actPlay(room, me.playerToken, msg.payload||{});
      return;
    }

    if(t==="prompt_reply"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.pending) return;
      const me = findPlayerByWs(room, wsId);
      if(!me) return;
      resolvePrompt(room, me.playerToken, msg.promptId, msg.payload||{});
      return;
    }

    if(t==="rename"){ // optional: enforce unique names if you add later
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return;
      const me=findPlayerByWs(room, wsId);
      if(!me) return;
      const newName = normName(msg.name);
      if(!newName) return send(ws,{type:"error",message:"Tên không hợp lệ."});
      if(nameTaken(room, newName, me.playerToken)) return send(ws,{type:"error",message:"Tên đã có người dùng trong phòng."});
      me.name=newName;
      log(room,`${me.name} đổi tên.`);
      sync(room);
      return;
    }
  });

  ws.on("close",()=>{
    clients.delete(wsId);
    // keep player slot for rejoin
    for(const room of rooms.values()){
      const p = findPlayerByWs(room, wsId);
      if(p){
        log(room, `${p.name} mất kết nối (có thể vào lại).`);
        sync(room);
      }
    }
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log("Server running on",PORT));
