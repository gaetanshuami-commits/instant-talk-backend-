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

app.get('/', (_, res) => res.send('Instant Talk backend alive ✅'))
app.get('/health', (_, res) => res.json({ status: 'ok', wsPath: '/ws', timestamp: Date.now() }))

const server = http.createServer(app)

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const translator = new deepl.Translator(DEEPL_API_KEY)

const wss = new WebSocketServer({ server, path: '/ws' })
console.log('✅ WebSocket server ready on /ws')

// ---------- Helpers ----------
function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  } catch {}
}

// DeepL mapping: enforce EN-US / EN-GB
function mapDeeplTargetLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  if (l === 'en' || l === 'en-us' || l === 'en-gb') {
    // Change here if you prefer EN-GB:
    return 'EN-US'
  }
  return l.toUpperCase()
}

function mapDeeplSourceLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  // DeepL source languages are generally fine like FR, DE, ES, EN...
  // Keep EN as EN (not EN-US)
  if (l === 'en-us' || l === 'en-gb') return 'EN'
  return l.toUpperCase()
}

// ---------- WAV helper (PCM Int16 LE, mono/stereo) ----------
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
  buffer.writeUInt16LE(16, 34) // bits

  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < pcmInt16.length; i++) {
    buffer.writeInt16LE(pcmInt16[i], headerSize + i * 2)
  }

  fs.writeFileSync(filePath, buffer)
}

wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  // Session config
  let from = 'fr'
  let to = 'en'
  let sampleRate = 16000
  let channels = 1

  // Buffer audio
  let pcmChunks = []
  let totalSamples = 0
  let busy = false

  safeSend(ws, { type: 'ready' })

  ws.on('message', async (data, isBinary) => {
    // 1) Control JSON
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

        console.log(`▶ START ${from} -> ${to} | sr=${sampleRate} ch=${channels}`)
        safeSend(ws, { type: 'ready' })
        return
      }

      if (msg.type === 'stop') {
        console.log('⏹ STOP received')

        if (busy) {
          safeSend(ws, { type: 'info', message: 'busy_skip_stop' })
          return
        }

        // Need at least ~200ms
        if (totalSamples < sampleRate * 0.2) {
          safeSend(ws, { type: 'error', message: 'Audio too short. Speak longer then Stop.' })
          pcmChunks = []
          totalSamples = 0
          return
        }

        busy = true
        safeSend(ws, { type: 'info', message: 'processing' })

        try {
          // Merge PCM
          const merged = new Int16Array(totalSamples)
          let offset = 0
          for (const chunk of pcmChunks) {
            merged.set(chunk, offset)
            offset += chunk.length
          }

          const wavPath = `/tmp/pcm-${Date.now()}.wav`
          writeWavFileFromPcmInt16LE({
            pcmInt16: merged,
            sampleRate,
            channels,
            filePath: wavPath
          })

          // ===== STT (Whisper) =====
          const stt = await openai.audio.transcriptions.create({
            file: fs.createReadStream(wavPath),
            model: 'whisper-1',
            language: from
          })

          const originalText = stt?.text?.trim()
          if (!originalText) {
            safeSend(ws, { type: 'error', message: 'STT empty' })
            fs.unlinkSync(wavPath)
            pcmChunks = []
            totalSamples = 0
            busy = false
            return
          }

          safeSend(ws, { type: 'stt', text: originalText, final: true })

          // ===== Translation (DeepL) =====
          const deeplSource = mapDeeplSourceLang(from)
          const deeplTarget = mapDeeplTargetLang(to) // ✅ EN-US fix here

          const translated = await translator.translateText(
            originalText,
            deeplSource,
            deeplTarget
          )

          const translatedText = translated.text
          safeSend(ws, { type: 'translation', text: translatedText, sourceLang: from, targetLang: to })

          // ===== TTS (OpenAI) =====
          const tts = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'alloy',
            input: translatedText
          })

          const ttsBuffer = Buffer.from(await tts.arrayBuffer())
          safeSend(ws, { type: 'tts', audio: ttsBuffer.toString('base64') })

          // Cleanup
          fs.unlinkSync(wavPath)

          // Reset
          pcmChunks = []
          totalSamples = 0
          busy = false
          safeSend(ws, { type: 'info', message: 'done' })
        } catch (err) {
          console.error('❌ Processing error', err)
          busy = false
          safeSend(ws, { type: 'error', message: err?.message || 'processing_error' })
        }

        return
      }

      return
    }

    // 2) Binary PCM Int16
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

    // copy chunk
    const copy = new Int16Array(pcm16.length)
    copy.set(pcm16)

    pcmChunks.push(copy)
    totalSamples += copy.length
  })

  ws.on('close', () => console.log('👋 Client disconnected'))
})

const listenPort = Number(PORT) || 8080
server.listen(listenPort, () => console.log(`🚀 Server listening on ${listenPort}`))
