import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const CARD = {
  BOOM:{name:"Mèo Boom 💥",desc:"Rút trúng mà không có Gỡ Boom → bị loại."},
  DEFUSE:{name:"Gỡ Boom 🧯",desc:"Dùng khi rút trúng Boom, rồi đặt Boom lại."},
  SOI:{name:"Soi 3 Lá 👀",desc:"Xem 3 lá trên cùng."},
  XAO:{name:"Xáo Trộn 🔀",desc:"Xáo trộn chồng bài."},
  NE:{name:"Né Lượt 🛑",desc:"Bỏ lượt (không cần rút)."},
  DAO:{name:"Đảo Chiều 🔁",desc:"Đổi chiều chơi."},
  CUOPN:{name:"Cướp Ngẫu Nhiên 🎯",desc:"Chọn người → lấy ngẫu nhiên 1 lá."},
  TAN2:{name:"Chỉ Định Rút 2 🧠",desc:"Người kế tiếp rút thêm 2 lá."},
  COMBO:{name:"Bộ Đôi 🐾🐾",desc:"Đánh 2 COMBO → lấy ngẫu nhiên 1 lá từ người khác."},
  RAC:{name:"Mèo Tấu Hài 😺",desc:"Không tác dụng."},
  RADAR:{name:"Radar Vũ Trụ 👁",desc:"Xem 5 lá trên cùng."},
  TOC:{name:"Tăng Tốc 🚀",desc:"Bạn phải rút thêm 1 lá trong lượt này."},
  DICH:{name:"Dịch Chuyển 🌀",desc:"Đảo ngẫu nhiên 3 lá trên cùng."},
  TAN3:{name:"Tấn Công 3 ⚡",desc:"Người kế tiếp rút thêm 3 lá."},
  NGUOC:{name:"Đảo Ngược ⏪",desc:"Quay lại lượt người vừa chơi."},
  BIEN:{name:"Biến Hình 🎭",desc:"Chọn biến thành 1 hành động (không Boom)."},
};

function uuid(){ return crypto.randomUUID(); }
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function nowHHMM(){
  return new Date().toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"});
}
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

const rooms=new Map();
const clients=new Map(); // id->ws

function publicState(room){
  return {
    code: room.code, hostId: room.hostId, modeKey: room.modeKey, started: room.started,
    direction: room.direction, turnIndex: room.turnIndex, deckCount: room.deck.length,
    log: room.log.slice(0,80),
    players: room.players.map(p=>({id:p.id,name:p.name,alive:p.alive,handCount:p.hand.length,mustDraw:p.mustDraw}))
  };
}
function send(ws,obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(room,obj){ room.players.forEach(p=>send(clients.get(p.id),obj)); }
function sendPrivate(room,id,obj){ send(clients.get(id),obj); }
function log(room,msg,cls=""){ room.log.unshift({t:nowHHMM(),msg,cls}); }
function currentPlayer(room){ return room.players[room.turnIndex]; }
function sync(room){
  broadcast(room,{type:"state",state:publicState(room)});
  room.players.forEach(p=>sendPrivate(room,p.id,{type:"hand",hand:p.hand,youId:p.id}));
  if(room.pending) sendPrivate(room, room.pending.forPlayerId, {type:"prompt", prompt: room.pending});
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
    return true;
  }
  return false;
}

