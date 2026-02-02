import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";
import * as deepl from "deepl-node";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquante");
if (!DEEPL_API_KEY) console.warn("⚠️ DEEPL_API_KEY manquante");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const translator = DEEPL_API_KEY ? new deepl.Translator(DEEPL_API_KEY) : null;

// --------- Helpers ----------
function safeJsonSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error("❌ WS send error:", e?.message);
  }
}

function normalizeLang(code) {
  if (!code) return "en";
  return String(code).toLowerCase().split("-")[0];
}

function tmpFile(ext) {
  const name = `chunk_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
  return path.join(os.tmpdir(), name);
}

// ================= HEALTH CHECK =================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// ================= TTS HTTP (optionnel mais utile) =================
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing" });
    }

    const voiceName = (voice && typeof voice === "string") ? voice : "alloy";

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: voiceName,
      input: text,
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

    res.json({ audioBase64, lang: lang || "auto", voice: voiceName });
  } catch (err) {
    console.error("❌ /tts error:", err);
    res.status(500).json({ error: err?.message || "TTS failed" });
  }
});

// ================= WEBSOCKET =================
const wss = new WebSocketServer({
  server,
  path: "/ws",
});

console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // config par connexion
  let cfg = {
    from: "fr",
    to: "en",
    audioFormat: "audio/webm;codecs=opus",
    sampleRate: 48000,
    voiceMode: false,
  };

  ws.on("message", async (raw) => {
    const t0 = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg?.type) return;

      // START
      if (msg.type === "start") {
        cfg = {
          ...cfg,
          from: normalizeLang(msg.from || cfg.from),
          to: normalizeLang(msg.to || cfg.to),
          audioFormat: msg.audioFormat || cfg.audioFormat,
          sampleRate: msg.sampleRate || cfg.sampleRate,
          voiceMode: !!msg.voiceMode,
        };

        console.log("▶ start:", cfg.from, "->", cfg.to, "|", cfg.audioFormat);

        safeJsonSend(ws, { type: "ready" });
        return;
      }

      // STOP
      if (msg.type === "stop") {
        console.log("⏹ stop");
        return;
      }

      // AUDIO CHUNK
      if (msg.type === "audio") {
        if (!msg.data || typeof msg.data !== "string") {
          safeJsonSend(ws, { type: "error", message: "Missing audio data" });
          return;
        }
        if (!OPENAI_API_KEY) {
          safeJsonSend(ws, { type: "error", message: "OPENAI_API_KEY missing" });
          return;
        }

        // 1) sauver chunk base64 -> .webm
        const file = tmpFile("webm");
        fs.writeFileSync(file, Buffer.from(msg.data, "base64"));

        // 2) STT Whisper
        let transcriptText = "";
        try {
          const stt = await openai.audio.transcriptions.create({
            file: fs.createReadStream(file),
            model: "whisper-1",
            language: cfg.from, // si tu veux auto-detect, enlève cette ligne
          });
          transcriptText = stt?.text || "";
        } catch (e) {
          console.error("❌ STT error:", e?.message);
          safeJsonSend(ws, { type: "error", message: "STT failed", details: e?.message });
          return;
        } finally {
          try { fs.unlinkSync(file); } catch {}
        }

        if (!transcriptText) {
          safeJsonSend(ws, { type: "error", message: "Empty transcription" });
          return;
        }

        safeJsonSend(ws, { type: "stt", text: transcriptText, final: true });

        // 3) Translate DeepL (si clé dispo), sinon fallback = texte original
        let translatedText = transcriptText;
        if (translator) {
          try {
            const result = await translator.translateText(
              transcriptText,
              cfg.from.toUpperCase(),
              cfg.to.toUpperCase()
            );
            translatedText = result?.text || transcriptText;
          } catch (e) {
            console.error("❌ DeepL error:", e?.message);
            // fallback
            translatedText = transcriptText;
          }
        }

        safeJsonSend(ws, {
          type: "translation",
          text: translatedText,
          sourceLang: cfg.from,
          targetLang: cfg.to,
          latencyMs: Date.now() - t0,
        });

        // 4) TTS (renvoie base64 mp3)
        try {
          const tts = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: translatedText,
          });

          const audioBuffer = Buffer.from(await tts.arrayBuffer());
          const audioBase64 = audioBuffer.toString("base64");

          safeJsonSend(ws, { type: "tts", data: audioBase64 });
        } catch (e) {
          console.error("❌ TTS error:", e?.message);
          safeJsonSend(ws, { type: "error", message: "TTS failed", details: e?.message });
        }

        return;
      }
    } catch (err) {
      console.error("❌ WS message error:", err);
      safeJsonSend(ws, { type: "error", message: err?.message || "Invalid packet" });
    }
  });

  ws.on("close", () => {
    console.log("❎ Client déconnecté");
  });

  ws.on("error", (e) => {
    console.error("❌ WS socket error:", e?.message);
  });
});

// ================= SERVER START =================
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
