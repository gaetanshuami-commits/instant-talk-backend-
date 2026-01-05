import express from "express";
import http from "http";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

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
