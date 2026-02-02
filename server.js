import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)

const PORT = process.env.PORT || 8080

// ================= HEALTH CHECK =================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    wsPath: '/ws',
    timestamp: Date.now()

})
app.post('/tts', async (req, res) => {
  try {
    const { text, lang } = req.body || {};
    if (!text) return res.status(400).json({ error: "Missing text" });

    // TODO: ici branche ton vrai TTS (OpenAI ou Google)
    // Pour le moment renvoyer vide pour éviter crash :
    return res.json({ audioBase64: "" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

})

// ================= WEBSOCKET =================

const wss = new WebSocketServer({
  server,
  path: '/ws'
})

console.log('✅ WebSocket path registered: /ws')

wss.on('connection', (ws) => {
  console.log('🔌 Client WebSocket connecté')

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString())

      if (!data.type) return

      // START SESSION
      if (data.type === 'start') {
        console.log('▶ Session started', data.from, '->', data.to)

        ws.send(JSON.stringify({
          type: 'ready'
        }))

        return
      }

      // AUDIO PACKET (POUR L’INSTANT ON ECHO POUR TEST PIPELINE)
      if (data.type === 'audio') {

        // Simulation traduction (test pipeline OK)
        ws.send(JSON.stringify({
          type: 'translation',
          text: '[OK] Audio reçu',
          sourceLang: 'fr',
          targetLang: 'en'
        }))

        return
      }

      if (data.type === 'stop') {
        console.log('⏹ Session stopped')
      }

    } catch (err) {
      console.error('❌ WS error', err)

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
  console.log(`🚀 Server running on port ${PORT}`)
})
