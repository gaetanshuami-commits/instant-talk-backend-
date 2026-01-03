ws.on("message", (message) => {
  try {
    const data = JSON.parse(message.toString());

    // Réception des chunks audio depuis le frontend
    if (data.type === "audio_chunk") {
      ws.send(
        JSON.stringify({
          type: "ack",
          receivedBytes: data.audioChunk ? data.audioChunk.length : 0,
          targetLang: data.targetLang || null
        })
      );
      return;
    }

    // Fallback : echo simple
    ws.send(
      JSON.stringify({
        type: "echo",
        echo: data
      })
    );
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Invalid JSON"
      })
    );
  }
});
