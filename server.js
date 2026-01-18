import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

import { SpeechClient } from "@google-cloud/speech";
import textToSpeech from "@google-cloud/text-to-speech";
import * as deepl from "deepl-node";

/**
 * ENV (Railway)
 * - PORT
 * - DEEPL_API_KEY
 * - GOOGLE_APPLICATION_CREDENTIALS_JSON  ✅ (JSON brut complet du service account)
 *   ou GOOGLE_CLOUD_CREDENTIALS          (fallback)
 *
 * WS PROTOCOL (JSON)
 * Client -> {type:"start", from:"fr", to:"en", audioFormat:"webm/opus", sampleRate:48000}
 * Client -> {type:"audio", data:"<base64 chunk>"}
 * Client -> {type:"stop"}
 *
 * Server -> {type:"hello"}
 * Server -> {type:"ready"}
 * Server -> {type:"stt", text:"...", final:true/false}
 * Server -> {type:"translation", text:"..."}
 * Server -> {type:"tts", mime:"audio/mpeg", data:"<base64 mp3>"}
 * Server -> {type:"error", message:"..."}
 */

// -------------------- Google credentials bootstrap --------------------
function ensureGoogleCredentialsFileFromEnv() {
  const json =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_CLOUD_CREDENTIALS;

  if (!json) {
    console.warn(
      "⚠️ Missing Google credentials JSON. Set GOOGLE_APPLICATION_CREDENTIALS_JSON in Railway."
    );
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;

  const filePath = path.join(os.tmpdir(), "gcp-creds.json");
  fs.writeFileSync(filePath, json, "utf8");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  console.log("✅ Google credentials file ready:", filePath);
}

ensureGoogleCredentialsFileFromEnv();

// -------------------- Clients --------------------
const speechClient = new SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

const deeplKey = process.env.DEEPL_API_KEY;
const deeplTranslator = deeplKey ? new deepl.Translator(deeplKey) : null;

// -------------------- Helpers --------------------
function mapToDeeplLang(lang) {
  const upper = String(lang || "").toUpperCase();
  if (upper === "EN") return "EN-US";
  return upper;
}

function mapToGoogleLang(lang) {
  const l = String(lang || "").toLowerCase();

  if (l === "fr") return "fr-FR";
  if (l === "en") return "en-US";
  if (l === "es") return "es-ES";
  if (l === "de") return "de-DE";
  if (l === "it") return "it-IT";
  if (l === "pt") return "pt-PT";
  if (l === "ar") return "ar-XA";
  if (l === "ja") return "ja-JP";
  if (l === "ko") return "ko-KR";
  if (l === "zh") return "cmn-CN";

  // if already xx-YY
  const parts = l.split("-");
  if (parts.length === 2) return `${parts[0]}-${parts[1].toUpperCase()}`;

  return `${l}-${l.toUpperCase()}`;
}

function normalizeAudioFormat(audioFormat) {
  const f = String(audioFormat || "").toLowerCase();
  if (f.includes("webm")) return "webm/opus";
  if (f.includes("ogg")) return "ogg/opus";
  if (f.includes("linear16") || f.includes("pcm")) return "linear16";
  return "webm/opus"; // default navigateur
}

function chooseSttEncoding(normalizedFormat) {
  if (normalizedFormat === "webm/opus") return "WEBM_OPUS";
  if (normalizedFormat === "ogg/opus") return "OGG_OPUS";
  if (normalizedFormat === "linear16") return "LINEAR16";
  return "WEBM_OPUS";
}

async function translateText(text, toLang) {
  if (!text || !text.trim()) return "";
  if (!deeplTranslator) return text;

  const target = mapToDeeplLang(toLang);
  const result = await deeplTranslator.translateText(text, null, target);
  return result?.text || "";
}

async function synthesizeTTS(text, toLang) {
  const languageCode = mapToGoogleLang(toLang);

  const request = {
    input: { text },
    voice: { languageCode },
    audioConfig: { audioEncoding: "MP3" },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  const audioContent = response.audioContent;

  return Buffer.isBuffer(audioContent)
    ? audioContent
    : Buffer.from(audioContent || "");
}

// -------------------- HTTP server --------------------
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, wsPath: "/ws" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// -------------------- WebSocket logic --------------------
wss.on("connection", (ws) => {
  const state = {
    started: false,
    from: "fr",
    to: "en",
    audioFormat: "webm/opus", // normalized
    sampleRate: 48000,
    sttStream: null,
    lastFinal: "",
    busy: false,
  };

  const send = (obj) => {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  };

  const closeStt = () => {
    try {
      if (state.sttStream) {
        state.sttStream.end();
        state.sttStream.removeAllListeners();
      }
    } catch {}
    state.sttStream = null;
  };

  const openStt = () => {
    closeStt();

    const languageCode = mapToGoogleLang(state.from);
    const encoding = chooseSttEncoding(state.audioFormat);

    // ✅ FIX IMPORTANT:
    // Pour WEBM_OPUS / OGG_OPUS, on évite d’imposer sampleRateHertz
    // car le conteneur Opus peut ne pas correspondre à la valeur annoncée.
    const config =
      encoding === "LINEAR16"
        ? {
            encoding,
            sampleRateHertz: Number(state.sampleRate || 16000),
            languageCode,
            enableAutomaticPunctuation: true,
          }
        : {
            encoding,
            languageCode,
            enableAutomaticPunctuation: true,
          };

    const request = { config, interimResults: true };

    state.sttStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => {
        send({
          type: "error",
          message: `STT error: ${String(err?.message || err)}`,
        });
      })
      .on("data", async (data) => {
        try {
          const result = data.results?.[0];
          const alt = result?.alternatives?.[0];
          const transcript = alt?.transcript || "";
          const isFinal = Boolean(result?.isFinal);

          if (transcript) {
            send({ type: "stt", text: transcript, final: isFinal });
          }

          // Final => translate + TTS
          if (isFinal && transcript && !state.busy) {
            if (transcript.trim() === state.lastFinal.trim()) return;
            state.lastFinal = transcript;

            state.busy = true;
            try {
              const translated = await translateText(transcript, state.to);
              if (translated) {
                send({ type: "translation", text: translated });

                const audioBuf = await synthesizeTTS(translated, state.to);
                send({
                  type: "tts",
                  mime: "audio/mpeg",
                  data: audioBuf.toString("base64"),
                });
              }
            } catch (e) {
              send({
                type: "error",
                message: `Translate/TTS error: ${String(e?.message || e)}`,
              });
            } finally {
              state.busy = false;
            }
          }
        } catch (e) {
          send({
            type: "error",
            message: `Handler error: ${String(e?.message || e)}`,
          });
        }
      });
  };

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "start") {
        state.from = msg.from || state.from;
        state.to = msg.to || state.to;
        state.audioFormat = normalizeAudioFormat(msg.audioFormat || state.audioFormat);
        state.sampleRate = Number(msg.sampleRate || state.sampleRate);

        state.started = true;
        openStt();
        send({ type: "ready" });
        return;
      }

      if (msg.type === "stop") {
        state.started = false;
        closeStt();
        send({ type: "stopped" });
        return;
      }

      if (msg.type === "audio") {
        if (!state.started || !state.sttStream) return;
        if (!msg.data) return;

        const buf = Buffer.from(msg.data, "base64");
        state.sttStream.write(buf);
        return;
      }
    } catch (e) {
      send({ type: "error", message: `Bad message: ${String(e?.message || e)}` });
    }
  });

  ws.on("close", () => {
    state.started = false;
    closeStt();
  });

  send({ type: "hello", message: "WS connected" });
});

// -------------------- Start server --------------------
const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`✅ Server listening on ${port}`);
});
