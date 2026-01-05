import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import PDFParse from "pdf-parse";

dotenv.config();

const PORT = process.env.PORT || 3000;

// =======================
// Express
// =======================
const app = express();
app.use(express.json({ limit: "10mb" }));

// =======================
// HTTP Server (OBLIGATOIRE)
// =======================
const server = http.createServer(app);

// =======================
// WebSocket attaché au serveur HTTP
// =======================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ WebSocket client connecté");

  ws.send(JSON.stringify({
    type: "status",
    message: "WebSocket connecté avec succès"
  }));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("📩 WS message reçu :", data);
    } catch (e) {
      console.error("❌ WS JSON invalide");
    }
  });
});

// =======================
// OpenAI
// =======================
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// =======================
// Multer (upload fichiers)
// =======================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// =======================
// POST /tts (TEXT → VOIX)
// =======================
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text required" });
    }

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: text
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.json({
      audioBase64: buffer.toString("base64"),
      audioMime: "audio/mpeg"
    });

  } catch (err) {
    console.error("❌ TTS error:", err.message);
    res.status(500).json({ error: "TTS failed" });
  }
});

// =======================
// POST /translate-file
// =======================
app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text;
    const targetLang = req.body.targetLang;

    if (req.file && req.file.mimetype === "application/pdf") {
      const pdf = await PDFParse(req.file.buffer);
      text = pdf.text;
    }

    if (!text || !targetLang) {
      return res.status(400).json({ error: "text/file and targetLang required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate to ${targetLang}` },
        { role: "user", content: text }
      ]
    });

    res.json({
      translatedText: completion.choices[0].message.content
    });

  } catch (err) {
    console.error("❌ translate-file error:", err.message);
    res.status(500).json({ error: "translation failed" });
  }
});

// =======================
// LANCEMENT SERVEUR (LE POINT CRUCIAL)
// =======================
server.listen(PORT, () => {
  console.log(`🚀 Backend Instant Talk actif sur le port ${PORT}`);
});
