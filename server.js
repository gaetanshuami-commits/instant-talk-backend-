// ===============================
// 🎤 STT + 🔊 TTS – Instant Talk
// ===============================

// -------- CONFIG --------
const BACKEND_TTS_URL =
  "https://instant-talk-backend-production.up.railway.app/tts";

// -------- STT (Speech to Text) --------
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  console.error("❌ SpeechRecognition non supporté par ce navigateur");
} else {
  const rec = new SpeechRecognition();

  rec.lang = "fr-FR";
  rec.interimResults = true;
  rec.continuous = true;

  let isSpeaking = false;
  let restartTimeout = null;

  rec.onstart = () => {
    console.log("🎤 STT démarré : parle maintenant");
  };

  rec.onresult = (e) => {
    let finalText = "";
    let interimText = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interimText += t;
    }

    if (interimText) {
      console.log("🟡 interim:", interimText);
    }

    if (finalText) {
      console.log("🟢 final:", finalText);
      speak(finalText);
    }
  };

  rec.onerror = (e) => {
    console.log("❌ erreur STT:", e.error);

    // on évite les boucles infinies
    if (e.error === "no-speech") {
      try {
        rec.stop();
      } catch {}
    }
  };

  rec.onend = () => {
    console.log("🔁 STT relancé (attente)");
    clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      try {
        rec.start();
      } catch {}
    }, 1500); // délai important
  };

  // Démarrage
  try {
    rec.start();
  } catch {}
}

// -------- TTS (Text to Speech via backend) --------
function speak(text) {
  if (!text || text.trim().length === 0) return;

  fetch(BACKEND_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice: "alloy",
    }),
  })
    .then((r) => r.blob())
    .then((blob) => {
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.play();
      console.log("🔊 TTS audio joué");
    })
    .catch((err) => {
      console.error("❌ Erreur TTS:", err);
    });
}

// -------- TEST MICRO --------
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then(() => console.log("🎙️ Micro autorisé OK"))
  .catch((e) =>
    console.error("❌ Micro bloqué:", e.name, e.message)
  );
