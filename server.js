import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

console.log("🚀 Instant Talk Backend OK sur le port", PORT);

wss.on("connection", (ws) => {
  console.log("✅ Client WebSocket connecté");

  // Message de bienvenue (IMPORTANT pour Base44)
  ws.send(
    JSON.stringify({
      type: "status",
      correspondance: "connected",
      message: "WebSocket connected successfully"
    })
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      console.log("📩 Message reçu :", data);

      // Réponse de test STANDARDISÉE
      ws.send(
        JSON.stringify({
          type: "translation",
          correspondance: "ok",
          originalText: "Bonjour",
          translatedText: "Hello",
          audioBase64: null // audio plus tard
        })
      );
    } catch (err) {
      console.error("❌ Erreur WS :", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client déconnecté");
  });
});
