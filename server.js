const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');
const httpReq = require('http');
const ytdl = require('@distube/ytdl-core');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Base de datos en memoria compartida entre todos tus dispositivos
let globalChannels = [];
let globalFavorites = [];
let defaultM3U = 'https://iptv-org.github.io/iptv/index.m3u';

// 1. Servir la aplicación
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/health', (req, res) => res.send('OK'));

// 2. Parser robusto M3U en backend (evita bloqueos de CORS del auto)
function fetchM3U(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : httpReq;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const lines = data.split('\n');
        const list = [];
        let curName = '';
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i].trim();
          if (l.startsWith('#EXTINF:')) {
            const parts = l.split(',');
            curName = parts[parts.length - 1].trim();
          } else if (l.startsWith('http')) {
            list.push({
              id: 'ch_' + (list.length + 1),
              name: curName || `Canal ${list.length + 1}`,
              url: l
            });
            curName = '';
          }
        }
        resolve(list);
      }).on('error', reject);
    }).on('error', reject);
  });
}

// Carga inicial automática de canales
fetchM3U(defaultM3U).then(chs => {
  globalChannels = chs;
  console.log(`[IPTV] Precargados ${chs.length} canales`);
}).catch(() => {});

// 3. Endpoints de IPTV sincronizados
app.get('/api/iptv/data', (req, res) => {
  res.json({
    channels: globalChannels.slice(0, 400),
    favorites: globalFavorites,
    url: defaultM3U
  });
});

app.post('/api/iptv/load', async (req, res) => {
  const url = req.body.url;
  if (!url) return res.status(400).send('URL requerida');
  try {
    const chs = await fetchM3U(url);
    defaultM3U = url;
    globalChannels = chs;
    res.json({ success: true, count: chs.length });
  } catch(e) {
    res.status(500).json({ error: 'Error descargando lista' });
  }
});

app.post('/api/iptv/favorite', (req, res) => {
  const { url, name } = req.body;
  const idx = globalFavorites.findIndex(f => f.url === url);
  if (idx === -1) {
    globalFavorites.push({ url, name });
  } else {
    globalFavorites.splice(idx, 1);
  }
  res.json({ favorites: globalFavorites });
});

// 4. YouTube Autocompletado y Búsqueda
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

// 5. Streaming extractor de YouTube
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
    ytdl(videoUrl, { format }).pipe(res);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// 6. Socket.io
io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => socket.join(roomId));
  socket.on('send-command', ({ roomId, action, payload }) => {
    socket.to(roomId).emit('execute-command', { action, payload });
  });
});

server.listen(PORT, () => console.log(`Server online en ${PORT}`));
