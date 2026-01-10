import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// --- middleware ---
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- OpenAI (backend only) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error("❌ OPENAI_API_KEY manquante dans Railway");
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- health ---
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- translate ---
app.post("/translate", async (req, res) => {
  try {
    const { text, target = "en" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "texte manquant" });
    }

    const r = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: "Traduis. Réponds uniquement par la traduction finale." },
        { role: "user", content: `Traduis en ${target} : ${text}` }
      ],
    });

    res.json({ translated: (r.output_text || "").trim() });
  } catch (e) {
    console.error("❌ translate:", e?.message || e);
    res.status(500).json({ error: "Erreur traduction serveur", details: String(e?.message || e) });
  }
});

// --- TTS (mp3) ---
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "alloy" } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "texte manquant" });
    }

    const audio = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      format: "mp3",
    });

    const buf = Buffer.from(await audio.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    console.error("❌ tts:", e?.message || e);
    res.status(500).json({ error: "Erreur TTS serveur", details: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Backend OK sur port", PORT));
