/**
 * server.js — Instant Talk Backend (Railway) — v2.0 ANTI-HALLUCINATION
 *
 * WS: /ws
 * Audio in: PCM Int16 LE mono 16kHz (binary frames)
 * Control in: JSON: config / flush / reset
 *
 * Output (always):
 *   {type:"stt"} {type:"translation"} {type:"tts"} OR {type:"error"}
 *
 * v2.0: Anti-hallucination + AGC + language normalization + compression ratio
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
const BYTES_PER_SAMPLE = AUDIO_BITS_PER_SAMPLE / 8;

// Limits
const MAX_PCM_BYTES_PER_UTTERANCE = Number(process.env.MAX_PCM_BYTES_PER_UTTERANCE || 3000000);
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 2000);
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);

// Guards quality
const MIN_AUDIO_MS_FOR_STT = Number(process.env.MIN_AUDIO_MS_FOR_STT || 500);
const MIN_RMS = Number(process.env.MIN_RMS || 0.007);
const MAX_CLIP_RATE = Number(process.env.MAX_CLIP_RATE || 0.08);
const MAX_NO_SPEECH_PROB = Number(process.env.MAX_NO_SPEECH_PROB || 0.55);
const MIN_AVG_LOGPROB = Number(process.env.MIN_AVG_LOGPROB || -1.10);
const MAX_COMPRESSION_RATIO = Number(process.env.MAX_COMPRESSION_RATIO || 2.4);

// AGC
const AGC_TARGET_RMS = 0.12;
const AGC_MAX_GAIN = 8.0;

// Optional: keep wavs for debugging
const KEEP_WAV_DEBUG = (process.env.KEEP_WAV_DEBUG || "false").toLowerCase() === "true";

// -------------------------
// OpenAI
// -------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------------
// HALLUCINATION BLACKLIST
// -------------------------
const HALLUCINATION_LIST = [
  "you", "thank you", "thanks", "thanks for watching",
  "thank you for watching", "thanks for listening",
  "thank you for listening", "bye", "bye bye", "goodbye",
  "see you next time", "see you", "subtitles by", "subtitles",
  "sous-titres", "sous-titrage", "merci",
  "merci d'avoir regarde", "au revoir",
  "toi", "moi", "oui", "non", "ok", "okay",
  "oh", "ah", "hmm", "um", "uh", "huh",
  "boing boing", "boing", "ding", "ding ding", "beep",
  "la la la", "blah blah", "i'm sorry", "sorry", "the end",
  "the", "a", "yeah", "yes", "no", "so", "and", "but",
  "like", "right", "well", "just", "it", "is", "this", "that",
  "what", "i", "he", "she", "we", "they", "do", "go",
  "come", "here", "there", "now", "then", "not", "all",
  "can", "will", "if", "on", "in", "at", "to", "for",
  "of", "up", "out", "off", "my", "me", "us",
  "le", "la", "les", "de", "du", "un", "une", "et", "ou",
  "je", "tu", "il", "elle", "nous", "vous", "ils", "elles",
  "ce", "ca", "que", "qui", "si", "ne", "pas", "plus",
  "est", "sont", "suis", "dit", "fait"
];
const HALLUCINATION_SET = new Set(HALLUCINATION_LIST);

// -------------------------
// LANGUAGE NORMALIZATION
// -------------------------
const LANG_MAP = Object.create(null);
LANG_MAP["francais"] = "fr";
LANG_MAP["french"] = "fr";
LANG_MAP["anglais"] = "en";
LANG_MAP["english"] = "en";
LANG_MAP["espagnol"] = "es";
LANG_MAP["spanish"] = "es";
LANG_MAP["allemand"] = "de";
LANG_MAP["german"] = "de";
LANG_MAP["deutsch"] = "de";
LANG_MAP["italien"] = "it";
LANG_MAP["italian"] = "it";
LANG_MAP["italiano"] = "it";
LANG_MAP["portugais"] = "pt";
LANG_MAP["portuguese"] = "pt";
LANG_MAP["chinois"] = "zh";
LANG_MAP["chinese"] = "zh";
LANG_MAP["mandarin"] = "zh";
LANG_MAP["arabe"] = "ar";
LANG_MAP["arabic"] = "ar";
LANG_MAP["japonais"] = "ja";
LANG_MAP["japanese"] = "ja";
LANG_MAP["coreen"] = "ko";
LANG_MAP["korean"] = "ko";
LANG_MAP["russe"] = "ru";
LANG_MAP["russian"] = "ru";
LANG_MAP["hindi"] = "hi";
LANG_MAP["turc"] = "tr";
LANG_MAP["turkish"] = "tr";
LANG_MAP["polonais"] = "pl";
LANG_MAP["polish"] = "pl";
LANG_MAP["neerlandais"] = "nl";
LANG_MAP["dutch"] = "nl";
LANG_MAP["suedois"] = "sv";
LANG_MAP["swedish"] = "sv";
LANG_MAP["danois"] = "da";
LANG_MAP["danish"] = "da";
LANG_MAP["finnois"] = "fi";
LANG_MAP["finnish"] = "fi";
LANG_MAP["norvegien"] = "no";
LANG_MAP["norwegian"] = "no";
LANG_MAP["tcheque"] = "cs";
LANG_MAP["czech"] = "cs";
LANG_MAP["roumain"] = "ro";
LANG_MAP["romanian"] = "ro";
LANG_MAP["hongrois"] = "hu";
LANG_MAP["hungarian"] = "hu";
LANG_MAP["grec"] = "el";
LANG_MAP["greek"] = "el";
LANG_MAP["hebreu"] = "he";
LANG_MAP["hebrew"] = "he";
LANG_MAP["thai"] = "th";
LANG_MAP["vietnamien"] = "vi";
LANG_MAP["vietnamese"] = "vi";
LANG_MAP["indonesien"] = "id";
LANG_MAP["indonesian"] = "id";
LANG_MAP["malais"] = "ms";
LANG_MAP["malay"] = "ms";
LANG_MAP["ukrainien"] = "uk";
LANG_MAP["ukrainian"] = "uk";
LANG_MAP["catalan"] = "ca";
LANG_MAP["bulgare"] = "bg";
LANG_MAP["bulgarian"] = "bg";
LANG_MAP["croate"] = "hr";
LANG_MAP["croatian"] = "hr";
LANG_MAP["slovaque"] = "sk";
LANG_MAP["slovak"] = "sk";
LANG_MAP["slovene"] = "sl";
LANG_MAP["slovenian"] = "sl";
LANG_MAP["lituanien"] = "lt";
LANG_MAP["lithuanian"] = "lt";
LANG_MAP["letton"] = "lv";
LANG_MAP["latvian"] = "lv";
LANG_MAP["estonien"] = "et";
LANG_MAP["estonian"] = "et";

function normalizeLangCode(lang) {
  if (!lang) return "";
  var trimmed = String(lang).trim();
  if (!trimmed) return "";
  if (/^[a-z]{2,3}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[a-z]{2,3}[-_][a-z]{2,4}$/i.test(trimmed)) {
    return trimmed.split(/[-_]/)[0].toLowerCase();
  }
  var lower = trimmed.toLowerCase()
    .replace(/[àâä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[ïî]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[ùûü]/g, "u")
    .replace(/[ç]/g, "c");
  if (LANG_MAP[lower]) return LANG_MAP[lower];
  var keys = Object.keys(LANG_MAP);
  for (var k = 0; k < keys.length; k++) {
    if (lower.indexOf(keys[k]) !== -1 || keys[k].indexOf(lower) !== -1) {
      return LANG_MAP[keys[k]];
    }
  }
  return trimmed.toLowerCase();
}

function getWhisperHint(rawLang) {
  var code = normalizeLangCode(rawLang);
  if (!code) return undefined;
  if (/^[a-z]{2}$/.test(code)) return code;
  return undefined;
}

// -------------------------
// Express
// -------------------------
const app = express();
app.disable("x-powered-by");

app.get("/", function(_req, res) {
  res.status(200).json({
    ok: true,
    service: "instant-talk-backend",
    version: "2.0",
    wsPath: WS_PATH,
    models: { stt: OPENAI_STT_MODEL, tts: OPENAI_TTS_MODEL, translation: OPENAI_TRANSLATION_MODEL },
    voice: OPENAI_TTS_VOICE,
    deepl: { enabled: Boolean(DEEPL_API_KEY), primaryEndpoint: DEEPL_API_URL_PRIMARY || null },
  });
});

app.get("/healthz", function(_req, res) { res.status(200).send("ok"); });

// -------------------------
// HTTP + WS
// -------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", function(req, socket, head) {
  try {
    var url = new URL(req.url || "", "http://" + (req.headers.host || "localhost"));
    if (url.pathname !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, function(ws) { wss.emit("connection", ws, req); });
  } catch (e) { socket.destroy(); }
});

// -------------------------
// Utils
// -------------------------
function nowMs() { return Date.now(); }
function makeConnId() { return crypto.randomBytes(8).toString("hex"); }

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function truncate(s, max) {
  if (!max) max = 220;
  var str = String(s == null ? "" : s);
  return str.length <= max ? str : str.slice(0, max) + "...";
}

function sanitizeTextForTTS(text) {
  var t = String(text == null ? "" : text).trim();
  if (!t) return "";
  if (t.length > MAX_TEXT_CHARS) t = t.slice(0, MAX_TEXT_CHARS);
  return t;
}

function mapDeepLTargetLang(lang) {
  var lower = String(lang || "").trim().toLowerCase();
  if (!lower) return lang;
  if (lower === "en") return "en-US";
  if (lower === "pt") return "pt-PT";
  if (lower === "zh") return "zh-Hans";
  return lang;
}

function isDeepLWrongEndpointMessage(rawText) {
  var t = String(rawText || "");
  return t.indexOf("Wrong endpoint") !== -1 || t.indexOf("wrong endpoint") !== -1;
}

function pcmBytesToDurationMs(pcmBytes) {
  var denom = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * BYTES_PER_SAMPLE;
  if (!denom) return 0;
  return Math.round((pcmBytes / denom) * 1000);
}

function computePcmMetrics(pcmBuffer) {
  var sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount <= 0) return { rms: 0, peak: 0, clipRate: 0, sampleCount: 0 };
  var sumSq = 0, peak = 0, clipCount = 0;
  for (var i = 0; i < sampleCount; i++) {
    var v = pcmBuffer.readInt16LE(i * 2);
    var a = Math.abs(v) / 32768;
    sumSq += a * a;
    if (a > peak) peak = a;
    if (a >= 0.98) clipCount++;
  }
  return { rms: Math.sqrt(sumSq / sampleCount), peak: peak, clipRate: clipCount / sampleCount, sampleCount: sampleCount };
}

function applyAGC(pcmBuffer, currentRms) {
  if (currentRms <= 0.001) return { gain: 1.0, applied: false };
  var desiredGain = AGC_TARGET_RMS / currentRms;
  var gain = Math.min(desiredGain, AGC_MAX_GAIN);
  if (gain > 0.8 && gain < 1.3) return { gain: 1.0, applied: false };
  var sampleCount = Math.floor(pcmBuffer.length / 2);
  for (var i = 0; i < sampleCount; i++) {
    var v = pcmBuffer.readInt16LE(i * 2);
    v = Math.round(v * gain);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    pcmBuffer.writeInt16LE(v, i * 2);
  }
  return { gain: Math.round(gain * 100) / 100, applied: true };
}

function checkHallucination(text, durationMs, avgNoSpeech, avgLogprob) {
  var clean = text.trim().toLowerCase().replace(/[.,!?;:\-'"()[\]{}]/g, "").trim();
  if (HALLUCINATION_SET.has(clean) && durationMs < 2000) {
    return { rejected: true, reason: "blacklist_short", cleaned: clean };
  }
  if (HALLUCINATION_SET.has(clean)) {
    var bad = false;
    if (typeof avgNoSpeech === "number" && avgNoSpeech > 0.35) bad = true;
    if (typeof avgLogprob === "number" && avgLogprob < -0.80) bad = true;
    if (bad) return { rejected: true, reason: "blacklist_bad_quality", cleaned: clean };
  }
  var words = clean.split(/\s+/).filter(function(w) { return w.length > 0; });
  if (words.length <= 1 && durationMs > 1500) {
    return { rejected: true, reason: "single_word_long_audio", cleaned: clean };
  }
  if (words.length >= 4) {
    var half = Math.floor(words.length / 2);
    var first = words.slice(0, half).join(" ");
    var second = words.slice(half, half * 2).join(" ");
    if (first === second && first.length > 2) {
      return { rejected: true, reason: "repeated_phrase", cleaned: clean };
    }
  }
  return { rejected: false, cleaned: clean };
}

function pcm16leToWavBuffer(pcmBuffer, sampleRate, channels, bitsPerSample) {
  var byteRate = (sampleRate * channels * bitsPerSample) / 8;
  var blockAlign = (channels * bitsPerSample) / 8;
  var dataSize = pcmBuffer.length;
  var header = Buffer.alloc(44);
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
    try { fs.unlinkSync(wavPath); } catch (e) { /* ok */ }
  }
}

