import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'
import * as deepl from 'deepl-node'

dotenv.config()

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
    status: 'ok',
    wsPath: '/ws',
    timestamp: Date.now()
  })
})

// ================= WEBSOCKET =================

const wss = new WebSocketServer({
  server,
  path: '/ws'
})

console.log('✅ WebSocket ready on /ws')

wss.on('connection', (ws) => {

  console.log('🔌 Client connected')

  let sessionConfig = {
    from: 'fr',
    to: 'en'
  }

  ws.on('message', async (raw) => {

    try {

      const data = JSON.parse(raw.toString())

      if (!data?.type) return

      // ---------- START ----------

      if (data.type === 'start') {

        sessionConfig.from = data.from || 'fr'
        sessionConfig.to = data.to || 'en'

        console.log('▶ Session start', sessionConfig)

        ws.send(JSON.stringify({ type: 'ready' }))

        return
      }

      // ---------- AUDIO ----------

      if (data.type === 'audio') {

        if (!data.data) return

        const audioBuffer = Buffer.from(data.data, 'base64')

        const tempFile = `/tmp/audio-${Date.now()}.webm`

        fs.writeFileSync(tempFile, audioBuffer)

        // ===== STT Whisper =====

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1',
          language: sessionConfig.from
        })

        fs.unlinkSync(tempFile)

        if (!transcription?.text) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'STT failed'
          }))
          return
        }

        const originalText = transcription.text

        ws.send(JSON.stringify({
          type: 'stt',
          text: originalText,
          final: true
        }))

        // ===== DeepL =====

        const translated = await translator.translateText(
          originalText,
          sessionConfig.from.toUpperCase(),
          sessionConfig.to.toUpperCase()
        )

        const translatedText = translated.text

        ws.send(JSON.stringify({
          type: 'translation',
          text: translatedText,
          sourceLang: sessionConfig.from,
          targetLang: sessionConfig.to
        }))

        // ===== TTS OpenAI =====

        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translatedText
        })

        const ttsBuffer = Buffer.from(await tts.arrayBuffer())

        ws.send(JSON.stringify({
          type: 'tts',
          data: ttsBuffer.toString('base64')
        }))

        return
      }

      // ---------- STOP ----------

      if (data.type === 'stop') {
        console.log('⏹ Session stop')
      }

    } catch (err) {

      console.error('❌ Pipeline error', err)

      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }))
    }

  })

  ws.on('close', () => {
    console.log('👋 Client disconnected')
  })

})

// ================= SERVER =================

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`)
})
