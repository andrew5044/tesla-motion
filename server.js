const express = require('express');
const http = require('http');
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

// Extractor de stream nativo con bypass anti-bloqueo para Render
app.get('/api/video-stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Falta ID' });

  // 1. Red de instancias públicas que resuelven el stream sin bloqueo de datacenter
  const endpoints = [
    `https://api.piped.private.coffee/streams/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://pipedapi.leptons.xyz/streams/${videoId}`,
    `https://yewtu.be/api/v1/videos/${videoId}`
  ];

  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(ep, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();

        // Formato Piped (videoStreams con audio incluido)
        if (data.videoStreams && Array.isArray(data.videoStreams)) {
          const muxed = data.videoStreams.find(s => !s.videoOnly && s.mimeType && s.mimeType.includes('mp4')) 
                     || data.videoStreams.find(s => !s.videoOnly);
          if (muxed && muxed.url) {
            return res.json({ streamUrl: muxed.url, title: data.title });
          }
        }

        // Formato Invidious (formatStreams)
        if (data.formatStreams && Array.isArray(data.formatStreams)) {
          const muxed = data.formatStreams.find(s => s.container === 'mp4' || (s.type && s.type.includes('mp4'))) 
                     || data.formatStreams[0];
          if (muxed && muxed.url) {
            return res.json({ streamUrl: muxed.url, title: data.title });
          }
        }
      }
    } catch (e) {
      // Continuar al siguiente si una instancia no responde
    }
  }

  // 2. Respaldo local ytdl
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: (f) => f.hasVideo && f.hasAudio
    });
    if (format && format.url) {
      return res.json({ streamUrl: format.url, title: info.videoDetails.title });
    }
  } catch (err) {
    console.error('Fallo ytdl local:', err.message);
  }

  res.status(502).json({ error: 'No se pudo obtener el stream nativo' });
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

// Búsqueda de videos
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
