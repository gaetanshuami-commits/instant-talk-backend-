/**
 * server.js — Instant Talk Backend (Railway) — CLEAN + STABLE + FULL LOGS
 *
 * WebSocket: /ws
 * Audio input: PCM Int16 LE, mono, 16kHz (binary frames)
 * Control input: JSON (string) messages, e.g.:
 *   {"type":"config","sourceLang":"fr","targetLang":"en","voice":"alloy"}
 *   {"type":"flush"}
 *   {"type":"reset"}
 *
 * Backend responses (ALWAYS):
 *   {type:"stt", text, model, ms, seq}
 *   {type:"translation", text, provider, sourceLang, targetLang, ms, seq}
 *   {type:"tts", audioB64, mime:"audio/mpeg", bytes, model, voice, ms, seq}
 *   OR {type:"error", stage, message, details}
 *
 * Fixes implemented (as per Base44 message + your screenshot):
 * - DeepL endpoint chosen based on key type:
 *     - if key endsWith(":fx") => api-free.deepl.com
 *     - else => api.deepl.com
 *   plus safety retry if DeepL returns "Wrong endpoint"
 * - OpenAI model names configurable via Railway Variables:
 *     OPENAI_STT_MODEL default whisper-1
 *     OPENAI_TTS_MODEL default tts-1
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
// ENV
// -------------------------
const PORT = Number(process.env.PORT || 3000);
const WS_PATH = "/ws";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
if (!OPENAI_API_KEY) {
  console.error("[FATAL] Missing OPENAI_API_KEY");
  process.exit(1);
}

// Base44-required defaults:
const OPENAI_STT_MODEL = (process.env.OPENAI_STT_MODEL || "whisper-1").trim();
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL || "tts-1").trim();

// Translation model fallback (only used when DeepL is disabled or fails)
const OPENAI_TRANSLATION_MODEL = (process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini").trim();

// Voice
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "alloy").trim();

// DeepL
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || "").trim();

// Choose correct DeepL endpoint based on key type (Base44)
const DEEPL_API_URL_PRIMARY = DEEPL_API_KEY
  ? DEEPL_API_KEY.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate"
  : "";

// Safety alternate endpoint (in case key type assumption is wrong)
const DEEPL_API_URL_ALT =
  DEEPL_API_URL_PRIMARY === "https://api.deepl.com/v2/translate"
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

// Audio strict
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;

// Limits / Stability
const MAX_PCM_BYTES_PER_UTTERANCE = Number(process.env.MAX_PCM_BYTES_PER_UTTERANCE || 3_000_000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2000);
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);

// -------------------------
// OpenAI Client
// -------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------------
// Express
// -------------------------
const app = express();
app.disable("x-powered-by");

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "instant-talk-backend",
    wsPath: WS_PATH,
    models: {
      stt: OPENAI_STT_MODEL,
      tts: OPENAI_TTS_MODEL,
      translation: OPENAI_TRANSLATION_MODEL,
    },
    voice: OPENAI_TTS_VOICE,
    deepl: {
      enabled: Boolean(DEEPL_API_KEY),
      primaryEndpoint: DEEPL_API_URL_PRIMARY || null,
    },
  });
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// -------------------------
// HTTP + WS server
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    socket.destroy();
  }
});

// -------------------------
// Utils
// -------------------------
function nowMs() {
  return Date.now();
}

function makeConnId() {
  return crypto.randomBytes(8).toString("hex");
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

function truncate(s, max = 220) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max) + "…";
}

function sanitizeTextForTTS(text) {
  let t = String(text ?? "").trim();
  if (!t) return "";
  if (t.length > MAX_TEXT_CHARS) t = t.slice(0, MAX_TEXT_CHARS);
  return t;
}

// DeepL mapping required
function mapDeepLTargetLang(lang) {
  const lower = String(lang || "").trim().toLowerCase();
  if (!lower) return lang;
  if (lower === "en") return "en-US";
  if (lower === "pt") return "pt-PT";
  if (lower === "zh") return "zh-Hans";
  return lang;
}

function isDeepLWrongEndpointMessage(rawText) {
  const t = String(rawText || "");
  return t.includes("Wrong endpoint") || t.includes("wrong endpoint");
}

/**
 * Build WAV from PCM Int16LE
 */
