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
app.use(express.json({ limit: "20mb" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// ==== REQUIRED ENV ====
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
}
if (!process.env.DEEPL_API_KEY) {
  console.error("❌ Missing DEEPL_API_KEY");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const translator = new deepl.Translator(process.env.DEEPL_API_KEY);

// ================= HEALTH CHECK =================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// ================= TTS HTTP ENDPOINT =================
// Frontend calls POST { text, lang, voice }
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }

    // OpenAI TTS voices: alloy, verse, etc. (keep default if unknown)
    const ttsVoice = (voice && typeof voice === "string") ? voice : "alloy";

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: ttsVoice,
      input: text,
      format: "mp3",
    });

    const buf = Buffer.from(await tts.arrayBuffer());
    return res.json({ audioBase64: buf.toString("base64"), lang: lang || "auto" });
  } catch (err) {
    console.error("❌ /tts error:", err?.message);
    return res.status(500).json({ error: err?.message || "TTS failed" });
  }
});

// ================= WEBSOCKET =================
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

function normalizeLangCode(code) {
  if (!code) return "EN";
  const c = String(code).toUpperCase();
  // DeepL expects e.g. EN, FR, ES, DE...
  // If you send "en" -> "EN"
  return c.length === 2 ? c : c.slice(0, 2);
}

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // Per-connection config
  let cfg = {
    from: "FR",
    to: "EN",
    voiceMode: false,
    quality: "balanced",
  };

  ws.send(JSON.stringify({ type: "ready" }));

  ws.on("message", async (msg) => {
    try {
      const raw = msg?.toString?.() || "";
      if (!raw) return;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (!data?.type) return;

      // START
      if (data.type === "start") {
        cfg.from = normalizeLangCode(data.from || "FR");
        cfg.to = normalizeLangCode(data.to || "EN");
        cfg.voiceMode = !!data.voiceMode;
        cfg.quality = data.quality || "balanced";

        console.log("▶ Session started", cfg.from, "->", cfg.to, "voiceMode:", cfg.voiceMode);

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
        const b64 = data.data;
        if (!b64 || typeof b64 !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
          return;
        }

        // 1) decode base64 -> write tmp webm
        const audioBuf = Buffer.from(b64, "base64");
        const tmpFile = path.join(os.tmpdir(), `chunk-${Date.now()}.webm`);
        fs.writeFileSync(tmpFile, audioBuf);

        // 2) STT (Whisper)
        let sttText = "";
        try {
          const tr = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tmpFile),
            model: "whisper-1",
            // language is optional; if you force wrong language it can hurt
            // language: cfg.from.toLowerCase(),
          });
          sttText = tr?.text || "";
        } finally {
          // cleanup temp
          try { fs.unlinkSync(tmpFile); } catch {}
        }

        if (!sttText) {
          ws.send(JSON.stringify({ type: "error", message: "STT failed (empty)" }));
          return;
        }

        ws.send(JSON.stringify({ type: "stt", text: sttText, final: true }));

        // 3) Translate (DeepL)
        // DeepL codes: EN, FR, ES, DE... (source can be null for auto-detect)
        let translated = "";
        try {
          const result = await translator.translateText(
            sttText,
            cfg.from || null,
            cfg.to
          );
          translated = result?.text || "";
        } catch (e) {
          console.error("❌ DeepL error:", e?.message);
          ws.send(JSON.stringify({ type: "error", message: "Translation failed", details: e?.message }));
          return;
        }

        if (!translated) {
          ws.send(JSON.stringify({ type: "error", message: "Translation failed (empty)" }));
          return;
        }

        ws.send(JSON.stringify({
          type: "translation",
          text: translated,
          sourceLang: cfg.from,
          targetLang: cfg.to,
        }));

        // 4) TTS (optional but recommended)
        // Always send TTS so frontend can play it in voice mode
        try {
          const tts = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: translated,
            format: "mp3",
          });
          const buf = Buffer.from(await tts.arrayBuffer());
          ws.send(JSON.stringify({ type: "tts", data: buf.toString("base64") }));
        } catch (e) {
          console.error("❌ TTS error:", e?.message);
          ws.send(JSON.stringify({ type: "error", message: "TTS failed", details: e?.message }));
        }

        return;
      }
    } catch (err) {
      console.error("❌ WS handler error:", err);
      try {
        ws.send(JSON.stringify({ type: "error", message: err?.message || "Unknown error" }));
      } catch {}
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
});

// ================= SERVER START =================
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
