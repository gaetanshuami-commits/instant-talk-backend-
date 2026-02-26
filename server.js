/**
 * server.js — Instant Talk Backend (Railway) — STABLE v2.1
 *
 * HTTP:
 *  - GET /        -> info
 *  - GET /healthz -> ok
 *
 * WS:
 *  - /ws
 *
 * Audio IN:
 *  - PCM Int16 LE mono 16kHz (binary frames)
 *
 * Control IN (JSON):
 *  - {type:"config", sourceLang, targetLang, auto_bidi, voice}
 *  - {type:"flush"}
 *  - {type:"reset"}
 *
 * Output (always JSON):
 *  - {type:"stt"} {type:"translation"} {type:"tts"} OR {type:"error"}
 *
 * Fixes:
 *  - Removes duplicate identifier crash (server/serveur already declared)
 *  - Uses httpServer naming + single HTTP server instance
 *  - Keeps DeepL endpoint auto-switch (free/pro)
 *  - Uses Railway env models (OPENAI_STT_MODEL / OPENAI_TTS_MODEL)
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

const OPENAI_STT_MODEL = (process.env.OPENAI_STT_MODEL || "whisper-1").trim();
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL || "tts-1").trim();
const OPENAI_TRANSLATION_MODEL = (process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini").trim();
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "alloy").trim();

const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || "").trim();

// DeepL endpoint selection
const DEEPL_API_URL_PRIMARY = DEEPL_API_KEY
  ? DEEPL_API_KEY.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate"
  : "";

const DEEPL_API_URL_ALT =
  DEEPL_API_URL_PRIMARY === "https://api.deepl.com/v2/translate"
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

// Audio strict
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = AUDIO_BITS_PER_SAMPLE / 8; // 2

// Limits
const MAX_PCM_BYTES_PER_UTTERANCE = Number(process.env.MAX_PCM_BYTES_PER_UTTERANCE || 3_000_000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2000);
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);

// Guards
const MIN_AUDIO_MS_FOR_STT = Number(process.env.MIN_AUDIO_MS_FOR_STT || 500);
const MIN_RMS = Number(process.env.MIN_RMS || 0.007);
const MAX_CLIP_RATE = Number(process.env.MAX_CLIP_RATE || 0.08);

// Optional: keep wavs for debugging
const KEEP_WAV_DEBUG = (process.env.KEEP_WAV_DEBUG || "false").toLowerCase() === "true";

// -------------------------
// Language normalization (simple, safe)
// -------------------------
const LANG_NAME_TO_CODE = {
  français: "fr",
  francais: "fr",
  french: "fr",
  english: "en",
  anglais: "en",
  spanish: "es",
  espagnol: "es",
  español: "es",
  german: "de",
  allemand: "de",
  deutsch: "de",
  italian: "it",
  italien: "it",
  italiano: "it",
  portuguese: "pt",
  portugais: "pt",
  português: "pt",
  chines: "zh",
  chinois: "zh",
  chinese: "zh",
  العربية: "ar",
  arabe: "ar",
  arabic: "ar",
  日本語: "ja",
  japonais: "ja",
  japanese: "ja",
};

function normalizeLangCode(lang) {
  if (!lang || typeof lang !== "string") return "";
  const trimmed = lang.trim();
  if (!trimmed) return "";

  if (/^[a-z]{2,3}$/i.test(trimmed)) return trimmed.toLowerCase();

  if (/^[a-z]{2,3}[-_][a-z]{2,4}$/i.test(trimmed)) {
    return trimmed.split(/[-_]/)[0].toLowerCase();
  }

  const lower = trimmed.toLowerCase();
  if (LANG_NAME_TO_CODE[lower]) return LANG_NAME_TO_CODE[lower];

  for (const [name, code] of Object.entries(LANG_NAME_TO_CODE)) {
    if (lower.includes(name) || name.includes(lower)) return code;
  }

  return trimmed.toLowerCase();
}

function whisperLanguageHint(rawLang) {
  const code = normalizeLangCode(rawLang);
  if (!code) return undefined;
  if (/^[a-z]{2}$/.test(code)) return code;
  return undefined;
}

function mapDeepLTargetLang(lang) {
  const code = normalizeLangCode(lang);
  if (!code) return lang;
  if (code === "en") return "en-US";
  if (code === "pt") return "pt-PT";
  if (code === "zh") return "zh-Hans";
  return code.toUpperCase();
}

function mapDeepLSourceLang(lang) {
  const code = normalizeLangCode(lang);
  if (!code) return undefined;
  return code.toUpperCase();
}

function isDeepLWrongEndpointMessage(rawText) {
  const t = String(rawText || "");
  return t.includes("Wrong endpoint") || t.toLowerCase().includes("wrong endpoint");
}

// -------------------------
// OpenAI client
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
    deepl: { enabled: Boolean(DEEPL_API_KEY), primaryEndpoint: DEEPL_API_URL_PRIMARY || null },
    audio: {
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      bits: AUDIO_BITS_PER_SAMPLE,
      guards: {
        MIN_AUDIO_MS_FOR_STT,
        MIN_RMS,
        MAX_CLIP_RATE,
      },
      KEEP_WAV_DEBUG,
    },
  });
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// -------------------------
// HTTP + WS (IMPORTANT: single instance -> httpServer)
// -------------------------
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
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

function pcmBytesToDurationMs(pcmBytes) {
  const denom = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * BYTES_PER_SAMPLE;
  if (!denom) return 0;
  return Math.round((pcmBytes / denom) * 1000);
}

function computePcmMetrics(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount <= 0) return { rms: 0, peak: 0, clipRate: 0, sampleCount: 0 };

  let sumSq = 0;
  let peak = 0;
  let clipCount = 0;

  for (let i = 0; i < sampleCount; i++) {
    const v = pcmBuffer.readInt16LE(i * 2);
    const a = Math.abs(v) / 32768;
    sumSq += a * a;
    if (a > peak) peak = a;
    if (a >= 0.98) clipCount++;
  }

  const rms = Math.sqrt(sumSq / sampleCount);
  const clipRate = clipCount / sampleCount;

  return { rms, peak, clipRate, sampleCount };
}

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

function cleanupWav(wavPath) {
  if (!KEEP_WAV_DEBUG) {
    try {
      fs.unlinkSync(wavPath);
    } catch {}
  } else {
    console.log(`[WAV_DEBUG] kept wav at ${wavPath}`);
  }
}

// -------------------------
// DeepL translate (with endpoint retry)
// -------------------------
async function deeplTranslate({ text, sourceLang, targetLang }) {
  const mappedTarget = mapDeepLTargetLang(targetLang);
  const mappedSource = mapDeepLSourceLang(sourceLang);
  const endpointsToTry = [DEEPL_API_URL_PRIMARY, DEEPL_API_URL_ALT].filter(Boolean);
  let lastErr = null;

  for (const endpoint of endpointsToTry) {
    const t0 = nowMs();
    try {
      const body = new URLSearchParams();
      body.set("auth_key", DEEPL_API_KEY);
      body.set("text", text);
      body.set("target_lang", mappedTarget);
      if (mappedSource) body.set("source_lang", mappedSource);

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const raw = await resp.text();
      const ms = nowMs() - t0;

      if (!resp.ok) {
        if (resp.status === 403 && isDeepLWrongEndpointMessage(raw)) {
          console.warn(`[DEEPL] wrong endpoint on ${endpoint} -> retry other`);
          lastErr = Object.assign(new Error(`DeepL wrong endpoint at ${endpoint}`), {
            details: { status: resp.status, body: raw, endpoint, ms, mappedTarget },
          });
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

      return {
        text: out,
        provider: "deepl",
        ms,
        endpoint,
        mappedTarget,
        detectedSourceLang: json?.translations?.[0]?.detected_source_language || null,
      };
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

  const srcName = sourceLang || "auto-detect";
  const tgtName = targetLang;

  const system =
    "You are a translation engine for real-time voice conversation. " +
    "Translate naturally and accurately. Return ONLY the translated text (no quotes, no explanations).";

  const user = `Translate from ${srcName} to ${tgtName}:\n\n${text}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_TRANSLATION_MODEL,
    temperature: 0.15,
    max_tokens: 1024,
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
async function openaiTranscribeVerbose({ wavPath, languageHint }) {
  const t0 = nowMs();
  const file = fs.createReadStream(wavPath);

  const params = {
    model: OPENAI_STT_MODEL,
    file,
    response_format: "verbose_json",
  };

  const hint = whisperLanguageHint(languageHint);
  if (hint) params.language = hint;

  const result = await openai.audio.transcriptions.create(params);
  const ms = nowMs() - t0;

  return {
    text: (result?.text || "").trim(),
    ms,
    model: OPENAI_STT_MODEL,
    language: result?.language || "",
  };
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
    sourceLang: "",
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
    if (isBinary) {
      const buf = Buffer.from(data);
      appendPcm(state, buf.length % 2 === 0 ? buf : buf.slice(0, buf.length - 1));

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

    const msg = safeJsonParse(data.toString("utf8"));
    if (!msg || typeof msg !== "object") return;

    const type = String(msg.type || "").trim();

    if (type === "config") {
      const next = { ...state.config };

      if (typeof msg.sourceLang === "string") next.sourceLang = normalizeLangCode(msg.sourceLang);
      if (typeof msg.targetLang === "string") next.targetLang = normalizeLangCode(msg.targetLang) || "en";
      if (typeof msg.auto_bidi === "boolean") next.auto_bidi = msg.auto_bidi;
      if (typeof msg.voice === "string" && msg.voice.trim()) next.voice = msg.voice.trim();

      state.config = next;

      console.log(`[CFG][${state.id}] sourceLang=${next.sourceLang || "auto"} targetLang=${next.targetLang} voice=${next.voice}`);
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
        sendJson(ws, { type: "flush_ack", status: "queued" });
        return;
      }
      await processUtterance(ws, state, msg);
      return;
    }
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

  const durationMs = pcmBytesToDurationMs(state.pcmBytes);
  const pcm = state.pcmBytes > 0 ? Buffer.concat(state.pcmChunks, state.pcmBytes) : Buffer.alloc(0);
  const metrics = computePcmMetrics(pcm);

  console.log(
    `[AUDIO][${state.id}][#${seq}] pcmBytes=${state.pcmBytes} durationMs=${durationMs} rms=${metrics.rms.toFixed(4)} peak=${metrics.peak.toFixed(4)} clipRate=${metrics.clipRate.toFixed(4)}`
  );

  const meta = {
    seq,
    pcmBytes: state.pcmBytes,
    durationMs,
    rms: metrics.rms,
    peak: metrics.peak,
    clipRate: metrics.clipRate,
    sourceLang: state.config.sourceLang || "auto",
    targetLang: state.config.targetLang || "en",
    voice: state.config.voice || OPENAI_TTS_VOICE,
  };

  try {
    if (state.pcmBytes <= 0) {
      sendJson(ws, { type: "error", stage: "ingest", message: "Flush received but no audio buffered.", details: meta });
      return;
    }

    if (durationMs < MIN_AUDIO_MS_FOR_STT) {
      resetAudioBuffer(state);
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: `Audio too short (${durationMs}ms < ${MIN_AUDIO_MS_FOR_STT}ms).`,
        details: { ...meta, code: "too_short", minMs: MIN_AUDIO_MS_FOR_STT },
      });
      return;
    }

    if (metrics.rms < MIN_RMS) {
      resetAudioBuffer(state);
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: `Audio too quiet (rms=${metrics.rms.toFixed(4)}).`,
        details: { ...meta, code: "too_quiet", minRms: MIN_RMS },
      });
      return;
    }

    if (metrics.clipRate > MAX_CLIP_RATE) {
      resetAudioBuffer(state);
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: `Audio clipped (clipRate=${metrics.clipRate.toFixed(4)}).`,
        details: { ...meta, code: "clipped", maxClipRate: MAX_CLIP_RATE },
      });
      return;
    }

    // Freeze and reset buffer (important: do it once)
    resetAudioBuffer(state);

    // WAV
    const wav = pcm16leToWavBuffer(pcm, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITS_PER_SAMPLE);
    const wavPath = path.join(os.tmpdir(), `utt_${state.id}_${seq}_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wav);

    // STT
    const stt = await openaiTranscribeVerbose({ wavPath, languageHint: state.config.sourceLang || undefined });
    cleanupWav(wavPath);

    console.log(`[STT][${state.id}][#${seq}] model=${stt.model} ms=${stt.ms} lang=${stt.language || "-"} text="${truncate(stt.text, 240)}"`);

    const sttText = (stt.text || "").trim();
    if (!sttText) {
      sendJson(ws, { type: "error", stage: "stt", message: "STT returned empty text.", details: { ...meta, detectedLang: stt.language } });
      return;
    }

    sendJson(ws, { type: "stt", text: sttText, model: stt.model, ms: stt.ms, seq, detectedLang: stt.language || null });

    // Translation
    const srcNorm = normalizeLangCode(state.config.sourceLang);
    const tgtNorm = normalizeLangCode(state.config.targetLang) || "en";

    let translatedText = sttText;
    let provider = "none";
    let translationMs = 0;

    if (srcNorm && tgtNorm && srcNorm === tgtNorm) {
      console.log(`[TRANSL][${state.id}][#${seq}] SKIP (same lang ${srcNorm})`);
    } else {
      const t0 = nowMs();

      if (DEEPL_API_KEY) {
        try {
          const r = await deeplTranslate({
            text: sttText,
            sourceLang: srcNorm || undefined,
            targetLang: tgtNorm,
          });
          translatedText = r.text;
          provider = "deepl";
          translationMs = nowMs() - t0;
        } catch (e) {
          console.warn(`[TRANSL][${state.id}][#${seq}] DeepL failed -> fallback OpenAI: ${truncate(e?.message || "", 160)}`);
          const r = await openaiTranslate({
            text: sttText,
            sourceLang: srcNorm || "auto",
            targetLang: tgtNorm,
          });
          translatedText = r.text;
          provider = "openai_fallback";
          translationMs = nowMs() - t0;
        }
      } else {
        const r = await openaiTranslate({
          text: sttText,
          sourceLang: srcNorm || "auto",
          targetLang: tgtNorm,
        });
        translatedText = r.text;
        provider = "openai";
        translationMs = nowMs() - t0;
      }

      console.log(`[TRANSL][${state.id}][#${seq}] provider=${provider} ms=${translationMs} text="${truncate(translatedText, 240)}"`);
    }

    sendJson(ws, { type: "translation", text: translatedText, provider, sourceLang: srcNorm || "auto", targetLang: tgtNorm, ms: translationMs, seq });

    // TTS
    const ttsInput = sanitizeTextForTTS(translatedText);
    if (!ttsInput) {
      sendJson(ws, { type: "error", stage: "tts", message: "TTS input empty after translation.", details: { ...meta, provider } });
      return;
    }

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
    console.log(`[PIPE][${state.id}][#${seq}] ✅ done totalMs=${totalMs} (stt=${stt.ms} transl=${translationMs} tts=${tts.ms})`);
    sendJson(ws, { type: "done", seq, totalMs, breakdown: { sttMs: stt.ms, translationMs, ttsMs: tts.ms } });
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
        audio: meta,
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

    if (state.pendingFlush) {
      state.pendingFlush = false;
      if (state.pcmBytes > 0 && ws.readyState === ws.OPEN) {
        processUtterance(ws, state, { type: "flush", pending: true }).catch((e) => {
          console.error(`[ERR][${state.id}] pending flush failed`, e);
        });
      }
    }
  }
}

// -------------------------
// Start
// -------------------------
httpServer.listen(PORT, () => {
  console.log(`[BOOT] 🚀 Instant Talk Backend STABLE v2.1`);
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
  console.log(`[BOOT] Guards: MIN_MS=${MIN_AUDIO_MS_FOR_STT} MIN_RMS=${MIN_RMS} MAX_CLIP=${MAX_CLIP_RATE}`);
});
