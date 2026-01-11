import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS (met ton domaine Base44 ensuite si tu veux)
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
  methods: ["GET", "POST"],
}));

// ✅ Page racine (plus de "Cannot GET /")
app.get("/", (_req, res) => res.send("Instant Talk backend OK"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

/**
 * -------------------------
 *  OpenAI helpers (fetch)
 * -------------------------
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY manquant");
}

async function openaiJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${txt}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ✅ Traduction (texte -> texte)
app.post("/translate", async (req, res) => {
  try {
    const { text, targetLang = "en" } = req.body || {};
    if (!text) return res.status(400).json({ error: "text manquant" });

    const out = await openaiJson("https://api.openai.com/v1/responses", {
      model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
      input: `Traduis en ${targetLang}. Réponds uniquement avec la traduction.\n\nTexte: ${text}`
    });

    const translated =
      out.output_text ||
      (out.output?.[0]?.content?.[0]?.text) ||
      "";

    res.json({ ok: true, originalText: text, translatedText: translated });
  } catch (e) {
    res.status(500).json({ error: "Erreur translate serveur", details: String(e.message || e) });
  }
});

// ✅ TTS (texte -> audio/mpeg)
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body || {};
    if (!text) return res.status(400).json({ error: "text manquant" });

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice,
        input: text,
        format: "mp3"
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "Erreur TTS serveur", details: t });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "Erreur TTS serveur", details: String(e.message || e) });
  }
});

/**
 * ---------------------------------------
 *  Socket.io = SIGNALISATION WEBRTC VIDEO
 * ---------------------------------------
 */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
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
    // le frontend peut gérer par socket.id
  });
});

/**
 * ---------------------------------------
 *  WebSocket /ws/rt = MVP "audio chunks"
 *  (reçoit base64, renvoie texte/trad/tts)
 * ---------------------------------------
 */
const wss = new WebSocketServer({ server, path: "/ws/rt" });

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // msg = { type:"translate_tts", text:"...", targetLang:"en", voice:"alloy" }
      if (msg.type === "translate_tts") {
        const text = msg.text || "";
        const targetLang = msg.targetLang || "en";
        const voice = msg.voice || "alloy";
        if (!text) {
          ws.send(JSON.stringify({ type: "error", error: "text manquant" }));
          return;
        }

        // 1) translate
        const out = await openaiJson("https://api.openai.com/v1/responses", {
          model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
          input: `Traduis en ${targetLang}. Réponds uniquement avec la traduction.\n\nTexte: ${text}`
        });

        const translated =
          out.output_text ||
          (out.output?.[0]?.content?.[0]?.text) ||
          "";

        // 2) tts
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

    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: "bad_request", details: String(e.message || e) }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Backend listening on", PORT));
