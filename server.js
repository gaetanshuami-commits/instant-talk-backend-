import express from "express";
import http from "http";
import multer from "multer";
import PDFParse from "pdf-parse";
import dotenv from "dotenv";
import OpenAI from "openai";
import { WebSocketServer } from "ws";

dotenv.config();

const PORT = process.env.PORT || 3000;

// ✅ Sécurité : on vérifie dès le début
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante dans Railway Variables");
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// (Optionnel mais utile) CORS simple pour Base44
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const server = http.createServer(app);

// =====================
// ✅ Health check
// =====================
app.get("/", (req, res) => {
  res.status(200).send("Instant Talk Backend OK ✅");
});

// =====================
// ✅ OpenAI client
// =====================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================
// ✅ Upload (PDF)
// =====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// =====================
// ✅ POST /tts
// =====================
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
  } catch (err) {
    console.error("❌ /tts error:", err?.message || err);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

// =====================
// ✅ POST /translate-file
// =====================
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
            `You are a professional translator. Translate to ${targetLang}. ` +
            `Preserve formatting and structure. Return ONLY the translated text.`
        },
        { role: "user", content: originalText }
      ],
      temperature: 0.2
    });

    const translatedText = completion.choices?.[0]?.message?.content || "";

    res.json({ originalText, translatedText, targetLang });
  } catch (err) {
    console.error("❌ /translate-file error:", err?.message || err);
    res.status(500).json({ error: "File translation failed" });
  }
});

// =====================
// ✅ WebSocket (base44)
// =====================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Message de “handshake” que Base44 aime bien
  ws.send(
    JSON.stringify({
      type: "status",
      correspondance: "connecté",
      message: "WebSocket connecté ✅"
    })
  );

  ws.on("message", async (raw) => {
    // Ici tu peux brancher ton vrai pipeline (STT->traduction->TTS)
    // Pour l’instant: on renvoie un message propre (évite les crashes)
    try {
      const msg = JSON.parse(raw.toString());

      // accepte plusieurs formats envoyés par le front
      const audio = msg.audio || msg.audioChunk || "";
      const targetLang = msg.targetLang || msg.targetLanguage || "EN";

      ws.send(
        JSON.stringify({
          type: "translation",
          correspondance: "ok",
          originalText: "(reçu audio chunk)",
          translatedText: `(cible ${targetLang})`,
          audioBase64: "" // tu pourras mettre un vrai mp3 base64 ici après
        })
      );
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "error",
          correspondance: "bad_json",
          message: "JSON invalide"
        })
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Backend listening on ${PORT}`);
});
