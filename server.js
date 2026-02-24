// server.js (ESM) — prêt à coller pour Railway
import http from "http";
import fs from "fs";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);

// ================= DEBUG AUDIO =================

function pcm16Stats(buf) {
  const samples = Math.floor(buf.length / 2);
  let min = 32767,
    max = -32768;
  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
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

function wavHeader({ sampleRate, numChannels, bitsPerSample, dataBytes }) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  return buffer;
}

// ================= SERVER HTTP (Railway friendly) =================

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("instant-talk-backend");
});

// ================= WEBSOCKET =================

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[WS] client connected");

  let pcmChunks = []; // Buffer[]
  let debugCounter = 0;

  ws.on("message", async (data) => {
    // 1) PCM binary
    if (Buffer.isBuffer(data)) {
      // alignment guard: ensure even length for Int16
      if (data.length % 2 !== 0) data = data.slice(0, data.length - 1);
      if (data.length > 0) pcmChunks.push(data);
      return;
    }

    // 2) JSON messages (flush, etc.)
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg?.type === "flush") {
      const totalBytes = pcmChunks.reduce((s, b) => s + b.length, 0);

      console.log("[FLUSH] received", {
        chunks: pcmChunks.length,
        bytes: totalBytes,
        time: Date.now(),
      });

      if (pcmChunks.length === 0 || totalBytes < 2) {
        return;
      }

      // concat PCM
      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      // stats
      const { samples, min, max, rms, peak } = pcm16Stats(pcmBuffer);
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

      // build wav
      const header = wavHeader({
        sampleRate: 16000,
        numChannels: 1,
        bitsPerSample: 16,
        dataBytes: pcmBuffer.length,
      });

      const wavBuffer = Buffer.concat([header, pcmBuffer]);

      console.log("[WHISPER] sending audio", {
        bytes: wavBuffer.length,
        durationMs,
      });

      // dump wav 1/5 flush
      debugCounter++;
      if (debugCounter % 5 === 0) {
        const file = `/tmp/instanttalk_debug_${Date.now()}.wav`;
        fs.writeFileSync(file, wavBuffer);
        console.log("[DEBUG WAV] saved:", file);
      }

      // TODO: replace with your existing Whisper call
      await sendToWhisper(wavBuffer);

      // optional: notify client (debug)
      try {
        ws.send(
          JSON.stringify({
            type: "server_debug",
            audio: { durationMs, rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(5)) },
          })
        );
      } catch {}
    }
  });

  ws.on("close", () => console.log("[WS] client disconnected"));
  ws.on("error", (e) => console.log("[WS] error", e?.message || e));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] listening on ${PORT}`);
});

// ================= WHISPER PLACEHOLDER =================
// Remplace uniquement le contenu par TON code Whisper existant
async function sendToWhisper(wavBuffer) {
  // IMPORTANT: This is a placeholder. Plug your OpenAI Whisper request here.
  // For now just log to confirm the pipeline works.
  console.log("[WHISPER] (placeholder) got wav bytes:", wavBuffer.length);
}
