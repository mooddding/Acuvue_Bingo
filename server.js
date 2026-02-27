const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const TEAM_COUNT = 9;
const COMMON_MISSIONS = ["M1","M2","M3","M4","M5","M6","M7","M8"];

// 2 공격 + 2 버프 (한글명)
const ITEM_DEFS = {
  SHUFFLE_ATTACK: { name: "빙고판 셔플", kind: "공격" },
  INSTANT_CLEAR:  { name: "원하는 칸 즉시 완료", kind: "버프" },
};
const ITEM_POOL = Object.keys(ITEM_DEFS);

function nowIso(){ return new Date().toISOString(); }
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function countBingos(cleared){
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ];
  let b=0;
  for(const line of lines){
    if(line.every(i => cleared[i])) b++;
  }
  return b;
}
function pushEvent(state, text){
  state.events.push({ at: nowIso(), text });
  if(state.events.length > 80) state.events = state.events.slice(-80);
}

// ✅ “3빙고 달성 기록/이벤트”는 여기서만 처리(순위 계산 중에 상태 변경 금지)
function ensureThreeBingo(state){
  for(let t=1;t<=TEAM_COUNT;t++){
    const tm = state.teams[t];
    const b = countBingos(tm.cleared);
    if(b >= 3 && !tm.threeBingoAt){
      tm.threeBingoAt = nowIso();
      pushEvent(state, `🎉 ${t}조 3빙고 달성!`);
    }
  }
}

function computeRanking(state){
  const list = [];
  for(let t=1;t<=TEAM_COUNT;t++){
    const tm = state.teams[t];
    list.push({
      team: t,
      bingoCount: countBingos(tm.cleared),
      clearedCount: tm.cleared.filter(Boolean).length,
      threeBingoAt: tm.threeBingoAt
    });
  }
  list.sort((a,b)=>{
    const a3 = a.threeBingoAt ? 1 : 0;
    const b3 = b.threeBingoAt ? 1 : 0;
    if(a3 !== b3) return b3 - a3;

    if(a3 === 1 && b3 === 1){
      if(a.threeBingoAt < b.threeBingoAt) return -1;
      if(a.threeBingoAt > b.threeBingoAt) return 1;
    }

    if(a.bingoCount !== b.bingoCount) return b.bingoCount - a.bingoCount;
    if(a.clearedCount !== b.clearedCount) return b.clearedCount - a.clearedCount;
    return a.team - b.team;
  });

  return list.map((x, idx)=>({
    rank: idx+1,
    team: x.team,
    bingoCount: x.bingoCount,
    clearedCount: x.clearedCount,
    threeBingoAt: x.threeBingoAt
  }));
}

function buildUserState(state){
  const teams = {};
  for(let t=1;t<=TEAM_COUNT;t++){
    const tm = state.teams[t];
    // mission completion map (do NOT expose positions)
    const missionDone = {};
    for (let i = 0; i < 9; i++) {
      const m = tm.board[i];
      if (tm.cleared[i]) missionDone[m] = true;
    }
    // reveal mission id only for cleared/disabled cells (do not leak remaining positions)
    const revealed = Array(9).fill(null);
    for (let i = 0; i < 9; i++) {
      if (tm.cleared[i] || tm.disabled[i]) revealed[i] = tm.board[i];
    }
    teams[t] = {
      cleared: tm.cleared,
      disabled: tm.disabled,
      awards: tm.awards,
      missionDone,
      revealed,
      bingoCount: countBingos(tm.cleared),
      clearedCount: tm.cleared.filter(Boolean).length
    };
  }
  return { game: state.game, ranking: computeRanking(state), teams, events: state.events };
}

function buildAdminState(state){
  const adminTeams = {};
  for(let t=1;t<=TEAM_COUNT;t++){
    const tm = state.teams[t];
    adminTeams[t] = {
      board: tm.board,
      cleared: tm.cleared,
      disabled: tm.disabled,
      awards: tm.awards,
      items: tm.items
    };
  }
  return {
    game: state.game,
    ranking: computeRanking(state),
    teams: buildUserState(state).teams,
    admin: { teams: adminTeams },
    events: state.events
  };
}

function emitAll(){
  io.emit("state", buildUserState(STATE));
  io.emit("adminState", buildAdminState(STATE));
}
function toastAll(text){ io.emit("toast", { text }); }

// ====== Undo를 위한 스냅샷 히스토리 ======
const HISTORY_LIMIT = 60;
const history = [];

function deepClone(obj){
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}
function saveHistory(){
  history.push(deepClone(STATE));
  if(history.length > HISTORY_LIMIT) history.shift();
}

