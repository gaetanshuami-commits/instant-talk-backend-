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
 * ENV attendues (Railway):
 * - PORT (Railway le fournit)
 * - DEEPL_API_KEY
 * - GOOGLE_APPLICATION_CREDENTIALS_JSON  (recommandé)  OU  GOOGLE_APPLICATION_CREDENTIALS (chemin fichier) OU (ton ancienne variable)
 *
 * Important:
 * Sur Railway, le plus simple est de coller le JSON de service account dans GOOGLE_APPLICATION_CREDENTIALS_JSON.
 */

// --- Google credentials helper (JSON en variable) ---
function ensureGoogleCredentialsFileFromEnv() {
  // Supporte plusieurs noms possibles (vu ta variable tronquée dans Railway)
  const json =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_STRING ||
    process.env.GOOGLE_APPLICATION_CREDENTIALIALS_JSON || // faute possible
    process.env.GOOGLE_APPLICATION_CREDENTIALIALS ||      // vu dans ta capture (tronqué)
    process.env.GOOGLE_APPLICATION_CREDENTIALS_INLINE;

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && json) {
    const filePath = path.join(os.tmpdir(), "gcp-creds.json");
    fs.writeFileSync(filePath, json, "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
  }
}

ensureGoogleCredentialsFileFromEnv();

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true, wsPath: "/ws" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// --- Clients ---
const speechClient = new SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

const deeplKey = process.env.DEEPL_API_KEY;
const deeplTranslator = deeplKey ? new deepl.Translator(deeplKey) : null;

function mapToDeeplLang(lang) {
  // DeepL attend souvent des codes spécifiques (ex: EN-US, EN-GB)
  // Ici on garde simple. Tu peux enrichir.
  const upper = String(lang || "").toUpperCase();
  if (upper === "EN") return "EN-US";
  return upper;
}

function mapToGoogleLang(lang) {
  // Google STT/TTS attend plutôt "fr-FR", "en-US", etc.
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
  // fallback: tente xx-XX
  const parts = l.split("-");
  if (parts.length === 2) return `${parts[0]}-${parts[1].toUpperCase()}`;
  return `${l}-${l.toUpperCase()}`;
}

function chooseSttEncoding(audioFormat) {
  // Tu envoies des chunks base64: souvent MediaRecorder => webm/opus.
  // Google STT supporte WEBM_OPUS / OGG_OPUS en streaming.
  // Sinon PCM brut => LINEAR16.
  const f = String(audioFormat || "").toLowerCase();

  if (f.includes("webm")) return "WEBM_OPUS";
  if (f.includes("ogg")) return "OGG_OPUS";
  if (f.includes("linear16") || f.includes("pcm")) return "LINEAR16";

  // défaut: webm opus (le plus probable dans un navigateur)
  return "WEBM_OPUS";
}

function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

async function translateText(text, fromLang, toLang) {
  if (!text || !text.trim()) return "";
  if (!deeplTranslator) return text; // fallback: pas de DeepL => renvoie le texte brut

  // DeepL auto-detect possible, mais on passe le target
  const target = mapToDeeplLang(toLang);

  // Optional: sourceLang (si tu veux forcer)
  // const source = mapToDeeplLang(fromLang);

  const result = await deeplTranslator.translateText(text, null, target);
  return result?.text || "";
}

async function synthesizeTTS(text, toLang) {
  // Sortie audio: MP3 (facile à jouer partout)
  const languageCode = mapToGoogleLang(toLang);

  const request = {
    input: { text },
    voice: { languageCode }, // tu peux choisir une voix plus tard
    audioConfig: { audioEncoding: "MP3" }
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  const audioContent = response.audioContent; // Buffer
  return Buffer.isBuffer(audioContent) ? audioContent : Buffer.from(audioContent || []);
}

/**
 * PROTOCOLE WS:
 * 1) client -> {"type":"start","from":"fr","to":"en","audioFormat":"webm/opus","sampleRate":48000}
 * 2) client -> {"type":"audio","data":"<base64>"}
 * 3) server -> {"type":"stt","text":"...","final":true}
 * 4) server -> {"type":"translation","text":"..."}
 * 5) server -> {"type":"tts","mime":"audio/mpeg","data":"<base64 mp3>"}
 * 6) client -> {"type":"stop"}
 */

wss.on("connection", (ws) => {
  const state = {
    started: false,
    from: "fr",
    to: "en",
    audioFormat: "webm/opus",
    sampleRate: 48000,
    sttStream: null,
    lastFinalText: "",
    isProcessingFinal: false
  };

  function safeSend(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function closeSttStream() {
    try {
      if (state.sttStream) {
        state.sttStream.end();
        state.sttStream.removeAllListeners();
        state.sttStream = null;
      }
    } catch {
      state.sttStream = null;
    }
  }

  function startSttStream() {
    closeSttStream();

    const encoding = chooseSttEncoding(state.audioFormat);
    const languageCode = mapToGoogleLang(state.from);

    const request = {
      config: {
        encoding,
        sampleRateHertz: state.sampleRate,
        languageCode,
        enableAutomaticPunctuation: true
      },
      interimResults: true
    };

    const recognizeStream = speechClient
      .streamingRecognize(request)
      .on("error", (err) => {
        safeSend({ type: "error", message: `STT error: ${String(err?.message || err)}` });
      })
      .on("data", async (data) => {
        try {
          const result = data.results?.[0];
          const alt = result?.alternatives?.[0];
          const transcript = alt?.transcript || "";
          const isFinal = Boolean(result?.isFinal);

          if (transcript) {
            safeSend({ type: "stt", text: transcript, final: isFinal });
          }

          // Quand final -> traduction + TTS
          if (isFinal && transcript && !state.isProcessingFinal) {
            // évite doublons
            if (transcript.trim() === state.lastFinalText.trim()) return;
            state.lastFinalText = transcript;

            state.isProcessingFinal = true;
            try {
              const translated = await translateText(transcript, state.from, state.t
