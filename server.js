import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Instant Talk Backend OK ✅"));

app.post("/translate-text", async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    if (!text || !targetLang) return res.status(400).json({ error: "Missing text/targetLang" });

    const translatedText = await deeplTranslate(text, String(targetLang).toUpperCase());
    res.json({ translatedText });
  } catch (e) {
    res.status(500).json({ error: e.message || "translate-text failed" });
  }
});

const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocketServer({ server });

function voiceForLang(lang) {
  const map = { EN: "alloy", FR: "nova", ES: "alloy", DE: "nova", IT: "alloy", PT: "nova", NL: "alloy", ZH: "alloy", AR: "nova" };
  return map[lang] || "alloy";
}

async function whisperTranscribe(webmBuffer) {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([webmBuffer], { type: "audio/webm" }), "audio.webm");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });

  if (!r.ok) throw new Error("Whisper error: " + (await r.text()));
  const json = await r.json();
  return json.text || "";
}

async function deeplTranslate(text, targetLang) {
  const params = new URLSearchParams();
  params.set("text", text);
  params.set("target_lang", targetLang);

  const r = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!r.ok) throw new Error("DeepL error: " + (await r.text()));
  const json = await r.json();
  return json.translations?.[0]?.text || "";
}

async function openaiTTS(text, lang) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: voiceForLang(lang),
      format: "mp3",
      input: text
    })
  });

  if (!r.ok) throw new Error("OpenAI TTS error: " + (await r.text()));
  return Buffer.from(await r.arrayBuffer());
}

wss.on("connection", (ws) => {
  let chunks = [];
  let lastFlush = Date.now();

  ws.send(JSON.stringify({ type: "connected", message: "WS OK ✅" }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type !== "audio_chunk") return;

      const targetLang = String(data.targetLang || "EN").toUpperCase();
      const buf = Buffer.from(String(data.audioChunk || ""), "base64");
      if (buf.length) chunks.push(buf);

      // ack immédiat
      ws.send(JSON.stringify({ type: "ack", receivedBytes: buf.length }));

      const now = Date.now();
      const elapsed = now - lastFlush;
      const totalSize = chunks.reduce((a, b) => a + b.length, 0);

      // flush stable toutes ~2.5s
      if (elapsed < 2500 && totalSize < 700000) return;

      lastFlush = now;
      const webm = Buffer.concat(chunks);
      chunks = [];

      const originalText = await whisperTranscribe(webm);
      if (!originalText.trim()) return;

      const translatedText = await deeplTranslate(originalText, targetLang);
      const audioOut = await openaiTTS(translatedText, targetLang);

      ws.send(JSON.stringify({
        type: "translation",
        originalText,
        translatedText,
        audio: audioOut.toString("base64"),
        audioMime: "audio/mpeg",
        targetLang
      }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: e.message || "error" }));
    }
  });
});
