import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import fetch from 'node-fetch'
import OpenAI from 'openai'

dotenv.config()

// ================= INIT =================

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)

const PORT = process.env.PORT || 8080
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ================= HEALTH CHECK =================

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

  ws.on('message', async (msg) => {
    try {

      const data = JSON.parse(msg.toString())
      if (!data.type) return

      // ================= START =================

      if (data.type === 'start') {

        sessionConfig.from = data.from || 'fr'
        sessionConfig.to = data.to || 'en'

        console.log(`▶ SESSION START ${sessionConfig.from} → ${sessionConfig.to}`)

        ws.send(JSON.stringify({
          type: 'ready'
        }))

        return
      }

      // ================= AUDIO =================

      if (data.type === 'audio') {

        if (!data.data) return

        // ---- TEMP: PIPELINE SIMULATION ----
        // (STT Whisper streaming temps réel = étape suivante)
        const fakeText = 'Audio reçu'

        // ---- TRANSLATION DeepL ----
        const deeplResponse = await fetch(
          'https://api-free.deepl.com/v2/translate',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              auth_key: process.env.DEEPL_API_KEY,
              text: fakeText,
              target_lang: sessionConfig.to.toUpperCase()
            })
          }
        )

        const deeplJson = await deeplResponse.json()

        const translatedText =
          deeplJson?.translations?.[0]?.text || fakeText

        // SEND TRANSLATION TEXT
        ws.send(JSON.stringify({
          type: 'translation',
          text: translatedText,
          sourceLang: sessionConfig.from,
          targetLang: sessionConfig.to
        }))

        // ---- TTS OPENAI ----

        const speech = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translatedText
        })

        const buffer = Buffer.from(await speech.arrayBuffer())
        const base64Audio = buffer.toString('base64')

        ws.send(JSON.stringify({
          type: 'tts',
          data: base64Audio
        }))

        return
      }

      // ================= STOP =================

      if (data.type === 'stop') {
        console.log('⏹ SESSION STOPPED')
        return
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
    console.log('❎ Client disconnected')
  })

})

// ================= START SERVER =================

server.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`)
})