// -------------------------
// DeepL translate
// -------------------------
async function deeplTranslate(text, targetLang) {
  var mappedTarget = mapDeepLTargetLang(targetLang);
  var endpointsToTry = [DEEPL_API_URL_PRIMARY, DEEPL_API_URL_ALT].filter(Boolean);
  var lastErr = null;

  for (var idx = 0; idx < endpointsToTry.length; idx++) {
    var endpoint = endpointsToTry[idx];
    var t0 = nowMs();
    try {
      var body = new URLSearchParams();
      body.set("auth_key", DEEPL_API_KEY);
      body.set("text", text);
      body.set("target_lang", mappedTarget);

      var resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body,
      });

      var raw = await resp.text();
      var ms = nowMs() - t0;

      if (!resp.ok) {
        if (resp.status === 403 && isDeepLWrongEndpointMessage(raw)) {
          console.warn("[DEEPL] wrong endpoint " + endpoint);
          lastErr = new Error("DeepL wrong endpoint");
          continue;
        }
        throw new Error("DeepL HTTP " + resp.status + ": " + truncate(raw, 400));
      }

      var json = safeJsonParse(raw);
      var out = json && json.translations && json.translations[0] ? json.translations[0].text : null;
      if (!out) throw new Error("DeepL empty response");

      return { text: out, provider: "deepl", ms: ms };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("DeepL failed");
}

