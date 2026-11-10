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

// Rutas de aplicación
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/health', (req, res) => res.send('OK'));

// 1. Endpoint de video para OGV (con soporte para peticiones HTTP Range)
app.get('/api/playback/video', async (req, res) => {
  const videoId = req.query.id;
  const rawUrl = req.query.url;

  if (videoId) {
    try {
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const info = await ytdl.getInfo(videoUrl);
      
      // Priorizar WebM/VP9 para decodificación WASM ultra rápida
      const format = ytdl.chooseFormat(info.formats, { filter: f => f.container === 'webm' && f.hasVideo }) ||
                     ytdl.chooseFormat(info.formats, { quality: '18' }) ||
                     ytdl.chooseFormat(info.formats, { filter: 'videoandaudio' });

      if (!format || !format.url) return res.status(404).send('Formato no encontrado');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'video/webm');
      ytdl(videoUrl, { format }).pipe(res);
    } catch (err) {
      console.error('Error video YouTube:', err.message);
      res.status(500).send('Error');
    }
  } else if (rawUrl) {
    // Proxy de video para IPTV / enlaces directos
    const client = rawUrl.startsWith('https') ? https : httpReq;
    client.get(rawUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (streamRes) => {
      res.writeHead(streamRes.statusCode, {
        'Content-Type': streamRes.headers['content-type'] || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      streamRes.pipe(res);
    }).on('error', () => res.status(500).send('Error en flujo'));
  } else {
    res.status(400).send('Falta id o url');
  }
});

// 2. Endpoint de audio separado (para sincronización Web Audio)
app.get('/api/playback/audio', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).send('ID requerido');

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, { filter: 'audioonly' });

    if (!format || !format.url) return res.status(404).send('Formato de audio no encontrado');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/webm');
    ytdl(videoUrl, { format }).pipe(res);
  } catch (err) {
    res.status(500).send('Error audio');
  }
});

// 3. Búsqueda y sugerencias de YouTube
app.get('/api/yt-suggest', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  https.get(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      try { res.json(JSON.parse(data)[1] || []); } catch(e) { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

app.get('/api/yt-search', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  https.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      try {
        const match = data.match(/var ytInitialData = ({.*?});<\/script>/);
        if (!match) return res.json([]);
        const initialData = JSON.parse(match[1]);
        const contents = initialData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
        const results = [];
        for (const item of contents) {
          if (item.videoRenderer) {
            const v = item.videoRenderer;
            results.push({
              id: v.videoId,
              title: v.title.runs[0].text,
              thumbnail: v.thumbnail.thumbnails[0]?.url,
              channel: v.ownerText?.runs[0]?.text || '',
              duration: v.lengthText?.simpleText || ''
            });
            if (results.length >= 15) break;
          }
        }
        res.json(results);
      } catch (err) { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

// Canales preconfigurados
const CANALES_DEFAULT = [
  { id: 'caracol', name: 'Caracol Televisión (En Vivo)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { id: 'demo1', name: 'Canal de Demostración (WebM / Software)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm' },
  { id: 'demo2', name: 'Canal Animación (Sintel)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm' }
];

app.get('/api/iptv/data', (req, res) => {
  res.json({ channels: CANALES_DEFAULT, favorites: globalFavorites });
});

server.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
