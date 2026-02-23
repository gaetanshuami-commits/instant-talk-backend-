// server.js
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => {
  res.send("Instant Talk Backend OK");
});

const server = http.createServer(app);

// 🔴 WebSocket Server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("✅ WebSocket client connected");

  ws.send(JSON.stringify({ type: "ready" }));

  ws.on("message", (data, isBinary) => {
    try {
      // 🔹 TEXTE (start / stop / config)
      if (!isBinary) {
        const msg = JSON.parse(data.toString());

        if (msg.type === "start") {
          console.log("▶️ START", msg.source, "→", msg.target);
          return;
        }

        if (msg.type === "stop") {
          console.log("⏹️ STOP");
          return;
        }

        return;
      }

      // 🔹 AUDIO BINAIRE PCM 16 bits
      const pcm16 = new Int16Array(
        data.buffer,
        data.byteOffset,
        data.byteLength / 2
      );

      console.log("🎧 PCM reçu:", pcm16.length, "samples");

      // 👉 ICI PLUS TARD :
      // envoyer pcm16 vers Whisper / STT / Deepgram etc.
    } catch (err) {
      console.error("❌ WS error:", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Backend listening on port", PORT);
});
