import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import os from "os";
import path from "path";
import OpenAI from "openai";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SAMPLE_RATE = 16000;

function writeWavPCM16LE(filePath, pcmBuffer) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * 2;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

wss.on("connection", (ws) => {
  console.log("WS CLIENT CONNECTED");

  let pcmChunks = [];

  ws.on("message", async (data) => {
    try {
      if (Buffer.isBuffer(data)) {
        if (data.length % 2 !== 0) {
          console.log("⚠️ PCM misaligned, trimming");
          data = data.subarray(0, data.length - 1);
        }
        pcmChunks.push(data);
        return;
      }

      const msg = JSON.parse(data.toString());

      if (msg.type === "flush") {
        const pcmBuffer = Buffer.concat(pcmChunks);
        pcmChunks = [];

        if (pcmBuffer.length === 0) return;

        const tmpFile = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
        writeWavPCM16LE(tmpFile, pcmBuffer);

        console.log("[InstantTalk] WAV_DUMP", tmpFile, "size=", pcmBuffer.length);

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpFile),
          model: "gpt-4o-mini-transcribe",
        });

        const text = transcription.text || "";
        console.log("[InstantTalk] TEXT:", text);

        ws.send(
          JSON.stringify({
            type: "transcript",
            text,
          })
        );

        fs.unlink(tmpFile, () => {});
      }
    } catch (err) {
      console.error("WS ERROR:", err);
    }
  });

  ws.on("close", () => {
    console.log("WS CLOSED");
  });
});

app.get("/", (req, res) => {
  res.send("InstantTalk backend running");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
