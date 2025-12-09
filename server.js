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
    image: "/assets/farm_twins_cropped.png",
    base: { w: 1024, h: 500 },
    // 요청하신 좌표 적용됨
    spots: [
      { id: "spot_1", nx: 0.72, ny: 0.222, nr: 0.025 },
      { id: "spot_2", nx: 0.791, ny: 0.216, nr: 0.025 },
      { id: "spot_3", nx: 0.985, ny: 0.684, nr: 0.025 },
      { id: "spot_4", nx: 0.889, ny: 0.806, nr: 0.025 },
      { id: "spot_5", nx: 0.624, ny: 0.236, nr: 0.025 },
      { id: "spot_6", nx: 0.829, ny: 0.784, nr: 0.025 },
      { id: "spot_7", nx: 0.858, ny: 0.762, nr: 0.025 },
      { id: "spot_8", nx: 0.732, ny: 0.388, nr: 0.025 },
      { id: "spot_9", nx: 0.552, ny: 0.452, nr: 0.025 },
      { id: "spot_10", nx: 0.832, ny: 0.612, nr: 0.025 },
      { id: "spot_11", nx: 0.984, ny: 0.478, nr: 0.025 },
      { id: "spot_12", nx: 0.517, ny: 0.63, nr: 0.025 },
      { id: "spot_13", nx: 0.593, ny: 0.454, nr: 0.025 },
      { id: "spot_14", nx: 0.679, ny: 0.298, nr: 0.025 },
      { id: "spot_15", nx: 0.646, ny: 0.708, nr: 0.025 },
      { id: "spot_16", nx: 0.864, ny: 0.684, nr: 0.025 },
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

    if (!room.players.has(sock.id)) {
      room.players.add(sock.id);
      room.names.set(sock.id, name || "Player");
      sock.join(roomId);
      if (!room.scores.has(sock.id)) room.scores.set(sock.id, 0);
    }

    const roster = rosterObj(room);
    sock.emit("joined", { roomId, you: sock.id, roster });
    sock.to(roomId).emit("peer-joined", { peer: sock.id, roster });

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
    if (!spotId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const isValid =
      room.spotsData && room.spotsData.some((s) => s.id === spotId);
    if (!isValid) return;

    if (room.locked.has(spotId)) return;

    room.locked.add(spotId);
    const oldScore = room.scores.get(sock.id) || 0;
    room.scores.set(sock.id, oldScore + 1);

    console.log(`[HIT] ${sock.id} found ${spotId}`);

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
        r.names.delete(sock.id);

        const roster = rosterObj(r);
        sock.to(rid).emit("peer-left", { peerId: sock.id, roster });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => console.log(`서버 실행: ${PORT}`));
