import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import multer from "multer";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // ✅ évite crash ESM

const PORT = process.env.PORT || 3000;

// ===============================
// APP EXPRESS
// ===============================
const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req, res) => {
  res.status(200).send("Instant Talk Backend OK ✅");
});

// ===============================
// OPENAI
// ===============================
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY manquante dans Railway Variables");
}
const openai = new OpenAI({ apiKey: apiKey || "missing" });


// ===============================
// HTTP SERVER + WS
// ===============================
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "status", correspondance: "connecte" }));

  ws.on("message", () => {
    ws.send(JSON.stringify({ type: "ack", correspondance: "ok" }));
  });
});

// ===============================
// TTS
// ===============================
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });

    const allowed = ["alloy", "nova", "shimmer", "echo", "fable", "onyx"];
    const v = allowed.includes(voice) ? voice : "alloy";

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: v,
      input: text
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.json({ audioBase64: buffer.toString("base64"), audioMime: "audio/mpeg" });
  } catch (err) {
    console.error("TTS ERROR:", err);
    res.status(500).json({ error: "tts failed" });
  }
});

// ===============================
// TRANSLATE FILE
// ===============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    const file = req.file;

    let originalText = text || "";

    if (file && file.mimetype === "application/pdf") {
      const pdf = await pdfParse(file.buffer); // ✅ pdfParse ici
      originalText = pdf.text || "";
    }

    if (!originalText || !targetLang) {
      return res.status(400).json({ error: "text/file and targetLang required" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate to ${targetLang}. Return only the translated text.` },
        { role: "user", content: originalText }
      ],
      temperature: 0.2
    });

    res.json({ translatedText: completion.choices?.[0]?.message?.content || "", targetLang });
  } catch (err) {
    console.error("TRANSLATE ERROR:", err);
    res.status(500).json({ error: "translation failed" });
  }
});

server.listen(PORT, () => {
  console.log("🚀 Backend running on port", PORT);
});
