// server.js (ESM) — Instant Talk Backend (Railway)
// WS protocol:
// - client sends JSON: {type:"start", from, to, sampleRate:16000, channels:1} OR {type:"start", mode:"auto_bidi", langs:["fr","en"], sampleRate:16000, channels:1}
// - client sends binary audio chunks: PCM16 LE mono 16kHz (ArrayBuffer)
// - client sends JSON: {type:"flush"} to trigger STT+translate+TTS
// - client sends JSON: {type:"stop"}
// Server replies:
// - {type:"stt", text, sourceLang?}
// - {type:"translation", text, sourceLang?, targetLang?}
// - {type:"tts", audio:"<base64 mp3>", format:"mp3"}
// - {type:"error", message}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI, { toFile } from 'openai';
import * as deepl from 'deepl-node';

// -------------------- ENV --------------------
const PORT = process.env.PORT || 8081;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('[FATAL] Missing OPENAI_API_KEY in env');
  process.exit(1);
}

const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const USE_DEEPL = Boolean(DEEPL_API_KEY);

const STT_MODEL = process.env.STT_MODEL || 'whisper-1';     // stable default
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';         // or tts-1-hd
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';

const MAX_PCM_BYTES_PER_FLUSH = Number(process.env.MAX_PCM_BYTES_PER_FLUSH || (4 * 1024 * 1024)); // 4MB safety
const WS_PATH = '/ws';

// -------------------- APP --------------------
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'instant-talk-backend', ws: WS_PATH, time: new Date().toISOString() });
});

const server = http.createServer(app);

// -------------------- WS --------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const pathname = url.pathname || '/';

    if (pathname !== WS_PATH) {
      // Close with 1008 (policy violation) so client sees "endpoint not found"
      socket.write(
        'HTTP/1.1 400 Bad Request\r\n' +
        'Connection: close\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        `WebSocket endpoint not found. Use ${WS_PATH}\n`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    socket.destroy();
  }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const deeplTranslator = USE_DEEPL ? new deepl.Translator(DEEPL_API_KEY) : null;

function nowIso() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Build a strict WAV (PCM16 LE mono 16kHz) from raw PCM bytes
function pcm16leToWavBuffer(pcmBuf, sampleRate = 16000, channels = 1) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const dataSize = pcmBuf.length;
  const headerSize = 44;
  const wavSize = headerSize + dataSize;

  const out = Buffer.alloc(wavSize);

  // RIFF header
  out.write('RIFF', 0);
  out.writeUInt32LE(wavSize - 8, 4);
  out.write('WAVE', 8);

  // fmt chunk
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);            // PCM fmt chunk size
  out.writeUInt16LE(1, 20);             // audio format = PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34);            // bits per sample

  // data chunk
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  pcmBuf.copy(out, 44);

  return out;
}

