import express from "express";
import http from "http";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";

import OpenAI from "openai";
import PDFParse from "pdf-parse";
import multer from "multer";

dotenv.config();

const PORT = process.env.PORT || 3000;

// --- Express app (HTTP) ---
const app = express();
app.use(express.json({ limit: "25mb" }));

// Health route
app.get("/", (_req, res) => res.send("Instant Talk Backend OK ✅"));

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- File upload (memory) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// --- Create one HTTP server for BOTH HTTP + WS ---
const server = http.createServer(app);

// --- WebSocket on same server/port ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Tell frontend we're connected
  ws.send(
    JSON.stringify({
      type: "status",
      correspondance: "connecte",
      message: "WebSocket connected"
    })
  );

  ws.on("message", async (msg) => {
    // For now: just ack (keeps frontend stable)
    try {
      JSON.parse(msg.toString());
      ws.send(JSON.stringify({ type: "ack", correspondance: "ok" }));
    } catch {
      ws.send(JSON.stringify({ type: "error", correspondance: "bad_json" }));
    }
  });
});

// --- /tts ---
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
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.json({ audioBase64: buffer.toString("base64"), audioMime: "audio/mpeg" });
  } catch (e) {
    console.error("TTS error:", e);
    res.status(500).json({ error: "TTS failed" });
  }
});

// --- /translate-file ---
// Accepts either text in body OR PDF upload
app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    const file = req.file;

    let originalText = text || "";

    if (file && file.mimetype === "application/pdf") {
      const pdfData = await PDFParse(file.buffer);
      originalText = pdfData.text || "";
    }

    if (!originalText || !targetLang) {
      return res.status(400).json({ error: "text/file and targetLang required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `You are a professional translator. Translate to ${targetLang}. Preserve formatting. Return ONLY the translated text.`
        },
        { role: "user", content: originalText }
      ],
      temperature: 0.3
    });

    const translatedText = completion.choices?.[0]?.message?.content || "";
    res.json({ translatedText, targetLang });
  } catch (e) {
    console.error("translate-file error:", e);
    res.status(500).json({ error: "Translate failed" });
  }
});

// --- Start ---
server.listen(PORT, () => {
  console.log("HTTP + WS running on port", PORT);
});
