import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// CORS (simple)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "2mb" }));

// --- Debug env ---
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
console.log("🔑 OPENAI_API_KEY présent :", Boolean(OPENAI_API_KEY));

const client = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// --- Routes ---
app.get("/", (req, res) => res.send("Instant Talk backend OK"));
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    openai_key_present: Boolean(OPENAI_API_KEY),
    time: new Date().toISOString(),
  })
);

// TTS: renvoie un MP3
app.post("/tts", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY manquante sur Railway. Ajoute-la dans Variables puis redéploie.",
      });
    }

    const { text, voice } = req.body || {};
    const safeText = typeof text === "string" ? text.trim() : "";

    if (!safeText) {
      return res.status(400).json({ error: "Champ 'text' manquant." });
    }

    const chosenVoice = (typeof voice === "string" && voice.trim()) || "alloy";

    // OpenAI TTS
    const mp3 = await client.audio.speech.create({
      model: "tts-1",
      voice: chosenVoice,
      input: safeText,
      format: "mp3",
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("❌ /tts error:", err?.message || err);
    return res.status(500).json({
      error: "Erreur TTS serveur",
      details: err?.message || String(err),
    });
  }
});

// --- Start ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Backend Instant Talk lancé sur le port", PORT);
});
