/**
 * server.js — Instant Talk Global (Railway)
 * WebSocket: /ws
 * Audio in: PCM Int16 LE, mono, 16kHz (binary frames)
 * Control: JSON strings (e.g. {"type":"flush", ...})
 * Output events (always):
 *   { type:"stt", text, lang, ms }
 *   { type:"translation", text, sourceLang, targetLang, provider, ms }
 *   { type:"tts", audioB64, mime:"audio/mpeg", bytes, voice, ms }
 *   OR { type:"error", stage, message, details }
 *
 * Requirements:
 * - Node.js ESM
 * - express, ws, openai
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

// -------------------------
// Env / Config
// -------------------------
const PORT = Number(process.env.PORT || 3000);

const WS_PATH = "/ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("[FATAL] Missing OPENAI_API_KEY");
  process.exit(1);
}

const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini";

const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "coral").trim();

const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || "").trim();

const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;

const MAX_PCM_BYTES_PER_UTTERANCE = Number(process.env.MAX_PCM_BYTES_PER_UTTERANCE || 3_000_000); // ~93s @16kHz mono 16-bit
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2000);

const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15_000);

// DeepL target lang mapping (mandatory)
function mapDeepLTargetLang(lang) {
  const l = (lang || "").trim();
  if (!l) return l;
  const lower = l.toLowerCase();
  if (lower === "en") return "en-US";
  if (lower === "pt") return "pt-PT";
  if (lower === "zh") return "zh-Hans";
  return l;
}

// -------------------------
// OpenAI Client
// -------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------------
// Express App
// -------------------------
const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "instant-talk-backend",
    ws: WS_PATH,
    sttModel: OPENAI_STT_MODEL,
    ttsModel: OPENAI_TTS_MODEL,
    translationModel: OPENAI_TRANSLATION_MODEL,
    deepL: Boolean(DEEPL_API_KEY),
  });
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// -------------------------
// HTTP + WS Server
// -------------------------
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

// -------------------------
// Utilities
// -------------------------
function nowMs() {
  return Date.now();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function makeConnId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Build WAV buffer from PCM Int16LE mono.
 */
