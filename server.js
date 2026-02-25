// server.js (ESM) — InstantTalk Backend (Railway)
// WS: /ws
// HTTP: /health

import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "instant-talk-backend", ws: "/ws", ts: Date.now() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || "";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY env var");
}

function nowISO() {
  return new Date().toISOString();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function computeRmsPeakInt16LE(buf) {
  // buf is Buffer of PCM16LE mono
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount <= 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / sampleCount);
  return { rms, peak };
}

function pcm16ToWavBuffer(pcm16le, sampleRate = 16000, channels = 1) {
  // PCM16LE => WAV (RIFF) 16-bit
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcm16le.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM
  header.writeUInt16LE(1, 20); // AudioFormat PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16le]);
}

function mapTargetLangForDeepL(code) {
  // DeepL doesn’t like "en" in some setups; use en-US or en-GB
  const m = {
    en: "en-US",
    pt: "pt-PT",
    zh: "zh-Hans",
  };
  return m[code] || code;
}

async function openaiWhisperTranscribe(wavBuffer) {
  // OpenAI REST: /v1/audio/transcriptions
  // Node18 has fetch/FormData/Blob
  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  form.append("file", blob, "audio.wav");
  form.append("model", "gpt-4o-mini-transcribe"); // good fast STT model
  // You can also add: form.append("language","fr") if you want force

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  const txt = await resp.text();
  if (!resp.ok) {
    throw new Error(`Whisper error ${resp.status}: ${txt}`);
  }
  const json = safeJsonParse(txt);
  // depending on response format, "text" is typical
  return json?.text || "";
}

