import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'
import * as deepl from 'deepl-node'

dotenv.config()

// ================= ENV CHECK =================

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing")
  process.exit(1)
}

if (!process.env.DEEPL_API_KEY) {
  console.error("❌ DEEPL_API_KEY missing")
  process.exit(1)
}

// ================= INIT =================

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const PORT = process.env.PORT || 8080

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const translator = new deepl.Translator(process.env.DEEPL_API_KEY)

// ================= HEALTH =================

app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    wsPath: "/ws",
    timestamp: Date.now()
  })
})

// ================= WEBSOCKET =================

const wss = new WebSocketServer({
  server,
  path: "/ws"
})

console.log("✅ WebSocket ready on /ws")

wss.on("connection", (ws) => {

  console.log("🔌 Client connected")

  let session = {
    from: "fr",
    to: "en"
  }

  ws.on("message", async (msg) => {

    try {

      const data = JSON.parse(msg.toString())

      // ---------- START ----------

      if (data.type === "start") {

        session.from = data.from || "fr"
        session.to = data.to || "en"

        console.log(`▶ SESSION ${}

${session.from} -> ${session.to}`)

        ws.send(JSON.stringify({
          type: "ready"
        }))

        return
      }

      // ---------- AUDIO ----------

      if (data.type === "audio") {

        if (!data.data) return

        const audioBuffer = Buffer.from(data.data, "base64")

        const tempFile = `/tmp/audio-${Date.now()}.webm`
        fs.writeFileSync(tempFile, audioBuffer)

        // ===== STT Whisper =====

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: "whisper-1",
          language: session.from
        })

        fs.unlinkSync(tempFile)

        if (!transcription.text) return

        ws.send(JSON.stringify({
          type: "stt",
          text: transcription.text
        }))

        // ===== TRANSLATION =====

        const result = await translator.translateText(
          transcription.text,
          session.from.toUpperCase(),
          session.to.toUpperCase()
        )

        ws.send(JSON.stringify({
          type: "translation",
          text: result.text
        }))

        // ===== TTS =====

        const speech = await openai.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: result.text
        })

        const ttsBuffer = Buffer.from(await speech.arrayBuffer())
        const ttsBase64 = ttsBuffer.toString("base64")

        ws.send(JSON.stringify({
          type: "tts",
          data: ttsBase64
        }))

        return
      }

      // ---------- STOP ----------

      if (data.type === "stop") {
        console.log("⏹ Session stopped")
      }

    } catch (err) {

      console.error("❌ Pipeline error:", err)

      ws.send(JSON.stringify({
        type: "error",
        message: err.message
      }))
    }

  })

  ws.on("close", () => {
    console.log("👋 Client disconnected")
  })

})

// ================= START SERVER =================

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