wss.on("connection",(ws)=>{
  const id=uuid();
  clients.set(id,ws);
  send(ws,{type:"hello_ok",clientId:id});

  ws.on("message",(buf)=>{
    let msg; try{msg=JSON.parse(buf.toString("utf8"));}catch{return;}
    const t=msg.type;

    if(t==="create_room"){
      const modeKey = msg.modeKey==="space"?"space":"classic";
      let code=makeRoomCode(); while(rooms.has(code)) code=makeRoomCode();
      const room={code,hostId:id,modeKey,started:false,direction:1,turnIndex:0,deck:[],boomPool:[],defusePool:[],players:[],log:[],pending:null};
      rooms.set(code,room);
      const name=(msg.name||"Host").toString().slice(0,24);
      room.players.push({id,name,alive:true,hand:[],mustDraw:1});
      log(room,`Phòng ${code} được tạo bởi ${name}.`);
      send(ws,{type:"room_ok",code,state:publicState(room)});
      sync(room);
      return;
    }

    if(t==="join_room"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng."});
      if(room.started) return send(ws,{type:"error",message:"Phòng đã bắt đầu."});
      if(room.players.length>=10) return send(ws,{type:"error",message:"Phòng đủ 10 người."});
      const name=(msg.name||`Người ${room.players.length+1}`).toString().slice(0,24);
      room.players.push({id,name,alive:true,hand:[],mustDraw:1});
      log(room,`${name} vào phòng.`);
      send(ws,{type:"room_ok",code,state:publicState(room)});
      sync(room);
      return;
    }

    if(t==="start_game"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng."});
      if(room.hostId!==id) return send(ws,{type:"error",message:"Chỉ host được bắt đầu."});
      if(room.players.length<4) return send(ws,{type:"error",message:"Cần ít nhất 4 người."});
      const {deck,boomPool,defusePool}=buildDeck(room.players.length, room.modeKey);
      room.deck=deck; room.boomPool=boomPool; room.defusePool=defusePool;
      room.started=true; room.direction=1; room.turnIndex=0; room.pending=null;
      deal(room);
      log(room,`Bắt đầu ván • ${room.players.length} người.`);
      sync(room);
      return;
    }

    if(t==="action"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.started) return;
      if(room.pending) return send(ws,{type:"error",message:"Đang chờ lựa chọn."});
      const p=currentPlayer(room);
      if(!p.alive || p.id!==id) return send(ws,{type:"error",message:"Chưa tới lượt bạn."});

      if(msg.kind==="peek"){
        const n = room.modeKey==="space" ? 5 : 3;
        const top = room.deck.slice(-n).reverse().map(c=>CARD[c.key]?.name||c.key);
        return send(ws,{type:"peek",cards:top});
      }

      if(msg.kind==="draw"){
        if(room.deck.length===0){ log(room,"Hết bài!"); sync(room); return; }
        const c=room.deck.pop();
        p.hand.push(c);
        log(room,`${p.name} rút: ${CARD[c.key]?.name||c.key}`);
        if(c.key==="BOOM"){
          const defIdx=p.hand.findIndex(x=>x.key==="DEFUSE");
          if(defIdx>=0){
            p.hand.splice(defIdx,1);
            p.hand=p.hand.filter(x=>x.id!==c.id);
            log(room,`${p.name} dùng Gỡ Boom 🧯`,"ok");
            room.pending={id:uuid(),type:"insert_boom",forPlayerId:id,data:{}};
            sync(room); return;
          }else{
            p.alive=false;
            p.hand=p.hand.filter(x=>x.id!==c.id);
            log(room,`💥 ${p.name} bị loại.`,"bad");
            if(!winCheck(room)){
              room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
            }
            sync(room); return;
          }
        }
        p.mustDraw=Math.max(0,p.mustDraw-1);
        sync(room); return;
      }

      if(msg.kind==="end"){
        if(p.mustDraw>0) return send(ws,{type:"error",message:`Bạn chưa rút đủ (${p.mustDraw}).`});
        p.mustDraw=1;
        room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
        sync(room); return;
      }

      if(msg.kind==="play"){
        const cardId = msg.payload?.cardId;
        const idx=p.hand.findIndex(x=>x.id===cardId);
        if(idx<0) return send(ws,{type:"error",message:"Không tìm thấy lá."});
        const card=p.hand.splice(idx,1)[0];
        if(["BOOM","DEFUSE"].includes(card.key)){ p.hand.push(card); return send(ws,{type:"error",message:"Không thể đánh lá này."}); }
        log(room,`${p.name} đánh: ${CARD[card.key]?.name||card.key}`);
        // simple effects
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
            send(ws,{type:"peek",cards:top});
            break;
          }
          case "NGUOC":{
            const prev = nextAliveIndex(room.players, room.turnIndex, -room.direction);
            room.turnIndex = prev;
            log(room,`Quay lại lượt ${room.players[prev].name}.`);
            break;
          }
          case "BIEN":{
            room.pending={id:uuid(),type:"bien_hinh",forPlayerId:id,data:{}};
            sync(room); return;
          }
          default:
            log(room,"(MVP) Lá này chưa có hiệu ứng online."); break;
        }
        sync(room); return;
      }
    }

    if(t==="prompt_reply"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.pending) return;
      if(room.pending.forPlayerId!==id) return;
      if(room.pending.id !== msg.promptId) return;

      const pend=room.pending;
      room.pending=null;

      if(pend.type==="insert_boom"){
        const pos = msg.payload?.pos || "top";
        const boom={key:"BOOM",id:uuid()};
        if(pos==="top") room.deck.push(boom);
        else if(pos==="bottom") room.deck.unshift(boom);
        else {
          const mid=Math.floor(Math.random()*(room.deck.length+1));
          room.deck.splice(mid,0,boom);
        }
        log(room,`${currentPlayer(room).name} đặt Boom lại (${pos}).`);
        sync(room); return;
      }

      if(pend.type==="bien_hinh"){
        const chosen = msg.payload?.key;
        if(!chosen || ["BOOM","DEFUSE"].includes(chosen) || !CARD[chosen]){ send(ws,{type:"error",message:"Chọn không hợp lệ."}); sync(room); return; }
        log(room,`${currentPlayer(room).name} biến hình: ${CARD[chosen].name}`);
        // treat as playing that card with no extra payload
        msg.type="action";
        // quick: push a fake action by directly applying same switch
        const p=currentPlayer(room);
        switch(chosen){
          case "XAO": shuffle(room.deck); log(room,"Chồng bài đã xáo."); break;
          case "NE": p.mustDraw=0; log(room,`${p.name} né lượt.`); break;
          case "DAO": room.direction*=-1; log(room,`Đổi chiều: ${room.direction===1?"thuận":"ngược"}.`); break;
          default: log(room,"(MVP) Biến hình xong nhưng hiệu ứng chưa đầy đủ."); break;
        }
        sync(room); return;
      }
    }
  });

  ws.on("close",()=>{ clients.delete(id); });
});

server.listen(PORT,"0.0.0.0",()=>console.log("Server on",PORT));
