const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ytSearch = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/car');
});

app.get('/car', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'car.html'));
});

app.get('/remote', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'remote.html'));
});

// Proxy de transmisión IPTV para evitar bloqueos HTTPS / CORS
app.get('/api/iptv/proxy', async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('Falta URL');

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    // Reenviar encabezados clave
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.setHeader('access-control-allow-origin', '*');

    // Transmitir en vivo el flujo directamente al cliente
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Error en proxy de stream:', err.message);
    res.status(502).send('Error transmitiendo canal');
  }
});

// Sugerencias YouTube
app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) return res.json({ suggestions: [] });
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();
    const suggestions = Array.isArray(data[1]) ? data[1] : [];
    res.json({ suggestions });
  } catch (err) {
    res.json({ suggestions: [] });
  }
});

// Búsqueda YouTube
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

// Canales Xtream Codes
app.get('/api/iptv/channels', async (req, res) => {
  let { host, username, password } = req.query;
  if (!host || !username || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }

  if (!host.startsWith('http://') && !host.startsWith('https://')) {
    host = 'http://' + host;
  }
  host = host.replace(/\/$/, '');

  const apiUrl = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`;

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      return res.status(401).json({ error: 'Credenciales inválidas o sin canales' });
    }

    const channels = data.map(ch => ({
      num: ch.num,
      name: ch.name,
      stream_id: ch.stream_id,
      logo: ch.stream_icon || '',
      stream_url: `${host}/live/${username}/${password}/${ch.stream_id}.m3u8`
    }));

    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo conectar con el servidor IPTV' });
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('send-command', ({ roomId, action, payload }) => {
    io.to(roomId).emit('execute-command', { action, payload });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
