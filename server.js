// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const { translateText } = require("./src/translate");
const { chatCompletion } = require("./src/chat");
const { speechToText } = require("./src/stt");
const { textToSpeech } = require("./src/tts");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// Si tu veux servir ton front plus tard depuis ici
app.use(express.static(path.join(__dirname, "public")));

// --- WebRTC signaling via Socket.io ---
io.on("connection", (socket) => {
  console.log("Client connecté:", socket.id);

  socket.on("join-room", (roomId) => {
    console.log(`Socket ${socket.id} rejoint la room ${roomId}`);
    socket.join(roomId);

    // Informer les autres qu'un nouvel utilisateur a rejoint
    socket.to(roomId).emit("user-joined", socket.id);

    // Offer WebRTC
    socket.on("offer", (data) => {
      socket.to(roomId).emit("offer", {
        from: socket.id,
        offer: data,
      });
    });

    // Answer WebRTC
    socket.on("answer", (data) => {
      socket.to(roomId).emit("answer", {
        from: socket.id,
        answer: data,
      });
    });

    // ICE candidates
    socket.on("ice-candidate", (data) => {
      socket.to(roomId).emit("ice-candidate", {
        from: socket.id,
        candidate: data,
      });
    });

    socket.on("disconnect", () => {
      console.log("Client déconnecté:", socket.id);
      socket.to(roomId).emit("user-left", socket.id);
    });
  });
});

// --- Routes API ---

// Health check
app.get("/", (req, res) => {
  res.send("Instant Talk Backend OK");
});

// Traduction via DeepL
app.post("/api/translate", async (req, res) => {
  try {
    const { text, target } = req.body;

    if (!text || !target) {
      return res.status(400).json({ error: "text et target sont requis" });
    }

    const translated = await translateText(text, target);
    res.json({ translated });
  } catch (err) {
    console.error("Erreur /api/translate:", err.message);
    res.status(500).json({ error: "Erreur serveur traduction" });
  }
});

// Chat OpenAI (pour résumer, reformuler, etc.)
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages doit être un tableau" });
    }

    const reply = await chatCompletion(messages);
    res.json({ reply });
  } catch (err) {
    console.error("Erreur /api/chat:", err.message);
    res.status(500).json({ error: "Erreur serveur chat" });
  }
});

// STT (placeholder pour plus tard)
app.post("/api/stt", async (req, res) => {
  try {
    // Ici tu traiteras de l'audio (à implémenter plus tard)
    const text = await speechToText(req);
    res.json({ text });
  } catch (err) {
    console.error("Erreur /api/stt:", err.message);
    res.status(500).json({ error: "Erreur serveur STT" });
  }
});

// TTS (placeholder pour plus tard)
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice } = req.body;
    const audioData = await textToSpeech(text, voice);
    res.json({ audio: audioData });
  } catch (err) {
    console.error("Erreur /api/tts:", err.message);
    res.status(500).json({ error: "Erreur serveur TTS" });
  }
});

// --- Lancement du serveur ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});
