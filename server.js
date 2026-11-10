const express = require('express');
const http = require('http');
const https = require('https');
const httpReq = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const { URL } = require('url');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 1. Persistencia local de favoritos
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FAV_FILE)) fs.writeFileSync(FAV_FILE, JSON.stringify([]), 'utf-8');

function readFavorites() {
  try {
    return JSON.parse(fs.readFileSync(FAV_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function writeFavorites(favs) {
  fs.writeFileSync(FAV_FILE, JSON.stringify(favs, null, 2), 'utf-8');
}

// 2. Rutas
app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/health', (req, res) => res.send('OK'));

// 3. Protección SSRF y Lista Blanca
const ALLOWED_DOMAINS = [
  'test-streams.mux.dev',
  'upload.wikimedia.org',
  'iptv-org.github.io',
  'commondatastorage.googleapis.com'
];

function isPrivateIP(ip) {
  return /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|::1|fe80::)/i.test(ip);
}

async function validateUrlSecurity(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    throw new Error('URL malformada');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo no permitido');
  }

  const hostname = parsed.hostname;
  const isAllowed = ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  if (!isAllowed) {
    throw new Error(`Dominio no autorizado: ${hostname}`);
  }

  const addresses = await dns.lookup(hostname, { all: true });
  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new Error('Dirección IP privada detectada');
    }
  }

  return parsed;
}

// 4. Proxy de Streaming con soporte HTTP Range completo
app.get('/api/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Parámetro url requerido');

  let parsedUrl;
  try {
    parsedUrl = await validateUrlSecurity(targetUrl);
  } catch (err) {
    return res.status(403).json({ error: 'SSRF Protection', message: err.message });
  }

  const client = parsedUrl.protocol === 'https:' ? https : httpReq;
  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Tesla; CarBrowser) AppleWebKit/537.36'
  };

  if (req.headers['range']) {
    upstreamHeaders['Range'] = req.headers['range'];
  }

  const options = {
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: upstreamHeaders
  };

  const upstreamReq = client.request(options, (upstreamRes) => {
    if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
      return res.redirect(`/api/proxy-stream?url=${encodeURIComponent(upstreamRes.headers.location)}`);
    }

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
    };

    ['content-range', 'content-length', 'content-type', 'etag', 'last-modified', 'accept-ranges'].forEach(h => {
      if (upstreamRes.headers[h]) responseHeaders[h] = upstreamRes.headers[h];
    });

    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);

    upstreamRes.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: 'Upstream gateway error', message: err.message });
  });

  req.on('aborted', () => {
    upstreamReq.destroy();
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      upstreamReq.destroy();
    }
  });

  upstreamReq.end();
});

// 5. Diagnóstico de Componentes Multimedia
app.get('/api/diagnostics/player', (req, res) => {
  const assetsDir = path.join(__dirname, 'public', 'player-assets');
  const requiredFiles = [
    'ogv.js',
    'ogv-support.js',
    'ogv-version.js',
    'ogv-demuxer-ogg-wasm.js',
    'ogv-demuxer-ogg-wasm.wasm',
    'ogv-decoder-video-vp8-wasm.js',
    'ogv-decoder-video-vp8-wasm.wasm',
    'ogv-decoder-video-vp9-wasm.js',
    'ogv-decoder-video-vp9-wasm.wasm',
    'ogv-decoder-audio-vorbis-wasm.js',
    'ogv-decoder-audio-vorbis-wasm.wasm',
    'ogv-decoder-audio-opus-wasm.js',
    'ogv-decoder-audio-opus-wasm.wasm'
  ];

  const present = [];
  const missing = [];

  requiredFiles.forEach(file => {
    const fullPath = path.join(assetsDir, file);
    if (fs.existsSync(fullPath)) {
      present.push(file);
    } else {
      missing.push(file);
    }
  });

  res.json({
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    ogvCoreAvailable: present.includes('ogv.js'),
    allWasmPresent: missing.length === 0,
    presentComponents: present,
    missingComponents: missing
  });
});

// 6. Canales y Favoritos
const CANALES_DEFAULT = [
  { id: 'demo1', name: 'Canal de Demostración (WebM VP9)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm' },
  { id: 'demo2', name: 'Canal Animación (Sintel VP9)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.360p.vp9.webm' },
  { id: 'caracol', name: 'Transmisión HLS de Demostración', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }
];

app.get('/api/iptv/data', (req, res) => {
  res.json({ channels: CANALES_DEFAULT, favorites: readFavorites() });
});

app.post('/api/favorites', (req, res) => {
  const { id, name, url } = req.body;
  if (!id || !name || !url) return res.status(400).json({ error: 'Datos incompletos' });
  const favs = readFavorites();
  if (!favs.some(f => f.url === url)) {
    favs.push({ id, name, url });
    writeFavorites(favs);
  }
  res.json({ success: true, favorites: favs });
});

app.delete('/api/favorites/:id', (req, res) => {
  let favs = readFavorites().filter(f => f.id !== req.params.id);
  writeFavorites(favs);
  res.json({ success: true, favorites: favs });
});

server.listen(PORT, () => {
  console.log(`[Tesla Motion] Servidor listo en puerto ${PORT} (Sin control remoto)`);
});
