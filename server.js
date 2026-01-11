// server.js — Instant Talk Backend (Railway)
// ✅ NO window / NO SpeechRecognition (backend only)

import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import { WebSocketServer } from "ws";

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// (Optionnel) Restreindre CORS plus tard, pour l’instant "*" pour éviter blocage
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante (Railway > Variables)");
}

// --- Helpers OpenAI (via fetch) ---
async function openaiJson(url, body) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// --- HTTP routes ---
app.get("/", (_req, res) => res.send("Instant Talk backend OK"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "instant-talk-backend" });
});

// Traduction HTTP (utile si Base44 l’appelle)
app.post("/translate", async (req, res) => {
  try {
    const { text, targetLang = "en" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Champ 'text' manquant" });
    }

    const out = await openaiJson("https://api.openai.com/v1/responses", {
      model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
      input:
        `Traduis en ${targetLang}. ` +
        `Réponds uniquement avec la traduction finale, sans explication.\n\nTexte: ${text}`,
    });

    const translated =
      out.output_text ||
      out.output?.[0]?.content?.[0]?.text ||
      "";

    res.json({ ok: true, originalText: text, translatedText: translated.trim() });
  } catch (e) {
    res.status(500).json({ error: "Erreur translate serveur", details: String(e.message || e) });
  }
});

// TTS HTTP (renvoie mp3)
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Champ 'text' manquant" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY manquante" });
    }

    const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice,
        input: text,
        format: "mp3",
      }),
    });

    if (!ttsResp.ok) {
      const t = await ttsResp.text();
      return res.status(500).json({ error: "Erreur TTS serveur", details: t });
    }

    const buf = Buffer.from(await ttsResp.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "Erreur TTS serveur", details: String(e.message || e) });
  }
});

// --- Create HTTP server ---
const server = http.createServer(app);

// --- Socket.io: WebRTC signaling (video calls) ---
const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("🔌 Socket.io connected:", socket.id);

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

  socket.on("leave-room", (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket.io disconnected:", socket.id);
  });
});

// --- WebSocket: /ws/rt (audio chunks + translate_tts) ---
const wss = new WebSocketServer({ server, path: "/ws/rt" });

wss.on("connection", (ws) => {
  console.log("🎧 WS client connected (/ws/rt)");

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // 1) Audio chunk -> ACK (MVP)
      if (data.type === "audio_chunk") {
        ws.send(
          JSON.stringify({
            type: "ack",
            received: true,
            bytes: data.audioChunk ? String(data.audioChunk).length : 0,
            ts: Date.now(),
          })
        );
        return;
      }

      // 2) Translate + TTS (text -> translated + audioBase64)
      // Expected:
      // { type:"translate_tts", text:"bonjour", targetLang:"en", voice:"alloy" }
      if (data.type === "translate_tts") {
        const text = (data.text || "").toString().trim();
        const targetLang = (data.targetLang || "en").toString().trim();
        const voice = (data.voice || "alloy").toString().trim();

        if (!text) {
          ws.send(JSON.stringify({ type: "error", error: "text manquant" }));
          return;
        }

        // --- Translate
        const out = await openaiJson("https://api.openai.com/v1/responses", {
          model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
          input:
            `Traduis en ${targetLang}. ` +
            `Réponds uniquement avec la traduction finale, sans explication.\n\nTexte: ${text}`,
        });

        const translated =
          (out.output_text || out.output?.[0]?.content?.[0]?.text || "").trim();

        // --- TTS
        const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
            voice,
            input: translated,
            format: "mp3",
          }),
        });

        if (!ttsResp.ok) {
          const t = await ttsResp.text();
          ws.send(JSON.stringify({ type: "error", error: "tts_failed", details: t }));
          return;
        }

        const audioBuf = Buffer.from(await ttsResp.arrayBuffer());

        ws.send(
          JSON.stringify({
            type: "translation",
            originalText: text,
            translatedText: translated,
            audioBase64: audioBuf.toString("base64"),
            audioMime: "audio/mpeg",
          })
        );
        return;
      }

      // Unknown message
      ws.send(JSON.stringify({ type: "error", error: "unknown_type", got: data.type || null }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: "bad_request", details: String(e.message || e) }));
    }
  });

  ws.on("close", () => console.log("🔴 WS client disconnected (/ws/rt)"));
});

server.listen(PORT, () => {
  console.log("🚀 Instant Talk backend running on port", PORT);
});
