const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const ytdl = require('@distube/ytdl-core');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const rooms = new Map();
const favorites = new Map();
const queues = new Map();
const channels = [
  { id: 'demo-webm', name: 'Big Buck Bunny · WebM', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm' },
  { id: 'sintel', name: 'Sintel · WebM', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm' }
];
const ALLOWED_STREAM_HOSTS = new Set(['upload.wikimedia.org', 'test-streams.mux.dev']);
const MAX_REDIRECTS = 3;

function validVideoId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id); }
function getRoom(code) {
  if (typeof code !== 'string' || !/^[A-Z0-9]{6}$/.test(code)) return null;
  return rooms.get(code) || null;
}
function sendJson(res, status, body) { res.status(status).json(body); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));
app.get('/health', (req, res) => res.json({ ok: true, service: 'tesla-motion' }));

app.post('/api/session', (req, res) => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  rooms.set(code, { createdAt: Date.now(), player: null });
  res.json({ code, expiresIn: 3600 });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 160);
  if (!q) return sendJson(res, 400, { error: 'Escribe qué quieres buscar.' });
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', q);
  const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }, timeout: 10000 }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; if (body.length > 4_000_000) request.destroy(new Error('Respuesta demasiado grande')); });
    response.on('end', () => {
      try {
        const match = body.match(/var ytInitialData\s*=\s*({.*?});<\/script>/s);
        if (!match) return res.json({ results: [] });
        const data = JSON.parse(match[1]);
        const sections = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const items = sections.flatMap(section => section.itemSectionRenderer?.contents || []);
        const results = items.filter(item => item.videoRenderer).slice(0, 15).map(({ videoRenderer: v }) => ({
          videoId: v.videoId,
          title: (v.title?.runs || []).map(x => x.text).join(''),
          thumbnail: v.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
          author: v.ownerText?.runs?.[0]?.text || '',
          duration: v.lengthText?.simpleText || ''
        }));
        res.json({ results });
      } catch (_) { res.json({ results: [] }); }
    });
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'No fue posible consultar YouTube.' }); });
});

app.get('/api/suggest', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.json({ suggestions: [] });
  const url = new URL('https://suggestqueries.google.com/complete/search');
  url.searchParams.set('client', 'firefox'); url.searchParams.set('ds', 'yt'); url.searchParams.set('q', q);
  https.get(url, { timeout: 7000 }, response => {
    let body = ''; response.setEncoding('utf8');
    response.on('data', c => body += c);
    response.on('end', () => { try { res.json({ suggestions: JSON.parse(body)[1] || [] }); } catch (_) { res.json({ suggestions: [] }); } });
  }).on('error', () => { if (!res.headersSent) res.json({ suggestions: [] }); });
});

app.get('/api/iptv/data', (req, res) => res.json({ channels, favorites: favorites.get('default') || [] }));

app.get('/api/favorites', (req, res) => res.json({ favorites: favorites.get('default') || [] }));
app.post('/api/favorites', (req, res) => {
  const item = req.body;
  if (!item || !validVideoId(item.videoId) || typeof item.title !== 'string' || item.title.length > 240) return sendJson(res, 400, { error: 'Favorito no válido.' });
  const list = favorites.get('default') || [];
  if (!list.some(v => v.videoId === item.videoId)) list.unshift({ videoId: item.videoId, title: item.title, thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail.slice(0, 1000) : '' });
  favorites.set('default', list.slice(0, 100));
  res.json({ favorites: favorites.get('default') });
});
app.delete('/api/favorites/:id', (req, res) => {
  const list = (favorites.get('default') || []).filter(v => v.videoId !== req.params.id);
  favorites.set('default', list); res.json({ favorites: list });
});

