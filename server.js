import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import OpenAI from "openai";
import multer from "multer";
import PDFParse from "pdf-parse";

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "25mb" }));

// ✅ Route test obligatoire
app.get("/", (_req, res) => res.send("Instant Talk Backend OK ✅"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ✅ HTTP server (Railway) + WS sur le même port
const server = http.createServer(app);

// ✅ WebSocket
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", correspondance: "connecte" }));

  ws.on("message", (msg) => {
    // ACK simple (stabilité)
    ws.send(JSON.stringify({ type: "ack", correspondance: "ok" }));
  });
});

// ✅ POST /tts (voix naturelle OpenAI)
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });

    const v = ["alloy", "nova", "shimmer", "echo", "fable", "onyx"].includes(voice)
      ? voice
      : "alloy";

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: v,
      input: text
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.json({ audioBase64: buffer.toString("base64"), audioMime: "audio/mpeg" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "tts failed" });
  }
});

// ✅ POST /translate-file (txt ou pdf -> traduction via OpenAI)
app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    const file = req.file;

    let originalText = text || "";
    if (file && file.mimetype === "application/pdf") {
      const pdf = await PDFParse(file.buffer);
      originalText = pdf.text || "";
    }

    if (!originalText || !targetLang) {
      return res.status(400).json({ error: "text/file and targetLang required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate to ${targetLang}. Return ONLY translated text.` },
        { role: "user", content: originalText }
      ],
      temperature: 0.2
    });

    res.json({
      translatedText: completion.choices?.[0]?.message?.content || "",
      targetLang
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "translate failed" });
  }
});

server.listen(PORT, () => console.log("✅ Backend running on", PORT));
