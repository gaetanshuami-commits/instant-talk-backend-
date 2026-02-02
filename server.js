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

// ================= CONFIG =================

const PORT = process.env.PORT || 8080
const OPENAI_KEY = process.env.OPENAI_API_KEY
const DEEPL_KEY = process.env.DEEPL_API_KEY

if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY missing')
if (!DEEPL_KEY) throw new Error('DEEPL_API_KEY missing')

// ================= INIT =================

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const openai = new OpenAI({ apiKey: OPENAI_KEY })

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

console.log('✅ WebSocket path registered: /ws')

// ================= HELPERS =================

async function translateDeepL(text, from, to) {
  const res = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      text,
      source_lang: from.toUpperCase(),
      target_lang: to.toUpperCase()
    })
  })

  const json = await res.json()
  return json.translations?.[0]?.text
}

// ================= WS HANDLER =================

wss.on('connection', (ws) => {

  console.log('🔌 Client WebSocket connecté')

  let session = {
    from: 'fr',
    to: 'en'
  }

  ws.on('message', async (msg) => {

    try {
      const data = JSON.parse(msg.toString())

      // ================= START =================

      if (data.type === 'start') {
        session.from = data.from || 'fr'
        session.to = data.to || 'en'

        console.log('▶ SESSION', session.from, '→', session.to)

        ws.send(JSON.stringify({ type: 'ready' }))
        return
      }

      // ================= AUDIO =================

      if (data.type === 'audio') {

        // Decode base64 audio
        const audioBuffer = Buffer.from(data.data, 'base64')
        const tempFile = `/tmp/${Date.now()}.webm`

        fs.writeFileSync(tempFile, audioBuffer)

        // ---------- STT (Whisper) ----------

        const transcript = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1',
          language: session.from
        })

        fs.unlinkSync(tempFile)

        if (!transcript.text) return

        // Send STT
        ws.send(JSON.stringify({
          type: 'stt',
          text: transcript.text,
          final: true
        }))

        // ---------- TRANSLATION ----------

        const translated = await translateDeepL(
          transcript.text,
          session.from,
          session.to
        )

        ws.send(JSON.stringify({
          type: 'translation',
          text: translated
        }))

        // ---------- TTS ----------

        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translated
        })

        const audioOut = Buffer.from(await tts.arrayBuffer()).toString('base64')

        ws.send(JSON.stringify({
          type: 'tts',
          data: audioOut
        }))

        return
      }

      // ================= STOP =================

      if (data.type === 'stop') {
        console.log('⏹ Session stopped')
        return
      }

    } catch (err) {

      console.error('❌ WS error:', err)

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

// ================= START SERVER =================

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})