function pcm16leToWavBuffer(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format PCM = 1
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function truncate(s, max = 220) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function sanitizeTextForTTS(text) {
  let t = String(text ?? "").trim();
  if (!t) return "";
  // Keep it safe & small to avoid huge TTS calls
  if (t.length > MAX_TEXT_CHARS) t = t.slice(0, MAX_TEXT_CHARS);
  return t;
}

// -------------------------
// DeepL Translation
// -------------------------
async function deeplTranslate({ text, targetLang }) {
  const t0 = nowMs();
  const mappedTarget = mapDeepLTargetLang(targetLang);

  const body = new URLSearchParams();
  body.set("auth_key", DEEPL_API_KEY);
  body.set("text", text);
  body.set("target_lang", mappedTarget);

  // Free vs Pro endpoint: DeepL uses different hosts; most keys work on api-free.deepl.com or api.deepl.com.
  // We try both deterministically based on key hint, but keep it strict and logged.
  const isFreeKey = DEEPL_API_KEY.endsWith(":fx");
  const endpoint = isFreeKey ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const ms = nowMs() - t0;

  const raw = await resp.text();
  if (!resp.ok) {
    const err = new Error(`DeepL HTTP ${resp.status}: ${truncate(raw, 400)}`);
    err.details = { status: resp.status, body: raw, endpoint, ms };
    throw err;
  }

  const json = safeJsonParse(raw);
  const out = json?.translations?.[0]?.text;
  if (!out) {
    const err = new Error(`DeepL invalid response: ${truncate(raw, 400)}`);
    err.details = { endpoint, ms };
    throw err;
  }

  return { text: out, provider: "deepl", ms, mappedTarget };
}

// -------------------------
// OpenAI Translation (fallback)
// -------------------------
async function openaiTranslate({ text, sourceLang, targetLang }) {
  const t0 = nowMs();

  const system = [
    "You are a translation engine for real-time voice translation.",
    "Return ONLY the translated text, no quotes, no explanations, no extra lines.",
    "Preserve meaning, tone, punctuation, and named entities.",
    "If the input is empty, return an empty string.",
  ].join(" ");

  const user = `Translate from ${sourceLang || "auto"} to ${targetLang}:\n\n${text}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_TRANSLATION_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const out = resp?.choices?.[0]?.message?.content?.trim() || "";
  const ms = nowMs() - t0;

  return { text: out, provider: "openai", ms };
}

// -------------------------
// OpenAI STT
// -------------------------
async function openaiTranscribeWavFile({ wavPath, languageHint }) {
  const t0 = nowMs();
  const file = fs.createReadStream(wavPath);

  // NOTE: gpt-4o-mini-transcribe supports json/text; we read .text either way.
  const transcription = await openai.audio.transcriptions.create({
    model: OPENAI_STT_MODEL,
    file,
    ...(languageHint ? { language: languageHint } : {}),
    response_format: "json",
  });

  const text = (transcription?.text || "").trim();
  const ms = nowMs() - t0;

  return { text, ms };
}

// -------------------------
// OpenAI TTS
// -------------------------
async function openaiTtsMp3({ text, voice }) {
  const t0 = nowMs();
  const mp3 = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: voice || OPENAI_TTS_VOICE,
    input: text,
    response_format: "mp3",
    // You can optionally control style with "instructions" for gpt-4o-mini-tts (kept minimal for latency)
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());
  const ms = nowMs() - t0;

  return { buffer, ms };
}

// -------------------------
// Connection State
// -------------------------
function makeDefaultSessionConfig() {
  return {
    // Languages:
    // - sourceLang: language of incoming audio (optional). If empty => auto STT.
    // - targetLang: output language for translation.
    sourceLang: "", // e.g. "fr"
    targetLang: "en", // default
    // Auto bidi support: if enabled, backend can swap based on who speaks (frontend can set per user)
    // For now we keep it configurable; pipeline uses targetLang as the output.
    auto_bidi: false,
    // TTS voice
    voice: OPENAI_TTS_VOICE,
    // Optional metadata
    room: "",
    participantId: "",
    participantName: "",
  };
}

function makeConnectionState() {
  return {
    id: makeConnId(),
    createdAt: nowMs(),
    config: makeDefaultSessionConfig(),

    pcmChunks: [],
    pcmBytes: 0,

    isProcessing: false,
    pendingFlush: false,
    utteranceSeq: 0,

    lastMsgAt: nowMs(),
    lastPongAt: nowMs(),
  };
}

function resetAudioBuffer(state) {
  state.pcmChunks = [];
  state.pcmBytes = 0;
}

function appendPcm(state, buf) {
  if (!Buffer.isBuffer(buf)) return;
  state.pcmChunks.push(buf);
  state.pcmBytes += buf.length;
}

// -------------------------
// WS Handling
// -------------------------
wss.on("connection", (ws, req) => {
  const state = makeConnectionState();

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  console.log(`[WS][${state.id}] connected ip=${ip}`);

  // Identify/ready
  sendJson(ws, {
    type: "ready",
    id: state.id,
    wsPath: WS_PATH,
    sttModel: OPENAI_STT_MODEL,
    ttsModel: OPENAI_TTS_MODEL,
    voice: state.config.voice,
    deepL: Boolean(DEEPL_API_KEY),
  });

  // Ping/Pong keepalive
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    state.lastPongAt = nowMs();
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!ws.isAlive) {
      console.warn(`[WS][${state.id}] ping timeout -> terminate`);
      try {
        ws.terminate();
      } catch {}
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }, WS_PING_INTERVAL_MS);

  ws.on("close", (code, reason) => {
    clearInterval(pingTimer);
    console.log(
      `[WS][${state.id}] closed code=${code} reason=${truncate(reason?.toString?.() || "", 120)}`
    );
  });

  ws.on("error", (err) => {
    console.error(`[WS][${state.id}] error`, err);
  });

  ws.on("message", async (data, isBinary) => {
    state.lastMsgAt = nowMs();

    // Binary => PCM chunk
    if (isBinary) {
      const buf = Buffer.from(data);

      // Basic sanity: even byte length for int16
      if (buf.length % 2 !== 0) {
        console.warn(`[AUDIO][${state.id}] odd buffer length=${buf.length} -> drop last byte`);
        appendPcm(state, buf.slice(0, buf.length - 1));
      } else {
        appendPcm(state, buf);
      }

      if (state.pcmBytes > MAX_PCM_BYTES_PER_UTTERANCE) {
        console.error(
          `[AUDIO][${state.id}] buffer overflow pcmBytes=${state.pcmBytes} > max=${MAX_PCM_BYTES_PER_UTTERANCE}`
        );
        resetAudioBuffer(state);
        sendJson(ws, {
          type: "error",
          stage: "ingest",
          message: "Audio buffer overflow. Utterance dropped.",
          details: { maxBytes: MAX_PCM_BYTES_PER_UTTERANCE },
        });
      }

      return;
    }

    // Text => JSON control
    const str = data.toString("utf8");
    const msg = safeJsonParse(str);

    if (!msg || typeof msg !== "object") {
      console.warn(`[WS][${state.id}] non-json text message ignored: ${truncate(str, 160)}`);
      return;
    }

    const type = String(msg.type || "").trim();

    if (type === "config") {
      // Accept config updates without breaking existing.
      const next = { ...state.config };

      if (typeof msg.sourceLang === "string") next.sourceLang = msg.sourceLang.trim();
      if (typeof msg.targetLang === "string") next.targetLang = msg.targetLang.trim();
      if (typeof msg.auto_bidi === "boolean") next.auto_bidi = msg.auto_bidi;
      if (typeof msg.voice === "string" && msg.voice.trim()) next.voice = msg.voice.trim();

      if (typeof msg.room === "string") next.room = msg.room.trim();
      if (typeof msg.participantId === "string") next.participantId = msg.participantId.trim();
      if (typeof msg.participantName === "string") next.participantName = msg.participantName.trim();

      state.config = next;

      console.log(
        `[CFG][${state.id}] sourceLang=${next.sourceLang || "auto"} targetLang=${next.targetLang} auto_bidi=${
          next.auto_bidi
        } voice=${next.voice} room=${next.room || "-"} participant=${next.participantId || "-"}`
      );

      sendJson(ws, { type: "config_ack", config: next });
      return;
    }

    if (type === "reset") {
      resetAudioBuffer(state);
      state.pendingFlush = false;
      console.log(`[AUDIO][${state.id}] reset`);
      sendJson(ws, { type: "reset_ack" });
      return;
    }

    if (type === "flush") {
      // If already processing, queue one pending flush (coalesce)
      if (state.isProcessing) {
        state.pendingFlush = true;
        console.log(`[FLUSH][${state.id}] received while processing -> pendingFlush=true`);
        sendJson(ws, { type: "flush_ack", status: "queued" });
        return;
      }

      await processUtterance(ws, state, msg);
      return;
    }

    // Optional: allow base64 audio for debugging
    if (type === "audio_b64" && typeof msg.b64 === "string") {
      const buf = Buffer.from(msg.b64, "base64");
      appendPcm(state, buf);
      sendJson(ws, { type: "audio_ack", bytes: buf.length, pcmBytes: state.pcmBytes });
      return;
    }

    console.warn(`[WS][${state.id}] unknown message type=${type} ignored`);
  });
});

// -------------------------
// Core pipeline
// -------------------------
async function processUtterance(ws, state, flushMsg) {
  state.isProcessing = true;
  state.pendingFlush = false;

  const seq = ++state.utteranceSeq;
  const startedAt = nowMs();

  const meta = {
    seq,
    pcmBytes: state.pcmBytes,
    sourceLang: state.config.sourceLang || "auto",
    targetLang: state.config.targetLang || "en",
    voice: state.config.voice || OPENAI_TTS_VOICE,
    room: state.config.room || "",
    participantId: state.config.participantId || "",
    participantName: state.config.participantName || "",
  };

  try {
    // Validate we have audio
    if (state.pcmBytes <= 0) {
      console.warn(`[FLUSH][${state.id}][#${seq}] no audio -> no-op`);
      sendJson(ws, {
        type: "error",
        stage: "ingest",
        message: "Flush received but no audio was buffered.",
        details: meta,
      });
      return;
    }

    const pcm = Buffer.concat(state.pcmChunks, state.pcmBytes);
    resetAudioBuffer(state);

    console.log(
      `[PIPE][${state.id}][#${seq}] start pcmBytes=${pcm.length} src=${meta.sourceLang} tgt=${meta.targetLang} voice=${meta.voice}`
    );

    // Build WAV
    const wav = pcm16leToWavBuffer(pcm, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITS_PER_SAMPLE);

    const tmpDir = os.tmpdir();
    const fileBase = `utterance_${state.id}_${seq}_${Date.now()}`;
    const wavPath = path.join(tmpDir, `${fileBase}.wav`);

    fs.writeFileSync(wavPath, wav);

    // STT
    const sttT0 = nowMs();
    const stt = await openaiTranscribeWavFile({
      wavPath,
      languageHint: state.config.sourceLang || undefined,
    });
    const sttMs = nowMs() - sttT0;

    console.log(`[STT][${state.id}][#${seq}] ms=${stt.ms} text="${truncate(stt.text, 240)}"`);

    sendJson(ws, {
      type: "stt",
      text: stt.text,
      lang: meta.sourceLang,
      ms: stt.ms,
      seq,
      pcmBytes: pcm.length,
    });

    // Clean tmp wav ASAP
    try {
      fs.unlinkSync(wavPath);
    } catch {}

    const sttText = (stt.text || "").trim();
    if (!sttText) {
      console.warn(`[PIPE][${state.id}][#${seq}] empty STT -> stop`);
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: "Transcription returned empty text.",
        details: { ...meta, sttMs },
      });
      return;
    }

    // Translation (skip if same lang and not forced)
    const src = (state.config.sourceLang || "").trim();
    const tgt = (state.config.targetLang || "").trim() || "en";

    let translatedText = sttText;
    let translationProvider = "none";
    let translationMs = 0;

    if (src && tgt && src.toLowerCase() === tgt.toLowerCase()) {
      translationProvider = "none";
      translationMs = 0;
      translatedText = sttText;
      console.log(`[TRANSL][${state.id}][#${seq}] skipped (same lang)`);
    } else {
      const trT0 = nowMs();
      if (DEEPL_API_KEY) {
        const r = await deeplTranslate({ text: sttText, targetLang: tgt });
        translatedText = r.text;
        translationProvider = r.provider;
        translationMs = r.ms;

        console.log(
          `[TRANSL][${state.id}][#${seq}] provider=deepl ms=${translationMs} mappedTarget=${r.mappedTarget} text="${truncate(
            translatedText,
            240
          )}"`
        );
      } else {
        const r = await openaiTranslate({ text: sttText, sourceLang: src || "auto", targetLang: tgt });
        translatedText = r.text;
        translationProvider = r.provider;
        translationMs = r.ms;

        console.log(
          `[TRANSL][${state.id}][#${seq}] provider=openai ms=${translationMs} text="${truncate(translatedText, 240)}"`
        );
      }
      translationMs = nowMs() - trT0; // hard measure end-to-end
    }

    sendJson(ws, {
      type: "translation",
      text: translatedText,
      sourceLang: src || "auto",
      targetLang: tgt,
      provider: translationProvider,
      ms: translationMs,
      seq,
    });

    const ttsInput = sanitizeTextForTTS(translatedText);
    if (!ttsInput) {
      console.warn(`[PIPE][${state.id}][#${seq}] empty translation -> stop`);
      sendJson(ws, {
        type: "error",
        stage: "translation",
        message: "Translation returned empty text.",
        details: { ...meta, provider: translationProvider, translationMs },
      });
      return;
    }

    // TTS
    const ttsT0 = nowMs();
    const tts = await openaiTtsMp3({ text: ttsInput, voice: meta.voice });
    const ttsMs = nowMs() - ttsT0;

    console.log(`[TTS][${state.id}][#${seq}] ms=${tts.ms} mp3Bytes=${tts.buffer.length}`);

    const audioB64 = tts.buffer.toString("base64");
    sendJson(ws, {
      type: "tts",
      audioB64,
      mime: "audio/mpeg",
      bytes: tts.buffer.length,
      voice: meta.voice,
      ms: tts.ms,
      seq,
    });

    const totalMs = nowMs() - startedAt;
    console.log(`[PIPE][${state.id}][#${seq}] done totalMs=${totalMs}`);
    sendJson(ws, { type: "done", seq, totalMs });
  } catch (err) {
    const totalMs = nowMs() - startedAt;
    const message = err?.message ? String(err.message) : "Unknown error";

    const details = {
      seq,
      totalMs,
      config: state.config,
      pcmBytesAtFlush: meta.pcmBytes,
      flushMsg: flushMsg && typeof flushMsg === "object" ? flushMsg : null,
      error: {
        name: err?.name || "Error",
        message,
        stack: err?.stack ? String(err.stack).slice(0, 4000) : "",
        details: err?.details ?? null,
      },
    };

    console.error(`[ERR][${state.id}][#${seq}] stage=pipeline totalMs=${totalMs} msg=${message}`);
    if (err?.details) console.error(`[ERR][${state.id}][#${seq}] details=`, err.details);

    sendJson(ws, {
      type: "error",
      stage: "pipeline",
      message,
      details,
    });
  } finally {
    state.isProcessing = false;

    // If a flush arrived during processing, immediately process next utterance (if audio exists).
    if (state.pendingFlush) {
      state.pendingFlush = false;
      if (state.pcmBytes > 0 && ws.readyState === ws.OPEN) {
        console.log(`[FLUSH][${state.id}] processing pending flush (pcmBytes=${state.pcmBytes})`);
        // fire-and-forget but awaited by event loop
        processUtterance(ws, state, { type: "flush", pending: true }).catch((e) => {
          console.error(`[ERR][${state.id}] pending flush failed`, e);
        });
      } else {
        console.log(`[FLUSH][${state.id}] pending flush cleared (no buffered audio)`);
      }
    }
  }
}

// -------------------------
// Start
// -------------------------
server.listen(PORT, () => {
  console.log(`[BOOT] Instant Talk Backend listening on :${PORT}`);
  console.log(`[BOOT] WS path: ${WS_PATH}`);
  console.log(`[BOOT] STT=${OPENAI_STT_MODEL} TTS=${OPENAI_TTS_MODEL} VOICE=${OPENAI_TTS_VOICE}`);
  console.log(`[BOOT] DeepL enabled: ${Boolean(DEEPL_API_KEY)}`);
});
