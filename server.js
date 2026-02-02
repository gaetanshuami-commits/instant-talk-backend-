import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import OpenAI from "openai";
import * as deepl from "deepl-node";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // pour /tts

const server = http.createServer(app);

// Railway injecte PORT automatiquement. Ne pas le “forcer” en secret fichier.
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquante");
if (!DEEPL_API_KEY) console.warn("⚠️ DEEPL_API_KEY manquante");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const translator = DEEPL_API_KEY ? new deepl.Translator(DEEPL_API_KEY) : null;

// ------------------- HEALTH -------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// ------------------- OPTIONAL HTTP TTS -------------------
// (utile si ton frontend appelle /tts en HTTP)
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

    const ttsResp = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
      format: "mp3",
    });

    const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
    return res.json({ audioBase64: audioBuffer.toString("base64") });
  } catch (e) {
    console.error("❌ /tts error:", e?.message);
    return res.status(500).json({ error: e?.message || "TTS failed" });
  }
});

// ------------------- WEBSOCKET /ws -------------------
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // config par connexion
  let config = { from: "fr", to: "en" };

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (!data?.type) return;

      // START
      if (data.type === "start") {
        config = {
          from: (data.from || "fr").toLowerCase(),
          to: (data.to || "en").toLowerCase(),
        };
        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      // AUDIO chunk base64 (webm/opus)
      if (data.type === "audio") {
        if (!data.data) {
          ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
          return;
        }
        if (!OPENAI_API_KEY) {
          ws.send(JSON.stringify({ type: "error", message: "OPENAI_API_KEY missing" }));
          return;
        }
        if (!translator) {
          ws.send(JSON.stringify({ type: "error", message: "DEEPL_API_KEY missing" }));
          return;
        }

        // 1) decode base64 -> temp file
        const buffer = Buffer.from(data.data, "base64");
        const tmpFile = path.join(os.tmpdir(), `chunk-${Date.now()}.webm`);
        fs.writeFileSync(tmpFile, buffer);

        // 2) Whisper STT
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile),
          model: "whisper-1",
          language: config.from, // ex: "fr"
        });

        // cleanup
        try { fs.unlinkSync(tmpFile); } catch {}

        const text = transcription?.text?.trim();
        if (!text) {
          ws.send(JSON.stringify({ type: "error", message: "STT failed (empty)" }));
          return;
        }

        ws.send(JSON.stringify({ type: "stt", text, final: true }));

        // 3) DeepL translate
        // DeepL veut souvent des codes style "FR", "EN-US"
        const source = config.from.toUpperCase(); // "FR"
        const target = config.to.toUpperCase();   // "EN"
        const tr = await translator.translateText(text, source, target);

        const translated = tr?.text?.trim();
        if (!translated) {
          ws.send(JSON.stringify({ type: "error", message: "Translation failed" }));
          return;
        }

        ws.send(JSON.stringify({
          type: "translation",
          text: translated,
          sourceLang: config.from,
          targetLang: config.to,
        }));

        // 4) OpenAI TTS -> mp3 base64
        const ttsResp = await openai.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: translated,
          format: "mp3",
        });

        const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
        ws.send(JSON.stringify({
          type: "tts",
          data: audioBuffer.toString("base64"),
        }));

        return;
      }

      if (data.type === "stop") {
        console.log("⏹ Session stopped");
        return;
      }

    } catch (err) {
      console.error("❌ WS error:", err?.message);
      try {
        ws.send(JSON.stringify({ type: "error", message: err?.message || "WS error" }));
      } catch {}
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
  ws.on("error", (e) => console.error("❌ WS socket error:", e?.message));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
