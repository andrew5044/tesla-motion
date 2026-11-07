const express = require('express');
const http = require('http');
const https = require('https');
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

// Proxy para saltar bloqueos HTTPS / Mixed Content en streams individuales
app.get('/api/iptv/stream', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta URL');

  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const proxyReq = client.get(targetUrl, {
      headers: { 'User-Agent': 'IPTVSmartersPlayer', 'Accept': '*/*' }
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, targetUrl).href;
        }
        return res.redirect(`/api/iptv/stream?url=${encodeURIComponent(redirectUrl)}`);
      }

      const contentType = proxyRes.headers['content-type'] || 'application/vnd.apple.mpegurl';
      res.writeHead(proxyRes.statusCode || 200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(502).send('Error conectando al stream');
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).send('URL invalida');
  }
});

// Cargar y procesar Lista M3U desde URL
app.get('/api/iptv/m3u', async (req, res) => {
  const m3uUrl = req.query.url;
  if (!m3uUrl) return res.status(400).json({ error: 'Falta la URL de la lista M3U' });

  try {
    const response = await fetch(m3uUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'No se pudo descargar la lista M3U' });
    }

    const text = await response.text();
    const lines = text.split('\n');
    const channels = [];
    let currentName = '';
    let currentLogo = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        // Extraer nombre
        const nameMatch = line.match(/,(.+)$/);
        currentName = nameMatch ? nameMatch[1].trim() : 'Canal sin nombre';

        // Extraer logo si existe
        const logoMatch = line.match(/tvg-logo="([^"]+)"/);
        currentLogo = logoMatch ? logoMatch[1] : '';
      } else if (line.startsWith('http://') || line.startsWith('https://')) {
        channels.push({
          id: channels.length + 1,
          name: currentName || `Canal ${channels.length + 1}`,
          logo: currentLogo,
          stream_url: line
        });
        currentName = '';
        currentLogo = '';
      }
    }

    res.json({ channels: channels.slice(0, 1500) });
  } catch (err) {
    res.status(500).json({ error: 'Error procesando la lista M3U' });
  }
});

// Sugerencias de YouTube
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

// Búsqueda de YouTube
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
