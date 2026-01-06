import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;

// 🔑 Vérification clé
const hasKey = !!process.env.OPENAI_API_KEY;
console.log("🔑 OPENAI_API_KEY présent :", hasKey);

if (!hasKey) {
  console.error("❌ OPENAI_API_KEY absente dans Railway");
}

// Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Route test
app.get("/", (req, res) => {
  res.json({ status: "Backend Instant Talk OK" });
});

// ✅ ROUTE TTS FONCTIONNELLE
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Texte manquant" });
    }

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": buffer.length,
    });

    res.send(buffer);
  } catch (err) {
    console.error("❌ Erreur TTS :", err);
    res.status(500).json({ error: "Erreur TTS serveur" });
  }
});

// Lancement serveur
app.listen(PORT, () => {
  console.log(`🚀 Backend Instant Talk lancé sur le port ${PORT}`);
});
