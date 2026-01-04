import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";

// =======================
// Vérification ENV
// =======================
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante");
  process.exit(1);
}

// =======================
// App Express
// =======================
const app = express();
app.use(express.json({ limit: "5mb" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// =======================
// OpenAI (APRES dotenv)
// =======================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =======================
// WebSocket Server
// =======================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ WebSocket client connecté");

  ws.send(JSON.stringify({
    type: "status",
    connected: true
  }));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("📩 WS message :", data);

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (e) {
      console.error("❌ WS error", e);
    }
  });
});

// =======================
// TTS ENDPOINT (OpenAI)
// =======================
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text missing" });
    }

    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text,
    });

    const buffer = Buffer.from(await speech.arrayBuffer());

    res.json({
      audioBase64: buffer.toString("base64"),
      mime: "audio/mpeg"
    });

  } catch (err) {
    console.error("❌ TTS error", err);
    res.status(500).json({ error: "TTS failed" });
  }
});

// =======================
// FILE TRANSLATION
// =======================
const upload = multer({ storage: multer.memoryStorage() });

app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text || "";

    if (req.file) {
      const pdf = await pdfParse(req.file.buffer);
      text = pdf.text;
    }

    if (!text || !req.body.targetLang) {
      return res.status(400).json({ error: "Missing data" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate to ${req.body.targetLang}` },
        { role: "user", content: text }
      ]
    });

    res.json({
      translatedText: completion.choices[0].message.content
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Translation failed" });
  }
});

// =======================
// START SERVER
// =======================
server.listen(PORT, () => {
  console.log(`🚀 Backend OK on port ${PORT}`);
});
