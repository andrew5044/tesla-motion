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

// Proxy y reescritor de manifiestos HLS (soluciona la pantalla negra)
app.get('/api/iptv/stream', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta URL');

  try {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const proxyReq = client.get(targetUrl, {
      headers: {
        'User-Agent': 'IPTVSmartersPlayer',
        'Accept': '*/*'
      }
    }, (proxyRes) => {
      // Manejar redirecciones HTTP 301/302 habituales en IPTV
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, targetUrl).href;
        }
        return res.redirect(`/api/iptv/stream?url=${encodeURIComponent(redirectUrl)}`);
      }

      const contentType = proxyRes.headers['content-type'] || '';
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Si es una lista M3U8, leemos el texto y reescribimos los enlaces internos
      const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL');

      if (isM3U8) {
        let rawData = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', chunk => { rawData += chunk; });
        proxyRes.on('end', () => {
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

          // Reescribir cada línea que sea un sub-manifiesto o segmento TS
          const rewritten = rawData.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;

            let segmentUrl = trimmed;
            if (!segmentUrl.startsWith('http://') && !segmentUrl.startsWith('https://')) {
              segmentUrl = baseUrl + segmentUrl;
            }
            return `/api/iptv/stream?url=${encodeURIComponent(segmentUrl)}`;
          }).join('\n');

          res.send(rewritten);
        });
      } else {
        // Si es un segmento binario de vídeo (.ts / .aac), enviarlo directo
        res.writeHead(proxyRes.statusCode || 200, {
          'Content-Type': contentType || 'video/MP2T',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      console.error('Error stream proxy:', err.message);
      if (!res.headersSent) res.status(502).send('Error conectando al stream');
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).send('URL inválida');
  }
});

// Autocompletado YouTube
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
