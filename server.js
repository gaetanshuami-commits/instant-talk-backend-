import express from "express";
import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ===============================
// UTILS
// ===============================
function log(ws, type, message) {
  ws.send(JSON.stringify({ type, message }));
}

// ===============================
// WEBSOCKET
// ===============================
wss.on("connection", (ws) => {
  console.log("WS connected");

  let audioChunks = [];
  let fromLang = "fr";
  let toLang = "en";
  let busy = false;

  log(ws, "server", "ready");

  ws.on("message", async (data) => {
    try {
      // ===============================
      // TEXT COMMAND
      // ===============================
      if (typeof data === "string") {
        const msg = JSON.parse(data);

        if (msg.type === "start") {
          fromLang = msg.from || "fr";
          toLang = msg.to || "en";
          audioChunks = [];
          busy = false;
          log(ws, "status", "LISTENING");
          return;
        }

        if (msg.type === "stop") {
          if (audioChunks.length === 0 || busy) {
            log(ws, "info", "no_audio_or_busy");
            return;
          }

          busy = true;
          log(ws, "info", "processing_audio");

          // ===============================
          // SAVE AUDIO FILE
          // ===============================
          const audioPath = path.join(TMP_DIR, `audio_${Date.now()}.webm`);
          fs.writeFileSync(audioPath, Buffer.concat(audioChunks));

          // ===============================
          // STT
          // ===============================
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "gpt-4o-transcribe",
            language: fromLang,
          });

          log(ws, "stt", transcription.text);

          // ===============================
          // TRANSLATION
          // ===============================
          const translationRes = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: `Translate from ${fromLang} to ${toLang}`,
              },
              {
                role: "user",
                content: transcription.text,
              },
            ],
          });

          const translatedText =
            translationRes.choices[0].message.content;

          log(ws, "translation", translatedText);

          // ===============================
          // TTS
          // ===============================
          const ttsResponse = await fetch(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-4o-mini-tts",
                voice: "alloy",
                input: translatedText,
              }),
            }
          );

          const ttsBuffer = Buffer.from(await ttsResponse.arrayBuffer());

          ws.send(
            JSON.stringify({
              type: "tts",
              audio: ttsBuffer.toString("base64"),
            })
          );

          fs.unlinkSync(audioPath);
          audioChunks = [];
          busy = false;
          log(ws, "status", "READY");
        }
        return;
      }

      // ===============================
      // AUDIO CHUNKS
      // ===============================
      if (busy) {
        log(ws, "info", "busy_skip_chunk");
        return;
      }

      audioChunks.push(Buffer.from(data));
    } catch (err) {
      console.error(err);
      log(ws, "error", err.message);
      busy = false;
    }
  });

  ws.on("close", () => {
    console.log("WS closed");
  });
});

// ===============================
// HEALTH CHECK
// ===============================
app.get("/", (_, res) => {
  res.send("Instant Talk Backend OK");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
