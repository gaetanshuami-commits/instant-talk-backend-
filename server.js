import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'
import * as deepl from 'deepl-node'

dotenv.config()

const { OPENAI_API_KEY, DEEPL_API_KEY, PORT } = process.env
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY')
if (!DEEPL_API_KEY) throw new Error('Missing DEEPL_API_KEY')

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

app.get('/', (_, res) => res.send('Instant Talk backend alive ✅'))
app.get('/health', (_, res) => {
  res.json({ status: 'ok', wsPath: '/ws', timestamp: Date.now() })
})

const server = http.createServer(app)

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const translator = new deepl.Translator(DEEPL_API_KEY)

const wss = new WebSocketServer({
  server,
  path: '/ws'
})

console.log('✅ WebSocket server ready on /ws')

wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  let from = 'fr'
  let to = 'en'
  let busy = false

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString())
      if (!data?.type) return

      if (data.type === 'start') {
        from = data.from || 'fr'
        to = data.to || 'en'
        console.log(`▶ START session ${from} → ${to}`)
        ws.send(JSON.stringify({ type: 'ready' }))
        return
      }

      if (data.type === 'audio') {
        if (busy) {
          ws.send(JSON.stringify({ type: 'info', message: 'busy_skip_chunk' }))
          return
        }
        busy = true

        const b64 = data.data || data.audio
        if (!b64) {
          busy = false
          return
        }

        const buffer = Buffer.from(b64, 'base64')
        const file = `/tmp/audio-${Date.now()}.webm`
        fs.writeFileSync(file, buffer)

        const stt = await openai.audio.transcriptions.create({
          file: fs.createReadStream(file),
          model: 'whisper-1',
          language: from
        })

        fs.unlinkSync(file)

        const text = stt?.text?.trim()
        if (!text) {
          busy = false
          ws.send(JSON.stringify({ type: 'error', message: 'STT empty' }))
          return
        }

        ws.send(JSON.stringify({ type: 'stt', text }))

        const translated = await translator.translateText(
          text,
          from.toUpperCase(),
          to.toUpperCase()
        )

        ws.send(JSON.stringify({
          type: 'translation',
          text: translated.text
        }))

        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translated.text
        })

        const audioBuffer = Buffer.from(await tts.arrayBuffer())
        ws.send(JSON.stringify({
          type: 'tts',
          audio: audioBuffer.toString('base64')
        }))

        busy = false
      }

      if (data.type === 'stop') {
        console.log('⏹ STOP session')
        busy = false
      }
    } catch (err) {
      busy = false
      console.error('❌ ERROR', err)
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message || 'server_error'
      }))
    }
  })

  ws.on('close', () => console.log('👋 Client disconnected'))
})

const listenPort = Number(PORT) || 8080
server.listen(listenPort, () => {
  console.log(`🚀 Server listening on ${listenPort}`)
})
