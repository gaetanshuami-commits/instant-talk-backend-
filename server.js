import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Instant Talk Backend OK ✅"));

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

const wss = new WebSocketServer({ server });

// Helpers
function b64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

function bufferToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

// Convert "audio/webm" chunks to a single file-like blob for Whisper:
// For MVP: we ACCUMULATE chunks ~3s then transcribe.
function createWhisperFormData(audioBuffer, mimeType = "audio/webm") {
  // Whisper endpoint expects multipart/form-data with a "file"
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
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("Whisper error: " + t);
  }

  const json = await r.json();
  return json.text || "";
}

async function deeplTranslate(text, targetLang) {
  // DeepL expects target_lang like EN, FR, ES, DE, IT, PT-PT/PT-BR, NL, ZH
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

  if (!r.ok) {
    const t = await r.text();
    throw new Error("DeepL error: " + t);
  }

  const json = await r.json();
  return json.translations?.[0]?.text || "";
}

async function azureTTS(text, voiceName = "en-US-JennyNeural") {
  const region = process.env.AZURE_SPEECH_REGION;
  const key = process.env.AZURE_SPEECH_KEY;

  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="${voiceName}">${escapeXml(text)}</voice>` +
    `</speak>`;

  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
      "User-Agent": "InstantTalkGlobal"
    },
    body: ssml
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("Azure TTS error: " + t);
  }

  const audioBuf = await r.arrayBuffer();
  return Buffer.from(audioBuf);
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Choose voice per language (simple mapping MVP)
function voiceForLang(lang) {
  const map = {
    EN: "en-US-JennyNeural",
    FR: "fr-FR-DeniseNeural",
    ES: "es-ES-ElviraNeural",
    DE: "de-DE-KatjaNeural",
    IT: "it-IT-ElsaNeural",
    PT: "pt-PT-RaquelNeural",
    NL: "nl-NL-FennaNeural",
    ZH: "zh-CN-XiaoxiaoNeural",
    AR: "ar-SA-ZariyahNeural"
  };
  return map[lang] || "en-US-JennyNeural";
}

wss.on("connection", (ws) => {
  console.log("WS client connected");

  // Accumulate chunks for ~3s per client
  let chunks = [];
  let lastFlush = Date.now();

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type !== "audio_chunk") return;

      const targetLang = (data.targetLang || "EN").toUpperCase();

      // data.audioChunk is base64 raw bytes of webm chunk
      const buf = b64ToBuffer(data.audioChunk);
      chunks.push(buf);

      const now = Date.now();
      const elapsed = now - lastFlush;

      // Flush every ~3000ms or if buffer grows
      const totalSize = chunks.reduce((a, b) => a + b.length, 0);

      if (elapsed < 3000 && totalSize < 600000) {
        // ACK so frontend knows it works
        ws.send(JSON.stringify({ type: "ack", receivedBytes: buf.length }));
        return;
      }

      lastFlush = now;
      const audioBuffer = Buffer.concat(chunks);
      chunks = [];

      // 1) Whisper
      const originalText = await whisperTranscribe(audioBuffer);

      if (!originalText.trim()) {
        ws.send(JSON.stringify({ type: "translation", originalText: "", translatedText: "", audio: "" }));
        return;
      }

      // 2) DeepL
      const translatedText = await deeplTranslate(originalText, targetLang);

      // 3) Azure TTS
      const voice = voiceForLang(targetLang);
      const audioOut = await azureTTS(translatedText, voice);

      ws.send(JSON.stringify({
        type: "translation",
        originalText,
        translatedText,
        audio: bufferToB64(audioOut),
        audioMime: "audio/mpeg"
      }));
    } catch (err) {
      console.error(err);
      ws.send(JSON.stringify({ type: "error", message: err.message || "error" }));
    }
  });
});
