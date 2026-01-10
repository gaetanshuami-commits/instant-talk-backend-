import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// IMPORTANT: en production, tu peux mettre ton domaine Base44 ici
// Exemple: https://tonapp.base44.app
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// --- Middlewares ---
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      // Autorise les appels sans origin (ex: curl, healthcheck)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
  })
);

// --- Vérif clé OpenAI ---
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante (Railway Variables)");
  // On ne crash pas ici, mais /tts renverra une erreur claire
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Routes ---
app.get("/", (_req, res) => {
  res.send("Instant Talk backend OK");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// TTS : renvoie un fichier audio (mp3)
app.post("/tts", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY manquante" });
    }

    const { text, voice } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Champ 'text' manquant" });
    }

    const chosenVoice = (voice && String(voice)) || "alloy";

    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: chosenVoice,
      input: text,
      format: "mp3",
    });

    const buffer = Buffer.from(await tts.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("❌ /tts error:", msg);

    // Si OpenAI renvoie un status (429 quota etc)
    const status = err?.status || 500;
    return res.status(status).json({
      error: "Erreur TTS serveur",
      details: msg,
    });
  }
});

// 404 propre
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// --- Start ---
app.listen(PORT, () => {
  console.log("✅ Instant Talk backend démarré sur le port", PORT);
});
