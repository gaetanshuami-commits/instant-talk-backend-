/**
 * InstantTalk Backend - server.js (ESM, Railway-ready)
 * - WebSocket receive PCM16 16kHz mono (binary)
 * - JSON messages: {type:"flush", ...} etc
 * - On flush: build WAV -> Whisper -> translate -> TTS -> send back
 * - Includes AUDIO IN logs + debug WAV dump
 *
 * ENV required:
 *   OPENAI_API_KEY=...
 *   DEEPL_API_KEY=... (optional but recommended)
 *   PUBLIC_BASE_URL=https://your-service.up.railway.app (optional)
 *
 * Optional ENV:
 *   OPENAI_WHISPER_MODEL=whisper-1
 *   OPENAI_TTS_MODEL=tts-1
 *   OPENAI_TTS_VOICE=alloy
 *   PORT=...
 */

import http from "http";
import fs from "fs";
import WebSocket, { WebSocketServer } from "ws";

// -------------------- CONFIG --------------------
const PORT = Number(process.env.PORT || 8080);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";

const OPENAI_WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

// -------------------- HELPERS --------------------
function pcm16StatsFromBufferLE(pcmBuf) {
  const samples = Math.floor(pcmBuf.length / 2);
  let min = 32767, max = -32768;
  let sumSq = 0, peak = 0;

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

function safeJsonSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function guessLangFromText(text) {
  // ultra simple fallback: contains typical FR characters/words
  const t = (text || "").toLowerCase();
  if (/[àâçéèêëîïôùûüÿœ]/.test(t)) return "FR";
  const frHints = [" je ", " tu ", " vous ", " nous ", " pas ", " avec ", "bonjour", "merci"];
  const enHints = [" the ", " i ", " you ", " we ", " is ", " are ", "hello", "thanks"];
  let fr = 0, en = 0;
  for (const w of frHints) if (t.includes(w)) fr++;
  for (const w of enHints) if (t.includes(w)) en++;
  return fr >= en ? "FR" : "EN";
}

function normalizeBidi(sourceLang, targetLang) {
  // allow only FR/EN for auto-bidi
  const s = (sourceLang || "").toUpperCase();
  const t = (targetLang || "").toUpperCase();
  const ok = (x) => (x === "FR" || x === "EN") ? x : null;
  return { source: ok(s), target: ok(t) };
}

// -------------------- OPENAI: WHISPER --------------------
async function whisperTranscribe(wavBuffer) {
  // Node18+: global fetch, FormData, Blob available in many runtimes.
  // If your runtime lacks Blob/FormData, upgrade Node or add undici.
  const url = "https://api.openai.com/v1/audio/transcriptions";

  const fileBlob = new Blob([wavBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("model", OPENAI_WHISPER_MODEL);
  form.append("file", fileBlob, "audio.wav");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Whisper error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return json?.text || "";
}

// -------------------- DeepL translate --------------------
async function deeplTranslate(text, sourceLang, targetLang) {
  if (!DEEPL_API_KEY) throw new Error("No DEEPL_API_KEY");

  const url = "https://api-free.deepl.com/v2/translate"; // use api.deepl.com if paid plan
  const body = new URLSearchParams();
  body.set("auth_key", DEEPL_API_KEY);
  body.set("text", text);
  body.set("target_lang", targetLang);
  if (sourceLang) body.set("source_lang", sourceLang);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DeepL error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const out = json?.translations?.[0]?.text;
  if (!out) throw new Error("DeepL empty translation");
  return out;
}

// -------------------- OpenAI translate fallback (simple) --------------------
async function openaiTranslateFallback(text, sourceLang, targetLang) {
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
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI translate error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- OpenAI TTS --------------------
async function openaiTTS(text) {
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
    const txt = await res.text().catch(() => "");
    throw new Error(`TTS error ${res.status}: ${txt}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf); // mp3 bytes
}

// -------------------- HTTP SERVER (Health) --------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("instant-talk-backend");
});

// -------------------- WEBSOCKET SERVER --------------------
const wss = new WebSocketServer({ server });

// Debug dump counter (global)
global.__IT_DEBUG_FLUSH_COUNT = global.__IT_DEBUG_FLUSH_COUNT || 0;

wss.on("connection", (ws) => {
  console.log("[WS] client connected");

  // per-connection buffer
  let pcmChunks = []; // Buffer[]
  let lastAudioAt = 0;

  // per-connection mode state (optional)
  let mode = "continuous"; // manual|continuous|...
  let sourceLang = null;   // "FR"|"EN"|null
  let targetLang = null;   // "FR"|"EN"|null
  let autoBidi = false;

  ws.on("message", async (data) => {
    // --------- binary PCM chunk ----------
    if (Buffer.isBuffer(data)) {
      // Ensure even bytes (int16)
      if (data.length % 2 !== 0) data = data.slice(0, data.length - 1);
      if (data.length > 0) {
        pcmChunks.push(data);
        lastAudioAt = Date.now();
      }
      return;
    }

    // --------- json control message ----------
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // update mode/lang settings if provided
    if (msg?.type === "config") {
      mode = msg.mode || mode;
      autoBidi = msg.mode === "auto_bidi" || msg.auto_bidi === true;
      if (msg.sourceLang) sourceLang = String(msg.sourceLang).toUpperCase();
      if (msg.targetLang) targetLang = String(msg.targetLang).toUpperCase();
      safeJsonSend(ws, { type: "config_ack", mode, autoBidi, sourceLang, targetLang });
      return;
    }

    // flush triggers STT pipeline
    if (msg?.type === "flush") {
      const totalBytes = pcmChunks.reduce((s, b) => s + b.length, 0);

      if (totalBytes < 2) {
        safeJsonSend(ws, { type: "debug", msg: "flush but no audio" });
        return;
      }

      // concat
      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      // stats
      const { samples, min, max, rms, peak } = pcm16StatsFromBufferLE(pcmBuffer);
      const durationMs = Math.round((samples / 16000) * 1000);

      console.log("[AUDIO IN]", {
        bytes: pcmBuffer.length,
        samples,
        durationMs,
        min,
        max,
        rms: Number(rms.toFixed(5)),
        peak: Number(peak.toFixed(5)),
      });

      // Optional: quality gate (avoid Whisper hallucinations)
      if (peak < 0.01 || rms < 0.005 || durationMs < 200) {
        safeJsonSend(ws, {
          type: "warning",
          code: "AUDIO_TOO_WEAK",
          details: { rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(5)), durationMs },
          message: "Audio too weak/short, not sending to STT.",
        });
        return;
      }

      // build wav
      const header = wavHeaderPCM16({ sampleRate: 16000, numChannels: 1, dataBytes: pcmBuffer.length });
      const wavBuffer = Buffer.concat([header, pcmBuffer]);

      // debug wav dump 1/5
      global.__IT_DEBUG_FLUSH_COUNT++;
      if (global.__IT_DEBUG_FLUSH_COUNT % 5 === 0) {
        const file = `/tmp/instanttalk_debug_${Date.now()}.wav`;
        fs.writeFileSync(file, wavBuffer);
        console.log("[DEBUG WAV] saved", { file, bytes: wavBuffer.length });
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

      // detect language
      const detected = guessLangFromText(sttText); // FR/EN
      safeJsonSend(ws, { type: "stt", text: sttText, detectedLang: detected });

      // decide translation direction
      let src = sourceLang ? sourceLang : detected;
      let tgt = targetLang ? targetLang : (detected === "FR" ? "EN" : "FR");

      if (autoBidi) {
        // auto-bidi: flip based on detected
        src = detected;
        tgt = detected === "FR" ? "EN" : "FR";
      }

      const { source: srcOk, target: tgtOk } = normalizeBidi(src, tgt);
      if (!srcOk || !tgtOk) {
        // fallback to FR->EN default
        src = "FR";
        tgt = "EN";
      } else {
        src = srcOk;
        tgt = tgtOk;
      }

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

      // TTS (natural voice is a separate improvement; this keeps it simple)
      let ttsBytes;
      try {
        ttsBytes = await openaiTTS(translated);
      } catch (e) {
        safeJsonSend(ws, { type: "error", stage: "tts", message: String(e?.message || e) });
        return;
      }

      safeJsonSend(ws, {
        type: "tts",
        format: "mp3",
        audioBase64: ttsBytes.toString("base64"),
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
