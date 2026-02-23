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

// ---------------- Helpers ----------------
function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  } catch {}
}

function mapDeeplTargetLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  // DeepL target EN requires region
  if (l === 'en' || l === 'en-us' || l === 'en-gb') return 'EN-US' // change to EN-GB if desired
  return l.toUpperCase()
}

function mapDeeplSourceLang(lang) {
  const l = String(lang || '').trim().toLowerCase()
  // DeepL source doesn't need region
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

function normalizeLang2(l) {
  const x = String(l || '').trim().toLowerCase()
  if (x.startsWith('fr')) return 'fr'
  if (x.startsWith('en')) return 'en'
  return ''
}

// small heuristic first (fast + free)
function heuristicDetectFrEn(text) {
  const t = (text || '').toLowerCase()
  if (!t) return ''

  // French accents / apostrophes + very common words
  const hasFrenchAccent = /[àâçéèêëîïôùûüÿœ]/.test(t)
  const frenchHits =
    (t.match(/\b(le|la|les|des|un|une|et|mais|donc|avec|pour|dans|sur|pas|vous|nous|bonjour|merci)\b/g) || []).length
  const englishHits =
    (t.match(/\b(the|a|an|and|but|so|with|for|in|on|not|you|we|hello|thanks)\b/g) || []).length

  if (hasFrenchAccent && frenchHits >= englishHits) return 'fr'
  if (englishHits > frenchHits + 1) return 'en'
  if (frenchHits > englishHits + 1) return 'fr'
  return ''
}

// definitive detect (if whisper doesn't return language)
async function detectFrEnWithOpenAI(text) {
  const t = (text || '').trim()
  if (!t) return 'fr' // default safe
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a language detector. Decide if the text is French or English. Output ONLY: "fr" or "en".'
      },
      { role: 'user', content: t }
    ],
    temperature: 0
  })
  const out = (r.choices?.[0]?.message?.content || '').trim().toLowerCase()
  return out === 'en' ? 'en' : 'fr'
}

// choose opposite in ["fr","en"]
function oppositeLang(lang) {
  return lang === 'fr' ? 'en' : 'fr'
}

function nowMs() {
  return Date.now()
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

// ---------------- WebSocket ----------------
wss.on('connection', (ws) => {
  console.log('🔌 Client connected')

  // Session config
  let mode = 'manual' // manual | continuous | ptt | auto_bidi
  let from = 'fr'
  let to = 'en'
  let allowedLangs = ['fr', 'en'] // for auto_bidi

  let sampleRate = 16000
  let channels = 1

  // Audio buffer
  let pcmChunks = []
  let totalSamples = 0

  // Stability / state
  let busy = false
  let sessionActive = false
  let lastProcessAt = 0

  // Limits
  const MIN_SECONDS_TO_PROCESS = 0.4
  const PROCESS_COOLDOWN_MS = 700
  const MAX_SECONDS_BUFFER = 12
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

      // ===== STT =====
      // For auto_bidi, do NOT force language; let model detect.
      // For manual modes, forcing can be ok but not required. We'll only force when not auto_bidi AND from exists.
      const sttParams = {
        file: fs.createReadStream(wavPath),
        model: 'whisper-1'
      }
      if (mode !== 'auto_bidi' && from) {
        sttParams.language = from
      }

      const stt = await openai.audio.transcriptions.create(sttParams)
      const originalText = stt?.text?.trim()

      // Some API variants can return language; keep it if present
      const sttLang = normalizeLang2(stt?.language)

      fs.unlinkSync(wavPath)

      if (!originalText) {
        safeSend(ws, { type: 'error', message: 'STT empty' })
        busy = false
        return
      }

      // Determine direction
      let sourceLang = from
      let targetLang = to

      if (mode === 'auto_bidi') {
        // prefer stt.language if available
        let detected = sttLang || heuristicDetectFrEn(originalText)
        if (!detected) detected = await detectFrEnWithOpenAI(originalText)

        // enforce only allowed langs; default fr if weird
        if (!allowedLangs.includes(detected)) detected = 'fr'

        sourceLang = detected
        targetLang = oppositeLang(detected)
      }

      safeSend(ws, { type: 'stt', text: originalText, final: true, sourceLang })

      // ===== Translation (DeepL -> fallback OpenAI) =====
      let translatedText = ''
      try {
        if (!translator) throw new Error('DEEPL_DISABLED')
        const deeplSource = mapDeeplSourceLang(sourceLang)
        const deeplTarget = mapDeeplTargetLang(targetLang)
        const translated = await translator.translateText(originalText, deeplSource, deeplTarget)
        translatedText = translated.text
      } catch (e) {
        translatedText = await translateWithOpenAI({ text: originalText, from: sourceLang, to: targetLang })
      }

      if (!translatedText) {
        safeSend(ws, { type: 'error', message: 'Translation failed' })
        busy = false
        return
      }

      safeSend(ws, { type: 'translation', text: translatedText, sourceLang, targetLang })

      // ===== TTS =====
      const tts = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: translatedText
      })
      const ttsBuffer = Buffer.from(await tts.arrayBuffer())
      safeSend(ws, { type: 'tts', audio: ttsBuffer.toString('base64'), sourceLang, targetLang })

      safeSend(ws, { type: 'info', message: 'done' })
    } catch (err) {
      console.error('❌ Processing error', err)
      safeSend(ws, { type: 'error', message: err?.message || 'processing_error' })
    } finally {
      busy = false
      // Clear buffer after each processing (crucial for continuous flush)
      pcmChunks = []
      totalSamples = 0
    }
  }

  ws.on('message', async (data, isBinary) => {
    // -------- Control JSON --------
    if (!isBinary) {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        safeSend(ws, { type: 'error', message: 'Invalid JSON control message' })
        return
      }

      if (msg.type === 'start') {
        mode = String(msg.mode || 'manual')
        // manual direction values
        from = msg.from || from || 'fr'
        to = msg.to || to || 'en'

        // auto bidi config
        const langs = Array.isArray(msg.langs) ? msg.langs.map(normalizeLang2).filter(Boolean) : []
        if (langs.length >= 2) {
          allowedLangs = [...new Set(langs)].filter((x) => x === 'fr' || x === 'en')
          if (allowedLangs.length < 2) allowedLangs = ['fr', 'en']
        } else {
          allowedLangs = ['fr', 'en']
        }

        sampleRate = Number(msg.sampleRate) || 16000
        channels = Number(msg.channels) || 1

        pcmChunks = []
        totalSamples = 0
        busy = false
        sessionActive = true
        lastProcessAt = 0

        console.log(`▶ START mode=${mode} | from=${from} to=${to} | langs=${allowedLangs.join(',')} | sr=${sampleRate} ch=${channels}`)
        safeSend(ws, { type: 'ready' })
        return
      }

      if (msg.type === 'flush') {
        await processBuffer('flush')
        return
      }

      if (msg.type === 'stop') {
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

    // -------- Binary PCM Int16 --------
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

    // Copy chunk
    const copy = new Int16Array(pcm16.length)
    copy.set(pcm16)

    pcmChunks.push(copy)
    totalSamples += copy.length

    // cap buffer
    const maxSamplesBuffer = sampleRate * MAX_SECONDS_BUFFER
    if (totalSamples > maxSamplesBuffer) {
      safeSend(ws, { type: 'info', message: 'buffer_cap_trim' })

      const keepSamples = Math.floor(maxSamplesBuffer / 2)
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