function newGameState(){
  const state = {
    game: {
      status: "WAITING",
      timer: {
        running: false,
        startedAt: null,
        endedAt: null,
        elapsedMs: 0
      }
    },
    teams: {},
    events: []
  };

  for(let t=1;t<=TEAM_COUNT;t++){
    const board = shuffle([...COMMON_MISSIONS, `H${t}`]);
    state.teams[t] = {
      board,
      cleared: Array(9).fill(false),
      disabled: Array(9).fill(false),
      awards: Array(9).fill(null),
      items: [],
      threeBingoAt: null
    };
  }
  pushEvent(state, "게임이 초기화되었습니다.");
  return state;
}

let STATE = newGameState();

// ===== routes =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});
app.get("/user", (req, res) => res.sendFile(path.join(__dirname, "public", "user.html")));
app.get("/rank", (req, res) => res.sendFile(path.join(__dirname, "public", "rank.html")));
app.get("/board", (req, res) => res.sendFile(path.join(__dirname, "public", "board.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/api/admin/state", (req, res) => res.json(buildAdminState(STATE)));

app.post("/api/admin/set-status", (req,res)=>{
  const { status } = req.body || {};
  if(!["WAITING","RUNNING","ENDED"].includes(status)){
    return res.status(400).json({ ok:false, message:"status 오류" });
  }

  saveHistory();

  const timer = STATE.game.timer;

  if(status === "RUNNING"){
    if(!timer.running){
      timer.running = true;
      timer.startedAt = nowIso();
      timer.endedAt = null;
    }
    STATE.game.status = "RUNNING";
    pushEvent(STATE, `상태 변경: RUNNING`);

  } else if(status === "ENDED"){
    if(timer.running){
      const now = Date.now();
      const started = Date.parse(timer.startedAt);
      if(!Number.isNaN(started)){
        timer.elapsedMs += Math.max(0, now - started);
      }
      timer.running = false;
      timer.endedAt = nowIso();
      timer.startedAt = null;

      STATE.game.status = "ENDED";
      pushEvent(STATE, `상태 변경: ENDED (타이머 정지)`);

    } else {
      timer.running = false;
      timer.startedAt = null;
      timer.endedAt = null;
      timer.elapsedMs = 0;

      STATE.game.status = "ENDED";
      pushEvent(STATE, `타이머 리셋(게임 유지)`);
    }

  } else if(status === "WAITING"){
    STATE.game.status = "WAITING";
    pushEvent(STATE, `상태 변경: WAITING`);
  }

  ensureThreeBingo(STATE);
  emitAll();
  toastAll(`상태: ${STATE.game.status}`);
  res.json({ ok:true, message:`상태 변경: ${STATE.game.status}` });
});

app.post("/api/admin/toggle-clear", (req,res)=>{
  const { team, pos } = req.body || {};
  const t = Number(team);
  const p = Number(pos);

  if(!(t>=1 && t<=TEAM_COUNT && p>=0 && p<9)){
    return res.status(400).json({ ok:false, message:"team/pos 오류" });
  }

  const tm = STATE.teams[t];
  if(tm.disabled[p]){
    return res.json({ ok:false, message:"무력화된 칸은 완료할 수 없습니다." });
  }

  saveHistory();

  tm.cleared[p] = !tm.cleared[p];
  const mission = tm.board[p];

  if(tm.cleared[p] && /^H\d+$/.test(mission) && !tm.awards[p]){
    const itemId = ITEM_POOL[Math.floor(Math.random()*ITEM_POOL.length)];
    tm.awards[p] = itemId;
    tm.items.push(itemId);
    pushEvent(STATE, `🎁 ${t}조 히든미션 완료! 아이템 획득: ${ITEM_DEFS[itemId].name}`);
    toastAll(`🎁 ${t}조 아이템 획득: ${ITEM_DEFS[itemId].name}`);
  }

  pushEvent(STATE, `${t}조 ${p+1}번 칸 ${tm.cleared[p] ? "완료" : "취소"}`);
  ensureThreeBingo(STATE);
  emitAll();
  res.json({ ok:true, message:"반영 완료" });
});

app.post("/api/admin/use-item", (req,res)=>{
  const { fromTeam, itemId, targetTeam, targetPos } = req.body || {};
  const ft = Number(fromTeam);
  const tt = Number(targetTeam);
  const tp = (targetPos === null || targetPos === undefined || targetPos === "") ? null : Number(targetPos);

  if(!(ft>=1 && ft<=TEAM_COUNT)) return res.status(400).json({ ok:false, message:"fromTeam 오류" });
  if(!ITEM_DEFS[itemId]) return res.status(400).json({ ok:false, message:"itemId 오류" });
  if(!(tt>=1 && tt<=TEAM_COUNT)) return res.status(400).json({ ok:false, message:"targetTeam 오류" });
  if(tp !== null && !(tp>=0 && tp<9)) return res.status(400).json({ ok:false, message:"targetPos 오류" });

  const from = STATE.teams[ft];
  const invIdx = from.items.indexOf(itemId);
  if(invIdx === -1){
    return res.json({ ok:false, message:`${ft}조 인벤토리에 '${ITEM_DEFS[itemId].name}'이 없습니다.` });
  }

  saveHistory();

  const target = STATE.teams[tt];
  let msg = "";

  if(itemId === "SHUFFLE_ATTACK"){
    const perm = shuffle([0,1,2,3,4,5,6,7,8]);
    target.board    = perm.map(i => target.board[i]);
    target.cleared  = perm.map(i => target.cleared[i]);
    target.disabled = perm.map(i => target.disabled[i]);
    target.awards   = perm.map(i => target.awards[i]);
    msg = `💥 ${ft}조 → ${tt}조 : '${ITEM_DEFS[itemId].name}' 사용!`;

  } else if(itemId === "DISABLE_CELL"){
    if(tp === null) return res.json({ ok:false, message:"무력화는 좌표 선택이 필요합니다." });
    if(target.disabled[tp]) return res.json({ ok:false, message:"이미 무력화된 칸입니다." });

    target.disabled[tp] = true;
    target.cleared[tp] = false;
    target.awards[tp] = null;
    msg = `⛔ ${ft}조 → ${tt}조 : ${tp+1}번 칸 무력화!`;

  } else if(itemId === "INSTANT_CLEAR"){
    if(tp === null) return res.json({ ok:false, message:"즉시완료는 좌표 선택이 필요합니다." });
    if(target.disabled[tp]) return res.json({ ok:false, message:"무력화된 칸은 즉시 완료할 수 없습니다." });

    target.cleared[tp] = true;
    msg = `✨ ${ft}조 → ${tt}조 : ${tp+1}번 칸 즉시 완료!`;

    const mission = target.board[tp];
    if(/^H\d+$/.test(mission) && !target.awards[tp]){
      const newItem = ITEM_POOL[Math.floor(Math.random()*ITEM_POOL.length)];
      target.awards[tp] = newItem;
      target.items.push(newItem);
      pushEvent(STATE, `🎁 ${tt}조 히든미션 즉시완료! 아이템 획득: ${ITEM_DEFS[newItem].name}`);
    }

  } else if(itemId === "REVEAL_POS"){
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6]
    ];

    let bestPos = null;
    for(const line of lines){
      const clearedCnt = line.filter(i => target.cleared[i]).length;
      const open = line.filter(i => !target.cleared[i] && !target.disabled[i]);
      if(clearedCnt === 2 && open.length === 1){ bestPos = open[0]; break; }
    }
    if(bestPos === null){
      const candidates = [];
      for(let i=0;i<9;i++) if(!target.cleared[i] && !target.disabled[i]) candidates.push(i);
      bestPos = candidates.length ? candidates[Math.floor(Math.random()*candidates.length)] : 4;
    }
    msg = `🔎 ${ft}조 → ${tt}조 : '${ITEM_DEFS[itemId].name}' → 추천 칸 ${bestPos+1}번`;
  }

  from.items.splice(invIdx, 1);

  pushEvent(STATE, msg);
  ensureThreeBingo(STATE);
  emitAll();
  toastAll(msg);

  res.json({ ok:true, message: msg });
});

app.post("/api/admin/undo", (req,res)=>{
  if(history.length === 0){
    return res.json({ ok:false, message:"되돌릴 내역이 없습니다." });
  }
  STATE = history.pop();
  emitAll();
  toastAll("↩️ 직전 동작을 되돌렸습니다.");
  res.json({ ok:true, message:"되돌림 완료" });
});

app.post("/api/admin/reset", (req,res)=>{
  saveHistory();
  STATE = newGameState();
  emitAll();
  toastAll("리셋 완료");
  res.json({ ok:true, message:"리셋 완료" });
});

io.on("connection", (socket)=>{
  socket.emit("state", buildUserState(STATE));
  socket.emit("adminState", buildAdminState(STATE));
});

server.listen(PORT, ()=>{
  console.log(`http://localhost:${PORT}/rank (user - rank)`);
  console.log(`http://localhost:${PORT}/board (user - board)`);
  console.log(`http://localhost:${PORT}/admin (admin)`);
});
