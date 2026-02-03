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
app.use(express.json({ limit: '2mb' }))

app.get('/', (req, res) => res.send('Instant Talk backend alive ✅'))
app.get('/health', (req, res) => {
  res.json({ status: 'ok', wsPath: '/ws', timestamp: Date.now() })
})

const server = http.createServer(app)

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const translator = new deepl.Translator(DEEPL_API_KEY)

const wss = new WebSocketServer({ server, path: '/ws' })
console.log('✅ WebSocket ready on /ws')

wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  const sessionConfig = { from: 'fr', to: 'en' }

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString())
      if (!data?.type) return

      if (data.type === 'start') {
        sessionConfig.from = data.from || 'fr'
        sessionConfig.to = data.to || 'en'
        console.log('▶ Session start', sessionConfig)
        ws.send(JSON.stringify({ type: 'ready' }))
        return
      }

      if (data.type === 'audio') {
        const b64 = data.data || data.audio
        if (!b64) return

        const audioBuffer = Buffer.from(b64, 'base64')
        const tempFile = `/tmp/audio-${Date.now()}.webm`
        fs.writeFileSync(tempFile, audioBuffer)

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1',
          language: sessionConfig.from
        })

        fs.unlinkSync(tempFile)

        const originalText = transcription?.text?.trim()
        if (!originalText) {
          ws.send(JSON.stringify({ type: 'error', message: 'STT failed' }))
          return
        }

        ws.send(JSON.stringify({ type: 'stt', text: originalText, final: true }))

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

        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translatedText
        })

        const ttsBuffer = Buffer.from(await tts.arrayBuffer())
        ws.send(JSON.stringify({ type: 'tts', audio: ttsBuffer.toString('base64') }))
        return
      }

      if (data.type === 'stop') {
        console.log('⏹ Session stop')
        return
      }
    } catch (err) {
      console.error('❌ Pipeline error', err)
      ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Unknown error' }))
    }
  })

  ws.on('close', () => console.log('👋 Client disconnected'))
})

server.listen(Number(PORT) || 8080, () => {
  console.log(`🚀 Server running on ${Number(PORT) || 8080}`)
})
