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

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || "development";

// ========= REQUIRED ENV =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

// Optional
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1); // safe default (no crash)
const MIN_AUDIO_BYTES_TO_PROCESS = Number(process.env.MIN_AUDIO_BYTES_TO_PROCESS || 18000); // ~1s+ webm opus (approx)
const MAX_BUFFER_BYTES = Number(process.env.MAX_BUFFER_BYTES || 800000); // 0.8MB buffer cap (safety)
const DEFAULT_FROM = (process.env.DEFAULT_FROM || "fr").toLowerCase();
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "alloy"; // OpenAI TTS voice
const DEEPL_TARGET_FORMALITY = process.env.DEEPL_FORMALITY || "default"; // default | more | less
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in Railway variables");
}
if (!DEEPL_API_KEY) {
  console.error("❌ Missing DEEPL_API_KEY in Railway variables");
}

// ========= Clients =========
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const translator = new deepl.Translator(DEEPL_API_KEY);

// ========= App =========
const app = express();

// CORS (safe)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: false,
  })
);

app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);

// ========= Health =========
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// ========= Helpers =========
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function mapLangToDeepL(code) {
  // DeepL uses e.g. EN, FR, ES, DE, IT, PT, NL, PL, etc.
  // We accept "en" / "en-US" -> "EN"
  const c = (code || "").toLowerCase();
  const base = c.split("-")[0];

  const map = {
    en: "EN",
    fr: "FR",
    es: "ES",
    de: "DE",
    it: "IT",
    pt: "PT",
    nl: "NL",
    pl: "PL",
    ru: "RU",
    ja: "JA",
    zh: "ZH",
    ar: "AR",
  };

  return map[base] || "EN";
}

function mapLangToWhisper(code) {
  // Whisper accepts ISO-like tags; we pass base language like "fr", "en"
  const c = (code || "").toLowerCase();
  return c.split("-")[0] || "en";
}

function nowId() {
  return crypto.randomBytes(6).toString("hex");
}

function tmpFile(ext = "webm") {
  return path.join(os.tmpdir(), `instant-talk-${Date.now()}-${nowId()}.${ext}`);
}

// Simple concurrency limiter (to avoid memory spikes / crash)
let runningJobs = 0;
const jobQueue = [];

function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      runningJobs++;
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        runningJobs--;
        if (jobQueue.length > 0) {
          const next = jobQueue.shift();
          next();
        }
      }
    };

    if (runningJobs < MAX_CONCURRENT_JOBS) task();
    else jobQueue.push(task);
  });
}

// ========= HTTP TTS Endpoint (optional but useful) =========
// POST /tts { text, lang, voice? } -> { audioBase64 }
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }

    const v = (voice && typeof voice === "string" ? voice : DEFAULT_VOICE).trim();

    const tts = await openai.audio.speech.create({
      model: "tts-1",
      voice: v,
      input: text,
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    return res.json({ audioBase64: audioBuffer.toString("base64") });
  } catch (err) {
    console.error("❌ /tts error:", err?.message || err);
    return res.status(500).json({ error: "TTS failed" });
  }
});

