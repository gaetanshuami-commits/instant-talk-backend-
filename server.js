import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import multer from "multer";
import pdfParse from "pdf-parse";

dotenv.config();

const hasOpenAIKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
console.log("🔑 OPENAI_API_KEY présent :", hasOpenAIKey);

const PORT = process.env.PORT || 8080;

// --------------------
// Express + HTTP server
// --------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const server = http.createServer(app);

// --------------------
// WebSocket server
// --------------------
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ WS client connected");

  // Message de bienvenue compatible Base44
  ws.send(
    JSON.stringify({
      type: "status",
      correspondance: "connecté",
      message: "WebSocket connecté avec succès",
    })
  );

  ws.on("message", (raw) => {
    // Ici: ton streaming audio/translation WS (tu peux garder ton format)
    // Pour l’instant on évite de crash si le JSON est mauvais
    try {
      const msg = JSON.parse(raw.toString());
      // Exemple: ack simple
      ws.send(
        JSON.stringify({
          type: "ack",
          correspondance: msg?.correspondance ?? "ok",
          message: "Reçu",
        })
      );
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Bad JSON" }));
    }
  });

  ws.on("close", () => console.log("👋 WS client disconnected"));
});

// --------------------
// Healthcheck
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("Instant Talk Backend OK ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasDeepLKey: !!process.env.DEEPL_API_KEY,
  });
});

// --------------------
// OpenAI client (lazy)
// --------------------
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return null; // IMPORTANT: ne pas crash
  }
  return new OpenAI({ apiKey: key });
}

// --------------------
// Upload (PDF) config
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// --------------------
// POST /tts (OpenAI TTS)
// --------------------
app.post("/tts", async (req, res) => {
  try {
    const openai = getOpenAI();
    if (!openai) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY manquante sur Railway. Ajoute-la dans Variables puis redéploie.",
      });
    }

    const { text, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text required" });
    }

    const allowed = new Set(["alloy", "nova", "shimmer", "echo", "fable", "onyx"]);
    const openaiVoice = allowed.has(voice) ? voice : "alloy";

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: openaiVoice,
      input: text,
      speed: 1.0,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.json({
      audioBase64: buffer.toString("base64"),
      audioMime: "audio/mpeg",
    });
  } catch (err) {
    console.error("❌ /tts error:", err);
    res.status(500).json({ error: "TTS failed", details: String(err?.message || err) });
  }
});

// --------------------
// POST /translate-file (PDF->text -> translate via OpenAI)
// --------------------
app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    const openai = getOpenAI();
    if (!openai) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY manquante sur Railway. Ajoute-la dans Variables puis redéploie.",
      });
    }

    const { text, targetLang } = req.body || {};
    const file = req.file;

    let originalText = text;

    if (file && file.mimetype === "application/pdf") {
      const parsed = await pdfParse(file.buffer);
      originalText = parsed.text;
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
            `You are a professional translator. Translate the following text to ${targetLang}. ` +
            `Preserve formatting. Return ONLY the translated text.`,
        },
        { role: "user", content: originalText },
      ],
      temperature: 0.2,
    });

    res.json({
      targetLang,
      translatedText: completion.choices?.[0]?.message?.content ?? "",
    });
  } catch (err) {
    console.error("❌ /translate-file error:", err);
    res.status(500).json({ error: "File translation failed", details: String(err?.message || err) });
  }
});

// --------------------
// Start
// --------------------
server.listen(PORT, () => {
  console.log(`🚀 Instant Talk backend listening on :${PORT}`);
  console.log(`🔎 OPENAI_API_KEY present: ${!!process.env.OPENAI_API_KEY}`);
});