// -------------------------
// OpenAI translation fallback
// -------------------------
async function openaiTranslate(text, sourceLang, targetLang) {
  var t0 = nowMs();
  var system = "You are a translation engine for real-time voice translation. Return ONLY the translated text. No quotes, no explanations, no extra lines.";
  var user = "Translate from " + (sourceLang || "auto") + " to " + targetLang + ":\n\n" + text;

  var resp = await openai.chat.completions.create({
    model: OPENAI_TRANSLATION_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  var out = "";
  try { out = resp.choices[0].message.content.trim(); } catch (e) { out = ""; }
  return { text: out, provider: "openai", ms: nowMs() - t0 };
}

// -------------------------
// OpenAI STT (verbose_json)
// -------------------------
async function openaiSTT(wavPath, languageHint) {
  var t0 = nowMs();
  var file = fs.createReadStream(wavPath);

  var params = {
    model: OPENAI_STT_MODEL,
    file: file,
    response_format: "verbose_json",
  };

  var hint = getWhisperHint(languageHint);
  if (hint) params.language = hint;

  var result = await openai.audio.transcriptions.create(params);
  var ms = nowMs() - t0;

  var text = "";
  try { text = result.text.trim(); } catch (e) { text = ""; }
  var language = "";
  try { language = result.language || ""; } catch (e) { language = ""; }
  var segments = [];
  try { segments = Array.isArray(result.segments) ? result.segments : []; } catch (e) { segments = []; }

  var avgNoSpeech = null, avgLogprob = null, avgCompressionRatio = null;

  if (segments.length > 0) {
    var sumNS = 0, cNS = 0, sumLP = 0, cLP = 0, sumCR = 0, cCR = 0;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (s && typeof s.no_speech_prob === "number") { sumNS += s.no_speech_prob; cNS++; }
      if (s && typeof s.avg_logprob === "number") { sumLP += s.avg_logprob; cLP++; }
      if (s && typeof s.compression_ratio === "number") { sumCR += s.compression_ratio; cCR++; }
    }
    if (cNS > 0) avgNoSpeech = sumNS / cNS;
    if (cLP > 0) avgLogprob = sumLP / cLP;
    if (cCR > 0) avgCompressionRatio = sumCR / cCR;
  }

  return {
    text: text, ms: ms, model: OPENAI_STT_MODEL, language: language,
    segmentsCount: segments.length, avgNoSpeech: avgNoSpeech,
    avgLogprob: avgLogprob, avgCompressionRatio: avgCompressionRatio,
  };
}

// -------------------------
// OpenAI TTS
// -------------------------
async function openaiTTS(text, voice) {
  var t0 = nowMs();
  var mp3 = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: voice || OPENAI_TTS_VOICE,
    input: text,
    response_format: "mp3",
    speed: 1.05,
  });
  var buffer = Buffer.from(await mp3.arrayBuffer());
  return { buffer: buffer, ms: nowMs() - t0, model: OPENAI_TTS_MODEL };
}

