import OpenAI from "openai";
import PDFParse from "pdf-parse";
import multer from "multer";

import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

console.log("🚀 Instant Talk Backend OK sur le port", PORT);

wss.on("connection", (ws) => {
  console.log("✅ Client WebSocket connecté");

  // Message de bienvenue (IMPORTANT pour Base44)
  ws.send(
    JSON.stringify({
      type: "status",
      correspondance: "connected",
      message: "WebSocket connected successfully"
    })
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("📩 Message reçu :", data);

      // Réponse de test STANDARDISÉE
      ws.send(
        JSON.stringify({
          type: "translation",
          correspondance: "ok",
          originalText: "Bonjour",
          translatedText: "Hello",
          audioBase64: null // audio plus tard
        })
      );
    } catch (err) {
      console.error("❌ Erreur WS :", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client déconnecté");
  });
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// POST /tts
app.post("/tts", async (req, res) => {
  try {
    const { text, lang, voice } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });

    let openaiVoice = "alloy";
    if (voice === "nova") openaiVoice = "nova";
    else if (voice === "shimmer") openaiVoice = "shimmer";
    else if (voice === "echo") openaiVoice = "echo";
    else if (voice === "fable") openaiVoice = "fable";
    else if (voice === "onyx") openaiVoice = "onyx";

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: openaiVoice,
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    const audioBase64 = buffer.toString("base64");

    res.json({ audioBase64, audioMime: "audio/mpeg" });
  } catch (error) {
    console.error("TTS error:", error);
    res.status(500).json({ error: "TTS generation failed" });
  }
});

// POST /translate-file
app.post("/translate-file", upload.single("file"), async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    const file = req.file;

    let originalText = text;

    if (file && file.mimetype === "application/pdf") {
      const pdfData = await PDFParse(file.buffer);
      originalText = pdfData.text;
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
            `You are a professional translator. Translate the following text to ${targetLang}. Preserve formatting. Return ONLY the translated text.`
        },
        { role: "user", content: originalText }
      ],
      temperature: 0.3
    });

    const translatedText = completion.choices?.[0]?.message?.content || "";

    res.json({ translatedText, targetLang });
  } catch (error) {
    console.error("Translate-file error:", error);
    res.status(500).json({ error: "File translation failed" });
  }
});
