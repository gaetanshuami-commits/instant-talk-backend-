/**
 * server.js — Instant Talk Backend (Railway) — STABLE v2.1
 *
 * WS: /ws
 * HTTP: /healthz + /
 *
 * Audio IN (binary frames):
 *  - PCM Int16 LE, mono, 16kHz
 *
 * Control IN (JSON text frames):
 *  - {type:"config", sourceLang, targetLang, auto_bidi, voice}
 *  - {type:"flush"}
 *  - {type:"reset"}
 *
 * Output (always JSON):
 *  - {type:"ready"}
 *  - {type:"config_ack"} / {type:"flush_ack"} / {type:"reset_ack"}
 *  - {type:"stt"} {type:"translation"} {type:"tts"} {type:"done"}
 *  - OR {type:"error"}
 *
 * Notes:
 *  - Uses OpenAI: STT whisper-1, TTS tts-1, Translation gpt-4o-mini (fallback)
 *  - DeepL optional via DEEPL_API_KEY with correct endpoint auto-select
 *  - Prevents “silent hangs”: every flush returns either pipeline results or an error
 */

import http from "http";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

// -------------------------
// ENV / CONSTANTS
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
const DEEPL_API_URL_PRIMARY = DEEPL_API_KEY
  ? DEEPL_API_KEY.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate"
  : "";
const DEEPL_API_URL_ALT = DEEPL_API_URL_PRIMARY
  ? DEEPL_API_URL_PRIMARY.includes("api-free")
    ? "https://api.deepl.com/v2/translate"
    : "https://api-free.deepl.com/v2/translate"
  : "";

// Audio strict
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = AUDIO_BITS_PER_SAMPLE / 8; // 2

// WS keepalive
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);

// Limits / guards
const MAX_PCM_BYTES_PER_UTTERANCE = Number(process.env.MAX_PCM_BYTES_PER_UTTERANCE || 3_000_000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2000);

// Quality guards (keep reasonable defaults; adjust on Railway)
const MIN_AUDIO_MS_FOR_STT = Number(process.env.MIN_AUDIO_MS_FOR_STT || 450);
const MIN_RMS = Number(process.env.MIN_RMS || 0.006);

// Optional WAV debug
const KEEP_WAV_DEBUG = (process.env.KEEP_WAV_DEBUG || "false").toLowerCase() === "true";

// -------------------------
// OpenAI client
// -------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------------
// Express
// -------------------------
const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

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
      altEndpoint: DEEPL_API_URL_ALT || null,
    },
    audio: {
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      bits: AUDIO_BITS_PER_SAMPLE,
      guards: { MIN_AUDIO_MS_FOR_STT, MIN_RMS },
      KEEP_WAV_DEBUG,
    },
  });
});

// -------------------------
// HTTP server + WS server (ONLY ONCE — no double declaration)
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
// Helpers
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

function truncate(s, max = 240) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max) + "…";
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function pcmBytesToDurationMs(pcmBytes) {
  const denom = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * BYTES_PER_SAMPLE;
  if (!denom) return 0;
  return Math.round((pcmBytes / denom) * 1000);
}

function computePcmMetrics(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount <= 0) return { rms: 0, peak: 0, sampleCount: 0 };

  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < sampleCount; i++) {
    const v = pcmBuffer.readInt16LE(i * 2);
    const a = Math.abs(v) / 32768;
    sumSq += a * a;
    if (a > peak) peak = a;
  }

  const rms = Math.sqrt(sumSq / sampleCount);
  return { rms, peak, sampleCount };
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
  header.writeUInt32LE(16, 16); // PCM
  header.writeUInt16LE(1, 20); // AudioFormat=1 PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function sanitizeTextForTTS(text) {
  let t = String(text ?? "").trim();
  if (!t) return "";
  if (t.length > MAX_TEXT_CHARS) t = t.slice(0, MAX_TEXT_CHARS);
  return t;
}

// -------------------------
// Language normalization (simple + safe)
// -------------------------
const LANG_NAME_TO_CODE = {
  français: "fr",
  francais: "fr",
  french: "fr",
  anglais: "en",
  english: "en",
  español: "es",
  espagnol: "es",
  spanish: "es",
  deutsch: "de",
  allemand: "de",
  german: "de",
  italiano: "it",
  italien: "it",
  italian: "it",
  português: "pt",
  portugais: "pt",
  portuguese: "pt",
  中文: "zh",
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

  // already iso code (fr / en / es etc)
  if (/^[a-z]{2,3}$/i.test(trimmed)) return trimmed.toLowerCase();

  // bcp47 (en-US / pt-BR)
  if (/^[a-z]{2,3}[-_][a-z]{2,4}$/i.test(trimmed)) return trimmed.split(/[-_]/)[0].toLowerCase();

  const lower = trimmed.toLowerCase();
  if (LANG_NAME_TO_CODE[lower]) return LANG_NAME_TO_CODE[lower];

  // partial match
  for (const [name, code] of Object.entries(LANG_NAME_TO_CODE)) {
    if (lower.includes(name) || name.includes(lower)) return code;
  }

  return lower;
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
  return t.toLowerCase().includes("wrong endpoint");
}