// ========= WebSocket =========
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws) => {
  const sessionId = nowId();

  // Session config
  const session = {
    from: DEFAULT_FROM,
    to: "en",
    voiceMode: true, // send tts by default
    whisperLanguage: DEFAULT_FROM,
    deeplSource: mapLangToDeepL(DEFAULT_FROM),
    deeplTarget: "EN",
    voice: DEFAULT_VOICE,
  };

  // Audio buffering (IMPORTANT: whisper needs enough audio to transcribe reliably)
  let audioChunks = [];
  let audioBytes = 0;
  let closed = false;

  console.log(`🔌 WS connected [${sessionId}]`);

  const send = (obj) => {
    if (closed) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  };

  const resetBuffer = () => {
    audioChunks = [];
    audioBytes = 0;
  };

  const processBufferedAudio = async () => {
    if (audioBytes <= 0) return;

    const buffer = Buffer.concat(audioChunks, audioBytes);
    resetBuffer();

    // Write temp file for Whisper
    const filePath = tmpFile("webm");
    fs.writeFileSync(filePath, buffer);

    try {
      // 1) STT Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        language: session.whisperLanguage, // best quality when set
      });

      const originalText = (transcription?.text || "").trim();
      if (!originalText) return;

      send({ type: "stt", text: originalText, final: true });

      // 2) DeepL translate
      // If you want strict source: use session.deeplSource; else allow autodetect by passing null.
      const translated = await translator.translateText(
        originalText,
        session.deeplSource, // fixed source for max quality/consistency
        session.deeplTarget,
        { formality: DEEPL_TARGET_FORMALITY }
      );

      const translatedText = (translated?.text || "").trim();
      if (!translatedText) return;

      send({
        type: "translation",
        text: translatedText,
        sourceLang: session.from,
        targetLang: session.to,
      });

      // 3) TTS OpenAI
      if (session.voiceMode) {
        const tts = await openai.audio.speech.create({
          model: "tts-1",
          voice: session.voice,
          input: translatedText,
        });

        const audioBuffer = Buffer.from(await tts.arrayBuffer());
        send({
          type: "tts",
          data: audioBuffer.toString("base64"),
          codec: "audio/mpeg",
        });
      }
    } finally {
      // always cleanup
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  };

  ws.on("message", async (raw) => {
    const msgStr = raw?.toString?.() || "";
    const data = safeJsonParse(msgStr);

    if (!data || typeof data !== "object" || !data.type) {
      return send({ type: "error", message: "Invalid packet" });
    }

    try {
      // START
      if (data.type === "start") {
        session.from = (data.from || DEFAULT_FROM).toLowerCase();
        session.to = (data.to || "en").toLowerCase();
        session.voiceMode = data.voiceMode !== undefined ? !!data.voiceMode : true;
        session.voice = (data.voice || DEFAULT_VOICE).toString();

        session.whisperLanguage = mapLangToWhisper(session.from);
        session.deeplSource = mapLangToDeepL(session.from);
        session.deeplTarget = mapLangToDeepL(session.to);

        resetBuffer();

        console.log(
          `▶ start [${sessionId}] ${session.from} -> ${session.to} voiceMode=${session.voiceMode}`
        );

        return send({ type: "ready" });
      }

      // AUDIO
      if (data.type === "audio") {
        if (!data.data || typeof data.data !== "string") {
          return send({ type: "error", message: "Missing audio data" });
        }

        // Safety: avoid infinite memory growth
        if (audioBytes > MAX_BUFFER_BYTES) {
          resetBuffer();
          return send({
            type: "error",
            message: "Audio buffer overflow (client sending too much too fast)",
          });
        }

        const chunk = Buffer.from(data.data, "base64");
        audioChunks.push(chunk);
        audioBytes += chunk.length;

        // Process only when we have enough audio for reliable Whisper
        if (audioBytes >= MIN_AUDIO_BYTES_TO_PROCESS) {
          await runWithLimit(processBufferedAudio);
        }
        return;
      }

      // STOP
      if (data.type === "stop") {
        console.log(`⏹ stop [${sessionId}]`);

        // flush remainder if any
        if (audioBytes > 0) {
          await runWithLimit(processBufferedAudio);
        }
        resetBuffer();
        return;
      }
    } catch (err) {
      console.error(`❌ WS pipeline error [${sessionId}]:`, err?.message || err);
      return send({
        type: "error",
        message: err?.message || "Pipeline error",
      });
    }
  });

  ws.on("close", () => {
    closed = true;
    resetBuffer();
    console.log(`👋 WS disconnected [${sessionId}]`);
  });

  ws.on("error", (err) => {
    console.error(`❌ WS error [${sessionId}]:`, err?.message || err);
  });
});

// ========= Start =========
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (${NODE_ENV})`);
});
