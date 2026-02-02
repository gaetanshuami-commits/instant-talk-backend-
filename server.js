import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "5mb" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY manquante dans Railway Variables");
}

// -------------------- HEALTH --------------------
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now(),
  });
});

// -------------------- HELPERS --------------------
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function normalizeLang(lang) {
  if (!lang) return "en";
  return String(lang).toLowerCase().split("-")[0]; // fr-FR => fr
}

function b64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

async function openaiTranscribeWebm(buffer, fromLang = "fr") {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // Node 18+ : FormData, Blob disponibles globalement
  const form = new FormData();
  const blob = new Blob([buffer], { type: "audio/webm" });

  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");
  // language est optionnel, mais aide la stabilité
  form.append("language", normalizeLang(fromLang));

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`STT failed (${resp.status}): ${errTxt.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.text?.trim?.() || "";
  return text;
}

async function openaiTranslateText(text, fromLang = "fr", toLang = "en") {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!text) return "";

  const from = normalizeLang(fromLang);
  const to = normalizeLang(toLang);

  const system = `You are a real-time interpreter. Translate from ${from} to ${to}.
Rules:
- Keep meaning, tone, and brevity.
- No extra commentary.
- Return only the translated text.`;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    temperature: 0.2,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Translate failed (${resp.status}): ${errTxt.slice(0, 300)}`);
  }

  const data = await resp.json();
  const out = data?.choices?.[0]?.message?.content?.trim?.() || "";
  return out;
}

async function openaiTTSBase64Mp3(text) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!text) return "";

  // Modèle TTS stable
  const body = {
    model: "tts-1",
    voice: "alloy",
    input: text,
    format: "mp3",
  };

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`TTS failed (${resp.status}): ${errTxt.slice(0, 300)}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const b64 = Buffer.from(arrayBuffer).toString("base64");
  return b64;
}

// -------------------- OPTIONAL HTTP TTS (Frontend callTTS) --------------------
// Ton frontend a une fonction callTTS() qui POST /tts
app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }
    const audioBase64 = await openaiTTSBase64Mp3(text);
    return res.json({ audioBase64 });
  } catch (e) {
    console.error("❌ /tts error:", e?.message || e);
    return res.status(500).json({ error: e?.message || "TTS error" });
  }
});

// -------------------- WEBSOCKET /ws --------------------
const wss = new WebSocketServer({ server, path: "/ws" });
console.log("✅ WebSocket path registered: /ws");

wss.on("connection", (ws, req) => {
  console.log("🔌 WS client connected:", req.socket.remoteAddress);

  // config session par client
  ws._cfg = {
    from: "fr",
    to: "en",
  };

  // ready immédiat
  ws.send(JSON.stringify({ type: "ready" }));

  ws.on("message", async (raw) => {
    const msgStr = raw?.toString?.() || "";
    const data = safeJsonParse(msgStr);

    if (!data || typeof data !== "object" || !data.type) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid packet" }));
      return;
    }

    // START
    if (data.type === "start") {
      ws._cfg.from = normalizeLang(data.from || "fr");
      ws._cfg.to = normalizeLang(data.to || "en");

      console.log("▶ WS start:", ws._cfg.from, "->", ws._cfg.to);

      ws.send(JSON.stringify({ type: "ready" }));
      return;
    }

    // STOP
    if (data.type === "stop") {
      console.log("⏹ WS stop");
      return;
    }

    // AUDIO
    if (data.type === "audio") {
      if (!data.data || typeof data.data !== "string") {
        ws.send(JSON.stringify({ type: "error", message: "Missing audio data" }));
        return;
      }

      const t0 = Date.now();

      try {
        const audioBuffer = b64ToBuffer(data.data);

        // 1) STT
        const sttText = await openaiTranscribeWebm(audioBuffer, ws._cfg.from);
        ws.send(JSON.stringify({ type: "stt", text: sttText, final: true }));

        if (!sttText) {
          ws.send(JSON.stringify({ type: "error", message: "Empty transcription" }));
          return;
        }

        // 2) Translate
        const translated = await openaiTranslateText(sttText, ws._cfg.from, ws._cfg.to);
        ws.send(
          JSON.stringify({
            type: "translation",
            text: translated,
            sourceLang: ws._cfg.from,
            targetLang: ws._cfg.to,
            latencyMs: Date.now() - t0,
          })
        );

        // 3) TTS
        const ttsBase64 = await openaiTTSBase64Mp3(translated);
        ws.send(JSON.stringify({ type: "tts", data: ttsBase64 }));

      } catch (e) {
        console.error("❌ Pipeline error:", e?.message || e);
        ws.send(
          JSON.stringify({
            type: "error",
            message: e?.message || "Pipeline error",
          })
        );
      }

      return;
    }

    // Unknown type
    ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${data.type}` }));
  });

  ws.on("close", () => console.log("👋 WS client disconnected"));
  ws.on("error", (e) => console.error("❌ WS error:", e?.message || e));
});

// -------------------- START --------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