// -------------------------
// DeepL translate (optional)
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
          lastErr = Object.assign(new Error(`DeepL wrong endpoint at ${endpoint}`), {
            details: { status: resp.status, body: raw, endpoint, ms },
          });
          continue;
        }
        const err = Object.assign(new Error(`DeepL HTTP ${resp.status}: ${truncate(raw, 400)}`), {
          details: { status: resp.status, body: raw, endpoint, ms },
        });
        throw err;
      }

      const json = safeJsonParse(raw);
      const out = json?.translations?.[0]?.text;
      if (!out) {
        const err = Object.assign(new Error(`DeepL invalid response: ${truncate(raw, 400)}`), {
          details: { endpoint, ms },
        });
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
  const system = [
    "You are a translation engine for real-time voice conversation.",
    "Translate naturally and accurately.",
    "Return ONLY the translated text.",
    "No quotes, no explanations, no extra lines.",
  ].join(" ");

  const user = `Translate from ${sourceLang || "auto"} to ${targetLang}:\n\n${text}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_TRANSLATION_MODEL,
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const out = resp?.choices?.[0]?.message?.content?.trim() || "";
  return { text: out, provider: "openai", ms: nowMs() - t0 };
}

// -------------------------
// OpenAI STT (Whisper)
// -------------------------
async function openaiTranscribeWavVerbose({ wavPath, languageHint }) {
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

  const text = (result?.text || "").trim();
  const language = result?.language || "";
  const segments = Array.isArray(result?.segments) ? result.segments : [];

  return {
    text,
    ms,
    model: OPENAI_STT_MODEL,
    language,
    segmentsCount: segments.length,
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
  return { buffer, ms: nowMs() - t0, model: OPENAI_TTS_MODEL };
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

function makeConnState() {
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
// Pipeline
// -------------------------
async function processUtterance(ws, state, flushMsg) {
  state.isProcessing = true;
  state.pendingFlush = false;

  const seq = ++state.seq;
  const startedAt = nowMs();

  const pcm = state.pcmBytes > 0 ? Buffer.concat(state.pcmChunks, state.pcmBytes) : Buffer.alloc(0);
  const durationMs = pcmBytesToDurationMs(pcm.length);
  const metrics = computePcmMetrics(pcm);

  const meta = {
    seq,
    pcmBytes: pcm.length,
    durationMs,
    rms: metrics.rms,
    peak: metrics.peak,
    sourceLang: state.config.sourceLang || "auto",
    targetLang: state.config.targetLang || "en",
    voice: state.config.voice || OPENAI_TTS_VOICE,
  };

  // freeze & clear buffer immediately (prevents deadlocks)
  resetAudioBuffer(state);

  try {
    console.log(
      `[AUDIO][${state.id}][#${seq}] pcmBytes=${meta.pcmBytes} durationMs=${durationMs} rms=${metrics.rms.toFixed(
        4
      )} peak=${metrics.peak.toFixed(4)}`
    );

    if (meta.pcmBytes <= 0) {
      sendJson(ws, { type: "error", stage: "ingest", message: "Flush received but no audio buffered.", details: meta });
      return;
    }

    if (durationMs < MIN_AUDIO_MS_FOR_STT) {
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: `Audio too short (${durationMs}ms < ${MIN_AUDIO_MS_FOR_STT}ms).`,
        details: { ...meta, code: "too_short", minMs: MIN_AUDIO_MS_FOR_STT },
      });
      return;
    }

    if (metrics.rms < MIN_RMS) {
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: `Audio too quiet (rms=${metrics.rms.toFixed(4)}).`,
        details: { ...meta, code: "too_quiet", minRms: MIN_RMS },
      });
      return;
    }

    console.log(
      `[PIPE][${state.id}][#${seq}] start src=${meta.sourceLang} tgt=${meta.targetLang} langHint=${
        whisperLanguageHint(state.config.sourceLang) || "auto"
      }`
    );

    // WAV
    const wav = pcm16leToWavBuffer(pcm, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITS_PER_SAMPLE);
    const wavPath = path.join(os.tmpdir(), `utt_${state.id}_${seq}_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wav);

    // STT
    const stt = await openaiTranscribeWavVerbose({
      wavPath,
      languageHint: state.config.sourceLang || undefined,
    });

    cleanupWav(wavPath);

    console.log(
      `[STT][${state.id}][#${seq}] model=${stt.model} ms=${stt.ms} lang=${stt.language || "-"} segments=${
        stt.segmentsCount
      } text="${truncate(stt.text, 240)}"`
    );

    const sttText = (stt.text || "").trim();
    if (!sttText) {
      sendJson(ws, {
        type: "error",
        stage: "stt",
        message: "STT returned empty text.",
        details: { ...meta, detectedLang: stt.language || null },
      });
      return;
    }

    sendJson(ws, {
      type: "stt",
      text: sttText,
      model: stt.model,
      ms: stt.ms,
      seq,
      detectedLang: stt.language || null,
      audio: { durationMs, rms: metrics.rms, peak: metrics.peak },
    });

    // Translation
    const srcNorm = normalizeLangCode(state.config.sourceLang || "");
    const tgtNorm = normalizeLangCode(state.config.targetLang || "en") || "en";

    let translatedText = sttText;
    let provider = "none";
    let translationMs = 0;

    if (srcNorm && tgtNorm && srcNorm === tgtNorm) {
      console.log(`[TRANSL][${state.id}][#${seq}] SKIP same lang=${srcNorm}`);
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
          console.log(
            `[TRANSL][${state.id}][#${seq}] provider=deepl ms=${translationMs} endpoint=${r.endpoint} text="${truncate(
              translatedText,
              240
            )}"`
          );
        } catch (e) {
          console.warn(
            `[TRANSL][${state.id}][#${seq}] DeepL failed -> fallback OpenAI err="${truncate(e?.message, 200)}"`
          );
          const r = await openaiTranslate({ text: sttText, sourceLang: srcNorm || "auto", targetLang: tgtNorm });
          translatedText = r.text;
          provider = "openai_fallback";
          translationMs = nowMs() - t0;
          console.log(
            `[TRANSL][${state.id}][#${seq}] provider=openai_fallback ms=${translationMs} text="${truncate(
              translatedText,
              240
            )}"`
          );
        }
      } else {
        const r = await openaiTranslate({ text: sttText, sourceLang: srcNorm || "auto", targetLang: tgtNorm });
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
      sourceLang: srcNorm || "auto",
      targetLang: tgtNorm,
      ms: translationMs,
      seq,
    });

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

    // If flush was queued while processing, run once more if there is audio
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
// WS handler
// -------------------------
wss.on("connection", (ws, req) => {
  const state = makeConnState();

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  console.log(`[WS][${state.id}] connected ip=${ip}`);

  sendJson(ws, {
    type: "ready",
    id: state.id,
    wsPath: WS_PATH,
    models: { stt: OPENAI_STT_MODEL, tts: OPENAI_TTS_MODEL, translation: OPENAI_TRANSLATION_MODEL },
    voice: state.config.voice,
    deepl: { enabled: Boolean(DEEPL_API_KEY), primary: DEEPL_API_URL_PRIMARY || null },
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
    // Binary = PCM audio
    if (isBinary) {
      const buf = Buffer.from(data);

      // keep even number of bytes (Int16)
      const fixed = buf.length % 2 === 0 ? buf : buf.slice(0, buf.length - 1);

      appendPcm(state, fixed);

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

    // Text = control JSON
    const str = data.toString("utf8");
    const msg = safeJsonParse(str);
    if (!msg || typeof msg !== "object") return;

    const type = String(msg.type || "").trim();

    if (type === "config") {
      const next = { ...state.config };

      if (typeof msg.sourceLang === "string") next.sourceLang = normalizeLangCode(msg.sourceLang);
      if (typeof msg.targetLang === "string") next.targetLang = normalizeLangCode(msg.targetLang) || "en";
      if (typeof msg.auto_bidi === "boolean") next.auto_bidi = msg.auto_bidi;
      if (typeof msg.voice === "string" && msg.voice.trim()) next.voice = msg.voice.trim();

      state.config = next;

      console.log(`[CFG][${state.id}] sourceLang=${next.sourceLang || "auto"} targetLang=${next.targetLang} voice=${next.voice} auto_bidi=${next.auto_bidi}`);
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
      sendJson(ws, { type: "flush_ack", status: "processing" });
      await processUtterance(ws, state, msg);
      return;
    }
  });
});

// -------------------------
// Start
// -------------------------
server.listen(PORT, () => {
  console.log(`[BOOT] 🚀 Instant Talk Backend v2.1`);
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
  console.log(`[BOOT] Guards: MIN_AUDIO_MS_FOR_STT=${MIN_AUDIO_MS_FOR_STT} MIN_RMS=${MIN_RMS}`);
});
