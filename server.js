import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

/* =========================
   CONFIG
========================= */

const PORT = process.env.PORT || 8080;
const WS_PATH = "/ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   EXPRESS
========================= */

const app = express();

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Instant Talk Backend v2.1",
    ws: WS_PATH,
    models: {
      stt: OPENAI_STT_MODEL,
      tts: OPENAI_TTS_MODEL,
      translation: OPENAI_TRANSLATION_MODEL,
    },
  });
});

app.get("/healthz", (req, res) => res.send("ok"));

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(app);

/* =========================
   WEBSOCKET
========================= */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== WS_PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/* =========================
   AUDIO UTILS
========================= */

function pcmToWav(pcmBuffer, sampleRate = 16000) {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);

  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/* =========================
   WS CONNECTION
========================= */

wss.on("connection", (ws) => {
  console.log("🟢 Client connecté");

  let audioChunks = [];

  send(ws, { type: "ready" });

  ws.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        audioChunks.push(Buffer.from(data));
        return;
      }

      const msg = JSON.parse(data.toString());

      /* =========================
         FLUSH AUDIO
      ========================= */
      if (msg.type === "flush") {
        if (!audioChunks.length) return;

        const pcm = Buffer.concat(audioChunks);
        audioChunks = [];

        const wav = pcmToWav(pcm);
        const filePath = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
        fs.writeFileSync(filePath, wav);

        /* =========================
           STT
        ========================= */
        const stt = await openai.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model: OPENAI_STT_MODEL,
        });

        const text = stt.text || "";

        send(ws, { type: "stt", text });

        /* =========================
           TRANSLATION
        ========================= */
        const trans = await openai.chat.completions.create({
          model: OPENAI_TRANSLATION_MODEL,
          messages: [
            { role: "system", content: "Translate naturally and only return translated text." },
            { role: "user", content: text },
          ],
        });

        const translated = trans.choices[0].message.content.trim();

        send(ws, { type: "translation", text: translated });

        /* =========================
           TTS
        ========================= */
        const tts = await openai.audio.speech.create({
          model: OPENAI_TTS_MODEL,
          voice: "alloy",
          input: translated,
        });

        const audioBuffer = Buffer.from(await tts.arrayBuffer());

        send(ws, {
          type: "tts",
          audio: audioBuffer.toString("base64"),
        });

        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error(err);
      send(ws, { type: "error", message: err.message });
    }
  });
});

/* =========================
   START SERVER
========================= */

server.listen(PORT, () => {
  console.log("🚀 Backend Instant Talk v2.1");
  console.log("🌐 Port:", PORT);
  console.log("🔌 WS:", WS_PATH);
});
