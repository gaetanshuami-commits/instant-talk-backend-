import express from "express";
import http from "http";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.post("/tts", async (req, res) => {
  try {
    const { text, voice } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Texte manquant" });
    }

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: voice || "alloy",
      input: text,
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    res.json({
      audioBase64: buffer.toString("base64"),
    });
  } catch (err) {
    console.error("❌ Erreur TTS :", err);
    res.status(500).json({ error: "Erreur TTS serveur" });
  }
});

const PORT = process.env.PORT || 8080;

// ✅ route test simple
app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Backend Instant Talk en ligne" });
});

// ✅ serveur HTTP DOIT exister AVANT WebSocket
const server = http.createServer(app);

// ❌ PAS DE WEBSOCKET POUR L’INSTANT
// ❌ PAS DE OPENAI POUR L’INSTANT

server.listen(PORT, () => {
  console.log("🚀 Backend Instant Talk lancé sur le port", PORT);
});
