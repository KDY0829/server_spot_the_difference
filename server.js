// server/server.js
const http = require("http");
const { Server } = require("socket.io");

// ──────────────────────────────────────
// CORS (Render용, 여러 도메인 허용 + 슬래시 정리)
//   ORIGIN="https://webrtcproject1.netlify.app, http://localhost:5173"
// ──────────────────────────────────────
const ORIGINS = (process.env.ORIGIN || "*")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""));
console.log("[ALLOW ORIGINS]", ORIGINS);

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("socket server");
  }
  res.writeHead(404);
  res.end("not found");
});

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      const o = (origin || "").replace(/\/$/, "");
      const ok = !origin || ORIGINS.includes("*") || ORIGINS.includes(o);
      if (ok) {
        if (origin) console.log("[CORS OK]", o);
        return cb(null, true);
      }
      console.log("[CORS BLOCK]", { origin, ORIGINS });
      cb(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
});

// ──────────────────────────────────────
// 게임 데이터 (단일 이미지 / 정규화 좌표 0..1)
//  - base: {w:1024, h:500}  (하단 아이콘 크롭 기준)
//  - spots: {id, nx, ny, nr}  (상대 좌표)
// ──────────────────────────────────────
const ROUND_SEC = 90;

const LEVELS = {
  1: {
    // 클라이언트의 public/assets/ 폴더에 이미지가 있어야 합니다.
    image: "/assets/farm_twins_cropped.jpg",
    base: { w: 1024, h: 500 }, // 이미지 비율에 맞춰 h값은 조정될 수 있음

    // id: 고유번호, nx: 가로위치(%), ny: 세로위치(%), nr: 판정반경(%)
    spots: [
      // 1. 하늘 우측 (연/새) - 왼쪽/오른쪽 쌍
      { id: 0, nx: 0.18, ny: 0.22, nr: 0.05 }, // 왼쪽 그림
      { id: 1, nx: 0.68, ny: 0.22, nr: 0.05 }, // 오른쪽 그림

      // 2. 우측 하단 그루터기 (도끼/나뭇가지)
      { id: 2, nx: 0.42, ny: 0.85, nr: 0.05 },
      { id: 3, nx: 0.92, ny: 0.85, nr: 0.05 },

      // 3. 좌측 하단 앉아있는 소년 (음식/주머니)
      { id: 4, nx: 0.08, ny: 0.8, nr: 0.05 },
      { id: 5, nx: 0.58, ny: 0.8, nr: 0.05 },

      // 4. 헛간 중앙 상단 창문/건초
      { id: 6, nx: 0.28, ny: 0.38, nr: 0.05 },
      { id: 7, nx: 0.78, ny: 0.38, nr: 0.05 },

      // 5. 좌측 상단 풍차/지붕
      { id: 8, nx: 0.06, ny: 0.25, nr: 0.05 },
      { id: 9, nx: 0.56, ny: 0.25, nr: 0.05 },

      // 6. 중앙 우측 젖소 꼬리/무늬
      { id: 10, nx: 0.35, ny: 0.55, nr: 0.05 },
      { id: 11, nx: 0.85, ny: 0.55, nr: 0.05 },
    ],
  },
};

const rooms = new Map();

function rosterObj(room) {
  const players = [...room.players].map((id) => ({
    id,
    name: room.names.get(id) || "Player",
  }));
  return { players };
}
function winnersFrom(scoresObj) {
  const vals = Object.values(scoresObj);
  if (!vals.length) return [];
  const top = Math.max(...vals);
  return Object.keys(scoresObj).filter((id) => scoresObj[id] === top);
}
function endRound(roomId, reason = "timeout") {
  const room = rooms.get(roomId);
  if (!room || !room.started) return;
  const scores = Object.fromEntries(room.scores);
  io.to(roomId).emit("round-over", {
    roomId,
    scores,
    winners: winnersFrom(scores),
    reason,
    endedAt: Date.now(),
  });
  clearTimeout(room.timer);
  room.timer = null;
  room.ready.clear();
  room.started = false;
}

io.on("connection", (sock) => {
  // join
  sock.on("join", ({ roomId, name }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        players: new Set(),
        names: new Map(),
        ready: new Set(),
        started: false,
        scores: new Map(),
        level: 1,
        locked: new Set(),
        spotsData: null,
        total: 0,
        timer: null,
        endsAt: null,
      });
    }
    const room = rooms.get(roomId);
    if (room.players.size >= 2) {
      sock.emit("room-full", { roomId });
      return;
    }
    room.players.add(sock.id);
    room.names.set(sock.id, (name || "Player").slice(0, 20));
    sock.join(roomId);
    sock.emit("joined", { roomId, you: sock.id, roster: rosterObj(room) });
    sock
      .to(roomId)
      .emit("peer-joined", { peer: sock.id, roster: rosterObj(room) });
  });

  // WebRTC 시그널 릴레이
  sock.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: sock.id, data });
  });

  // ready → start
  sock.on("ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.ready.add(sock.id);

    if (room.ready.size >= 2 && !room.started) {
      room.started = true;
      room.scores = new Map();
      room.locked = new Set();

      const level = room.level || 1;
      const payload = LEVELS[level];
      const startsAt = Date.now() + 1500;
      const endsAt = startsAt + ROUND_SEC * 1000;

      room.total = payload.spots.length;
      room.spotsData = payload.spots;
      room.endsAt = endsAt;

      clearTimeout(room.timer);
      room.timer = setTimeout(
        () => endRound(roomId, "timeout"),
        endsAt - Date.now() + 200
      );

      io.to(roomId).emit("start", {
        roomId,
        level,
        startsAt,
        endsAt,
        image: payload.image, // 한 장
        base: payload.base, // {w, h}
        spots: payload.spots, // 정규화 좌표 0..1
        total: room.total,
      });
    }
  });

  // 정답 선점
  sock.on("claim", ({ roomId, spotId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const exists = room.spotsData?.some((s) => s.id === spotId);
    if (!exists) return;
    if (room.locked.has(spotId)) {
      sock.emit("reject", { spotId, reason: "locked" });
      return;
    }

    room.locked.add(spotId);
    room.scores.set(sock.id, (room.scores.get(sock.id) || 0) + 1);

    io.to(roomId).emit("lock", {
      spotId,
      winnerId: sock.id,
      lockedAt: Date.now(),
      scores: Object.fromEntries(room.scores),
    });

    if (room.locked.size >= room.total) endRound(roomId, "all-locked");
  });

  // disconnect
  sock.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      if (room.players.delete(sock.id)) {
        room.ready?.delete(sock.id);
        room.names?.delete(sock.id);
        sock
          .to(roomId)
          .emit("peer-left", { peerId: sock.id, roster: rosterObj(room) });
        if (room.started) endRound(roomId, "peer-left");
        if (room.players.size === 0) {
          clearTimeout(room.timer);
          rooms.delete(roomId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => console.log("서버 실행 중:", PORT));
