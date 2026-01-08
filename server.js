import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// TTS / Traduction uniquement ici (PAS de window)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Backend lancé sur le port", PORT);
});
