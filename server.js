import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Route test HTTP (Railway en a besoin)
app.get("/", (req, res) => {
  res.send("Instant Talk Backend OK ✅");
});

// Démarrage serveur HTTP
const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

// WebSocket
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "audio_chunk") {
        ws.send(
          JSON.stringify({
            type: "ack",
            receivedBytes: data.audioChunk?.length || 0
          })
        );
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "error" }));
    }
  });
});
