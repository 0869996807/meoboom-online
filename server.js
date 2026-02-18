import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

// Render best practice: use a persistent disk mounted at /var/data (optional).
// If not mounted, it will still work but ranking/history resets on redeploy.
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "meoboom.sqlite");

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

sqlite3.verbose();
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players(
    player_token TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1000,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS matches(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS match_results(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    player_token TEXT NOT NULL,
    display_name TEXT NOT NULL,
    placement INTEGER NOT NULL,
    exploded INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    ended_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_results_token ON match_results(player_token)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_results_match ON match_results(match_id)`);
});

function dbRun(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.run(sql, params, function(err){
      if(err) reject(err); else resolve(this);
    });
  });
}
function dbAll(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.all(sql, params, (err, rows)=> err?reject(err):resolve(rows));
  });
}
function dbGet(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.get(sql, params, (err, row)=> err?reject(err):resolve(row));
  });
}

async function upsertPlayer(playerToken, displayName){
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO players(player_token, display_name, updated_at)
     VALUES(?,?,?)
     ON CONFLICT(player_token) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`,
    [playerToken, displayName, now]
  );
}

async function createMatch(roomCode, mode){
  const now = new Date().toISOString();
  const r = await dbRun(`INSERT INTO matches(room_code, mode, started_at) VALUES(?,?,?)`, [roomCode, mode, now]);
  return r.lastID;
}

async function endMatch(matchId){
  const now = new Date().toISOString();
  await dbRun(`UPDATE matches SET ended_at=? WHERE id=?`, [now, matchId]);
  return now;
}

async function addResult(matchId, playerToken, displayName, placement, exploded, delta, endedAt){
  await dbRun(
    `INSERT INTO match_results(match_id, player_token, display_name, placement, exploded, delta, ended_at)
     VALUES(?,?,?,?,?,?,?)`,
    [matchId, playerToken, displayName, placement, exploded?1:0, delta, endedAt]
  );
}

async function applyPlayerDelta(playerToken, displayName, delta, isWin){
  const row = await dbGet(`SELECT rating,wins,losses,games FROM players WHERE player_token=?`, [playerToken]);
  const rating0 = row?.rating ?? 1000;
  const wins0 = row?.wins ?? 0;
  const losses0 = row?.losses ?? 0;
  const games0 = row?.games ?? 0;
  const rating = Math.max(0, rating0 + delta);
  const wins = wins0 + (isWin ? 1 : 0);
  const losses = losses0 + (isWin ? 0 : 1);
  const games = games0 + 1;
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO players(player_token, display_name, rating, wins, losses, games, updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(player_token) DO UPDATE SET display_name=excluded.display_name, rating=?, wins=?, losses=?, games=?, updated_at=?`,
    [playerToken, displayName, rating, wins, losses, games, now, rating, wins, losses, games, now]
  );
}

/** ===== Express (API + static) ===== **/
const app = express();
app.use(express.json({limit:"1mb"}));
app.use(express.static("public"));

app.get("/api/health", (_req,res)=>res.json({ok:true, db: DB_PATH}));

app.get("/api/ranking", async (req,res)=>{
  try{
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit||"50",10)));
    const items = await dbAll(
      `SELECT display_name, rating, wins, losses, games
       FROM players
       WHERE games>0
       ORDER BY rating DESC, wins DESC, games DESC
       LIMIT ?`,
      [limit]
    );
    res.json({items});
  }catch(e){
    res.status(500).json({error:"ranking failed", detail:String(e)});
  }
});

app.get("/api/history", async (req,res)=>{
  try{
    const tok = (req.query.player_token||"").toString().trim();
    if(!tok) return res.status(400).json({error:"missing player_token"});
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit||"30",10)));
    const items = await dbAll(
      `SELECT mr.ended_at, m.room_code, m.mode, mr.placement, mr.exploded, mr.delta
       FROM match_results mr
       JOIN matches m ON m.id = mr.match_id
       WHERE mr.player_token=?
       ORDER BY mr.ended_at DESC, mr.id DESC
       LIMIT ?`,
      [tok, limit]
    );
    res.json({items});
  }catch(e){
    res.status(500).json({error:"history failed", detail:String(e)});
  }
});

/** ===== WebSocket realtime game ===== **/
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function uuid(){ return crypto.randomUUID(); }
function token(){ return crypto.randomBytes(16).toString("hex"); }
function nowHHMM(){ return new Date().toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"}); }
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function normName(s){ return (s||"").toString().trim().replace(/\s+/g," ").slice(0,24); }
function nameTaken(room, name, exceptPlayerToken=null){
  const n = name.toLowerCase();
  return room.players.some(p => p.name.toLowerCase()===n && p.playerToken!==exceptPlayerToken);
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

const rooms=new Map(); // code -> room
const clients=new Map(); // wsId -> ws

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

function sync(room){
  broadcast(room,{type:"state",state:publicState(room)});
  room.players.forEach(p=>sendToWsId(p.wsId,{type:"hand",hand:p.hand,youToken:p.playerToken}));
  if(room.pending) sendPrivate(room, room.pending.forPlayerToken, {type:"prompt", prompt: room.pending});
}

function deal(room){
  room.players.forEach(p=>{p.hand=[];p.alive=true;p.mustDraw=1;p.exploded=false;});
  room.players.forEach(p=>p.hand.push(room.defusePool.pop()));
  for(let r=0;r<7;r++) room.players.forEach(p=>p.hand.push(room.deck.pop()));
  room.deck.push(...room.defusePool, ...room.boomPool);
  room.defusePool=[]; room.boomPool=[];
  shuffle(room.deck);
}

const TURN_SECONDS = 20;
function stopTurnTimer(room){
  if(room.turnTimer){ clearInterval(room.turnTimer); room.turnTimer=null; }
}
function startOrResetTurnTimer(room){
  room.turnDeadline = Date.now() + TURN_SECONDS*1000;
  if(room.turnTimer) return;
  room.turnTimer = setInterval(()=>{
    if(!room.started) return;
    if(room.pending) return;
    const p = room.players[room.turnIndex];
    if(!p || !p.alive) return;
    const remaining = room.turnDeadline - Date.now();
    if(remaining > 0) return;
    actDraw(room, p.playerToken, true);
  }, 500);
}
function announceNextDrawer(room){
  const p = room.players[room.turnIndex];
  if(p && p.alive) log(room, `Đến lượt ${p.name} rút.`);
}
function advanceIfDoneDrawing(room){
  const p = room.players[room.turnIndex];
  if(!p) return;
  if(p.mustDraw<=0){
    p.mustDraw=1;
    room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
    announceNextDrawer(room);
  }else{
    announceNextDrawer(room);
  }
}

async function persistEnd(room){
  if(!room.matchId) return;
  const endedAt = await endMatch(room.matchId);

  const alive = room.players.filter(p=>p.alive);
  const winnerToken = alive.length===1 ? alive[0].playerToken : null;

  // order: winner first, then non-exploded, then exploded
  const ordered = [...room.players].sort((a,b)=>{
    if(a.playerToken===winnerToken) return -1;
    if(b.playerToken===winnerToken) return 1;
    if(a.exploded && !b.exploded) return 1;
    if(!a.exploded && b.exploded) return -1;
    return 0;
  });

  for(let i=0;i<ordered.length;i++){
    const p=ordered[i];
    const placement=i+1;
    let delta = (placement===1) ? 25 : -10;
    if(p.exploded) delta -= 15;
    if(placement<=3) delta += 5;

    await addResult(room.matchId, p.playerToken, p.name, placement, p.exploded, delta, endedAt);
    await applyPlayerDelta(p.playerToken, p.name, delta, placement===1);
  }
}

function winCheck(room){
  const alive=room.players.filter(p=>p.alive);
  if(alive.length<=1){
    if(alive.length===1) log(room,`🎉 ${alive[0].name} thắng!`,"ok");
    else log(room,"Không còn ai sống...","bad");
    stopTurnTimer(room);
    persistEnd(room);
    return true;
  }
  return false;
}

function isMyTurn(room, playerToken){
  const p = room.players[room.turnIndex];
  return p && p.alive && p.playerToken===playerToken;
}

function actDraw(room, playerToken, auto=false){
  if(!isMyTurn(room, playerToken)) return;
  const p = room.players[room.turnIndex];
  if(room.deck.length===0){ sync(room); startOrResetTurnTimer(room); return; }

  const c = room.deck.pop();
  p.hand.push(c);

  if(c.key==="BOOM"){
    log(room, `${auto?"⏱️ ":""}💥 ${p.name} bốc phải Mèo Boom!`, "bad");
    const defIdx=p.hand.findIndex(x=>x.key==="DEFUSE");
    if(defIdx>=0){
      p.hand.splice(defIdx,1);
      p.hand=p.hand.filter(x=>x.id!==c.id);
      room.pending={id:uuid(), type:"insert_boom", forPlayerToken: playerToken, data:{}};
      sync(room);
      return;
    }else{
      p.alive=false;
      p.exploded=true;
      p.hand=p.hand.filter(x=>x.id!==c.id);
      log(room, `💥 ${p.name} bị loại.`, "bad");
      if(!winCheck(room)){
        room.turnIndex = nextAliveIndex(room.players, room.turnIndex, room.direction);
        announceNextDrawer(room);
        sync(room);
        startOrResetTurnTimer(room);
      }else{
        sync(room);
      }
      return;
    }
  }

  p.mustDraw = Math.max(0, p.mustDraw - 1);
  advanceIfDoneDrawing(room);
  sync(room);
  startOrResetTurnTimer(room);
}

function resolvePrompt(room, playerToken, promptId, payload){
  const pend = room.pending;
  if(!pend || pend.forPlayerToken!==playerToken || pend.id!==promptId) return;
  room.pending=null;

  if(pend.type==="insert_boom"){
    const pos = payload?.pos || "top";
    const boom={key:"BOOM",id:uuid()};
    if(pos==="top") room.deck.push(boom);
    else if(pos==="bottom") room.deck.unshift(boom);
    else {
      const mid=Math.floor(Math.random()*(room.deck.length+1));
      room.deck.splice(mid,0,boom);
    }
    const p = room.players[room.turnIndex];
    p.mustDraw = Math.max(0, p.mustDraw - 1);
    advanceIfDoneDrawing(room);
    sync(room);
    startOrResetTurnTimer(room);
  }
}

wss.on("connection",(ws)=>{
  const wsId=uuid();
  clients.set(wsId,ws);
  ws.isAlive=true;
  ws.on("pong",()=>{ws.isAlive=true;});
  send(ws,{type:"hello_ok",wsId});

  ws.on("message", async (buf)=>{
    let msg; try{msg=JSON.parse(buf.toString("utf8"));}catch{return;}
    const t=msg.type;

    if(t==="create_room"){
      const modeKey = msg.modeKey==="space"?"space":"classic";
      let code=makeRoomCode(); while(rooms.has(code)) code=makeRoomCode();

      const room={
        code,
        hostPlayerToken:null,
        modeKey,
        started:false,
        direction:1,
        turnIndex:0,
        deck:[], boomPool:[], defusePool:[],
        players:[],
        log:[],
        pending:null,
        turnDeadline:0,
        turnTimer:null,
        matchId:null
      };
      rooms.set(code,room);

      const name = normName(msg.name||"Host");
      const pTok = token();
      room.hostPlayerToken=pTok;
      room.players.push({wsId, playerToken:pTok, name, alive:true, hand:[], mustDraw:1, exploded:false});

      await upsertPlayer(pTok, name);

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

      const pTok=token();
      room.players.push({wsId, playerToken:pTok, name, alive:true, hand:[], mustDraw:1, exploded:false});
      await upsertPlayer(pTok, name);

      send(ws,{type:"room_ok",code,playerToken:pTok,state:publicState(room)});
      sync(room);
      return;
    }

    if(t==="resume"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng để vào lại."});
      const pTok=(msg.playerToken||"").toString().trim();
      const p = room.players.find(x=>x.playerToken===pTok);
      if(!p) return send(ws,{type:"error",message:"Không tìm thấy người chơi (token sai)."});
      p.wsId=wsId;
      await upsertPlayer(pTok, p.name);
      send(ws,{type:"room_ok",code,playerToken:pTok,state:publicState(room)});
      sync(room);
      if(room.started) startOrResetTurnTimer(room);
      return;
    }

    if(t==="start_game"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room) return send(ws,{type:"error",message:"Không tìm thấy phòng."});
      const me = room.players.find(p=>p.wsId===wsId);
      if(!me) return send(ws,{type:"error",message:"Bạn chưa ở trong phòng."});
      if(me.playerToken!==room.hostPlayerToken) return send(ws,{type:"error",message:"Chỉ host được bắt đầu."});
      if(room.players.length<4) return send(ws,{type:"error",message:"Cần ít nhất 4 người."});
      if(room.started) return;

      const {deck,boomPool,defusePool}=buildDeck(room.players.length, room.modeKey);
      room.deck=deck; room.boomPool=boomPool; room.defusePool=defusePool;
      room.started=true; room.direction=1; room.turnIndex=0; room.pending=null;
      deal(room);

      room.log=[];
      announceNextDrawer(room);
      sync(room);
      startOrResetTurnTimer(room);

      room.matchId = await createMatch(room.code, room.modeKey);
      return;
    }

    if(t==="action"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.started) return send(ws,{type:"error",message:"Phòng chưa bắt đầu."});
      const me = room.players.find(p=>p.wsId===wsId);
      if(!me) return send(ws,{type:"error",message:"Bạn chưa ở trong phòng."});
      if(room.pending) return send(ws,{type:"error",message:"Đang chờ lựa chọn."});

      const kind=msg.kind;
      if(kind==="draw") return actDraw(room, me.playerToken, false);
      if(kind==="peek"){
        const n = room.modeKey==="space" ? 5 : 3;
        const top = room.deck.slice(-n).reverse().map(c=>c.key);
        return sendPrivate(room, me.playerToken, {type:"peek",cards:top});
      }
      return;
    }

    if(t==="prompt_reply"){
      const code=(msg.code||"").toString().trim().toUpperCase();
      const room=rooms.get(code);
      if(!room || !room.pending) return;
      const me = room.players.find(p=>p.wsId===wsId);
      if(!me) return;
      resolvePrompt(room, me.playerToken, msg.promptId, msg.payload||{});
      return;
    }
  });

  ws.on("close",()=>{ clients.delete(wsId); });
});

setInterval(()=>{
  for(const [id, ws] of clients.entries()){
    if(ws.isAlive===false){
      try{ws.terminate();}catch{}
      clients.delete(id);
      continue;
    }
    ws.isAlive=false;
    try{ws.ping();}catch{}
  }
}, 25000);

server.listen(PORT,"0.0.0.0",()=>console.log("Server running on",PORT, "DB:", DB_PATH));
