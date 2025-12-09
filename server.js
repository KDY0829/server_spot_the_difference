const http = require("http");
const { Server } = require("socket.io");

const ORIGINS = (process.env.ORIGIN || "*")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("socket server");
});

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      const o = (origin || "").replace(/\/$/, "");
      const ok = !origin || ORIGINS.includes("*") || ORIGINS.includes(o);
      cb(null, ok);
    },
    methods: ["GET", "POST"],
    credentials: false,
  },
});

const ROUND_SEC = 90;

const LEVELS = {
  1: {
    // ★ 파일 확장자 .png 확인 (public/assets 폴더 파일명과 일치해야 함)
    image: "/assets/farm_twins_cropped.png",
    base: { w: 1024, h: 500 },
    spots: [
      { id: "sun_L", nx: 0.175, ny: 0.14, nr: 0.06 },
      { id: "sun_R", nx: 0.675, ny: 0.14, nr: 0.06 },
      { id: "truck_L", nx: 0.385, ny: 0.49, nr: 0.06 },
      { id: "truck_R", nx: 0.885, ny: 0.49, nr: 0.06 },
      { id: "boy_L", nx: 0.07, ny: 0.8, nr: 0.06 },
      { id: "boy_R", nx: 0.57, ny: 0.8, nr: 0.06 },
      { id: "cow_L", nx: 0.45, ny: 0.55, nr: 0.06 },
      { id: "cow_R", nx: 0.95, ny: 0.55, nr: 0.06 },
      { id: "roof_L", nx: 0.28, ny: 0.3, nr: 0.06 },
      { id: "roof_R", nx: 0.78, ny: 0.3, nr: 0.06 },
    ],
  },
};

const rooms = new Map();

function endRound(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room || !room.started) return;
  const scores = Object.fromEntries(room.scores);
  io.to(roomId).emit("round-over", {
    roomId,
    scores,
    winners: [],
    reason,
  });
  room.started = false;
  clearTimeout(room.timer);
}

io.on("connection", (sock) => {
  console.log(`[CONNECT] ${sock.id}`);

  sock.on("join", ({ roomId, name }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        players: new Set(),
        names: new Map(),
        ready: new Set(),
        started: false,
        scores: new Map(),
        locked: new Set(),
      });
      console.log(`[ROOM] Created ${roomId}`);
    }
    const room = rooms.get(roomId);
    room.players.add(sock.id);
    room.names.set(sock.id, name || "Player");
    sock.join(roomId);

    if (!room.scores.has(sock.id)) room.scores.set(sock.id, 0);

    sock.emit("joined", { roomId, you: sock.id });
    console.log(`[JOIN] ${name} -> ${roomId}`);
  });

  sock.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: sock.id, data });
  });

  sock.on("ready", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.ready.add(sock.id);

    if (room.ready.size >= 2 && !room.started) {
      room.started = true;
      room.scores = new Map();
      room.locked = new Set();

      const levelData = LEVELS[1];
      const startsAt = Date.now() + 1500;
      const endsAt = startsAt + ROUND_SEC * 1000;

      room.spotsData = levelData.spots;
      room.total = levelData.spots.length;

      io.to(roomId).emit("start", {
        roomId,
        image: levelData.image,
        base: levelData.base,
        spots: levelData.spots,
        startsAt,
        endsAt,
      });
      console.log(`[START] Room ${roomId}`);

      room.timer = setTimeout(
        () => endRound(roomId, "time-out"),
        endsAt - Date.now() + 1000
      );
    }
  });

  sock.on("claim", ({ roomId, spotId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[FAIL] Room not found: ${roomId} (Server restarted?)`);
      return;
    }

    // 유효한 ID인지 확인
    const isValid =
      room.spotsData && room.spotsData.some((s) => s.id === spotId);
    if (!isValid) {
      console.log(`[FAIL] Invalid ID: ${spotId}`);
      return;
    }

    if (room.locked.has(spotId)) return; // 이미 찾음

    room.locked.add(spotId);
    const oldScore = room.scores.get(sock.id) || 0;
    room.scores.set(sock.id, oldScore + 1);

    console.log(`[HIT] ${sock.id} found ${spotId} (Score: ${oldScore + 1})`);

    io.to(roomId).emit("lock", {
      spotId,
      scores: Object.fromEntries(room.scores),
    });

    if (room.locked.size >= room.total) {
      endRound(roomId, "all-clear");
    }
  });

  sock.on("disconnect", () => {
    for (const [rid, r] of rooms) {
      if (r.players.has(sock.id)) {
        r.players.delete(sock.id);
        r.ready.delete(sock.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => console.log(`서버 실행: ${PORT}`));
