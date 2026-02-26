// server.js — Instant Talk Backend (Node only, no React)
// WS: /ws
// Receives: binary PCM16 mono 16kHz
// Receives JSON: {type:"config"|"flush"|"reset"}
// Sends JSON: {type:"stt"} {type:"translation"} {type:"tts", audioB64:"..."} {type:"error"}

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { OpenAI } from "openai";
import { toFile } from "openai/uploads";

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;

const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TRANSL_MODEL = process.env.OPENAI_TRANSL_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) console.warn("[WARN] OPENAI_API_KEY missing");
if (!DEEPL_API_KEY) console.warn("[WARN] DEEPL_API_KEY missing");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --------- Constants / Guards ----------
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2; // Int16
const MIN_AUDIO_MS = 420;   // drop too short audio (anti-hallucination)
const MAX_AUDIO_MS = 8000;  // safety

function audioMsFromBytes(byteLen) {
  const samples = byteLen / BYTES_PER_SAMPLE;
  return (samples / SAMPLE_RATE) * 1000;
}

// Detect "suspect" text (empty, symbols, too short, typical short hallucinations)
function isSuspectText(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (!t) return true;
  if (t.length < 2) return true;

  // must contain at least one letter (covers Latin/Cyrillic/CJK/Kana)
  const hasLetter = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-я一-龯ぁ-ゟァ-ヿ]/.test(t);
  if (!hasLetter) return true;

  // blacklist typical noise hallucinations (you can extend)
  const lower = t.toLowerCase();
  const blacklist = new Set(["you", "boing", "boing boing"]);
  if (blacklist.has(lower)) return true;

  return false;
}

// --------- PCM16 -> WAV (so Whisper accepts it) ----------
function pcm16ToWav(pcmBuffer, sampleRate = 16000, channels = 1) {
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);            // PCM fmt chunk size
  header.writeUInt16LE(1, 20);             // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// --------- Language helpers ----------
function normalizeLang(input) {
  if (!input) return "en";
  const raw = String(input).trim();
  const parts = raw.split(/[-_]/).filter(Boolean);
  if (parts.length === 1) return parts[0].toLowerCase();
  return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
}

// DeepL uses like: EN, EN-GB, EN-US, FR, DE, ES, IT, PT-BR, PT-PT, etc.
function toDeeplLang(lang) {
  const n = normalizeLang(lang);
  const [l, r] = n.split("-");
  if (!r) {
    // base language
    if (l === "en") return "EN";
    return l.toUpperCase();
  }
  // region variants
  if (l === "en" && (r === "GB" || r === "US")) return `EN-${r}`;
  if (l === "pt" && (r === "BR" || r === "PT")) return `PT-${r}`;
  // fallback
  return `${l.toUpperCase()}-${r}`;
}

function deeplBaseUrl(apiKey) {
  // free keys often end with :fx
  return apiKey && apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}

// --------- Providers ----------
async function sttWhisper(pcm16Buffer, fromLang) {
  // Convert raw PCM to WAV for Whisper
  const wav = pcm16ToWav(pcm16Buffer, SAMPLE_RATE, CHANNELS);

  const file = await toFile(wav, "audio.wav");
  const language = normalizeLang(fromLang)?.split("-")[0]; // whisper expects e.g. "fr" "en"

  const res = await openai.audio.transcriptions.create({
    model: OPENAI_STT_MODEL,
    file,
    language,
  });

  // openai sdk returns { text: "..." }
  return res?.text || "";
}

async function translateDeepL(text, fromLang, toLang) {
  if (!DEEPL_API_KEY) throw new Error("DEEPL_API_KEY missing");
  const url = `${deeplBaseUrl(DEEPL_API_KEY)}/v2/translate`;

  const params = new URLSearchParams();
  params.set("auth_key", DEEPL_API_KEY);
  params.append("text", text);

  // Source is optional in DeepL. If you pass it, use correct codes.
  const src = toDeeplLang(fromLang);
  const tgt = toDeeplLang(toLang);
  if (src) params.set("source_lang", src);
  params.set("target_lang", tgt);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DeepL error ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const translated = data?.translations?.[0]?.text || "";
  return translated;
}

async function translateFallbackOpenAI(text, fromLang, toLang) {
  const src = normalizeLang(fromLang);
  const tgt = normalizeLang(toLang);

  const resp = await openai.chat.completions.create({
    model: OPENAI_TRANSL_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a translation engine. Return ONLY the translated text, no explanations, no quotes.",
      },
      {
        role: "user",
        content: `Translate from ${src} to ${tgt}:\n\n${text}`,
      },
    ],
  });

  return resp?.choices?.[0]?.message?.content?.trim() || "";
}

