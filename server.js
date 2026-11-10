const express = require('express');
const http = require('http');
const https = require('https');
const httpReq = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FAV_FILE)) fs.writeFileSync(FAV_FILE, JSON.stringify([]), 'utf-8');

app.get('/car', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'car.html')));
app.get('/health', (req, res) => res.send('OK'));

function isPrivateIP(ip) {
  return /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.|::1|fe80::)/i.test(ip);
}

async function validateUrlSecurity(targetUrl) {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo no permitido');
  }

  const hostname = parsed.hostname;
  const isAllowed = hostname.includes('wikimedia.org') || 
                    hostname.includes('mux.dev') || 
                    hostname.includes('googleapis.com') ||
                    hostname.includes('github.io');

  if (!isAllowed) throw new Error(`Dominio no autorizado: ${hostname}`);

  const addresses = await dns.lookup(hostname, { all: true });
  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) throw new Error('IP privada detectada');
  }

  return parsed;
}

// Proxy con soporte Range y seguimiento de redirecciones
app.get('/api/proxy-stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('URL requerida');

  let parsedUrl;
  try {
    parsedUrl = await validateUrlSecurity(targetUrl);
  } catch (err) {
    return res.status(403).json({ error: 'SSRF', message: err.message });
  }

  const client = parsedUrl.protocol === 'https:' ? https : httpReq;
  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Tesla; CarBrowser) AppleWebKit/537.36'
  };

  if (req.headers['range']) {
    upstreamHeaders['Range'] = req.headers['range'];
  }

  const upstreamReq = client.get(parsedUrl.href, { headers: upstreamHeaders }, (upstreamRes) => {
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
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).send(err.message);
  });

  req.on('aborted', () => upstreamReq.destroy());
  res.on('close', () => { if (!res.writableEnded) upstreamReq.destroy(); });
});

// Diagnóstico estático
app.get('/api/diagnostics/player', (req, res) => {
  const assetsDir = path.join(__dirname, 'public', 'player-assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  res.json({
    hasWebmDemuxer: files.includes('ogv-demuxer-webm-wasm.wasm'),
    hasOggDemuxer: files.includes('ogv-demuxer-ogg-wasm.wasm'),
    hasVp8Decoder: files.includes('ogv-decoder-video-vp8-wasm.wasm'),
    hasVp9Decoder: files.includes('ogv-decoder-video-vp9-wasm.wasm'),
    allFiles: files
  });
});

const CANALES_DEFAULT = [
  { id: 'demo-ogv', name: '▶ Prueba OGG Nativa (Sin Fallos)', url: 'https://upload.wikimedia.org/wikipedia/commons/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.ogv' },
  { id: 'demo-webm', name: '▶ Prueba WebM VP9 (Desempaquetada)', url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm' }
];

app.get('/api/iptv/data', (req, res) => {
  res.json({ channels: CANALES_DEFAULT });
});

app.listen(PORT, () => console.log(`[Tesla Motion] Listo en puerto ${PORT}`));
