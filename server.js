import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// HTTP server (Railway needs it)
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.get("/", (req, res) => {
  res.send("Instant Talk Backend OK ✅");
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.send(JSON.stringify({ status: "connected", message: "WS OK ✅" }));

  ws.on("message", (message) => {
    ws.send(
      JSON.stringify({
        status: "ok",
        echo: message.toString()
      })
    );
  });

  ws.on("close", () => console.log("Client disconnected"));
});
