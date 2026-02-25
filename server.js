// server.js (ESM) — Instant Talk Backend (Railway)
// WS: /ws   HTTP health: /health
// Receives: JSON start/flush/stop + binary PCM16LE mono 16kHz
// Produces: {type:"stt"} {type:"translation"} {type:"tts"} {type:"error"}

import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 8080);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";

// Models (override via env if you want)
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";

// Audio format expected from frontend
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// ---- Helpers ----
function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(nowIso(), ...args);
}

function warn(...args) {
  console.warn(nowIso(), ...args);
}

function errLog(...args) {
  console.error(nowIso(), ...args);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function mapDeepLLang(code) {
  // DeepL quirks (common)
  // - "en" deprecated → use "en-US" or "en-GB"
  // - "pt" often wants pt-PT or pt-BR
  // - Chinese often wants zh / zh-hans/zh-hant depending; here we choose zh (or zh-HANS)
  const c = (code || "").trim();

  if (!c) return c;

  const lower = c.toLowerCase();
  if (lower === "en") return "en-US";
  if (lower === "pt") return "pt-PT";
  if (lower === "zh") return "zh"; // keep simple; adjust if your DeepL plan requires "ZH"
  return c;
}

function bufferToWavPCM16Mono(bufferPCM16LE, sampleRate = SAMPLE_RATE) {
  // WAV header (PCM, mono, 16-bit LE)
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const dataSize = bufferPCM16LE.length;
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + dataSize);

  // RIFF chunk descriptor
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4);
  wavBuffer.write("WAVE", 8);

  // fmt subchunk
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16); // PCM
  wavBuffer.writeUInt16LE(1, 20);  // AudioFormat PCM = 1
  wavBuffer.writeUInt16LE(numChannels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataSize, 40);

  bufferPCM16LE.copy(wavBuffer, 44);

  return wavBuffer;
}

function ensureEvenBytes(buf) {
  // PCM16 must be multiple of 2 bytes
  if (buf.length % 2 === 0) return buf;
  warn("[ALIGN] trimming 1 byte to keep 16-bit alignment. len=", buf.length);
  return buf.subarray(0, buf.length - 1);
}

function pcmRmsPeakInt16LE(buf) {
  // Compute RMS/peak on PCM16LE
  const n = Math.floor(buf.length / 2);
  if (n <= 0) return { rms: 0, peak: 0 };

  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  return { rms, peak };
}

