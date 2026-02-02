import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

import OpenAI from "openai";
import * as deepl from "deepl-node";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

// Railway fournit PORT automatiquement → ne force pas si pas besoin
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY manquante");
if (!DEEPL_API_KEY) console.warn("⚠️ DEEPL_API_KEY manquante");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const translator = new deepl.Translator(DEEPL_API_KEY);

// ---------- Helpers ----------
function normalizeLang(code) {
  if (!code) return "en";
  return String(code).toLowerCase().split("-")[0];
}

function mapToDeepL(code) {
  // DeepL attend souvent EN/FR/ES... en majuscules (source peut être null = autodetect)
  const c = normalizeLang(code).toUpperCase();
  // quelques normalisations
  if (c === "ZH") return "ZH";
  if (c === "PT") return "PT";
  return c;
}

function tempFilePath(ext = "webm") {
  const id = crypto.randomUUID();
  return path.join(os.tmpdir(), `instant-talk-${id}.${ext}`);
}

// ---------- HTTP ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", wsPath: "/ws", timestamp: Date.now() });
});

/**
 * POST /tts
 * body: { text, lang, voice }
 * return: { audioBase64 }
 */
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }

    const v = (voice && String(voice)) || "alloy";

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: v,
      input: text,
      format: "mp3",
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

    res.json({ audioBase64 });
  } catch (err) {
    console.error("❌ /tts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- WebSocket /ws ----------
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // session config par client
  let config = {
    from: "fr",  // peut être "auto"
    to: "en",
    voiceMode: false,
  };

  ws.send(JSON.stringify({ type: "ready" }));

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (!data?.type) return;

      if (data.type === "start") {
        config = {
          from: data.from || "fr",
          to: data.to || "en",
          voiceMode: !!data.voiceMode,
        };
        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      if (data.type === "stop") {
        return;
      }

      if (data.type !== "audio") return;
      if (!data.data) {
        ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
        return;
      }

      // 1) base64 -> fichier temporaire webm
      const inputPath = tempFilePath("webm");
      const buffer = Buffer.from(data.data, "base64");
      fs.writeFileSync(inputPath, buffer);

      // 2) STT Whisper
      const whisperLang = normalizeLang(config.from);
      const stt = await openai.audio.transcriptions.create({
        file: fs.createReadStream(inputPath),
        model: "whisper-1",
        // si "auto", ne pas forcer language
        ...(whisperLang === "auto" ? {} : { language: whisperLang }),
      });

      // cleanup
      try { fs.unlinkSync(inputPath); } catch {}

      const originalText = stt?.text?.trim();
      if (!originalText) {
        ws.send(JSON.stringify({ type: "error", message: "STT failed" }));
        return;
      }

      ws.send(JSON.stringify({ type: "stt", text: originalText, final: true }));

      // 3) DeepL translation
      const target = mapToDeepL(config.to);

      // sourceLang = null => autodetect DeepL
      const source = (normalizeLang(config.from) === "auto") ? null : mapToDeepL(config.from);

      const translated = await translator.translateText(
        originalText,
        source,     // peut être null
        target
      );

      const translatedText = translated?.text?.trim();
      if (!translatedText) {
        ws.send(JSON.stringify({ type: "error", message: "Translation failed" }));
        return;
      }

      ws.send(JSON.stringify({
        type: "translation",
        text: translatedText,
        sourceLang: source || "auto",
        targetLang: target,
      }));

      // 4) TTS (optionnel mais demandé par ton frontend)
      const tts = await openai.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: translatedText,
        format: "mp3",
      });

      const audioBuffer = Buffer.from(await tts.arrayBuffer());
      const audioBase64 = audioBuffer.toString("base64");

      ws.send(JSON.stringify({ type: "tts", data: audioBase64 }));

    } catch (err) {
      console.error("❌ WS pipeline error:", err);
      try {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      } catch {}
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
