import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


// ================= HEALTH =================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now()
  });
});


// ================= WEBSOCKET =================

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

console.log("✅ WebSocket registered on /ws");

wss.on("connection", (ws) => {

  console.log("🔌 Client connecté");

  let sessionConfig = {
    from: "fr",
    to: "en"
  };

  ws.on("message", async (msg) => {

    try {

      const data = JSON.parse(msg.toString());

      if (!data.type) return;

      // START SESSION
      if (data.type === "start") {

        sessionConfig.from = data.from;
        sessionConfig.to = data.to;

        console.log("▶ SESSION", sessionConfig);

        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }

      // AUDIO CHUNK
      if (data.type === "audio") {

        // === POUR L’INSTANT SIMULATION TEXTE ===
        // (Remplacé plus tard par Whisper réel streaming)

        const fakeText = "Bonjour ceci est un test";

        // SEND STT
        ws.send(JSON.stringify({
          type: "stt",
          text: fakeText,
          final: true
        }));

        // TRANSLATION VIA GPT
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Translate from ${sessionConfig.from} to ${sessionConfig.to}`
            },
            {
              role: "user",
              content: fakeText
            }
          ]
        });

        const translatedText = completion.choices[0].message.content;

        ws.send(JSON.stringify({
          type: "translation",
          text: translatedText
        }));

        // TTS AUDIO
        const tts = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: "alloy",
          input: translatedText
        });

        const buffer = Buffer.from(await tts.arrayBuffer());
        const audioBase64 = buffer.toString("base64");

        ws.send(JSON.stringify({
          type: "tts",
          data: audioBase64
        }));

        return;
      }

      if (data.type === "stop") {
        console.log("⏹ Session stop");
      }

    } catch (err) {

      console.error("❌ WS ERROR", err);

      ws.send(JSON.stringify({
        type: "error",
        message: err.message
      }));
    }

  });

  ws.on("close", () => {
    console.log("❎ Client disconnect");
  });

});


// ================= START =================

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