async function openaiTranscribeWav(wavBuffer, languageHint = "") {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // OpenAI STT (Whisper)
  // Uses multipart/form-data
  const form = new FormData();
  form.append("model", OPENAI_STT_MODEL);
  if (languageHint) form.append("language", languageHint);
  form.append("response_format", "json");
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenAI STT failed (${res.status}): ${txt}`);

  const json = safeJsonParse(txt) || {};
  return (json.text || "").toString();
}

async function deeplTranslate(text, targetLang, sourceLang = "") {
  if (!DEEPL_API_KEY) throw new Error("Missing DEEPL_API_KEY");

  // DeepL API Free/Pro endpoint difference is your responsibility.
  // This uses the common endpoint for DeepL Pro; if you use Free, change host accordingly.
  const url = "https://api.deepl.com/v2/translate";

  const params = new URLSearchParams();
  params.set("text", text);
  params.set("target_lang", mapDeepLLang(targetLang));
  if (sourceLang) params.set("source_lang", mapDeepLLang(sourceLang));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`DeepL failed (${res.status}): ${body}`);

  const json = safeJsonParse(body);
  const out = json?.translations?.[0]?.text;
  return (out || "").toString();
}

async function openaiTranslate(text, from, to) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // Minimal translation using chat
  const payload = {
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a high-accuracy translator. Output only the translation text." },
      { role: "user", content: `Translate from ${from || "auto"} to ${to}: ${text}` },
    ],
    temperature: 0.2,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`OpenAI translate failed (${res.status}): ${body}`);

  const json = safeJsonParse(body);
  const out = json?.choices?.[0]?.message?.content;
  return (out || "").trim();
}

async function openaiTtsMp3(text, voice = "alloy") {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model: OPENAI_TTS_MODEL,
    voice,
    input: text,
    format: "mp3",
  };

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const e = await res.text();
    throw new Error(`OpenAI TTS failed (${res.status}): ${e}`);
  }

  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}

// ---- Server ----
const app = express();

app.get("/", (_req, res) => res.status(200).send("InstantTalk backend up"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);

// WS on /ws
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const id = crypto.randomBytes(4).toString("hex");
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  ws.binaryType = "arraybuffer";
  log(`[WS] CONNECT id=${id} ip=${ip}`);

  // Session state
  let started = false;
  let fromLang = "fr";
  let toLang = "en";
  let mode = "mono"; // or auto_bidi later
  let pcmChunks = [];
  let totalPcmBytes = 0;
  let lastBinaryAt = Date.now();

  function sendJson(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      errLog(`[WS] sendJson failed id=${id}`, e?.message || e);
    }
  }

  function resetBuffer() {
    pcmChunks = [];
    totalPcmBytes = 0;
  }

  // Heartbeat
  const pingIv = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.ping();
    } catch {}
  }, 25000);

  ws.on("pong", () => { /* keepalive */ });

  ws.on("close", (code, reason) => {
    clearInterval(pingIv);
    log(`[WS] CLOSE id=${id} code=${code} reason=${reason?.toString?.() || ""}`);
  });

  ws.on("error", (e) => {
    errLog(`[WS] ERROR id=${id}`, e?.message || e);
  });

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        const buf = Buffer.from(data);
        lastBinaryAt = Date.now();

        // Keep alignment
        const aligned = ensureEvenBytes(buf);

        pcmChunks.push(aligned);
        totalPcmBytes += aligned.length;

        if (totalPcmBytes % 32000 < aligned.length) {
          // roughly each second @16k mono int16 => 32000 bytes
          const { rms, peak } = pcmRmsPeakInt16LE(Buffer.concat(pcmChunks));
          log(`[AUDIO] id=${id} pcmBytes=${totalPcmBytes} rms=${rms.toFixed(5)} peak=${peak.toFixed(5)}`);
        }
        return;
      }

      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      const msg = safeJsonParse(text);

      if (!msg || !msg.type) {
        warn(`[WS] id=${id} Non-JSON message ignored:`, text.slice(0, 120));
        return;
      }

      if (msg.type === "start") {
        started = true;
        mode = msg.mode || "mono";
        fromLang = (msg.from || "fr").toString();
        toLang = (msg.to || "en").toString();

        // Fix DeepL deprecated codes early
        fromLang = mapDeepLLang(fromLang);
        toLang = mapDeepLLang(toLang);

        resetBuffer();

        log(`[START] id=${id} mode=${mode} from=${fromLang} to=${toLang} sr=${msg.sampleRate} ch=${msg.channels}`);
        sendJson({ type: "ack", ok: true, id, wsPath: "/ws" });
        return;
      }

      if (msg.type === "stop") {
        log(`[STOP] id=${id}`);
        resetBuffer();
        sendJson({ type: "stopped" });
        return;
      }

      if (msg.type === "flush") {
        if (!started) {
          warn(`[FLUSH] id=${id} received before start`);
          sendJson({ type: "error", message: "flush before start" });
          return;
        }

        const pcm = Buffer.concat(pcmChunks);
        const pcmAligned = ensureEvenBytes(pcm);

        const durationMs = Math.round((pcmAligned.length / 2 / SAMPLE_RATE) * 1000);
        log(`[FLUSH] id=${id} pcmBytes=${pcmAligned.length} durationMs≈${durationMs}`);

        if (pcmAligned.length < 3200) { // <100ms
          warn(`[FLUSH] id=${id} too short, skipping`);
          resetBuffer();
          sendJson({ type: "stt", text: "" });
          return;
        }

        // Build WAV
        const wav = bufferToWavPCM16Mono(pcmAligned, SAMPLE_RATE);
        log(`[WAV] id=${id} wavBytes=${wav.length}`);

        // Reset buffer BEFORE processing to keep stream moving
        resetBuffer();

        // STT
        log(`[STT] id=${id} start model=${OPENAI_STT_MODEL}`);
        const sttText = await openaiTranscribeWav(wav, ""); // keep auto
        log(`[STT] id=${id} text="${sttText.slice(0, 120)}"`);

        sendJson({ type: "stt", text: sttText, sourceLang: fromLang });

        if (!sttText.trim()) {
          log(`[TRANSLATE] id=${id} empty stt → skip`);
          return;
        }

        // Translate
        let translated = "";
        try {
          if (DEEPL_API_KEY) {
            translated = await deeplTranslate(sttText, toLang, fromLang);
            log(`[DEEPL] id=${id} ok len=${translated.length}`);
          } else {
            translated = await openaiTranslate(sttText, fromLang, toLang);
            log(`[OAI-TR] id=${id} ok len=${translated.length}`);
          }
        } catch (e) {
          errLog(`[TRANSLATE] id=${id} failed`, e?.message || e);
          sendJson({ type: "error", message: `translate failed: ${e?.message || e}` });
          return;
        }

        sendJson({ type: "translation", text: translated, targetLang: toLang, sourceLang: fromLang });

        // TTS
        try {
          log(`[TTS] id=${id} start model=${OPENAI_TTS_MODEL}`);
          const mp3 = await openaiTtsMp3(translated, process.env.OPENAI_TTS_VOICE || "alloy");
          const b64 = mp3.toString("base64");
          log(`[TTS] id=${id} mp3Bytes=${mp3.length} b64Len=${b64.length}`);
          sendJson({ type: "tts", audio: b64, format: "mp3" });
        } catch (e) {
          errLog(`[TTS] id=${id} failed`, e?.message || e);
          sendJson({ type: "error", message: `tts failed: ${e?.message || e}` });
        }

        return;
      }

      warn(`[WS] id=${id} Unknown msg.type=${msg.type}`);
    } catch (e) {
      errLog(`[WS] id=${id} handler crash`, e?.message || e);
      sendJson({ type: "error", message: `server exception: ${e?.message || e}` });
    }
  });
});

server.listen(PORT, () => {
  log(`HTTP listening on :${PORT}`);
  log(`WS path: /ws`);
});
