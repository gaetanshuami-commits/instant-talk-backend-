/**
 * InstantTalk Backend - server.js (CommonJS) - Railway ready
 *
 * Receives:
 *   - Binary WebSocket messages: PCM Int16 LE, 16kHz, mono
 *   - JSON messages: { type: "flush" } and { type: "config", ... }
 *
 * Sends:
 *   - {type:"stt", text, detectedLang}
 *   - {type:"translation", text, sourceLang, targetLang, direction}
 *   - {type:"tts", format:"mp3", audioBase64, direction}
 *   - {type:"warning"/"error"}
 *
 * ENV required:
 *   OPENAI_API_KEY
 * Optional:
 *   DEEPL_API_KEY
 *   OPENAI_WHISPER_MODEL (default whisper-1)
 *   OPENAI_TTS_MODEL (default tts-1)
 *   OPENAI_TTS_VOICE (default alloy)
 *   NODE_ENV
 */

const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";

const OPENAI_WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

// ---------- small utils ----------
function safeJsonSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function nowMs() {
  return Date.now();
}

function guessLangFromText(text) {
  const t = (text || "").toLowerCase();
  // accents => FR
  if (/[àâçéèêëîïôùûüÿœ]/.test(t)) return "FR";
  const frHints = [" je ", " tu ", " vous ", " nous ", " pas ", " avec ", "bonjour", "merci"];
  const enHints = [" the ", " i ", " you ", " we ", " is ", " are ", "hello", "thanks"];
  let fr = 0,
    en = 0;
  for (const w of frHints) if (t.includes(w)) fr++;
  for (const w of enHints) if (t.includes(w)) en++;
  return fr >= en ? "FR" : "EN";
}

function normalizeLang(x) {
  const u = String(x || "").toUpperCase();
  return u === "FR" || u === "EN" ? u : null;
}

// ---------- PCM/WAV helpers ----------
function pcm16StatsLE(pcmBuf) {
  const samples = Math.floor(pcmBuf.length / 2);
  let min = 32767,
    max = -32768;
  let sumSq = 0,
    peak = 0;

  for (let i = 0; i < samples; i++) {
    const v = pcmBuf.readInt16LE(i * 2);
    if (v < min) min = v;
    if (v > max) max = v;
    const f = v / 32768;
    sumSq += f * f;
    const a = Math.abs(f);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples));
  return { samples, min, max, rms, peak };
}

function wavHeaderPCM16({ sampleRate = 16000, numChannels = 1, dataBytes }) {
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);

  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);

  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(numChannels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);

  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// ---------- OpenAI / DeepL calls ----------
async function whisperTranscribe(wavBuffer) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const url = "https://api.openai.com/v1/audio/transcriptions";

  // Node 18+ provides fetch, FormData, Blob in many environments.
  // Railway Node is usually new enough. If not, upgrade runtime.
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("model", OPENAI_WHISPER_MODEL);
  form.append("file", blob, "audio.wav");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Whisper error ${res.status}: ${t}`);
  }
  const json = await res.json();
  return (json && json.text) ? String(json.text) : "";
}

async function deeplTranslate(text, sourceLang, targetLang) {
  if (!DEEPL_API_KEY) throw new Error("Missing DEEPL_API_KEY");

  const endpoint = "https://api-free.deepl.com/v2/translate"; // use api.deepl.com for paid plan
  const body = new URLSearchParams();
  body.set("auth_key", DEEPL_API_KEY);
  body.set("text", text);
  body.set("target_lang", targetLang);
  if (sourceLang) body.set("source_lang", sourceLang);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`DeepL error ${res.status}: ${t}`);
  }
  const json = await res.json();
  const out = json?.translations?.[0]?.text;
  if (!out) throw new Error("DeepL empty translation");
  return String(out);
}

async function openaiTranslateFallback(text, sourceLang, targetLang) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const url = "https://api.openai.com/v1/chat/completions";
  const prompt = `Translate from ${sourceLang || "auto"} to ${targetLang}:\n\n${text}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are a precise translation engine." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI translate error ${res.status}: ${t}`);
  }
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content || "").trim();
}

