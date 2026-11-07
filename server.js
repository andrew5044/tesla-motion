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

// Endpoint que extrae el video nativo en MP4 para que la GPU de Tesla no lo congele
app.get('/api/video-stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'Falta ID' });

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(videoUrl);
    
    // Buscar formato combinado (video + audio) compatible con HTML5 nativo (720p/360p)
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highest',
      filter: (f) => f.hasVideo && f.hasAudio && f.container === 'mp4'
    });

    if (format && format.url) {
      return res.json({ streamUrl: format.url, title: info.videoDetails.title });
    }

    // Si no hay combinado MP4 directo, pasar el mejor disponible
    const fallback = info.formats.find(f => f.hasVideo && f.hasAudio);
    if (fallback && fallback.url) {
      return res.json({ streamUrl: fallback.url, title: info.videoDetails.title });
    }

    res.status(404).json({ error: 'Formato no compatible' });
  } catch (err) {
    console.error('Error extrayendo stream nativo:', err.message);
    res.status(500).json({ error: 'No se pudo obtener el stream' });
  }
});

// Autocompletado
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