async function translateText(text, from, to) {
  if (!text.trim()) return "";

  if (DEEPL_API_KEY) {
    const target = mapTargetLangForDeepL(to);
    const params = new URLSearchParams();
    params.set("text", text);
    params.set("target_lang", target.toUpperCase().replace("-", "_"));
    if (from) params.set("source_lang", from.toUpperCase().replace("-", "_"));

    const resp = await fetch("https://api-free.deepl.com/v2/translate", {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await resp.text();
    if (!resp.ok) throw new Error(`DeepL error ${resp.status}: ${data}`);

    const json = safeJsonParse(data);
    const out = json?.translations?.[0]?.text || "";
    return out;
  }

  // fallback: OpenAI text translate
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a translation engine. Translate faithfully, no extra commentary.",
        },
        {
          role: "user",
          content: `Translate from ${from || "auto"} to ${to}:\n\n${text}`,
        },
      ],
    }),
  });

  const data = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI translate error ${resp.status}: ${data}`);

  const json = safeJsonParse(data);
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

async function openaiTtsMp3Base64(text) {
  if (!text.trim()) return "";

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: OPENAI_TTS_VOICE,
      format: "mp3",
      input: text,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI TTS error ${resp.status}: ${err}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const b64 = Buffer.from(arrayBuffer).toString("base64");
  return b64;
}

wss.on("connection", (ws, req) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  console.log(`${nowISO()} ✅ WS CONNECT ip=${ip}`);

  // session state
  const state = {
    started: false,
    from: "fr",
    to: "en",
    mode: "simple", // or auto_bidi
    sampleRate: 16000,
    channels: 1,
    pcmChunks: [],
    pcmBytes: 0,
    busy: false,
  };

  ws.on("message", async (data, isBinary) => {
    try {
      // 1) JSON control messages
      if (!isBinary) {
        const str = data.toString("utf8");
        const msg = safeJsonParse(str);

        if (!msg || !msg.type) {
          console.log(`${nowISO()} ⚠️ WS TEXT (non-json):`, str.slice(0, 200));
          return;
        }

        console.log(`${nowISO()} 📩 WS JSON type=${msg.type}`);

        if (msg.type === "start") {
          state.started = true;
          state.from = msg.from || state.from;
          state.to = msg.to || state.to;
          state.mode = msg.mode || state.mode;
          state.sampleRate = Number(msg.sampleRate || 16000);
          state.channels = Number(msg.channels || 1);

          // reset audio buffer on start
          state.pcmChunks = [];
          state.pcmBytes = 0;
          state.busy = false;

          ws.send(
            JSON.stringify({
              type: "info",
              message: "start_ok",
              sampleRate: state.sampleRate,
              channels: state.channels,
              from: state.from,
              to: state.to,
              mode: state.mode,
            })
          );
          return;
        }

        if (msg.type === "flush") {
          if (!state.started) {
            ws.send(JSON.stringify({ type: "error", message: "flush_before_start" }));
            return;
          }
          if (state.busy) {
            ws.send(JSON.stringify({ type: "info", message: "busy_skip_flush" }));
            return;
          }
          if (state.pcmBytes < 3200) {
            // <100ms audio at 16kHz mono int16 = 3200 bytes
            ws.send(JSON.stringify({ type: "info", message: "too_short_skip", pcmBytes: state.pcmBytes }));
            // still clear buffer to avoid stale junk
            state.pcmChunks = [];
            state.pcmBytes = 0;
            return;
          }

          state.busy = true;

          const pcm = Buffer.concat(state.pcmChunks, state.pcmBytes);
          state.pcmChunks = [];
          state.pcmBytes = 0;

          const { rms, peak } = computeRmsPeakInt16LE(pcm);
          console.log(`${nowISO()} 🎧 FLUSH rx pcmBytes=${pcm.length} rms=${rms.toFixed(5)} peak=${peak.toFixed(5)}`);

          const wav = pcm16ToWavBuffer(pcm, 16000, 1);
          const durationMs = Math.round((pcm.length / 2 / 16000) * 1000);
          console.log(`${nowISO()} 🧾 WAV bytes=${wav.length} durationMs=${durationMs}`);

          // STT → Translate → TTS
          const sttText = await openaiWhisperTranscribe(wav);
          console.log(`${nowISO()} 📝 STT text="${sttText.slice(0, 120)}"`);

          ws.send(JSON.stringify({ type: "stt", text: sttText, sourceLang: state.from || "auto" }));

          const translated = await translateText(sttText, state.from, state.to);
          console.log(`${nowISO()} 🌍 TRANSL text="${translated.slice(0, 120)}"`);

          ws.send(JSON.stringify({ type: "translation", text: translated, sourceLang: state.from || "auto", targetLang: state.to }));

          const ttsB64 = await openaiTtsMp3Base64(translated);
          console.log(`${nowISO()} 🔊 TTS mp3_b64_len=${ttsB64.length}`);

          ws.send(JSON.stringify({ type: "tts", audio: ttsB64, text: translated }));

          state.busy = false;
          return;
        }

        if (msg.type === "stop") {
          console.log(`${nowISO()} 🛑 STOP`);
          state.started = false;
          state.pcmChunks = [];
          state.pcmBytes = 0;
          state.busy = false;
          ws.send(JSON.stringify({ type: "info", message: "stopped" }));
          return;
        }

        // unknown
        ws.send(JSON.stringify({ type: "error", message: `unknown_type:${msg.type}` }));
        return;
      }

      // 2) Binary PCM frames
      if (!state.started) return;

      const buf = Buffer.from(data);

      // ensure even length for int16
      const aligned = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
      if (aligned.length === 0) return;

      state.pcmChunks.push(aligned);
      state.pcmBytes += aligned.length;

      // optional: log occasionally
      if (state.pcmBytes % (16000 * 2 * 1) < aligned.length) {
        // about each ~1s of audio
        console.log(`${nowISO()} 📦 PCM buffered=${state.pcmBytes} bytes`);
      }
    } catch (err) {
      console.error(`${nowISO()} ❌ WS handler error:`, err);
      try {
        ws.send(JSON.stringify({ type: "error", message: String(err?.message || err) }));
      } catch {}
      // never leave busy stuck
      state.busy = false;
    }
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = reasonBuf?.toString?.() || "";
    console.log(`${nowISO()} 🔌 WS CLOSE code=${code} reason=${reason}`);
  });

  ws.on("error", (e) => {
    console.error(`${nowISO()} ❌ WS ERROR`, e);
  });
});

server.listen(PORT, () => {
  console.log(`${nowISO()} ✅ HTTP listening on :${PORT}`);
  console.log(`${nowISO()} ✅ WS path: /ws`);
});
