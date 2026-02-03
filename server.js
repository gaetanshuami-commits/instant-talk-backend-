import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'
import * as deepl from 'deepl-node'

dotenv.config()

// ================= ENV GUARDS =================

const { OPENAI_API_KEY, DEEPL_API_KEY, PORT } = process.env

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY')
  process.exit(1)
}

if (!DEEPL_API_KEY) {
  console.error('❌ Missing DEEPL_API_KEY')
  process.exit(1)
}

// ================= APP INIT =================

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

app.get('/', (req, res) => res.send('Instant Talk backend alive ✅'))
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    wsPath: '/ws',
    timestamp: Date.now()
  })
})

const server = http.createServer(app)
const listenPort = Number(PORT) || 8080

// ================= CLIENTS =================

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const translator = new deepl.Translator(DEEPL_API_KEY)

// ================= HELPERS =================

function safeSend(ws, payload) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  } catch {
    // ignore
  }
}

function safeUnlink(path) {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path)
  } catch {
    // ignore
  }
}

function normalizeLang(code, fallback) {
  if (!code || typeof code !== 'string') return fallback
  return code.toLowerCase().trim()
}

function toDeepLLang(code) {
  // DeepL attend souvent des codes en MAJUSCULES (ex: EN, FR, DE, ES)
  // Pour variantes: EN-GB, EN-US si tu veux (plus tard).
  return String(code || '').toUpperCase()
}

// ================= WEBSOCKET =================

const wss = new WebSocketServer({
  server,
  path: '/ws'
})

console.log('✅ WebSocket ready on /ws')

wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  const sessionConfig = {
    from: 'fr',
    to: 'en'
  }

  let isBusy = false // évite d’empiler 20 requêtes STT si le client envoie trop vite

  safeSend(ws, { type: 'ready' })

  ws.on('message', async (raw) => {
    let data

    try {
      data = JSON.parse(raw.toString())
    } catch (e) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON' })
      return
    }

    if (!data?.type) return

    // ---------- START ----------
    if (data.type === 'start') {
      sessionConfig.from = normalizeLang(data.from, 'fr')
      sessionConfig.to = normalizeLang(data.to, 'en')

      console.log('▶ Session start', sessionConfig)
      safeSend(ws, { type: 'ready' })
      return
    }

    // ---------- STOP ----------
    if (data.type === 'stop') {
      console.log('⏹ Session stop')
      return
    }

    // ---------- AUDIO ----------
    if (data.type === 'audio') {
      // Accepte data.data OU data.audio (compat front)
      const b64 = data.data || data.audio
      if (!b64) return

      // Anti-emballement (MVP stable)
      if (isBusy) {
        safeSend(ws, { type: 'info', message: 'busy_skip_chunk' })
        return
      }

      isBusy = true
      const tempFile = `/tmp/audio-${Date.now()}.webm`

      try {
        const audioBuffer = Buffer.from(b64, 'base64')
        fs.writeFileSync(tempFile, audioBuffer)

        // ===== STT Whisper =====
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1',
          language: sessionConfig.from
        })

        const originalText = transcription?.text?.trim()
        if (!originalText) {
          safeSend(ws, { type: 'error', message: 'STT failed' })
          return
        }

        safeSend(ws, {
          type: 'stt',
          text: originalText,
          final: true,
          sourceLang: sessionConfig.from
        })

        // ===== DeepL =====
        const translated = await translator.translateText(
          originalText,
          toDeepLLang(sessionConfig.from),
          toDeepLLang(sessionConfig.to)
        )

        const translatedText = translated?.text?.trim()
        if (!translatedText) {
          safeSend(ws, { type: 'error', message: 'Translation failed' })
          return
        }

        safeSend(ws, {
          type: 'translation',
          text: translatedText,
          sourceLang: sessionConfig.from,
          targetLang: sessionConfig.to
        })

        // ===== TTS OpenAI =====
        const tts = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'alloy',
          input: translatedText
        })

        const ttsBuffer = Buffer.from(await tts.arrayBuffer())

        safeSend(ws, {
          type: 'tts',
          audio: ttsBuffer.toString('base64'),
          format: 'mp3'
        })
      } catch (err) {
        console.error('❌ Pipeline error', err)
        safeSend(ws, {
          type: 'error',
          message: err?.message || 'Unknown error'
        })
      } finally {
        safeUnlink(tempFile)
        isBusy = false
      }

      return
    }
  })

  ws.on('close', () => console.log('👋 Client disconnected'))
  ws.on('error', (e) => console.error('❌ WS error', e?.message || e))
})

// ================= HARDENING =================

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err)
  // option: process.exit(1)
})

// ================= SERVER =================

server.listen(listenPort, () => {
  console.log(`🚀 Server running on ${listenPort}`)
})
