import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => res.send("Instant Talk Backend OK ✅"));

/**
 * Endpoint pour traduire un texte (utile pour fichiers / chat)
 * POST /translate-text { text, targetLang }
 */
app.post("/translate-text", async (req, res) => {
  try {
    const { text, targetLang } = req.body || {};
    if (!text || !targetLang) return res.status(400).json({ error: "Missing text/targetLang" });

    const translatedText = await deeplTranslate(text, targetLang.toUpperCase());
    res.json({ translatedText });
  } catch (e) {
    res.status(500).json({ error: e.message || "translate-text failed" });
  }
});

const server = app.listen(PORT, () => console.log("Server running on port", PORT));
const wss = new WebSocketServer({ server });

// ---------- Helpers ----------
const b64ToBuffer = (b64) => Buffer.from(b64, "base64");
const bufferToB64 = (buf) => Buffer.from(buf).toString("base64");

function createWhisperFormData(audioBuffer, mimeType = "audio/webm") {
  const boundary = "----InstantTalkBoundary" + Date.now();
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), audioBuffer, Buffer.from(tail, "utf8")]);
  return { body, boundary };
}

async function whisperTranscribe(audioBuffer) {
  const { body, boundary } = createWhisperFormData(audioBuffer);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
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
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!r.ok) throw new Error("DeepL error: " + (await r.text()));
  const json = await r.json();
  return json.translations?.[0]?.text || "";
}

/**
 * OpenAI TTS: texte -> audio mp3 base64
 * On choisit une voix selon la langue cible (mapping simple)
 */
function openaiVoiceForLang(lang) {
  const map = {
    EN: "alloy",
    FR: "nova",
    ES: "alloy",
    DE: "nova",
    IT: "alloy",
    PT: "nova",
    NL: "alloy",
    ZH: "alloy",
    AR: "nova",
  };
  return map[lang] || "alloy";
}

async function openaiTTS(text, lang) {
  const voice = openaiVoiceForLang(lang);
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      format: "mp3",
      input: text,
    }),
  });
  if (!r.ok) throw new Error("OpenAI TTS error: " + (await r.text()));
  const audioBuf = Buffer.from(await r.arrayBuffer());
  return audioBuf;
}

// ---------- WebSocket pipeline (audio -> text -> translate -> tts) ----------
wss.on("connection", (ws) => {
  // Accumulation de chunks audio par client (produit stable)
  let chunks = [];
  let lastFlush = Date.now();

  ws.send(JSON.stringify({ type: "connected", message: "WS OK ✅" }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type !== "audio_chunk") return;

      const targetLang = (data.targetLang || "EN").toUpperCase();

      // base64 chunk audio/webm
      const buf = b64ToBuffer(data.audioChunk || "");
      if (buf.length) chunks.push(buf);

      // ACK immédiat (front vérifie que ça marche)
      ws.send(JSON.stringify({ type: "ack", receivedBytes: buf.length }));

      const now = Date.now();
      const elapsed = now - lastFlush;
      const totalSize = chunks.reduce((a, b) => a + b.length, 0);

      // On flush toutes ~2.5s (latence raisonnable + stable)
      if (elapsed < 2500 && totalSize < 600000) return;

      lastFlush = now;
      const audioBuffer = Buffer.concat(chunks);
      chunks = [];

      // 1) Transcription
      const originalText = await whisperTranscribe(audioBuffer);
      if (!originalText.trim()) return;

      // 2) Traduction
      const translatedText = await deeplTranslate(originalText, targetLang);

      // 3) Voix (TTS)
      const audioOut = await openaiTTS(translatedText, targetLang);

      ws.send(
        JSON.stringify({
          type: "translation",
          originalText,
          translatedText,
          audio: bufferToB64(audioOut),
          audioMime: "audio/mpeg",
          targetLang,
        })
      );
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: e.message || "error" }));
    }
  });
});
