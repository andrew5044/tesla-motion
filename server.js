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

// Proxy de transmisión IPTV para esquivar bloqueos de HTTPS / Mixed-Content
app.get('/api/iptv/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta URL');

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'IPTVSmartersPlayer',
        'Accept': '*/*'
      }
    });

    const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!response.body) {
      return res.status(500).send('Stream vacío');
    }

    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(Buffer.from(value));
      return pump();
    };
    pump();
  } catch (err) {
    console.error('Error streaming proxy:', err.message);
    if (!res.headersSent) res.status(502).send('Error conectando al stream');
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
      // URL directa estándar de Xtream (algunos servidores usan .m3u8 y otros .ts)
      stream_url: `${host}/live/${username}/${password}/${ch.stream_id}.m3u8`,
      raw_stream_url: `${host}/live/${username}/${password}/${ch.stream_id}.ts`
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
server
cat << 'EOF' > public/car.html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Tesla Motion Screen</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body, html { width: 100vw; height: 100vh; overflow: hidden; background: #000; }
    
    #overlay {
      position: fixed; inset: 0; z-index: 999;
      background: #0f0f11; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center; padding: 24px;
    }
    .badge { background: #222; border: 1px solid #333; padding: 6px 14px; border-radius: 20px; font-size: 13px; color: #aaa; margin-bottom: 14px; }
    h1 { font-size: 26px; margin-bottom: 8px; font-weight: 700; letter-spacing: -0.5px; }
    p { color: #888; font-size: 14px; margin-bottom: 24px; max-width: 420px; line-height: 1.4; }
    
    .room-box { background: #1c1c1e; border: 1px solid #2c2c2e; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px; }
    .room-box span { font-size: 11px; color: #888; display: block; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 1px; }
    .room-box strong { font-size: 32px; letter-spacing: 4px; color: #e82127; }
    
    .btn-container { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 320px; }
    .btn-primary {
      background: #e82127; color: #fff; border: none; padding: 16px;
      font-size: 15px; font-weight: 700; border-radius: 12px; cursor: pointer;
      box-shadow: 0 4px 18px rgba(232, 33, 39, 0.4); text-decoration: none; display: block;
    }
    .btn-secondary {
      background: #1c1c1e; color: #ddd; border: 1px solid #333; padding: 14px;
      font-size: 14px; font-weight: 600; border-radius: 12px; cursor: pointer; text-decoration: none; display: block;
    }

    #yt-wrapper, #hls-wrapper {
      position: absolute; inset: 0; width: 100vw; height: 100vh;
    }
    #iptv-video {
      width: 100%; height: 100%; object-fit: contain; background: #000;
    }
    .hidden { display: none !important; }
    
    #status-pill {
      position: absolute; top: 16px; left: 20px; z-index: 50;
      background: rgba(15, 15, 17, 0.85); padding: 8px 16px; border-radius: 8px;
      font-size: 13px; border: 1px solid rgba(255,255,255,0.12);
      backdrop-filter: blur(10px); opacity: 0; transition: opacity 0.3s ease;
      pointer-events: none;
    }
  </style>
</head>
<body>

  <div id="overlay">
    <div class="badge">SISTEMA MULTIMEDIA COPILOTO</div>
    <h1>Pantalla Tesla Motion</h1>
    <p>Toca para autorizar la pantalla y desbloquear el audio del vehículo.</p>
    
    <div class="room-box">
      <span>Código de Enlace</span>
      <strong id="display-room">TSLA-77</strong>
    </div>

    <div class="btn-container">
      <button class="btn-primary" onclick="startDisplay()">1. ACTIVAR PANTALLA Y AUDIO</button>
      <a class="btn-secondary" id="theater-trigger" href="#">2. PANTALLA COMPLETA (TEATRO)</a>
    </div>
  </div>

  <div id="status-pill">Iniciando...</div>

  <div id="yt-wrapper">
    <div id="player"></div>
  </div>

  <div id="hls-wrapper" class="hidden">
    <video id="iptv-video" playsinline webkit-playsinline autoplay></video>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script src="https://www.youtube.com/iframe_api"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script>
    const ROOM_ID = 'TSLA-77';
    let ytPlayer;
    let hls = null;
    const iptvVideo = document.getElementById('iptv-video');
    const ytWrapper = document.getElementById('yt-wrapper');
    const hlsWrapper = document.getElementById('hls-wrapper');
    const statusPill = document.getElementById('status-pill');
    const socket = io();

    const destinationUrl = encodeURIComponent(window.location.origin + '/car');
    document.getElementById('theater-trigger').href = `https://www.youtube.com/redirect?q=${destinationUrl}`;

    function showStatus(msg) {
      statusPill.textContent = msg;
      statusPill.style.opacity = '1';
      setTimeout(() => { statusPill.style.opacity = '0'; }, 3500);
    }

    function onYouTubeIframeAPIReady() {
      ytPlayer = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '5qap5aO4i9A',
        playerVars: {
          'autoplay': 0,
          'controls': 0,
          'playsinline': 1,
          'rel': 0,
          'disablekb': 1,
          'iv_load_policy': 3
        }
      });
    }

    function startDisplay() {
      document.getElementById('overlay').style.display = 'none';
      socket.emit('join-room', ROOM_ID);
      if (ytPlayer && ytPlayer.playVideo) {
        ytPlayer.playVideo();
      }
      iptvVideo.play().catch(() => {});
      showStatus('Pantalla y Audio Conectados');
    }

    function playIptvStream(originalUrl, name = 'Canal IPTV') {
      if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
      ytWrapper.classList.add('hidden');
      hlsWrapper.classList.remove('hidden');

      if (hls) {
        hls.destroy();
        hls = null;
      }

      showStatus(`Sintonizando: ${name}...`);

      // Si la URL es HTTP y estamos en HTTPS, pasamos a través del proxy seguro
      let streamUrl = originalUrl;
      if (window.location.protocol === 'https:' && originalUrl.startsWith('http://')) {
        streamUrl = `/api/iptv/stream?url=${encodeURIComponent(originalUrl)}`;
      }

      function tryNative(fallbackUrl) {
        iptvVideo.src = fallbackUrl;
        iptvVideo.play().catch(e => {
          console.log('Error native playback:', e);
          showStatus('Error de señal en este canal');
        });
      }

      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          manifestLoadingTimeOut: 10000,
          manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 10000
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(iptvVideo);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          iptvVideo.play().catch(() => {
            iptvVideo.muted = true;
            iptvVideo.play();
          });
          showStatus(`En Vivo: ${name}`);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.log('Fallo HLS:', data.type, 'Probando proxy nativo...');
            hls.destroy();
            hls = null;
            // Reintento directo vía proxy o nativo
            tryNative(`/api/iptv/stream?url=${encodeURIComponent(originalUrl)}`);
          }
        });
      } else {
        tryNative(streamUrl);
      }
    }

    function playYtVideo(videoId) {
      if (hls) {
        iptvVideo.pause();
        hls.destroy();
        hls = null;
      }
      hlsWrapper.classList.add('hidden');
      ytWrapper.classList.remove('hidden');
      if (ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(videoId);
      }
      showStatus('Reproduciendo YouTube');
    }

    socket.on('execute-command', ({ action, payload }) => {
      if (action === 'playVideo') playYtVideo(payload.videoId);
      else if (action === 'playIptv') playIptvStream(payload.url, payload.name);
      else if (action === 'pause') {
        if (!hlsWrapper.classList.contains('hidden')) iptvVideo.pause();
        if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
      } else if (action === 'play') {
        if (!hlsWrapper.classList.contains('hidden')) iptvVideo.play();
        if (ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
      } else if (action === 'seek') {
        if (ytPlayer && !ytWrapper.classList.contains('hidden')) {
          const currentTime = ytPlayer.getCurrentTime();
          ytPlayer.seekTo(currentTime + payload.seconds, true);
        }
      }
    });
  </script>
</body>
</html>
