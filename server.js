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
      if (data.type === "translate_tts") {
  const text = data.text || "";
  const targetLang = data.targetLang || "en";
  const voice = data.voice || "alloy";

  if (!text) {
    ws.send(JSON.stringify({ type: "error", error: "text manquant" }));
    return;
  }

  // 1) translate (OpenAI)
  const out = await openaiJson("https://api.openai.com/v1/responses", {
    model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
    input: `Traduis en ${targetLang}. Réponds uniquement avec la traduction.\n\nTexte: ${text}`
  });

  const translated =
    out.output_text ||
    (out.output?.[0]?.content?.[0]?.text) ||
    "";

  // 2) tts (OpenAI)
  const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice,
      input: translated,
      format: "mp3"
    })
  });

  if (!ttsResp.ok) {
    const t = await ttsResp.text();
    ws.send(JSON.stringify({ type: "error", error: "tts_failed", details: t }));
    return;
  }

  const audioBuf = Buffer.from(await ttsResp.arrayBuffer());

  ws.send(JSON.stringify({
    type: "translation",
    originalText: text,
    translatedText: translated,
    audioBase64: audioBuf.toString("base64")
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