async function openaiTTS(text) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const url = "https://api.openai.com/v1/audio/speech";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      format: "mp3",
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`TTS error ${res.status}: ${t}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ---------- HTTP server (for Railway health) ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("instant-talk-backend");
});

// ---------- WebSocket server ----------
const wss = new WebSocket.Server({ server });

// global debug counter for wav dumps
global.__IT_DEBUG_FLUSH_COUNT = global.__IT_DEBUG_FLUSH_COUNT || 0;

wss.on("connection", (ws) => {
  console.log("[WS] client connected");

  // audio buffers per client
  let pcmChunks = []; // Buffer[]
  let lastAudioAt = 0;

  // config per client
  let mode = "continuous"; // continuous | manual | flush | auto_bidi
  let sourceLang = null;   // FR|EN|null
  let targetLang = null;   // FR|EN|null
  let autoBidi = false;

  ws.on("message", async (data) => {
    // ---- binary chunk: PCM16 LE ----
    if (Buffer.isBuffer(data)) {
      // 16-bit alignment guard
      if (data.length % 2 !== 0) data = data.slice(0, data.length - 1);
      if (data.length > 0) {
        pcmChunks.push(data);
        lastAudioAt = nowMs();
      }
      return;
    }

    // ---- json message ----
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (_) {
      return;
    }

    // config
    if (msg?.type === "config") {
      if (msg.mode) mode = String(msg.mode);
      autoBidi = mode === "auto_bidi" || msg.auto_bidi === true;

      if (msg.sourceLang) sourceLang = normalizeLang(msg.sourceLang);
      if (msg.targetLang) targetLang = normalizeLang(msg.targetLang);

      safeJsonSend(ws, { type: "config_ack", mode, autoBidi, sourceLang, targetLang });
      return;
    }

    // flush pipeline
    if (msg?.type === "flush") {
      const totalBytes = pcmChunks.reduce((s, b) => s + b.length, 0);

      if (totalBytes < 2) {
        safeJsonSend(ws, { type: "warning", code: "NO_AUDIO", message: "Flush with no audio" });
        return;
      }

      // concat PCM
      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      // stats server-side (truth)
      const { samples, min, max, rms, peak } = pcm16StatsLE(pcmBuffer);
      const durMs = Math.round((samples / 16000) * 1000);

      console.log(
        `[InstantTalk] OUT_AUDIO bytes=${pcmBuffer.length} samples=${samples} durMs=${durMs} ` +
          `rms=${rms.toFixed(5)} peak=${peak.toFixed(5)} min=${min} max=${max}`
      );

      // anti-hallucination gate
      if (durMs < 250 || peak < 0.01 || rms < 0.005) {
        console.log(
          `[InstantTalk] DROP_AUDIO reason=weak_or_short durMs=${durMs} rms=${rms.toFixed(5)} peak=${peak.toFixed(5)}`
        );
        safeJsonSend(ws, {
          type: "warning",
          code: "AUDIO_TOO_WEAK",
          message: "Audio too weak/short, not sending to STT.",
          details: { durMs, rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(5)) },
        });
        return;
      }

      // make WAV strict PCM16 LE mono 16k
      const header = wavHeaderPCM16({ sampleRate: 16000, numChannels: 1, dataBytes: pcmBuffer.length });
      const wavBuffer = Buffer.concat([header, pcmBuffer]);

      // dump wav 1/5 flush (debug)
      global.__IT_DEBUG_FLUSH_COUNT++;
      if (global.__IT_DEBUG_FLUSH_COUNT % 5 === 0) {
        const file = `/tmp/instanttalk_debug_${Date.now()}.wav`;
        fs.writeFileSync(file, wavBuffer);
        console.log(`[InstantTalk] WAV_DUMP ${file} size=${wavBuffer.length}`);
      }

      // STT
      let sttText = "";
      try {
        sttText = (await whisperTranscribe(wavBuffer)).trim();
      } catch (e) {
        safeJsonSend(ws, { type: "error", stage: "stt", message: String(e?.message || e) });
        return;
      }

      if (!sttText) {
        safeJsonSend(ws, { type: "warning", code: "EMPTY_STT", message: "No text detected." });
        return;
      }

      // language detection
      const detected = guessLangFromText(sttText);
      safeJsonSend(ws, { type: "stt", text: sttText, detectedLang: detected });

      // choose direction
      let src = sourceLang || detected;
      let tgt = targetLang || (detected === "FR" ? "EN" : "FR");

      if (autoBidi) {
        src = detected;
        tgt = detected === "FR" ? "EN" : "FR";
      }

      src = normalizeLang(src) || "FR";
      tgt = normalizeLang(tgt) || (src === "FR" ? "EN" : "FR");

      // translate
      let translated = "";
      try {
        translated = await deeplTranslate(sttText, src, tgt);
      } catch (e) {
        try {
          translated = await openaiTranslateFallback(sttText, src, tgt);
        } catch (e2) {
          safeJsonSend(ws, { type: "error", stage: "translate", message: String(e2?.message || e2) });
          return;
        }
      }

      safeJsonSend(ws, {
        type: "translation",
        text: translated,
        sourceLang: src,
        targetLang: tgt,
        direction: `${src}→${tgt}`,
      });

      // TTS
      let ttsMp3;
      try {
        ttsMp3 = await openaiTTS(translated);
      } catch (e) {
        safeJsonSend(ws, { type: "error", stage: "tts", message: String(e?.message || e) });
        return;
      }

      safeJsonSend(ws, {
        type: "tts",
        format: "mp3",
        audioBase64: ttsMp3.toString("base64"),
        direction: `${src}→${tgt}`,
      });
    }
  });

  ws.on("close", () => console.log("[WS] client disconnected"));
  ws.on("error", (e) => console.log("[WS] error", e?.message || e));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] listening on ${PORT}`);
});
