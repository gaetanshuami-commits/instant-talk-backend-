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
if (!DEEPL_API_KEY) console.warn('⚠️ Missing DEEPL_API_KEY (translation will fallback to OpenAI)')

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/', (_, res) => res.send('Instant Talk backend alive ✅'))
app.get('/health', (_, res) => res.json({ status: 'ok', wsPath: '/ws', timestamp: Date.now() }))

const server = http.createServer(app)

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const translator = DEEPL_API_KEY ? new deepl.Translator(DEEPL_API_KEY) : null

const wss = new WebSocketServer({ server, path: '/ws' })
console.log('✅ WebSocket server ready on /ws')

// ---------- Helpers ----------
function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  } catch {}
}

function mapDeeplTargetLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  if (l === 'en' || l === 'en-us' || l === 'en-gb') return 'EN-US' // change to EN-GB if desired
  return l.toUpperCase()
}

function mapDeeplSourceLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  if (l === 'en-us' || l === 'en-gb') return 'EN'
  return l.toUpperCase()
}

async function translateWithOpenAI({ text, from, to }) {
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Translate from ${from} to ${to}. Output only the translated text.` },
      { role: 'user', content: text }
    ],
    temperature: 0.2
  })
  return (r.choices?.[0]?.message?.content || '').trim()
}

// ---------- WAV helper (PCM Int16 LE) ----------
function writeWavFileFromPcmInt16LE({ pcmInt16, sampleRate, channels, filePath }) {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcmInt16.length * bytesPerSample
  const headerSize = 44

  const buffer = Buffer.alloc(headerSize + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)

  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)

  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < pcmInt16.length; i++) {
    buffer.writeInt16LE(pcmInt16[i], headerSize + i * 2)
  }

  fs.writeFileSync(filePath, buffer)
}

function nowMs() {
  return Date.now()
}

wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  // Session config
  let from = 'fr'
  let to = 'en'
  let sampleRate = 16000
  let channels = 1

  // Audio buffer
  let pcmChunks = []
  let totalSamples = 0

  // Stability / state
  let busy = false
  let sessionActive = false
  let lastProcessAt = 0

  // Limits (stability)
  const MIN_SECONDS_TO_PROCESS = 0.4          // ignore ultra short
  const PROCESS_COOLDOWN_MS = 700             // anti spam flush
  const MAX_SECONDS_BUFFER = 12               // prevent memory blow
  const MAX_SAMPLES_BUFFER = sampleRate * MAX_SECONDS_BUFFER

  safeSend(ws, { type: 'ready' })

  async function processBuffer(reason) {
    if (busy) return
    if (!sessionActive) return

    const ms = nowMs()
    if (ms - lastProcessAt < PROCESS_COOLDOWN_MS) {
      safeSend(ws, { type: 'info', message: 'cooldown_skip' })
      return
    }

    if (totalSamples < sampleRate * MIN_SECONDS_TO_PROCESS) {
      safeSend(ws, { type: 'info', message: 'too_short_skip' })
      return
    }

    busy = true
    lastProcessAt = ms
    safeSend(ws, { type: 'info', message: `processing:${reason}` })

    try {
      // Merge PCM
      const merged = new Int16Array(totalSamples)
      let offset = 0
      for (const chunk of pcmChunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }

      const wavPath = `/tmp/pcm-${Date.now()}.wav`
      writeWavFileFromPcmInt16LE({ pcmInt16: merged, sampleRate, channels, filePath: wavPath })

      // STT
      const stt = await openai.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: 'whisper-1',
        language: from
      })
      const originalText = stt?.text?.trim()

      fs.unlinkSync(wavPath)

      if (!originalText) {
        safeSend(ws, { type: 'error', message: 'STT empty' })
        busy = false
        return
      }

      safeSend(ws, { type: 'stt', text: originalText, final: true })

      // Translation (DeepL -> fallback OpenAI)
      let translatedText = ''
      try {
        if (!translator) throw new Error('DEEPL_DISABLED')
        const deeplSource = mapDeeplSourceLang(from)
        const deeplTarget = mapDeeplTargetLang(to)
        const translated = await translator.translateText(originalText, deeplSource, deeplTarget)
        translatedText = translated.text
      } catch (e) {
        translatedText = await translateWithOpenAI({ text: originalText, from, to })
      }

      if (!translatedText) {
        safeSend(ws, { type: 'error', message: 'Translation failed' })
        busy = false
        return
      }

      safeSend(ws, { type: 'translation', text: translatedText, sourceLang: from, targetLang: to })

      // TTS
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: translatedText
      })
      const ttsBuffer = Buffer.from(await tts.arrayBuffer())
      safeSend(ws, { type: 'tts', audio: ttsBuffer.toString('base64') })

      safeSend(ws, { type: 'info', message: 'done' })
    } catch (err) {
      console.error('❌ Processing error', err)
      safeSend(ws, { type: 'error', message: err?.message || 'processing_error' })
    } finally {
      busy = false

      // IMPORTANT for "continuous":
      // after processing we CLEAR the buffer so next flush processes new speech
      pcmChunks = []
      totalSamples = 0
    }
  }

  ws.on('message', async (data, isBinary) => {
    // Control JSON
    if (!isBinary) {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        safeSend(ws, { type: 'error', message: 'Invalid JSON control message' })
        return
      }

      if (msg.type === 'start') {
        from = msg.from || 'fr'
        to = msg.to || 'en'
        sampleRate = Number(msg.sampleRate) || 16000
        channels = Number(msg.channels) || 1

        pcmChunks = []
        totalSamples = 0
        busy = false
        sessionActive = true
        lastProcessAt = 0

        console.log(`▶ START ${from} -> ${to} | sr=${sampleRate} ch=${channels}`)
        safeSend(ws, { type: 'ready' })
        return
      }

      if (msg.type === 'flush') {
        // “continuous mode”: process without stopping session
        await processBuffer('flush')
        return
      }

      if (msg.type === 'stop') {
        // final segment
        await processBuffer('stop')
        sessionActive = false
        return
      }

      if (msg.type === 'ping') {
        safeSend(ws, { type: 'pong', ts: Date.now() })
        return
      }

      return
    }

    // Binary PCM Int16
    if (!sessionActive) return
    if (busy) {
      safeSend(ws, { type: 'info', message: 'busy_skip_chunk' })
      return
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length < 2) return

    const evenLen = buf.length - (buf.length % 2)
    if (evenLen <= 0) return

    const slice = buf.subarray(0, evenLen)
    const pcm16 = new Int16Array(slice.buffer, slice.byteOffset, slice.byteLength / 2)

    const copy = new Int16Array(pcm16.length)
    copy.set(pcm16)

    pcmChunks.push(copy)
    totalSamples += copy.length

    // stability: cap buffer
    if (totalSamples > MAX_SAMPLES_BUFFER) {
      safeSend(ws, { type: 'info', message: 'buffer_cap_trim' })
      // keep last ~MAX_SECONDS_BUFFER/2 seconds
      const keepSamples = Math.floor(MAX_SAMPLES_BUFFER / 2)
      const merged = new Int16Array(totalSamples)
      let offset = 0
      for (const c of pcmChunks) {
        merged.set(c, offset)
        offset += c.length
      }
      const tail = merged.subarray(Math.max(0, merged.length - keepSamples))
      pcmChunks = [new Int16Array(tail)]
      totalSamples = tail.length
    }
  })

  ws.on('close', () => console.log('👋 Client disconnected'))
})

const listenPort = Number(PORT) || 8080
server.listen(listenPort, () => console.log(`🚀 Server listening on ${listenPort}`))
