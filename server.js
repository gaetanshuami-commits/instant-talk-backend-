import express from "express";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Instant Talk Backend OK ✅"));

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("WS client connected");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "audio_chunk") {
        ws.send(
          JSON.stringify({
            type: "ack",
            receivedBytes: data.audioChunk?.length || 0,
            targetLang: data.targetLang || null
          })
        );
        return;
      }

      ws.send(JSON.stringify({ type: "echo", data }));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
  });
});
