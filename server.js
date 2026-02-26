// wsPipeline.js
// Branch this into your ws connection handler.
// Assumes you already have OpenAI + DeepL clients wired.

const MIN_AUDIO_MS = 420;
const MAX_AUDIO_MS = 8000; // safety
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // Int16

function audioMsFromBytes(byteLen) {
  const samples = byteLen / BYTES_PER_SAMPLE;
  return (samples / SAMPLE_RATE) * 1000;
}

function isSuspectText(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;

  // too short
  if (t.length < 2) return true;

  // must contain at least one letter (latin or extended). This filters "??" or random symbols.
  const hasLetter = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-Яа-я一-龯ぁ-ゟァ-ヿ]/.test(t);
  if (!hasLetter) return true;

  // blacklist typical hallucinations for short/noisy segments
  const lower = t.toLowerCase();
  const blacklist = new Set(["you", "boing", "boing boing", "thanks", "thank you"]);
  if (blacklist.has(lower)) return true;

  return false;
}

/**
 * @param {WebSocket} ws
 * @param {object} deps - your dependencies (openai, deepl, tts)
 */
function createWsPipeline(ws, deps) {
  let config = { fromLang: "en", toLang: "fr", mode: "continuous" };
  let audioChunks = [];
  let audioBytes = 0;

  function send(obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function resetBuffer() {
    audioChunks = [];
    audioBytes = 0;
  }

  async function runPipeline() {
    const totalMs = audioMsFromBytes(audioBytes);

    if (totalMs < MIN_AUDIO_MS) {
      send({ type: "stt", skipped: true, reason: "audio_too_short", audioMs: Math.round(totalMs) });
      resetBuffer();
      return;
    }
    if (totalMs > MAX_AUDIO_MS) {
      send({ type: "stt", skipped: true, reason: "audio_too_long", audioMs: Math.round(totalMs) });
      resetBuffer();
      return;
    }

    // Merge audio
    const merged = Buffer.concat(audioChunks, audioBytes);
    resetBuffer();

    try {
      // 1) STT
      const sttText = await deps.stt(merged, config.fromLang); // implement deps.stt
      if (!sttText || !sttText.trim()) {
        send({ type: "stt", skipped: true, reason: "stt_empty" });
        return;
      }
      if (isSuspectText(sttText)) {
        send({ type: "stt", skipped: true, reason: "stt_suspect", text: sttText });
        return;
      }
      send({ type: "stt", text: sttText });

      // 2) Translation (DeepL priority)
      const translated = await deps.translate(sttText, config.fromLang, config.toLang); // implement deps.translate
      if (!translated || !translated.trim()) {
        send({ type: "error", code: "TRANSL_EMPTY", message: "Translation returned empty text" });
        return;
      }
      send({ type: "translation", text: translated });

      // 3) TTS
      const mp3Base64 = await deps.tts(translated, config.toLang); // implement deps.tts
      if (!mp3Base64) {
        send({ type: "error", code: "TTS_EMPTY", message: "TTS returned empty audio" });
        return;
      }
      send({ type: "tts", audioB64: mp3Base64 });
    } catch (err) {
      send({ type: "error", code: "PIPELINE_ERROR", message: err?.message || "Unknown pipeline error" });
    }
  }

  ws.on("message", async (data, isBinary) => {
    try {
      if (!isBinary) {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "config") {
          config = {
            fromLang: String(msg.fromLang || "en"),
            toLang: String(msg.toLang || "fr"),
            mode: msg.mode === "push_to_talk" ? "push_to_talk" : "continuous",
          };
          return;
        }
        if (msg.type === "reset") {
          resetBuffer();
          return;
        }
        if (msg.type === "flush") {
          // flush boundary: run STT/translation/TTS on current buffer
          if (audioBytes > 0) await runPipeline();
          return;
        }
        return;
      }

      // Binary PCM chunk
      const buf = Buffer.from(data);
      audioChunks.push(buf);
      audioBytes += buf.length;

      // Optional: if you want auto-run when buffer large
      const totalMs = audioMsFromBytes(audioBytes);
      if (config.mode === "continuous" && totalMs >= 1500) {
        await runPipeline();
      }
    } catch (err) {
      send({ type: "error", code: "WS_MSG_ERROR", message: err?.message || "WS message error" });
    }
  });

  ws.on("close", () => {
    resetBuffer();
  });
}

module.exports = { createWsPipeline };