function pcm16leToWavBuffer(pcmBuffer, sampleRate, channels, bitsPerSample) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

// -------------------------
// DeepL translate (with correct endpoint + safety retry)
// -------------------------
async function deeplTranslate({ text, targetLang }) {
  if (!DEEPL_API_KEY) {
    const err = new Error("DeepL disabled (missing DEEPL_API_KEY)");
    err.details = { enabled: false };
    throw err;
  }

  const mappedTarget = mapDeepLTargetLang(targetLang);
  const endpointsToTry = [DEEPL_API_URL_PRIMARY, DEEPL_API_URL_ALT].filter(Boolean);

  let lastErr = null;

  for (const endpoint of endpointsToTry) {
    const t0 = nowMs();
    try {
      const body = new URLSearchParams();
      body.set("auth_key", DEEPL_API_KEY);
      body.set("text", text);
      body.set("target_lang", mappedTarget);

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const raw = await resp.text();
      const ms = nowMs() - t0;

      if (!resp.ok) {
        // If wrong endpoint => try other endpoint
        if (resp.status === 403 && isDeepLWrongEndpointMessage(raw)) {
          console.warn(
            `[DEEPL] 403 wrong endpoint on ${endpoint} -> retry other endpoint (msg="${truncate(raw, 160)}")`
          );
          const err = new Error(`DeepL wrong endpoint at ${endpoint}`);
          err.details = { status: resp.status, body: raw, endpoint, ms, mappedTarget };
          lastErr = err;
          continue;
        }

        const err = new Error(`DeepL HTTP ${resp.status}: ${truncate(raw, 400)}`);
        err.details = { status: resp.status, body: raw, endpoint, ms, mappedTarget };
        throw err;
      }

      const json = safeJsonParse(raw);
      const out = json?.translations?.[0]?.text;

      if (!out) {
        const err = new Error(`DeepL invalid response: ${truncate(raw, 400)}`);
        err.details = { endpoint, ms, mappedTarget };
        throw err;
      }

      return { text: out, provider: "deepl", ms, endpoint, mappedTarget };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("DeepL failed");
}

// -------------------------
// OpenAI translation fallback
// -------------------------
async function openaiTranslate({ text, sourceLang, targetLang }) {
  const t0 = nowMs();

  const system = [
    "You are a translation engine for real-time voice translation.",
    "Return ONLY the translated text.",
    "No quotes, no explanations, no extra lines.",
    "Preserve meaning, tone, punctuation, named entities.",
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
// OpenAI STT (Whisper)
// -------------------------
async function openaiTranscribeWavFile({ wavPath, languageHint }) {
  const t0 = nowMs();

  const file = fs.createReadStream(wavPath);
  const transcription = await openai.audio.transcriptions.create({
    model: OPENAI_STT_MODEL,
    file,
    ...(languageHint ? { language: languageHint } : {}),
    response_format: "json",
  });

  const text = (transcription?.text || "").trim();
  const ms = nowMs() - t0;

  return { text, ms, model: OPENAI_STT_MODEL };
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
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());
  const ms = nowMs() - t0;

  return { buffer, ms, model: OPENAI_TTS_MODEL };
}

// -------------------------
// Connection state
// -------------------------
function makeDefaultSessionConfig() {
  return {
    sourceLang: "", // "" => auto
    targetLang: "en",
    auto_bidi: false,
    voice: OPENAI_TTS_VOICE,
  };
}

function makeConnectionState() {
  return {
    id: makeConnId(),
    config: makeDefaultSessionConfig(),
    pcmChunks: [],
    pcmBytes: 0,
    isProcessing: false,
    pendingFlush: false,
    seq: 0,
  };
}

function resetAudioBuffer(state) {
  state.pcmChunks = [];
  state.pcmBytes = 0;
}

function appendPcm(state, buf) {
  state.pcmChunks.push(buf);
  state.pcmBytes += buf.length;
}

// -------------------------
// WS
// -------------------------
wss.on("connection", (ws, req) => {
  const state = makeConnectionState();

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  console.log(`[WS][${state.id}] connected ip=${ip}`);

  sendJson(ws, {
    type: "ready",
    id: state.id,
    wsPath: WS_PATH,
    models: {
      stt: OPENAI_STT_MODEL,
      tts: OPENAI_TTS_MODEL,
      translation: OPENAI_TRANSLATION_MODEL,
    },
    voice: state.config.voice,
    deepl: { enabled: Boolean(DEEPL_API_KEY), endpoint: DEEPL_API_URL_PRIMARY || null },
  });

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

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
    console.log(`[WS][${state.id}] closed code=${code} reason=${truncate(reason?.toString?.() || "", 120)}`);
  });

  ws.on("error", (err) => console.error(`[WS][${state.id}] error`, err));

  ws.on("message", async (data, isBinary) => {
    // Binary audio frame
    if (isBinary) {
      const buf = Buffer.from(data);

      if (buf.length % 2 !== 0) {
        console.warn(`[AUDIO][${state.id}] odd buffer length=${buf.length} -> drop last byte`);
        appendPcm(state, buf.slice(0, buf.length - 1));
      } else {
        appendPcm(state, buf);
      }

      if (state.pcmBytes > MAX_PCM_BYTES_PER_UTTERANCE) {
        console.error(`[AUDIO][${state.id}] overflow pcmBytes=${state.pcmBytes} max=${MAX_PCM_BYTES_PER_UTTERANCE}`);
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

    // Text control message
    const str = data.toString("utf8");
    const msg = safeJsonParse(str);
    if (!msg || typeof msg !== "object") {
      console.warn(`[WS][${state.id}] non-json ignored: ${truncate(str, 160)}`);
      return;
    }

    const type = String(msg.type || "").trim();

    if (type === "config") {
      const next = { ...state.config };

      if (typeof msg.sourceLang === "string") next.sourceLang = msg.sourceLang.trim();
      if (typeof msg.targetLang === "string") next.targetLang = msg.targetLang.trim();
      if (typeof msg.auto_bidi === "boolean") next.auto_bidi = msg.auto_bidi;
      if (typeof msg.voice === "string" && msg.voice.trim()) next.voice = msg.voice.trim();

      state.config = next;

      console.log(
        `[CFG][${state.id}] sourceLang=${next.sourceLang || "auto"} targetLang=${next.targetLang} auto_bidi=${next.auto_bidi} voice=${next.voice}`
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
      if (state.isProcessing) {
        state.pendingFlush = true;
        console.log(`[FLUSH][${state.id}] received while processing -> queued`);
        sendJson(ws, { type: "flush_ack", status: "queued" });
        return;
      }
      await processUtterance(ws, state, msg);
      return;
    }

    console.warn(`[WS][${state.id}] unknown type="${type}" ignored`);
  });
});

// -------------------------
// Pipeline
// -------------------------
async function processUtterance(ws, state, flushMsg) {
  state.isProcessing = true;
  state.pendingFlush = false;

  const seq = ++state.seq;
  const startedAt = nowMs();

  const meta = {
    seq,
    pcmBytes: state.pcmBytes,
    sourceLang: state.config.sourceLang || "auto",
    targetLang: state.config.targetLang || "en",
    voice: state.config.voice || OPENAI_TTS_VOICE,
  };

  try {
    if (state.pcmBytes <= 0) {
      console.warn(`[FLUSH][${state.id}][#${seq}] no audio`);
      sendJson(ws, {
        type: "error",
        stage: "ingest",
        message: "Flush received but no audio buffered.",
        details: meta,
      });
      return;
    }

    const pcm = Buffer.concat(state.pcmChunks, state.pcmBytes);
    resetAudioBuffer(state);

    console.log(`[PIPE][${state.id}][#${seq}] start pcmBytes=${pcm.length} src=${meta.sourceLang} tgt=${meta.targetLang}`);

    // WAV
    const wav = pcm16leToWavBuffer(pcm, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITS_PER_SAMPLE);
    const wavPath = path.join(os.tmpdir(), `utt_${state.id}_${seq}_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wav);

    // STT
    const stt = await openaiTranscribeWavFile({ wavPath, languageHint: state.config.sourceLang || undefined });
    console.log(`[STT][${state.id}][#${seq}] model=${stt.model} ms=${stt.ms} text="${truncate(stt.text, 240)}"`);

    sendJson(ws, { type: "stt", text: stt.text, model: stt.model, ms: stt.ms, seq });

    try {
      fs.unlinkSync(wavPath);
    } catch {}

    const sttText = (stt.text || "").trim();
    if (!sttText) {
      sendJson(ws, { type: "error", stage: "stt", message: "STT returned empty text.", details: meta });
      return;
    }

    // Translation
    const src = (state.config.sourceLang || "").trim();
    const tgt = (state.config.targetLang || "").trim() || "en";

    let translatedText = sttText;
    let provider = "none";
    let translationMs = 0;

    if (src && tgt && src.toLowerCase() === tgt.toLowerCase()) {
      console.log(`[TRANSL][${state.id}][#${seq}] skipped (same lang)`);
    } else {
      const t0 = nowMs();
      if (DEEPL_API_KEY) {
        try {
          const r = await deeplTranslate({ text: sttText, targetLang: tgt });
          translatedText = r.text;
          provider = "deepl";
          translationMs = nowMs() - t0;

          console.log(
            `[TRANSL][${state.id}][#${seq}] provider=deepl ms=${translationMs} endpoint=${r.endpoint} mappedTarget=${r.mappedTarget} text="${truncate(
              translatedText,
              240
            )}"`
          );
        } catch (deeplErr) {
          // If DeepL fails, fallback OpenAI translation (so pipeline never blocks)
          console.warn(`[TRANSL][${state.id}][#${seq}] DeepL failed -> fallback OpenAI. err="${truncate(deeplErr?.message, 240)}"`);
          const r = await openaiTranslate({ text: sttText, sourceLang: src || "auto", targetLang: tgt });
          translatedText = r.text;
          provider = "openai_fallback";
          translationMs = nowMs() - t0;

          console.log(`[TRANSL][${state.id}][#${seq}] provider=openai_fallback ms=${translationMs} text="${truncate(translatedText, 240)}"`);
        }
      } else {
        const r = await openaiTranslate({ text: sttText, sourceLang: src || "auto", targetLang: tgt });
        translatedText = r.text;
        provider = "openai";
        translationMs = nowMs() - t0;

        console.log(`[TRANSL][${state.id}][#${seq}] provider=openai ms=${translationMs} text="${truncate(translatedText, 240)}"`);
      }
    }

    sendJson(ws, {
      type: "translation",
      text: translatedText,
      provider,
      sourceLang: src || "auto",
      targetLang: tgt,
      ms: translationMs,
      seq,
    });

    const ttsInput = sanitizeTextForTTS(translatedText);
    if (!ttsInput) {
      sendJson(ws, {
        type: "error",
        stage: "translation",
        message: "Translation returned empty text.",
        details: { ...meta, provider },
      });
      return;
    }

    // TTS
    const tts = await openaiTtsMp3({ text: ttsInput, voice: meta.voice });
    console.log(`[TTS][${state.id}][#${seq}] model=${tts.model} ms=${tts.ms} mp3Bytes=${tts.buffer.length}`);

    sendJson(ws, {
      type: "tts",
      audioB64: tts.buffer.toString("base64"),
      mime: "audio/mpeg",
      bytes: tts.buffer.length,
      model: tts.model,
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

    console.error(`[ERR][${state.id}][#${seq}] totalMs=${totalMs} msg=${message}`);

    sendJson(ws, {
      type: "error",
      stage: "pipeline",
      message,
      details: {
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
      },
    });
  } finally {
    state.isProcessing = false;

    // If a flush arrived during processing, handle it immediately if audio exists
    if (state.pendingFlush) {
      state.pendingFlush = false;
      if (state.pcmBytes > 0 && ws.readyState === ws.OPEN) {
        console.log(`[FLUSH][${state.id}] processing pending flush (pcmBytes=${state.pcmBytes})`);
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
  console.log(`[BOOT] listening :${PORT}`);
  console.log(`[BOOT] WS path: ${WS_PATH}`);
  console.log(`[BOOT] OpenAI STT model: ${OPENAI_STT_MODEL}`);
  console.log(`[BOOT] OpenAI TTS model: ${OPENAI_TTS_MODEL}`);
  console.log(`[BOOT] OpenAI Translation model: ${OPENAI_TRANSLATION_MODEL}`);
  console.log(`[BOOT] DeepL enabled: ${Boolean(DEEPL_API_KEY)}`);
  if (DEEPL_API_KEY) {
    console.log(`[BOOT] DeepL endpoint(primary): ${DEEPL_API_URL_PRIMARY}`);
    console.log(`[BOOT] DeepL endpoint(alt): ${DEEPL_API_URL_ALT}`);
  }
});
