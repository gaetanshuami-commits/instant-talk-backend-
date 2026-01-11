/* instant-talk-backend - server.js (CommonJS, Railway-ready, NO window) */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

const PORT = process.env.PORT || 3000;

// ---------- OpenAI client ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquant dans les variables Railway.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Basic routes ----------
app.get("/", (_req, res) => res.send("Instant Talk backend OK ✅"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------- TTS endpoint (binary audio) ----------
app.post("/tts", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString();
    const voice = (req.body?.voice || "alloy").toString();

    if (!text.trim()) return res.status(400).json({ error: "text required" });

    // TTS: returns audio bytes
    const audio = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text
    });

    const buf = Buffer.from(await audio.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("❌ /tts error:", e?.message || e);
    return res.status(500).json({ error: "Erreur TTS serveur", details: e?.message || String(e) });
  }
});

// ---------- Translate endpoint (text -> translated text) ----------
app.post("/translate", async (req, res) => {
  try {
    const text = (req.body?.text || "").toString();
    const targetLang = (req.body?.targetLang || "en").toString();

    if (!text.trim()) return res.status(400).json({ error: "text required" });

    // Simple translation via LLM (MVP)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a fast, accurate translator. Output ONLY the translation text, nothing else." },
        { role: "user", content: `Translate to ${targetLang}:\n${text}` }
      ]
    });

    const translated = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ originalText: text, translatedText: translated });
  } catch (e) {
    console.error("❌ /translate error:", e?.message || e);
    return res.status(500).json({ error: "Erreur translate serveur", details: e?.message || String(e) });
  }
});

// ---------- Create HTTP server ----------
const server = http.createServer(app);

// ---------- Socket.io signaling for WebRTC ----------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on("connection", (socket) => {
  console.log("🟢 socket connected:", socket.id);

  socket.on("join-room", (roomId) => {
    if (!roomId) return;
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
    console.log(`👥 ${socket.id} joined room ${roomId}`);
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
    console.log("🔴 socket disconnected:", socket.id);
    // optional: broadcast disconnect to rooms (front can handle)
    socket.rooms.forEach((roomId) => socket.to(roomId).emit("user-left", socket.id));
  });
});

// ---------- WebSocket server (/ws) for translation + TTS ----------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // only accept /ws
  const url = req.url || "";
  if (!url.startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  console.log("🟣 WS connected");

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString("utf8"));

      // MVP: on reçoit du texte déjà transcrit (STT côté navigateur)
      if (data.type === "text") {
        const text = (data.text || "").toString();
        const targetLang = (data.targetLang || "en").toString();
        const voice = (data.voice || "alloy").toString();

        if (!text.trim()) {
          ws.send(JSON.stringify({ type: "error", error: "text required" }));
          return;
        }

        // translate
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: "You are a fast, accurate translator. Output ONLY the translation text, nothing else." },
            { role: "user", content: `Translate to ${targetLang}:\n${text}` }
          ]
        });
        const translatedText = completion.choices?.[0]?.message?.content?.trim() || "";

        // TTS
        const audio = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice,
          input: translatedText
        });
        const buf = Buffer.from(await audio.arrayBuffer());

        ws.send(JSON.stringify({
          type: "translation",
          originalText: text,
          translatedText,
          audioBase64: buf.toString("base64")
        }));
        return;
      }

      ws.send(JSON.stringify({ type: "error", error: "unknown type" }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: "bad json", details: e?.message || String(e) }));
    }
  });

  ws.on("close", () => console.log("🟣 WS closed"));
  ws.on("error", (e) => console.log("🟣 WS error:", e?.message || e));
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`✅ Instant Talk backend running on :${PORT}`);
});