// -------------------------
// Connection state
// -------------------------
function makeConnectionState() {
  return {
    id: makeConnId(),
    config: { sourceLang: "", targetLang: "en", auto_bidi: false, voice: OPENAI_TTS_VOICE },
    pcmChunks: [], pcmBytes: 0,
    isProcessing: false, pendingFlush: false, seq: 0,
    lastSttText: "", lastSttTime: 0,
  };
}

function resetAudioBuffer(state) { state.pcmChunks = []; state.pcmBytes = 0; }
function appendPcm(state, buf) { state.pcmChunks.push(buf); state.pcmBytes += buf.length; }

// -------------------------
// WS connections
// -------------------------
wss.on("connection", function(ws, req) {
  var state = makeConnectionState();
  var ip = "unknown";
  try { ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket.remoteAddress || "unknown"; } catch (e) {}

  console.log("[WS][" + state.id + "] connected ip=" + ip);

  sendJson(ws, {
    type: "ready", id: state.id, version: "2.0", wsPath: WS_PATH,
    models: { stt: OPENAI_STT_MODEL, tts: OPENAI_TTS_MODEL, translation: OPENAI_TRANSLATION_MODEL },
    voice: state.config.voice,
    deepl: { enabled: Boolean(DEEPL_API_KEY), endpoint: DEEPL_API_URL_PRIMARY || null },
  });

  ws.isAlive = true;
  ws.on("pong", function() { ws.isAlive = true; });

  var pingTimer = setInterval(function() {
    if (ws.readyState !== ws.OPEN) return;
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }, WS_PING_INTERVAL_MS);

  ws.on("close", function(code) { clearInterval(pingTimer); console.log("[WS][" + state.id + "] closed " + code); });
  ws.on("error", function(err) { console.error("[WS][" + state.id + "] error", err); });

  ws.on("message", async function(data, isBinary) {
    try {
      if (isBinary) {
        var buf = Buffer.from(data);
        if (buf.length % 2 !== 0) appendPcm(state, buf.slice(0, buf.length - 1));
        else appendPcm(state, buf);
        if (state.pcmBytes > MAX_PCM_BYTES_PER_UTTERANCE) {
          resetAudioBuffer(state);
          sendJson(ws, { type: "error", stage: "ingest", message: "Audio buffer overflow." });
        }
        return;
      }

      var str = data.toString("utf8");
      var msg = safeJsonParse(str);
      if (!msg || typeof msg !== "object") return;
      var type = String(msg.type || "").trim();

      if (type === "config") {
        if (typeof msg.sourceLang === "string") state.config.sourceLang = normalizeLangCode(msg.sourceLang);
        if (typeof msg.targetLang === "string") state.config.targetLang = normalizeLangCode(msg.targetLang) || "en";
        if (typeof msg.auto_bidi === "boolean") state.config.auto_bidi = msg.auto_bidi;
        if (typeof msg.voice === "string" && msg.voice.trim()) state.config.voice = msg.voice.trim();
        console.log("[CFG][" + state.id + "] src=" + (state.config.sourceLang || "auto") + " tgt=" + state.config.targetLang);
        sendJson(ws, { type: "config_ack", config: state.config });
        return;
      }

      if (type === "reset") {
        resetAudioBuffer(state);
        state.pendingFlush = false;
        state.lastSttText = "";
        state.lastSttTime = 0;
        sendJson(ws, { type: "reset_ack" });
        return;
      }

      if (type === "flush") {
        if (state.isProcessing) { state.pendingFlush = true; sendJson(ws, { type: "flush_ack", status: "queued" }); return; }
        await processUtterance(ws, state);
        return;
      }
    } catch (msgErr) {
      console.error("[WS][" + state.id + "] msg error", msgErr);
    }
  });
});