app.get('/api/playback/video', async (req, res) => {
  const id = String(req.query.id || '');
  if (!validVideoId(id)) return sendJson(res, 400, { error: 'ID de video no válido.' });

  const videoUrl = 'https://www.youtube.com/watch?v=' + id;
  let stream;
  try {
    // Use one stream instance. Creating a second one after getInfo caused
    // unnecessary duplicate extraction requests to YouTube.
    const info = await ytdl.getInfo(videoUrl);
    const format = ytdl.chooseFormat(info.formats, {
      quality: '18',
      filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
    }) || ytdl.chooseFormat(info.formats, { filter: 'audioandvideo' });

    if (!format || !format.url) {
      return sendJson(res, 415, { error: 'YouTube no entregó un formato MP4 compatible para este video.' });
    }

    res.status(200);
    res.setHeader('Content-Type', format.mimeType ? format.mimeType.split(';')[0] : 'video/mp4');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    stream = ytdl.downloadFromInfo(info, {
      format,
      highWaterMark: 1 << 20,
      dlChunkSize: 0
    });

    stream.on('error', error => {
      console.error('YouTube stream error:', error.message);
      if (!res.headersSent) sendJson(res, 502, { error: 'Falló la transmisión desde YouTube: ' + error.message.slice(0, 180) });
      else res.destroy(error);
    });

    // IncomingMessage "close" can fire after the request has been received,
    // even while the response body is still streaming. Watch the response.
    res.on('close', () => {
      if (!res.writableEnded && stream && !stream.destroyed) stream.destroy();
    });

    stream.pipe(res);
  } catch (error) {
    console.error('YouTube playback:', error.stack || error.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'No fue posible extraer el video de YouTube: ' + String(error.message || 'error desconocido').slice(0, 180) });
    else res.destroy(error);
  }
});

function requestAllowedStream(target, res, range, redirects = 0) {
  let parsed;
  try { parsed = new URL(target); } catch (_) { return res.status(400).send('URL no válida.'); }
  if (parsed.protocol !== 'https:' || !ALLOWED_STREAM_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) return res.status(403).send('Fuente no autorizada.');
  const request = https.get(parsed, { headers: { 'User-Agent': 'TeslaMotion/1.0', ...(range ? { Range: range } : {}) }, timeout: 15000 }, upstream => {
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      if (redirects >= MAX_REDIRECTS) return res.status(502).send('Demasiadas redirecciones.');
      return requestAllowedStream(new URL(upstream.headers.location, parsed).toString(), res, range, redirects + 1);
    }
    const headers = {};
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(key => { if (upstream.headers[key]) headers[key] = upstream.headers[key]; });
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Cache-Control'] = 'no-store';
    res.writeHead(upstream.statusCode || 502, headers);
    upstream.pipe(res);
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => { if (!res.headersSent) res.status(502).send('Error al conectar con la fuente.'); });
  reqAbortCleanup(request, res);
}
function reqAbortCleanup(request, res) {
  res.on('close', () => { if (!res.writableEnded) request.destroy(); });
}
app.get('/api/proxy-stream', (req, res) => {
  if (typeof req.query.url !== 'string' || req.query.url.length > 2048) return res.status(400).send('Falta URL o es demasiado larga.');
  requestAllowedStream(req.query.url, res, typeof req.headers.range === 'string' ? req.headers.range : null);
});

io.on('connection', socket => {
  socket.on('join-room', code => {
    const room = getRoom(code);
    if (!room || Date.now() - room.createdAt > 3600000) return socket.emit('room-error', 'Código vencido o inválido.');
    socket.join(code); socket.data.roomCode = code; socket.emit('room-joined', { code });
  });
  socket.on('send-command', message => {
    const room = getRoom(message?.roomId);
    if (!room || socket.data.roomCode !== message.roomId) return;
    const allowed = new Set(['playVideo', 'play', 'pause', 'seek', 'queueAdd']);
    if (!allowed.has(message.action)) return;
    if (message.action === 'playVideo' && !validVideoId(message.payload?.videoId)) return;
    io.to(message.roomId).emit('player-command', { action: message.action, payload: message.payload || {} });
  });
  socket.on('disconnect', () => {});
});

server.listen(PORT, () => console.log('[Tesla Motion] Servidor activo en puerto ' + PORT));
