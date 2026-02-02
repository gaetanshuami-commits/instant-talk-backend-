import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// CORS large (ok pour MVP). Plus tard tu peux restreindre au domaine Base44.
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const PORT = Number(process.env.PORT || 8080);

// ===================== OPENAI =====================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===================== HEALTH CHECK =====================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    wsPath: "/ws",
    ttsPath: "/tts",
    timestamp: Date.now(),
  });
});

// ===================== TTS ENDPOINT =====================
// Body: { text: string, lang?: string, voice?: string }
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body || {};

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing 'text' (string)" });
    }

    if (!openai) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured on Railway" });
    }

    // voix OpenAI possibles: alloy, verse, aria, etc (selon compte).
    const selectedVoice = (voice && typeof voice === "string") ? voice : "alloy";

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: selectedVoice,
      input: text,
      format: "mp3",
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

    return res.status(200).json({ audioBase64 });
  } catch (err) {
    console.error("❌ /tts error:", err);
    return res.status(500).json({ error: err?.message || "TTS failure" });
  }
});

// ===================== WEBSOCKET /ws =====================
// Messages attendus:
// start: {type:'start', from:'fr', to:'en', audioFormat:'webm/opus', sampleRate:48000, voiceMode?:boolean}
// audio: {type:'audio', data:'<base64 webm>'}
// stop: {type:'stop'}
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // session config par client
  let session = {
    from: "fr",
    to: "en",
    voiceMode: false,
  };

  ws.on("message", async (msg) => {
    try {
      const raw = msg?.toString?.() ?? "";
      if (!raw) return;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (!data?.type) return;

      if (data.type === "start") {
        session.from = typeof data.from === "string" ? data.from : "fr";
        session.to = typeof data.to === "string" ? data.to : "en";
        session.voiceMode = !!data.voiceMode;

        console.log("▶ Session started", session.from, "->", session.to, "voiceMode:", session.voiceMode);

        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      if (data.type === "stop") {
        console.log("⏹ Session stopped");
        return;
      }

      if (data.type === "audio") {
        // Pour l’instant: on confirme pipeline (comme ton test)
        // Étape suivante: STT -> Translation -> (optionnel) TTS

        if (!data.data || typeof data.data !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Missing audio data (base64)" }));
          return;
        }

        // ✅ 1) STT (à brancher ensuite)
        // Ici tu peux brancher Whisper / Google STT.
        // Pour ne pas casser, on envoie un stt simulé:
        ws.send(JSON.stringify({ type: "stt", text: "[OK] audio chunk reçu", final: true }));

        // ✅ 2) Translation (simulée, à remplacer)
        ws.send(JSON.stringify({
          type: "translation",
          text: "[OK] Audio reçu",
          sourceLang: session.from,
          targetLang: session.to
        }));

        // ✅ 3) TTS (si voiceMode actif) via OpenAI
        if (session.voiceMode && openai) {
          const tts = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: "[OK] Audio reçu",
            format: "mp3",
          });
          const audioBuffer = Buffer.from(await tts.arrayBuffer());
          const audioBase64 = audioBuffer.toString("base64");

          ws.send(JSON.stringify({ type: "tts", data: audioBase64 }));
        }

        return;
      }
    } catch (err) {
      console.error("❌ WS error", err);
      try {
        ws.send(JSON.stringify({ type: "error", message: err?.message || "WS error" }));
      } catch {}
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