// Quick RMS/peak for PCM16
function pcm16RmsPeak(pcmBuf) {
  const len = Math.floor(pcmBuf.length / 2);
  if (len <= 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < len; i++) {
    const v = pcmBuf.readInt16LE(i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }

  const rms = Math.sqrt(sumSq / len);
  return { rms, peak };
}

async function translateText(text, from, to) {
  if (!text || !text.trim()) return '';

  if (USE_DEEPL && deeplTranslator) {
    const result = await deeplTranslator.translateText(text, from || null, to || null);
    return result.text || '';
  }

  // OpenAI fallback
  const prompt = `Translate the following text from ${from || 'the source language'} to ${to || 'the target language'}.
Return ONLY the translated text, no quotes, no explanations.

TEXT:
${text}`.trim();

  const completion = await openai.chat.completions.create({
    model: TRANSLATE_MODEL,
    messages: [
      { role: 'system', content: 'You are a translation engine.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  });

  return completion.choices?.[0]?.message?.content?.trim() || '';
}

async function ttsMp3Base64(text, voice = 'alloy') {
  if (!text || !text.trim()) return '';

  // openai-node: audio.speech.create returns a fetch Response-like object with arrayBuffer()
  const resp = await openai.audio.speech.create({
    model: TTS_MODEL,
    voice,
    input: text,
    format: 'mp3',
  });

  const ab = await resp.arrayBuffer();
  return Buffer.from(ab).toString('base64');
}

async function sttWhisper(wavBuf) {
  // Use toFile helper so openai SDK sends multipart
  const file = await toFile(wavBuf, 'audio.wav');

  const result = await openai.audio.transcriptions.create({
    file,
    model: STT_MODEL,
    // language: optional
    // response_format: 'json'
  });

  // openai SDK may return {text: "..."} for whisper-1
  return (result?.text || '').trim();
}

// -------------------- CONNECTION HANDLER --------------------
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log('[WS] CONNECT', { ip, url: req.url });

  ws.binaryType = 'arraybuffer';

  // session state per connection
  const session = {
    started: false,
    from: 'fr',
    to: 'en',
    mode: 'oneway',          // 'oneway' | 'auto_bidi'
    langs: ['fr', 'en'],
    sampleRate: 16000,
    channels: 1,
    pcmChunks: [],
    pcmBytes: 0,
    lastStartAt: Date.now(),
  };

  // Keepalive (some proxies close idle ws)
  const pingIv = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) ws.ping();
    } catch {}
  }, 25000);

  ws.on('close', (code, reason) => {
    clearInterval(pingIv);
    log('[WS] CLOSE', { code, reason: reason?.toString?.() });
  });

  ws.on('error', (err) => {
    log('[WS] ERROR', err?.message || err);
  });

  ws.on('message', async (data, isBinary) => {
    try {
      // ---------------- TEXT / JSON ----------------
      if (!isBinary) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const msg = safeJsonParse(text);

        if (!msg || !msg.type) {
          log('[WS] TEXT (ignored)', text?.slice?.(0, 200));
          return;
        }

        if (msg.type === 'start') {
          session.started = true;
          session.from = msg.from || session.from;
          session.to = msg.to || session.to;
          session.sampleRate = Number(msg.sampleRate || session.sampleRate);
          session.channels = Number(msg.channels || session.channels);

          if (msg.mode === 'auto_bidi') {
            session.mode = 'auto_bidi';
            if (Array.isArray(msg.langs) && msg.langs.length >= 2) session.langs = msg.langs;
          } else {
            session.mode = 'oneway';
          }

          session.pcmChunks = [];
          session.pcmBytes = 0;
          session.lastStartAt = Date.now();

          log('[WS] START', {
            mode: session.mode,
            from: session.from,
            to: session.to,
            langs: session.langs,
            sampleRate: session.sampleRate,
            channels: session.channels,
          });

          ws.send(JSON.stringify({ type: 'ack', ok: true, started: true }));
          return;
        }

        if (msg.type === 'stop') {
          log('[WS] STOP');
          session.started = false;
          session.pcmChunks = [];
          session.pcmBytes = 0;
          ws.send(JSON.stringify({ type: 'ack', ok: true, stopped: true }));
          return;
        }

        if (msg.type === 'flush') {
          if (!session.started) {
            ws.send(JSON.stringify({ type: 'error', message: 'flush before start' }));
            return;
          }

          if (session.pcmBytes <= 0) {
            log('[WS] FLUSH (empty)');
            ws.send(JSON.stringify({ type: 'ack', ok: true, flush: 'empty' }));
            return;
          }

          // Concat PCM
          let pcmBuf = Buffer.concat(session.pcmChunks, session.pcmBytes);

          // Align 2 bytes
          if (pcmBuf.length % 2 !== 0) pcmBuf = pcmBuf.subarray(0, pcmBuf.length - 1);

          const { rms, peak } = pcm16RmsPeak(pcmBuf);
          const estMs = Math.round((pcmBuf.length / 2 / session.sampleRate) * 1000);

          log('[WS] FLUSH', {
            bytes: pcmBuf.length,
            estMs,
            rms: Number(rms.toFixed(5)),
            peak: Number(peak.toFixed(5)),
          });

          // Reset buffer BEFORE heavy work (so next audio can accumulate)
          session.pcmChunks = [];
          session.pcmBytes = 0;

          // Safety: reject absurd segments
          if (pcmBuf.length > MAX_PCM_BYTES_PER_FLUSH) {
            ws.send(JSON.stringify({ type: 'error', message: `PCM too large (${pcmBuf.length} bytes)` }));
            return;
          }

          // Create WAV strict 16kHz mono
          const wavBuf = pcm16leToWavBuffer(pcmBuf, 16000, 1);

          // STT
          const sttText = await sttWhisper(wavBuf);
          log('[STT] text=', sttText?.slice(0, 120));

          ws.send(JSON.stringify({
            type: 'stt',
            text: sttText || '',
            sourceLang: session.mode === 'auto_bidi' ? undefined : session.from,
          }));

          if (!sttText || !sttText.trim()) {
            ws.send(JSON.stringify({ type: 'ack', ok: true, note: 'empty_stt' }));
            return;
          }

          // Translate
          const fromLang = session.mode === 'auto_bidi' ? (session.langs?.[0] || 'fr') : session.from;
          const toLang = session.mode === 'auto_bidi' ? (session.langs?.[1] || 'en') : session.to;

          const translated = await translateText(sttText, fromLang, toLang);
          log('[TR] text=', translated?.slice(0, 120));

          ws.send(JSON.stringify({
            type: 'translation',
            text: translated || '',
            sourceLang: fromLang,
            targetLang: toLang,
          }));

          if (!translated || !translated.trim()) {
            ws.send(JSON.stringify({ type: 'ack', ok: true, note: 'empty_translation' }));
            return;
          }

          // TTS (natural voice)
          const audioB64 = await ttsMp3Base64(translated, process.env.TTS_VOICE || 'alloy');
          log('[TTS] bytes(b64)=', audioB64 ? audioB64.length : 0);

          ws.send(JSON.stringify({
            type: 'tts',
            audio: audioB64 || '',
            format: 'mp3',
            text: translated,
            targetLang: toLang,
          }));

          return;
        }

        // Unknown message
        log('[WS] JSON unknown', msg.type);
        ws.send(JSON.stringify({ type: 'error', message: `unknown type: ${msg.type}` }));
        return;
      }

      // ---------------- BINARY AUDIO ----------------
      if (!session.started) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Align 2 bytes
      const aligned = (buf.length % 2 === 0) ? buf : buf.subarray(0, buf.length - 1);
      if (aligned.length <= 0) return;

      session.pcmChunks.push(aligned);
      session.pcmBytes += aligned.length;

      // Optional: if client never flushes, prevent unbounded growth
      if (session.pcmBytes > MAX_PCM_BYTES_PER_FLUSH) {
        log('[WS] PCM too large, auto-flush drop', { bytes: session.pcmBytes });
        session.pcmChunks = [];
        session.pcmBytes = 0;
        ws.send(JSON.stringify({ type: 'error', message: 'PCM buffer overflow, dropped' }));
      }
    } catch (err) {
      log('[WS] handler error', err?.message || err);
      try {
        ws.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
      } catch {}
    }
  });
});

// -------------------- START --------------------
server.listen(PORT, () => {
  log(`HTTP listening on :${PORT}`);
  log(`Health: /health`);
  log(`WebSocket: ${WS_PATH}`);
});
