const express = require('express');
const http = require('http');
const https = require('https');
const httpReq = require('http');
const path = require('path');
const { Server } = require('socket.io');
const ytdl = require('@distube/ytdl-core');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let globalFavorites = [];

// Rutas base
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/health', (req, res) => res.send('OK'));

// Proxy universal de streaming (elimina bloqueos CORS y cabeceras del auto)
app.get('/api/proxy-stream', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL requerida');

  const client = targetUrl.startsWith('https') ? https : httpReq;
  
  const request = client.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  }, (streamRes) => {
    // Si hay redirección (301, 302)
    if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
      return res.redirect(`/api/proxy-stream?url=${encodeURIComponent(streamRes.headers.location)}`);
    }

    res.writeHead(streamRes.statusCode, {
      'Content-Type': streamRes.headers['content-type'] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });

    streamRes.pipe(res);
  });

  request.on('error', (err) => {
    console.error('Error en proxy-stream:', err.message);
    if (!res.headersSent) res.status(500).send('Error conectando flujo');
  });
});

// Canales preconfigurados en el servidor
const CANALES_DEFAULT = [
  { id: 'caracol', name: 'Caracol Televisión (En Vivo)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { id: 'demo1', name: 'Canal de Prueba Continuo (Software)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm' },
  { id: 'demo2', name: 'Canal Alterno (Animación)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm' }
];

app.get('/api/iptv/data', (req, res) => {
  res.json({
    channels: CANALES_DEFAULT,
    favorites: globalFavorites
  });
});

app.post('/api/iptv/favorite', (req, res) => {
  const { url, name } = req.body;
  const idx = globalFavorites.findIndex(f => f.url === url);
  if (idx === -1) globalFavorites.push({ url, name });
  else globalFavorites.splice(idx, 1);
  res.json({ favorites: globalFavorites });
});

// Extractor de YouTube hacia el túnel
app.get('/api/yt-stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).send('ID requerido');
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, { quality: '18' }) || 
                   ytdl.chooseFormat(info.formats, { filter: 'audioandvideo' });
    if (!format || !format.url) return res.status(404).send('Formato no encontrado');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    ytdl(videoUrl, { format }).pipe(res);
  } catch (err) {
    res.status(500).send('Error');
  }
});

server.listen(PORT, () => console.log(`Servidor en ejecución en puerto ${PORT}`));