async function ttsOpenAI(text, toLang) {
  const voice = "alloy"; // you can make configurable
  const resp = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice,
    format: "mp3",
    input: text,
  });

  // resp is a Response-like object in the SDK
  const arrayBuffer = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  return buf.toString("base64");
}

// --------- WebSocket Pipeline ----------
function createSession(ws) {
  let config = { fromLang: "en", toLang: "fr", mode: "continuous" };
  let audioChunks = [];
  let audioBytes = 0;

  function send(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function resetBuffer() {
    audioChunks = [];
    audioBytes = 0;
  }

  async function runPipeline(reason = "flush") {
    const ms = audioMsFromBytes(audioBytes);

    // guards
    if (ms < MIN_AUDIO_MS) {
      send({ type: "stt", skipped: true, reason: "audio_too_short", audioMs: Math.round(ms) });
      resetBuffer();
      return;
    }
    if (ms > MAX_AUDIO_MS) {
      send({ type: "stt", skipped: true, reason: "audio_too_long", audioMs: Math.round(ms) });
      resetBuffer();
      return;
    }

    const merged = Buffer.concat(audioChunks, audioBytes);
    resetBuffer();

    try {
      console.log(`[PIPE] start reason=${reason} audioMs=${Math.round(ms)} from=${config.fromLang} to=${config.toLang}`);

      // 1) STT
      const stt = await sttWhisper(merged, config.fromLang);
      if (!stt || !stt.trim()) {
        send({ type: "stt", skipped: true, reason: "stt_empty" });
        return;
      }
      if (isSuspectText(stt)) {
        send({ type: "stt", skipped: true, reason: "stt_suspect", text: stt });
        return;
      }
      send({ type: "stt", text: stt });

      // 2) Translation (DeepL priority)
      let translated = "";
      try {
        translated = await translateDeepL(stt, config.fromLang, config.toLang);
      } catch (e) {
        console.warn("[TRANSL] DeepL failed, fallback to OpenAI:", e?.message || e);
        translated = await translateFallbackOpenAI(stt, config.fromLang, config.toLang);
      }

      if (!translated || !translated.trim()) {
        send({ type: "error", code: "TRANSL_EMPTY", message: "Translation returned empty text" });
        return;
      }
      send({ type: "translation", text: translated });

      // 3) TTS
      const audioB64 = await ttsOpenAI(translated, config.toLang);
      if (!audioB64) {
        send({ type: "error", code: "TTS_EMPTY", message: "TTS returned empty audio" });
        return;
      }
      send({ type: "tts", audioB64 });
    } catch (err) {
      console.error("[PIPE] error:", err);
      send({ type: "error", code: "PIPELINE_ERROR", message: err?.message || "Pipeline error" });
    }
  }

  ws.on("message", async (data, isBinary) => {
    try {
      if (!isBinary) {
        const msg = JSON.parse(data.toString("utf8"));

        if (msg.type === "config") {
          config = {
            fromLang: normalizeLang(msg.fromLang || "en"),
            toLang: normalizeLang(msg.toLang || "fr"),
            mode: msg.mode === "push_to_talk" ? "push_to_talk" : "continuous",
          };
          return;
        }

        if (msg.type === "reset") {
          resetBuffer();
          return;
        }

        if (msg.type === "flush") {
          if (audioBytes > 0) await runPipeline("flush");
          return;
        }

        return;
      }

      // Binary PCM16 chunk
      const buf = Buffer.from(data);
      audioChunks.push(buf);
      audioBytes += buf.length;

      // Optional auto-run for continuous mode every ~1.5s of audio
      const ms = audioMsFromBytes(audioBytes);
      if (config.mode === "continuous" && ms >= 1500) {
        await runPipeline("auto");
      }
    } catch (err) {
      send({ type: "error", code: "WS_MSG_ERROR", message: err?.message || "WS message error" });
    }
  });

  ws.on("close", () => resetBuffer());
}

// --------- Server ----------
const app = express();
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.status(200).send("Instant Talk backend OK");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[WS] client connected");
  createSession(ws);
  ws.on("close", () => console.log("[WS] client disconnected"));
});

server.listen(PORT, () => {
  console.log(`Backend Instant Talk listening on port ${PORT}`);
  console.log(`WS endpoint: /ws`);
});
