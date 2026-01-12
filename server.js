// server.js (CommonJS) — Instant Talk Backend (Google Cloud STT + Translate + TTS)
// ✅ Railway-ready
// ✅ WebRTC signaling via Socket.io
// ✅ WebSocket streaming /ws/rt for audio_chunk (WEBM_OPUS)
// ✅ Returns {type:"translation", originalText, translatedText, audioBase64}

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const WebSocket = require("ws");

const speech = require("@google-cloud/speech");
const { Translate } = require("@google-cloud/translate").v2;
const tts = require("@google-cloud/text-to-speech");

// -------------------- ENV / GOOGLE CREDS --------------------
/**
 * Railway Variables à ajouter :
 * GOOGLE_APPLICATION_CREDENTIALS_JSON = (contenu JSON du service account)
 */
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credPath = path.join(__dirname, "google-credentials.json");
  if (!fs.existsSync(credPath)) {
    fs.writeFileSync(credPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "utf8");
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
}

// -------------------- APP --------------------
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => res.send("Instant Talk backend OK ✅"));
app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

const server = http.createServer(app);

// -------------------- SOCKET.IO (WebRTC signaling) --------------------
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("🟢 socket connected:", socket.id);

  socket.on("join-room", (roomId) => {
    if (!roomId) return;
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("offer", (roomId, offer) => socket.to(roomId).emit("offer", offer, socket.id));
  socket.on("answer", (roomId, answer) => socket.to(roomId).emit("answer", answer, socket.id));
  socket.on("ice-candidate", (roomId, candidate) =>
    socket.to(roomId).emit("ice-candidate", candidate, socket.id)
  );

  socket.on("leave-room", (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit("user-left", socket.id);
  });

  socket.on("disconnect", () => console.log("🔴 socket disconnected:", socket.id));
});

// -------------------- GOOGLE CLIENTS --------------------
const sttClient = new speech.SpeechClient();
const translateClient = new Translate();
const ttsClient = new tts.TextToSpeechClient();

// -------------------- SIMPLE CACHE (memory) --------------------
const cache = new Map(); // key => translation
function cacheGet(k) {
  const v = cache.get(k);
  return v;
}
function cacheSet(k, v) {
  if (cache.size > 500) {
    // purge simple
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(k, v);
}

// -------------------- WEBSOCKET /ws/rt --------------------
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/ws/rt")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🎧 WS client connected");

  // Un stream STT par client WS
  let sttStream = null;
  let currentTarget = "en";
  let currentSource = "fr-FR";

  function startSttStream() {
    // IMPORTANT: streamingRecognize pour chunks
    sttStream = sttClient
      .streamingRecognize({
        config: {
          encoding: "WEBM_OPUS",
          sampleRateHertz: 48000,
          languageCode: currentSource || "fr-FR",
          enableAutomaticPunctuation: true
          // Option: alternativeLanguageCodes: ["en-US","es-ES",...]
        },
        interimResults: true
      })
      .on("error", (err) => {
        console.error("❌ STT stream error:", err.message || err);
        try {
          ws.send(JSON.stringify({ type: "error", message: "stt_stream_error", details: String(err.message || err) }));
        } catch {}
        try { sttStream.destroy(); } catch {}
        sttStream = null;
      })
      .on("data", async (data) => {
        try {
          const result = data.results?.[0];
          if (!result) return;

          const transcript = result.alternatives?.[0]?.transcript || "";
          const isFinal = !!result.isFinal;

          // On envoie aussi des sous-titres interim si tu veux (optionnel)
          ws.send(JSON.stringify({
            type: "stt",
            text: transcript,
            isFinal
          }));

          if (!isFinal) return;
          if (!transcript.trim()) return;

          // Translate (cache)
          const key = `${currentTarget}::${transcript}`;
          let translated = cacheGet(key);
          if (!translated) {
            const [t] = await translateClient.translate(transcript, currentTarget);
            translated = t || "";
            cacheSet(key, translated);
          }

          // TTS (mp3)
          const [ttsResp] = await ttsClient.synthesizeSpeech({
            input: { text: translated },
            voice: { languageCode: mapLangToTts(currentTarget), ssmlGender: "NEUTRAL" },
            audioConfig: { audioEncoding: "MP3", speakingRate: 1.0, pitch: 0.0 }
          });

          const audioBase64 = Buffer.from(ttsResp.audioContent).toString("base64");

          ws.send(JSON.stringify({
            type: "translation",
            correspondance: Date.now(),
            originalText: transcript,
            translatedText: translated,
            audioBase64
          }));
        } catch (err) {
          console.error("❌ pipeline error:", err.message || err);
          try {
            ws.send(JSON.stringify({ type: "error", message: "pipeline_error", details: String(err.message || err) }));
          } catch {}
        }
      });
  }

  function mapLangToTts(lang) {
    // mapping simple (à étendre)
    const m = {
      fr: "fr-FR",
      en: "en-US",
      es: "es-ES",
      de: "de-DE",
      it: "it-IT",
      pt: "pt-PT",
      nl: "nl-NL",
      zh: "cmn-CN",
      ar: "ar-SA"
    };
    return m[lang] || "en-US";
  }

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "invalid_json" }));
      return;
    }

    // Le frontend doit envoyer au moins une fois config (ou on garde defaults)
    if (data.type === "config") {
      currentTarget = (data.targetLang || "en").toString();
      currentSource = (data.sourceLang || "fr-FR").toString();

      // redémarrer stream si déjà actif (pour changer langue STT)
      if (sttStream) {
        try { sttStream.destroy(); } catch {}
        sttStream = null;
      }
      startSttStream();

      ws.send(JSON.stringify({ type: "ack", message: "config_ok", target: currentTarget, source: currentSource }));
      return;
    }

    if (data.type === "audio_chunk") {
      const chunkB64 = data.audioChunk;
      if (!chunkB64) {
        ws.send(JSON.stringify({ type: "ack", bytesReceived: 0 }));
        return;
      }

      // démarrer stream si pas démarré
      if (!sttStream) startSttStream();

      // écrire le chunk
      const audioBytes = Buffer.from(chunkB64, "base64");
      try {
        sttStream.write(audioBytes);
      } catch (err) {
        console.error("❌ stt write error:", err.message || err);
      }

      ws.send(JSON.stringify({ type: "ack", bytesReceived: audioBytes.length }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", message: "unknown_type", got: data.type }));
  });

  ws.on("close", () => {
    console.log("🔴 WS client disconnected");
    try { sttStream && sttStream.destroy(); } catch {}
    sttStream = null;
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err.message || err);
  });
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🚀 Server running on", PORT));
