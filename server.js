const fs = require("fs");
const WebSocket = require("ws");

// ================= DEBUG AUDIO =================

function pcm16Stats(buf) {
  const samples = Math.floor(buf.length / 2);
  let min = 32767, max = -32768;
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
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  return buffer;
}

// ================= SERVER =================

const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (ws) => {
  console.log("Client connected");

  let pcmChunks = [];
  let debugCounter = 0;

  ws.on("message", async (data) => {

    // ====== BINAIRE PCM ======
    if (Buffer.isBuffer(data)) {
      pcmChunks.push(data);
      return;
    }

    // ====== MESSAGE JSON ======
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // ====== FLUSH ======
    if (msg.type === "flush") {

      console.log("[FLUSH] received", {
        chunks: pcmChunks.length,
        bytes: pcmChunks.reduce((s, b) => s + b.length, 0),
        time: Date.now(),
      });

      if (pcmChunks.length === 0) return;

      // CONCAT PCM
      const pcmBuffer = Buffer.concat(pcmChunks);
      pcmChunks = [];

      // AUDIO STATS
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

      // WAV BUILD
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

      // DEBUG WAV (1 sur 5)
      debugCounter++;
      if (debugCounter % 5 === 0) {
        const file = `/tmp/instanttalk_debug_${Date.now()}.wav`;
        fs.writeFileSync(file, wavBuffer);
        console.log("[DEBUG WAV] saved:", file);
      }

      // ====== APPEL WHISPER ======
      await sendToWhisper(wavBuffer);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// ================= WHISPER CALL =================

async function sendToWhisper(wavBuffer) {
  // Remplace par ton appel OpenAI existant
  console.log("Sending to Whisper...");
}
