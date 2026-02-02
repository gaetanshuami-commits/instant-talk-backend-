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

// Railway fournit PORT automatiquement. Ne le mets pas en variable.
const PORT = process.env.PORT || 8080;

// ====== REQUIRED ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!DEEPL_API_KEY) console.warn("⚠️ Missing DEEPL_API_KEY");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const translator = DEEPL_API_KEY ? new deepl.Translator(DEEPL_API_KEY) : null;

// ================= HEALTH CHECK =================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    ttsPath: "/tts",
    timestamp: Date.now(),
  });
});

// ================= TTS HTTP ENDPOINT =================
// Front: POST /tts { text, lang, voice }
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }

    // Voice OpenAI: alloy / verse / aria / etc (selon ton compte)
    const chosenVoice = (voice && String(voice)) || "alloy";

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: chosenVoice,
      input: text,
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

    res.json({ audioBase64 });
  } catch (err) {
    console.error("❌ /tts error:", err);
    res.status(500).json({ error: err.message || "TTS failed" });
  }
});

// ================= WEBSOCKET =================
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // config par client
  let config = { from: "fr", to: "en" };

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (!data || typeof data !== "object" || !data.type) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid packet" }));
        return;
      }

      // START
      if (data.type === "start") {
        config = {
          from: (data.from || "fr").toLowerCase(),
          to: (data.to || "en").toLowerCase(),
        };

        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      // STOP
      if (data.type === "stop") {
        console.log("⏹ Session stopped");
        return;
      }

      // AUDIO
      if (data.type === "audio") {
        if (!data.data) {
          ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
          return;
        }
        if (!OPENAI_API_KEY) {
          ws.send(JSON.stringify({ type: "error", message: "OPENAI_API_KEY not set" }));
          return;
        }

        // 1) base64 -> file temp .webm
        const buffer = Buffer.from(data.data, "base64");
        const tmpFile = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(16).slice(2)}.webm`);
        fs.writeFileSync(tmpFile, buffer);

        // 2) STT Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile),
          model: "whisper-1",
          language: config.from, // "fr", "en", ...
        });

        // cleanup temp file
        fs.unlinkSync(tmpFile);

        const originalText = transcription?.text?.trim();
        if (!originalText) {
          ws.send(JSON.stringify({ type: "error", message: "STT failed" }));
          return;
        }

        ws.send(JSON.stringify({ type: "stt", text: originalText, final: true }));

        // 3) Translate DeepL
        if (!translator) {
          ws.send(JSON.stringify({ type: "error", message: "DEEPL_API_KEY not set" }));
          return;
        }

        // DeepL veut souvent "FR" / "EN" etc. On map simple :
        const sourceLang = config.from.toUpperCase();
        const targetLang = config.to.toUpperCase();

        const translation = await translator.translateText(originalText, sourceLang, targetLang);
        const translatedText = translation?.text?.trim();

        if (!translatedText) {
          ws.send(JSON.stringify({ type: "error", message: "Translation failed" }));
          return;
        }

        ws.send(JSON.stringify({ type: "translation", text: translatedText, sourceLang: config.from, targetLang: config.to }));

        // 4) TTS OpenAI
        const tts = await openai.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: translatedText,
        });

        const audioBuffer = Buffer.from(await tts.arrayBuffer());
        const audioBase64 = audioBuffer.toString("base64");

        ws.send(JSON.stringify({ type: "tts", data: audioBase64 }));
        return;
      }
    } catch (err) {
      console.error("❌ WS error:", err);
      try {
        ws.send(JSON.stringify({ type: "error", message: err.message || "WS error" }));
      } catch {}
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
