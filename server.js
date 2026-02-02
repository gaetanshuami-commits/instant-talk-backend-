import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});


// ---------------- HEALTH CHECK ----------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', wsPath: '/ws' });
});


// ---------------- WEBSOCKET ----------------

wss.on('connection', (ws) => {

  console.log('✅ Client WebSocket connecté');

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (!data?.type) return;

      if (data.type === 'start') {
        ws.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      if (data.type === 'audio') {

        // TODO: PIPELINE STT → TRANSLATE → TTS
        // (Tu peux brancher Whisper + DeepL ici)

        ws.send(JSON.stringify({
          type: 'translation',
          text: '[TEST OK] Traduction reçue'
        }));

        return;
      }

      if (data.type === 'stop') {
        console.log('⏹ Session arrêtée');
      }

    } catch (err) {
      console.error('WS ERROR:', err.message);

      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }));
    }
  });

  ws.on('close', () => {
    console.log('❌ Client déconnecté');
  });
});


// ---------------- START SERVER ----------------

server.listen(PORT, () => {
  console.log('🚀 Backend Instant Talk en ligne sur port', PORT);
});
