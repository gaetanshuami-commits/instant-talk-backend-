import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

// =======================
// Variables
// =======================
const PORT = process.env.PORT || 8080;

// Railway parfois n’injecte pas la variable là où on croit.
// On lit plusieurs noms possibles (sécurité) :
const OPENAI_API_KEY =
  (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "").trim();

const hasOpenAIKey = Boolean(OPENAI_API_KEY);

console.log("🔑 OPENAI_API_KEY présent :", hasOpenAIKey);

// =======================
// Express
// =======================
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// Route simple de santé
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Instant Talk backend is running" });
});

// =======================
// HTTP Server
// =======================
const server = http.createServer(app);

// =======================
// WebSocket Server
// =======================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ Client WebSocket connecté");

  ws.send(
    JSON.stringify({
      type: "status",
      message: "WebSocket connecté",
    })
  );

  ws.on("message", (raw) => {
    try {
      const str = raw?.toString?.() || "";
      const data = str ? JSON.parse(str) : {};
      // Ici tu pourras gérer tes events (audio, start, stop, etc.)
      // Pour l’instant on log juste :
      console.log("📩 WS message:", data);
    } catch (e) {
      console.error("❌ WS JSON invalide:", e.message);
    }
  });

  ws.on("close", () => console.log("🔌 Client WebSocket déconnecté"));
});

// =======================
// OpenAI Client
// =======================
const openai = hasOpenAIKey ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// =======================
// POST /tts
// =======================
app.post("/tts", async (req, res) => {
  try {
    if (!hasOpenAIKey || !openai) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY manquante sur Railway. Ajoute-la dans Variables puis redéploie.",
      });
    }

    const { text, voice } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: "Champ 'text' manquant" });
    }

    const chosenVoice = (voice || "alloy").toString();

    // TTS OpenAI
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: chosenVoice,
      input: String(text),
      format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    return res.json({ audioBase64: buffer.toString("base64") });
  } catch (err) {
    console.error("❌ Erreur /tts :", err?.message || err);
    return res.status(500).json({ error: "Erreur TTS serveur" });
  }
});

// =======================
// Start
// =======================
server.listen(PORT, () => {
  console.log(`🚀 Backend Instant Talk lancé sur le port ${PORT}`);
});
