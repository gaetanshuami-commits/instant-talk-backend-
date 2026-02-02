import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const server = http.createServer(app)

const PORT = process.env.PORT || 8080

// ================= OPENAI =================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

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
  console.log('🔌 Client connecté')

  let sessionConfig = {
    from: 'fr',
    to: 'en'
  }

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString())

      // ================= START =================

      if (data.type === 'start') {
        sessionConfig.from = data.from || 'fr'
        sessionConfig.to = data.to || 'en'

        ws.send(JSON.stringify({ type: 'ready' }))
        return
      }

      // ================= AUDIO PIPELINE =================

      if (data.type === 'audio') {

        const audioBase64 = data.data
        if (!audioBase64) return

        const audioBuffer = Buffer.from(audioBase64, 'base64')

        const tempFile = `/tmp/audio-${Date.now()}.webm`
        fs.writeFileSync(tempFile, audioBuffer)

        // ---------- SPEECH TO TEXT ----------

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1'
        })

        const text = transcription.text

        ws.send(JSON.stringify({
          type: 'stt',
          text,
          final: true
        }))

        // ---------- TRANSLATION (DeepL REST) ----------

        const deeplRes = await fetch('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            auth_key: process.env.DEEPL_API_KEY,
            text,
            source_lang: sessionConfig.from.toUpperCase(),
            target_lang: sessionConfig.to.toUpperCase()
          })
        })

        const deeplJson = await deeplRes.json()
        const translatedText = deeplJson.translations[0].text

        ws.send(JSON.stringify({
          type: 'translation',
          text: translatedText,
          sourceLang: sessionConfig.from,
          targetLang: sessionConfig.to
        }))

        // ---------- TTS ----------

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

        fs.unlinkSync(tempFile)
      }

    } catch (err) {
      console.error('❌ WS ERROR', err)

      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }))
    }
  })

  ws.on('close', () => {
    console.log('❎ Client déconnecté')
  })
})

// ================= SERVER START =================

server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
})
