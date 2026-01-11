import express from "express";
import http from "http";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

/* ================================
   ROUTES HTTP
================================ */

app.get("/", (_req, res) => {
  res.send("Instant Talk backend OK");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "instant-talk-backend" });
});

/* ================================
   SOCKET.IO — SIGNALISATION WEBRTC
================================ */

const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("🔌 WebRTC user connected:", socket.id);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("offer", (roomId, offer) => {
    socket.to(roomId).emit("offer", offer, socket.id);
  });

  socket.on("answer", (roomId, answer) => {
    socket.to(roomId).emit("answer", answer, socket.id);
  });

  socket.on("ice-candidate", (roomId, candidate) => {
    socket.to(roomId).emit("ice-candidate", candidate, socket.id);
  });

  socket.on("disconnect", () => {
    console.log("❌ WebRTC user disconnected:", socket.id);
  });
});

/* ================================
   WEBSOCKET — AUDIO / TRADUCTION
================================ */

const wss = new WebSocketServer({ server, path: "/ws/rt" });

wss.on("connection", (ws) => {
  console.log("🎧 Client audio connecté");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "audio_chunk") {
        // Pour l’instant on renvoie juste un ACK
        ws.send(JSON.stringify({
          type: "ack",
          received: true,
          bytes: data.audioChunk?.length || 0
        }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ error: "invalid_json" }));
    }
  });

  ws.on("close", () => {
    console.log("🔴 Audio client déconnecté");
  });
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("🚀 Instant Talk Backend running on port", PORT);
});
