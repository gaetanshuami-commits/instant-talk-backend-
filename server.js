import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import OpenAI from "openai";
import * as deepl from "deepl-node";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// ============ API CLIENTS ============
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// DeepL optionnel (si pas de clé, on fallback OpenAI)
const deeplKey = process.env.DEEPL_API_KEY || "";
const deeplTranslator = deeplKey ? new deepl.Translator(deeplKey) : null;

// ============ HELPERS ============
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function normalizeLang(code) {
  if (!code) return "en";
  return String(code).toLowerCase().split("-")[0];
}

// Traduction : DeepL si possible, sinon OpenAI (fallback)
async function translateText(text, from, to) {
  const src = normalizeLang(from);
  const dst = normalizeLang(to);

  if (deeplTranslator) {
    // DeepL attend des codes type EN, FR...
    const map = (l) => {
      const u = l.toUpperCase();
      if (u === "EN") return "EN";
      if (u === "FR") return "FR";
      if (u === "ES") return "ES";
      if (u === "DE") return "DE";
      if (u === "IT") return "IT";
      if (u === "PT") return "PT";
      if (u === "NL") return "NL";
      if (u === "RU") return "RU";
      if (u === "JA") return "JA";
      if (u === "ZH") return "ZH";
      // DeepL gère AR via API Pro selon plan; sinon fallback OpenAI
      return null;
    };

    const dlSrc = map(src);
    const dlDst = map(dst);

    if (dlDst) {
      const result = await deeplTranslator.translateText(
        text,
        dlSrc || null, // null => auto-detect
        dlDst
      );
      return result?.text || "";
    }
  }

  // Fallback OpenAI translation
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a high quality translator. Preserve meaning and tone. Output only the translation, no quotes.",
      },
      {
        role: "user",
        content: `Translate from ${src} to ${dst}:\n\n${text}`,
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// STT (Whisper) via fichier temporaire
async function sttFromWebmBase64(base64, languageHint) {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `audio_${Date.now()}_${Math.random().toString(16).slice(2)}.webm`);

  const buffer = Buffer.from(base64, "base64");
  await fsp.writeFile(filePath, buffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      language: normalizeLang(languageHint), // si tu veux auto-detect, enlève cette ligne
    });

    return transcription?.text || "";
  } finally {
    // cleanup
    fsp.unlink(filePath).catch(() => {});
  }
}

// TTS OpenAI (retour base64 MP3)
async function ttsToBase64(text, voice = "alloy") {
  const tts = await openai.audio.speech.create({
    model: "tts-1",
    voice,
    input: text,
    format: "mp3",
  });

  const arr = await tts.arrayBuffer();
  const buf = Buffer.from(arr);
  return buf.toString("base64");
}

// ============ HTTP ROUTES ============
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// Endpoint TTS utilisé par ton frontend (callTTS)
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }

    // voice optionnel : alloy, verse, aria... selon OpenAI
    const audioBase64 = await ttsToBase64(text, voice || "alloy");
    return res.json({ audioBase64 });
  } catch (err) {
    console.error("❌ /tts error:", err);
    return res.status(500).json({ error: err.message || "TTS failed" });
  }
});

// ============ WEBSOCKET ============
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket connecté");

  // config par connexion
  let config = {
    from: "fr",
    to: "en",
    voiceMode: false,
    voice: "alloy",
  };

  ws.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg?.type) return;

    try {
      if (msg.type === "start") {
        config = {
          ...config,
          from: msg.from || config.from,
          to: msg.to || config.to,
          voiceMode: !!msg.voiceMode,
          voice: msg.voice || config.voice,
        };

        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      if (msg.type === "audio") {
        const base64 = msg.data;
        if (!base64 || typeof base64 !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
          return;
        }

        // 1) STT
        const sttText = await sttFromWebmBase64(base64, config.from);
        if (sttText) {
          ws.send(JSON.stringify({ type: "stt", text: sttText, final: true }));
        }

        // 2) Translate
        const translated = sttText ? await translateText(sttText, config.from, config.to) : "";
        if (translated) {
          ws.send(JSON.stringify({
            type: "translation",
            text: translated,
            sourceLang: normalizeLang(config.from),
            targetLang: normalizeLang(config.to),
          }));
        }

        // 3) TTS (si tu veux toujours TTS, garde. Sinon conditionne à msg.voiceMode)
        // Ici: on envoie TTS si voiceMode = true
        if (config.voiceMode && translated) {
          const audioB64 = await ttsToBase64(translated, config.voice);
          ws.send(JSON.stringify({ type: "tts", data: audioB64 }));
        }

        return;
      }

      if (msg.type === "stop") {
        console.log("⏹ Session stopped");
        return;
      }
    } catch (err) {
      console.error("❌ WS pipeline error:", err);
      ws.send(JSON.stringify({ type: "error", message: err.message || "Pipeline error" }));
    }
  });

  ws.on("close", () => console.log("❎ Client déconnecté"));
  ws.on("error", (e) => console.error("❌ WS error:", e));
});

// ============ START ============
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
