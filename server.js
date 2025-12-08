const http = require("http");
const server = http.createServer();

const { Server } = require("socket.io");
const ORIGINS = (process.env.ORIGIN || "*")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, "")); // ← 끝 슬래시 제거

console.log("[ALLOW ORIGINS]", ORIGINS);

const io = new Server(server, {
  cors: {
    // Socket.IO는 폴링(xhr)에서도 이 콜백을 사용한다.
    origin(origin, callback) {
      const clean = (origin || "").replace(/\/$/, "");
      const allowed =
        !origin || // 서버 내부 / curl 등의 Origin 없음
        ORIGINS.includes("*") ||
        ORIGINS.includes(clean);

      if (allowed) {
        if (origin) console.log("[CORS OK]", clean);
        return callback(null, true);
      }

      console.log("[CORS BLOCK]", origin);
      return callback(new Error("CORS blocked: " + origin));
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
});

// ===== 라운드 시간(초) =====
const ROUND_SEC = 90;

// ---- 레벨 데이터(예시: 3번에서 분리한 좌/우 패널) ----
const LEVELS = {
  1: {
    left: "/assets/level1_left.png",
    right: "/assets/level1_right.png",
    base_w: 467,
    base_h: 514,
    spots: [
      { id: 0, side: "L", x: 171, y: 311, r: 10 },
      { id: 0, side: "R", x: 171, y: 311, r: 10 },
      { id: 1, side: "L", x: 236, y: 236, r: 10 },
      { id: 1, side: "R", x: 236, y: 236, r: 10 },
      { id: 2, side: "L", x: 116, y: 406, r: 10 },
      { id: 2, side: "R", x: 116, y: 406, r: 10 },
      { id: 3, side: "L", x: 229, y: 330, r: 10 },
      { id: 3, side: "R", x: 229, y: 330, r: 10 },
      { id: 4, side: "L", x: 67, y: 104, r: 10 },
      { id: 4, side: "R", x: 67, y: 104, r: 10 },
      { id: 5, side: "L", x: 63, y: 342, r: 10 },
      { id: 5, side: "R", x: 63, y: 342, r: 10 },
      { id: 6, side: "L", x: 341, y: 448, r: 10 },
      { id: 6, side: "R", x: 341, y: 448, r: 10 },
      { id: 7, side: "L", x: 321, y: 60, r: 10 },
      { id: 7, side: "R", x: 321, y: 60, r: 10 },
    ],
  },
};

// roomId -> 상태 객체
const rooms = new Map();

function rosterObj(room) {
  const players = [...room.players].map((id) => ({
    id,
    name: room.names.get(id) || "Player",
  }));
  return { players };
}

function computeWinners(scoresObj) {
  const vals = Object.values(scoresObj);
  if (vals.length === 0) return [];
  const top = Math.max(...vals);
  return Object.keys(scoresObj).filter((id) => scoresObj[id] === top);
}

function endRound(roomId, reason = "timeout") {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.started) return;

  const scoresObj = Object.fromEntries(room.scores);
  const winners = computeWinners(scoresObj);

  io.to(roomId).emit("round-over", {
    roomId,
    scores: scoresObj,
    winners,
    reason, // 'timeout' | 'all-locked' | 'peer-left'
    endedAt: Date.now(),
  });

  // 타이머 정리 및 상태 리셋
  clearTimeout(room.timer);
  room.timer = null;
  room.ready.clear();
  room.started = false;
}

io.on("connection", (sock) => {
  // ---- 입장 ----
  sock.on("join", ({ roomId, name }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        players: new Set(),
        names: new Map(), // socketId -> name
        locked: new Set(),
        ready: new Set(),
        started: false,
        scores: new Map(),
        level: 1,
        spotsData: null,
        total: 0,
        timer: null,
        endsAt: null,
      });
    }
    const room = rooms.get(roomId);

    // 정원 2명
    if (room.players.size >= 2) {
      sock.emit("room-full", { roomId });
      return;
    }

    room.players.add(sock.id);
    room.names.set(sock.id, String(name || "").slice(0, 20) || "Player");

    sock.join(roomId);
    sock.emit("joined", { roomId, you: sock.id, roster: rosterObj(room) });
    sock
      .to(roomId)
      .emit("peer-joined", { peer: sock.id, roster: rosterObj(room) });
  });

  // ---- WebRTC 시그널 릴레이 ----
  sock.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: sock.id, data });
  });

  // ---- 준비 -> START 방송 ----
  sock.on("ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.ready.add(sock.id);

    if (room.ready.size >= 2 && !room.started) {
      room.started = true;
      room.locked = new Set();
      room.scores = new Map();

      const level = room.level || 1;
      const payload = LEVELS[level];
      const seed = Date.now();
      const startsAt = Date.now() + 1500;
      const endsAt = startsAt + ROUND_SEC * 1000; // ★ 라운드 시간

      room.spotsData = payload.spots;
      const total = new Set(payload.spots.map((s) => s.id)).size;
      room.total = total;
      room.endsAt = endsAt;

      // ★ 타임아웃으로 자동 종료
      clearTimeout(room.timer);
      room.timer = setTimeout(
        () => endRound(roomId, "timeout"),
        endsAt - Date.now() + 200
      );

      io.to(roomId).emit("start", {
        roomId,
        level,
        seed,
        startsAt,
        endsAt, // ★ endsAt 포함
        images: { left: payload.left, right: payload.right },
        base: { w: payload.base_w, h: payload.base_h },
        spots: payload.spots,
        total,
      });
    }
  });

  // ---- 정답 선점 ----
  sock.on("claim", ({ roomId, spotIdx }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const ok = room.spotsData?.some((s) => s.id === spotIdx);
    if (!ok) return;

    if (room.locked.has(spotIdx)) {
      sock.emit("reject", { spotIdx, reason: "locked" });
      return;
    }

    room.locked.add(spotIdx);
    room.scores.set(sock.id, (room.scores.get(sock.id) || 0) + 1);

    io.to(roomId).emit("lock", {
      spotIdx,
      winnerId: sock.id,
      lockedAt: Date.now(),
      scores: Object.fromEntries(room.scores),
    });

    // 모든 정답이 잠기면 즉시 종료
    if (room.locked.size >= (room.total || 0)) {
      endRound(roomId, "all-locked");
    }
  });

  // ---- 퇴장 ----
  sock.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      if (room.players.delete(sock.id)) {
        room.ready?.delete(sock.id);
        room.names?.delete(sock.id);
        sock
          .to(roomId)
          .emit("peer-left", { peerId: sock.id, roster: rosterObj(room) });

        // 플레이 중에 나갔으면 라운드 종료
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
server.listen(PORT, () =>
  console.log("서버 실행 중:", PORT, "origin:", ALLOW_ORIGIN)
);