// -------------------------
// Pipeline
// -------------------------
async function processUtterance(ws, state) {
  state.isProcessing = true;
  state.pendingFlush = false;
  var seq = ++state.seq;
  var startedAt = nowMs();
  var durationMs = pcmBytesToDurationMs(state.pcmBytes);
  var pcm = state.pcmBytes > 0 ? Buffer.concat(state.pcmChunks, state.pcmBytes) : Buffer.alloc(0);
  var metrics = computePcmMetrics(pcm);

  console.log("[AUDIO][" + state.id + "][#" + seq + "] bytes=" + state.pcmBytes + " dur=" + durationMs + "ms rms=" + metrics.rms.toFixed(4) + " peak=" + metrics.peak.toFixed(4) + " clip=" + metrics.clipRate.toFixed(4));

  try {
    if (state.pcmBytes <= 0) { sendJson(ws, { type: "error", stage: "ingest", message: "No audio." }); return; }

    if (durationMs < MIN_AUDIO_MS_FOR_STT) {
      resetAudioBuffer(state);
      sendJson(ws, { type: "error", stage: "stt", message: "Too short (" + durationMs + "ms).", details: { code: "too_short" } });
      return;
    }
    if (metrics.rms < MIN_RMS) {
      resetAudioBuffer(state);
      sendJson(ws, { type: "error", stage: "stt", message: "Too quiet.", details: { code: "too_quiet", rms: metrics.rms } });
      return;
    }
    if (metrics.clipRate > MAX_CLIP_RATE) {
      resetAudioBuffer(state);
      sendJson(ws, { type: "error", stage: "stt", message: "Clipped.", details: { code: "clipped" } });
      return;
    }

    resetAudioBuffer(state);

    // AGC
    var agc = applyAGC(pcm, metrics.rms);
    if (agc.applied) console.log("[AGC][" + state.id + "][#" + seq + "] gain=" + agc.gain + "x");

    var whisperHint = getWhisperHint(state.config.sourceLang);
    console.log("[PIPE][" + state.id + "][#" + seq + "] start src=" + (state.config.sourceLang || "auto") + " tgt=" + state.config.targetLang + " hint=" + (whisperHint || "auto"));

    // WAV
    var wav = pcm16leToWavBuffer(pcm, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, AUDIO_BITS_PER_SAMPLE);
    var wavPath = path.join(os.tmpdir(), "utt_" + state.id + "_" + seq + "_" + Date.now() + ".wav");
    fs.writeFileSync(wavPath, wav);

    // STT
    var stt = await openaiSTT(wavPath, state.config.sourceLang);
    console.log("[STT][" + state.id + "][#" + seq + "] ms=" + stt.ms + " lang=" + (stt.language || "-") + " text=\"" + truncate(stt.text, 200) + "\"");
    console.log("[STT_Q][" + state.id + "][#" + seq + "] noSp=" + (stt.avgNoSpeech === null ? "-" : stt.avgNoSpeech.toFixed(3)) + " logp=" + (stt.avgLogprob === null ? "-" : stt.avgLogprob.toFixed(3)) + " comp=" + (stt.avgCompressionRatio === null ? "-" : stt.avgCompressionRatio.toFixed(3)));

    // Quality guards
    if (typeof stt.avgNoSpeech === "number" && stt.avgNoSpeech > MAX_NO_SPEECH_PROB) {
      cleanupWav(wavPath);
      sendJson(ws, { type: "error", stage: "stt", message: "No speech (p=" + stt.avgNoSpeech.toFixed(3) + ").", details: { code: "no_speech" } });
      return;
    }
    if (typeof stt.avgLogprob === "number" && stt.avgLogprob < MIN_AVG_LOGPROB) {
      cleanupWav(wavPath);
      sendJson(ws, { type: "error", stage: "stt", message: "Low confidence.", details: { code: "low_conf", avgLogprob: stt.avgLogprob } });
      return;
    }
    if (typeof stt.avgCompressionRatio === "number" && stt.avgCompressionRatio > MAX_COMPRESSION_RATIO) {
      cleanupWav(wavPath);
      sendJson(ws, { type: "error", stage: "stt", message: "Bad compression ratio.", details: { code: "high_compression" } });
      return;
    }

    cleanupWav(wavPath);

    var sttText = (stt.text || "").trim();
    if (!sttText) { sendJson(ws, { type: "error", stage: "stt", message: "Empty STT." }); return; }

    // Hallucination check
    var hallu = checkHallucination(sttText, durationMs, stt.avgNoSpeech, stt.avgLogprob);
    if (hallu.rejected) {
      console.warn("[HALLU][" + state.id + "][#" + seq + "] BLOCKED \"" + truncate(sttText, 80) + "\" reason=" + hallu.reason);
      sendJson(ws, { type: "error", stage: "stt", message: "Filtered: \"" + truncate(sttText, 40) + "\"", details: { code: "hallucination", reason: hallu.reason } });
      return;
    }

    // Repeat check
    var elapsed = nowMs() - state.lastSttTime;
    if (sttText === state.lastSttText && elapsed < 3000 && sttText.split(/\s+/).length <= 3) {
      sendJson(ws, { type: "error", stage: "stt", message: "Repeat.", details: { code: "repeat" } });
      return;
    }
    state.lastSttText = sttText;
    state.lastSttTime = nowMs();

    // Emit STT
    sendJson(ws, {
      type: "stt", text: sttText, model: stt.model, ms: stt.ms, seq: seq,
      detectedLang: stt.language || null,
      sttQuality: { avgNoSpeech: stt.avgNoSpeech, avgLogprob: stt.avgLogprob, avgCompressionRatio: stt.avgCompressionRatio, segmentsCount: stt.segmentsCount },
      audio: { durationMs: durationMs, rms: metrics.rms, peak: metrics.peak, clipRate: metrics.clipRate, agcGain: agc.gain },
    });

    // Translation
    var src = state.config.sourceLang || "";
    var tgt = state.config.targetLang || "en";
    var translatedText = sttText;
    var provider = "none";
    var translationMs = 0;

    if (src && tgt && src.toLowerCase() === tgt.toLowerCase()) {
      console.log("[TRANSL][" + state.id + "][#" + seq + "] SKIP same=" + src);
    } else {
      var t0 = nowMs();
      if (DEEPL_API_KEY) {
        try {
          var dr = await deeplTranslate(sttText, tgt);
          translatedText = dr.text;
          provider = "deepl";
          translationMs = nowMs() - t0;
          console.log("[TRANSL][" + state.id + "][#" + seq + "] deepl ms=" + translationMs + " \"" + truncate(translatedText, 200) + "\"");
        } catch (de) {
          console.warn("[TRANSL][" + state.id + "][#" + seq + "] DeepL fail: " + truncate(de.message, 100));
          var or = await openaiTranslate(sttText, src || "auto", tgt);
          translatedText = or.text;
          provider = "openai_fallback";
          translationMs = nowMs() - t0;
        }
      } else {
        var or2 = await openaiTranslate(sttText, src || "auto", tgt);
        translatedText = or2.text;
        provider = "openai";
        translationMs = nowMs() - t0;
      }
    }

    sendJson(ws, { type: "translation", text: translatedText, provider: provider, sourceLang: src || "auto", targetLang: tgt, ms: translationMs, seq: seq });

    // TTS
    var ttsInput = sanitizeTextForTTS(translatedText);
    if (!ttsInput) { sendJson(ws, { type: "error", stage: "tts", message: "TTS input empty." }); return; }

    var tts = await openaiTTS(ttsInput, state.config.voice || OPENAI_TTS_VOICE);
    console.log("[TTS][" + state.id + "][#" + seq + "] ms=" + tts.ms + " bytes=" + tts.buffer.length);

    sendJson(ws, {
      type: "tts", audioB64: tts.buffer.toString("base64"), mime: "audio/mpeg",
      bytes: tts.buffer.length, model: tts.model, voice: state.config.voice || OPENAI_TTS_VOICE, ms: tts.ms, seq: seq,
    });

    var totalMs = nowMs() - startedAt;
    console.log("[PIPE][" + state.id + "][#" + seq + "] DONE " + totalMs + "ms (stt=" + stt.ms + " tr=" + translationMs + " tts=" + tts.ms + ")");
    sendJson(ws, { type: "done", seq: seq, totalMs: totalMs, breakdown: { sttMs: stt.ms, translationMs: translationMs, ttsMs: tts.ms } });

  } catch (err) {
    var totalMs2 = nowMs() - startedAt;
    var msg = (err && err.message) ? String(err.message) : "Unknown error";
    console.error("[ERR][" + state.id + "][#" + seq + "] " + totalMs2 + "ms " + msg);
    sendJson(ws, { type: "error", stage: "pipeline", message: msg, details: { seq: seq, totalMs: totalMs2 } });
  } finally {
    state.isProcessing = false;
    if (state.pendingFlush && state.pcmBytes > 0 && ws.readyState === ws.OPEN) {
      state.pendingFlush = false;
      processUtterance(ws, state).catch(function(e) { console.error("[ERR] pending flush", e); });
    } else {
      state.pendingFlush = false;
    }
  }
}

