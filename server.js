// =======================
// 🎤 SPEECH TO TEXT (STT)
// =======================

window.SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (!window.SpeechRecognition) {
  console.error("❌ SpeechRecognition non supporté");
} else {
  const rec = new SpeechRecognition();

  rec.lang = "fr-FR";
  rec.interimResults = true;
  rec.continuous = true;

  let isManuallyStopped = false;

  // 🎧 Résultats
  rec.onresult = (e) => {
    let finalText = "";
    let interim = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalText += text;
      } else {
        interim += text;
      }
    }

    if (interim) {
      console.log("🟡 interim :", interim);
    }

    if (finalText) {
      console.log("🟢 final :", finalText);

      // 👉 ICI tu brancheras la traduction + TTS plus tard
      // sendToTranslate(finalText)
    }
  };

  // ❌ Erreurs
  rec.onerror = (e) => {
    console.log("❌ erreur STT :", e.error);

    if (e.error === "no-speech") {
      try {
        rec.stop();
      } catch {}
    }
  };

  // 🔁 Relance automatique PROPRE
  rec.onend = () => {
    if (isManuallyStopped) return;

    console.log("🔁 STT relancé...");
    setTimeout(() => {
      try {
        rec.start();
      } catch {}
    }, 1200); // délai important
  };

  // ▶️ Démarrage
  try {
    rec.start();
    console.log("🎤 STT démarré : parle maintenant");
  } catch (e) {
    console.error("❌ Impossible de démarrer STT", e);
  }

  // Expose pour debug si besoin
  window.__stt = {
    stop: () => {
      isManuallyStopped = true;
      rec.stop();
      console.log("⏹️ STT arrêté manuellement");
    },
    start: () => {
      isManuallyStopped = false;
      rec.start();
      console.log("▶️ STT relancé manuellement");
    }
  };
}
