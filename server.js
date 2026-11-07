const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/car'));
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));

// 1. Obtener la URL del stream
async function resolveStreamUrl(videoId) {
  // Instancias públicas Piped / Invidious
  const endpoints = [
    `https://api.piped.private.coffee/streams/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://yewtu.be/api/v1/videos/${videoId}`
  ];

  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(ep, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        // Formato Piped
        if (data.videoStreams) {
          const muxed = data.videoStreams.find(s => !s.videoOnly && s.mimeType && s.mimeType.includes('mp4')) 
                     || data.videoStreams.find(s => !s.videoOnly);
          if (muxed && muxed.url) return { url: muxed.url, title: data.title };
        }
        // Formato Invidious
        if (data.formatStreams) {
          const muxed = data.formatStreams.find(s => s.container === 'mp4' || (s.type && s.type.includes('mp4'))) 
                     || data.formatStreams[0];
          if (muxed && muxed.url) return { url: muxed.url, title: data.title };
        }
      }
    } catch (e) {}
  }

  // Fallback ytdl
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: (f) => f.hasVideo && f.hasAudio
    });
    if (format && format.url) return { url: format.url, title: info.videoDetails.title };
  } catch (err) {}

  return null;
}

// 2. Endpoint de metadatos
app.get('/api/video-stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Falta ID' });

  const resolved = await resolveStreamUrl(videoId);
  if (!resolved) {
    return res.status(502).json({ error: 'No se pudo resolver el stream' });
  }

  // Se envía la URL del proxy local para saltar el bloqueo de CORS y permisos de Chromium
  res.json({
    streamUrl: `/api/stream-proxy?url=${encodeURIComponent(resolved.url)}`,
    title: resolved.title
  });
});

// 3. Proxy de transmisión con soporte completo de streaming por trozos (Range request)
app.get('/api/stream-proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta URL');

  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': '*/*'
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const proxyReq = client.get(targetUrl, { headers }, (proxyRes) => {
      // Manejo de redirecciones
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        return res.redirect(`/api/stream-proxy?url=${encodeURIComponent(proxyRes.headers.location)}`);
      }

      res.writeHead(proxyRes.statusCode || 200, {
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
        'Content-Length': proxyRes.headers['content-length'],
        'Content-Range': proxyRes.headers['content-range'],
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });

      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(502).send('Error conectando al flujo de video');
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).send('URL inválida');
  }
});

// Autocompletado de búsqueda
app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) return res.json({ suggestions: [] });
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&ds=yt&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await response.json();
    res.json({ suggestions: Array.isArray(data[1]) ? data[1] : [] });
  } catch (err) {
    res.json({ suggestions: [] });
  }
});

// Búsqueda
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ results: [] });
  try {
    const searchResults = await ytSearch(query);
    const videos = (searchResults.videos || []).slice(0, 10).map(v => ({
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      timestamp: v.timestamp,
      author: v.author ? v.author.name : ''
    }));
    res.json({ results: videos });
  } catch (error) {
    res.status(500).json({ error: 'Error en la búsqueda' });
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => socket.join(roomId));
  socket.on('send-command', ({ roomId, action, payload }) => {
    io.to(roomId).emit('execute-command', { action, payload });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