// -------------------------
// Start
// -------------------------
server.listen(PORT, function() {
  console.log("[BOOT] Instant Talk Backend v2.0");
  console.log("[BOOT] Port: " + PORT);
  console.log("[BOOT] WS: " + WS_PATH);
  console.log("[BOOT] STT: " + OPENAI_STT_MODEL);
  console.log("[BOOT] TTS: " + OPENAI_TTS_MODEL + " voice=" + OPENAI_TTS_VOICE);
  console.log("[BOOT] Translation: " + OPENAI_TRANSLATION_MODEL);
  console.log("[BOOT] DeepL: " + (DEEPL_API_KEY ? "ON (" + DEEPL_API_URL_PRIMARY + ")" : "OFF"));
  console.log("[BOOT] AGC: target=" + AGC_TARGET_RMS + " maxGain=" + AGC_MAX_GAIN);
  console.log("[BOOT] Guards: minMs=" + MIN_AUDIO_MS_FOR_STT + " minRms=" + MIN_RMS + " maxClip=" + MAX_CLIP_RATE);
  console.log("[BOOT] Guards: maxNoSpeech=" + MAX_NO_SPEECH_PROB + " minLogprob=" + MIN_AVG_LOGPROB + " maxCompRatio=" + MAX_COMPRESSION_RATIO);
  console.log("[BOOT] Hallucination blacklist: " + HALLUCINATION_SET.size + " entries");
  console.log("[BOOT] Ready.");
});
