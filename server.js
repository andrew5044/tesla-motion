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

// Endpoint para sugerencias en tiempo real (Autocompletado)
app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length === 0) return res.json({ suggestions: [] });
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&client=firefox&q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();
    const suggestions = Array.isArray(data[1]) ? data[1] : [];
    res.json({ suggestions });
  } catch (error) {
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

// API Xtream Codes: Obtener canales en vivo
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
cat << 'EOF' > public/remote.html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Control Copiloto</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #121214; color: #fff; padding: 18px; display: flex; flex-direction: column; min-height: 100vh; }
    
    .header { text-align: center; margin-bottom: 16px; }
    .header h2 { font-size: 20px; font-weight: 600; }
    .header p { color: #888; font-size: 13px; margin-top: 2px; }
    
    .tabs { display: flex; background: #1c1c1e; border-radius: 12px; padding: 4px; margin-bottom: 16px; }
    .tab-btn { flex: 1; padding: 10px; border: none; background: transparent; color: #888; font-weight: 600; font-size: 14px; border-radius: 8px; cursor: pointer; }
    .tab-btn.active { background: #2c2c2e; color: #fff; }

    .card { background: #1c1c1e; padding: 16px; border-radius: 14px; margin-bottom: 16px; border: 1px solid #2a2a2c; position: relative; }
    label { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; display: block; margin-bottom: 8px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 10px; position: relative; }
    input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #333; background: #000; color: #fff; font-size: 14px; }
    .btn-action { background: #e82127; color: #fff; border: none; padding: 12px 18px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; }

    /* Tira desplegable de sugerencias */
    .suggestions-dropdown {
      position: absolute; top: calc(100% - 2px); left: 0; right: 0;
      background: #1c1c1e; border: 1px solid #3a3a3c; border-radius: 8px;
      z-index: 100; max-height: 220px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      display: none;
    }
    .suggestion-item {
      padding: 12px 14px; font-size: 14px; color: #ddd; border-bottom: 1px solid #28282a;
      cursor: pointer; display: flex; align-items: center; gap: 10px;
    }
    .suggestion-item:last-child { border-bottom: none; }
    .suggestion-item:active { background: #2c2c2e; color: #fff; }
    .suggestion-icon { color: #888; font-size: 13px; }

    /* Resultados YouTube */
    .results-container { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; margin-top: 10px; }
    .video-card { display: flex; gap: 12px; background: #242426; border: 1px solid #333; padding: 8px; border-radius: 10px; align-items: center; cursor: pointer; }
    .video-card:active { border-color: #e82127; background: #2a2a2c; }
    .video-thumb { width: 90px; height: 55px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
    .video-info { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
    .video-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .video-meta { font-size: 11px; color: #888; margin-top: 4px; }

    /* Canales IPTV */
    .channel-item { display: flex; justify-content: space-between; align-items: center; background: #242426; padding: 10px 14px; border-radius: 10px; border: 1px solid #333; gap: 10px; }
    .channel-left { display: flex; align-items: center; gap: 10px; overflow: hidden; flex: 1; cursor: pointer; }
    .channel-logo { width: 32px; height: 32px; object-fit: contain; border-radius: 4px; background: #111; }
    .channel-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .channel-actions { display: flex; align-items: center; gap: 12px; }
    .fav-btn { background: none; border: none; font-size: 20px; cursor: pointer; color: #666; padding: 4px; }
    .fav-btn.is-fav { color: #ffd700; }
    .channel-play { font-size: 12px; color: #e82127; font-weight: bold; cursor: pointer; }

    /* Filtros IPTV */
    .filter-bar { display: flex; gap: 8px; margin-bottom: 8px; }
    .filter-btn { flex: 1; padding: 8px; background: #242426; border: 1px solid #333; border-radius: 8px; color: #aaa; font-size: 12px; font-weight: 600; cursor: pointer; }
    .filter-btn.active { background: #e82127; color: #fff; border-color: #e82127; }

    /* Controles */
    .controls-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ctrl-btn { background: #242426; border: 1px solid #333; color: #fff; padding: 14px 0; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .ctrl-btn:active { background: #333; }
    .btn-full { grid-column: span 3; background: #2c2c2e; }

    .hidden { display: none; }
  </style>
cat << 'EOF' > public/remote.html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Control Copiloto</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #121214; color: #fff; padding: 18px; display: flex; flex-direction: column; min-height: 100vh; }
    
    .header { text-align: center; margin-bottom: 16px; }
    .header h2 { font-size: 20px; font-weight: 600; }
    .header p { color: #888; font-size: 13px; margin-top: 2px; }
    
    .tabs { display: flex; background: #1c1c1e; border-radius: 12px; padding: 4px; margin-bottom: 16px; }
    .tab-btn { flex: 1; padding: 10px; border: none; background: transparent; color: #888; font-weight: 600; font-size: 14px; border-radius: 8px; cursor: pointer; }
    .tab-btn.active { background: #2c2c2e; color: #fff; }

    .card { background: #1c1c1e; padding: 16px; border-radius: 14px; margin-bottom: 16px; border: 1px solid #2a2a2c; position: relative; }
    label { font-size: 12px; color: #888; text-transform: uppercase; font-weight: 600; display: block; margin-bottom: 8px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 10px; position: relative; }
    input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #333; background: #000; color: #fff; font-size: 14px; }
    .btn-action { background: #e82127; color: #fff; border: none; padding: 12px 18px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; }

    /* Tira desplegable de sugerencias */
    .suggestions-dropdown {
      position: absolute; top: calc(100% - 2px); left: 0; right: 0;
      background: #1c1c1e; border: 1px solid #3a3a3c; border-radius: 8px;
      z-index: 100; max-height: 220px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      display: none;
    }
    .suggestion-item {
      padding: 12px 14px; font-size: 14px; color: #ddd; border-bottom: 1px solid #28282a;
      cursor: pointer; display: flex; align-items: center; gap: 10px;
    }
    .suggestion-item:last-child { border-bottom: none; }
    .suggestion-item:active { background: #2c2c2e; color: #fff; }
    .suggestion-icon { color: #888; font-size: 13px; }

    /* Resultados YouTube */
    .results-container { display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; margin-top: 10px; }
    .video-card { display: flex; gap: 12px; background: #242426; border: 1px solid #333; padding: 8px; border-radius: 10px; align-items: center; cursor: pointer; }
    .video-card:active { border-color: #e82127; background: #2a2a2c; }
    .video-thumb { width: 90px; height: 55px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
    .video-info { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
    .video-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .video-meta { font-size: 11px; color: #888; margin-top: 4px; }

    /* Canales IPTV */
    .channel-item { display: flex; justify-content: space-between; align-items: center; background: #242426; padding: 10px 14px; border-radius: 10px; border: 1px solid #333; gap: 10px; }
    .channel-left { display: flex; align-items: center; gap: 10px; overflow: hidden; flex: 1; cursor: pointer; }
    .channel-logo { width: 32px; height: 32px; object-fit: contain; border-radius: 4px; background: #111; }
    .channel-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .channel-actions { display: flex; align-items: center; gap: 12px; }
    .fav-btn { background: none; border: none; font-size: 20px; cursor: pointer; color: #666; padding: 4px; }
    .fav-btn.is-fav { color: #ffd700; }
    .channel-play { font-size: 12px; color: #e82127; font-weight: bold; cursor: pointer; }

    /* Filtros IPTV */
    .filter-bar { display: flex; gap: 8px; margin-bottom: 8px; }
    .filter-btn { flex: 1; padding: 8px; background: #242426; border: 1px solid #333; border-radius: 8px; color: #aaa; font-size: 12px; font-weight: 600; cursor: pointer; }
    .filter-btn.active { background: #e82127; color: #fff; border-color: #e82127; }

    /* Controles */
    .controls-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ctrl-btn { background: #242426; border: 1px solid #333; color: #fff; padding: 14px 0; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .ctrl-btn:active { background: #333; }
    .btn-full { grid-column: span 3; background: #2c2c2e; }

    .hidden { display: none; }
  </style>
</head>
<body>

  <div class="header">
    <h2>Control Multimedia Tesla</h2>
    <p>Sala: <strong style="color: #e82127;">TSLA-77</strong></p>
  </div>

  <div class="tabs">
    <button class="tab-btn active" id="tab-yt-btn" onclick="switchTab('yt')">YouTube</button>
    <button class="tab-btn" id="tab-iptv-btn" onclick="switchTab('iptv')">IPTV (Xtream)</button>
  </div>

  <!-- Pestaña YouTube -->
  <div id="section-yt">
    <div class="card">
      <label>Buscar vídeos en YouTube</label>
      <div class="search-row">
        <input type="text" id="searchInput" placeholder="Escribe el nombre o tema..." autocomplete="off" oninput="onSearchInput(this.value)" onkeydown="if(event.key==='Enter') executeSearch(this.value)">
        <button class="btn-action" onclick="executeSearch(document.getElementById('searchInput').value)">Buscar</button>
        <!-- Tira de sugerencias -->
        <div class="suggestions-dropdown" id="suggestionsBox"></div>
      </div>
      <div id="loadingText" style="display:none; font-size:13px; color:#888; text-align:center; padding:10px;">Buscando vídeos...</div>
      <div class="results-container" id="resultsContainer"></div>
    </div>

    <div class="card">
      <label>O enviar URL directa</label>
      <div class="search-row">
        <input type="text" id="ytUrl" placeholder="https://youtu.be/...">
        <button class="btn-action" onclick="sendDirectUrl()">Enviar</button>
      </div>
    </div>
  </div>

  <!-- Pestaña IPTV -->
  <div id="section-iptv" class="hidden">
    <div class="card" id="iptv-login-box">
      <label>Conexión IPTV (Xtream Codes)</label>
      <input type="text" id="iptvHost" placeholder="Servidor (ej: http://iptvpro.me:8080)" style="margin-bottom:8px;">
      <input type="text" id="iptvUser" placeholder="Usuario" style="margin-bottom:8px;">
      <input type="password" id="iptvPass" placeholder="Contraseña" style="margin-bottom:8px;">
      <button class="btn-action" style="width:100%;" onclick="loadXtreamChannels()">Conectar y Cargar Canales</button>
      <div id="iptvStatus" style="font-size:12px; color:#aaa; margin-top:8px; text-align:center;"></div>
    </div>

    <div class="card hidden" id="iptv-channels-box">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <label style="margin:0;">Canales (<span id="chCount">0</span>)</label>
        <button onclick="resetIptvLogin()" style="background:none; border:none; color:#e82127; font-size:12px; cursor:pointer;">Cambiar Cuenta</button>
      </div>

      <div class="filter-bar">
        <button class="filter-btn active" id="filter-all-btn" onclick="setChannelFilter('all')">Todos</button>
        <button class="filter-btn" id="filter-fav-btn" onclick="setChannelFilter('fav')">⭐ Favoritos (<span id="favCount">0</span>)</button>
      </div>

      <input type="text" id="filterChannelInput" placeholder="Filtrar por nombre (ej: ESPN, Caracol, HBO)..." oninput="filterChannels()">
      <div class="results-container" id="channelsListContainer"></div>
    </div>
  </div>

  <!-- Controles universales -->
  <div class="card">
    <label>Controles de Reproducción</label>
    <div class="controls-grid">
      <button class="ctrl-btn" onclick="sendCommand('seek', { seconds: -10 })">-10s</button>
      <button class="ctrl-btn" onclick="sendCommand('play')">Play</button>
      <button class="ctrl-btn" onclick="sendCommand('seek', { seconds: 10 })">+10s</button>
      <button class="ctrl-btn btn-full" onclick="sendCommand('pause')">Pausar Reproducción</button>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const ROOM_ID = 'TSLA-77';
    let allChannels = [];
    let currentFilterMode = 'all';
    let favorites = JSON.parse(localStorage.getItem('iptv_favorites') || '[]');
    let suggestTimeout = null;

    socket.emit('join-room', ROOM_ID);

    window.onload = () => {
      updateFavCount();
      const savedHost = localStorage.getItem('iptv_host');
      const savedUser = localStorage.getItem('iptv_user');
      const savedPass = localStorage.getItem('iptv_pass');
      if (savedHost && savedUser && savedPass) {
        document.getElementById('iptvHost').value = savedHost;
        document.getElementById('iptvUser').value = savedUser;
        document.getElementById('iptvPass').value = savedPass;
        loadXtreamChannels();
      }
    };

    // Lógica de Autocompletado en Tiempo Real
    function onSearchInput(val) {
      clearTimeout(suggestTimeout);
      const box = document.getElementById('suggestionsBox');
      const text = val.trim();

      if (text.length < 2) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
      }

      // Esperar 250ms después de que el usuario deje de teclear
      suggestTimeout = setTimeout(async () => {
        try {
          const res = await fetch(`/api/suggest?q=${encodeURIComponent(text)}`);
          const data = await res.json();
          const items = data.suggestions || [];

          if (items.length === 0) {
            box.style.display = 'none';
            return;
          }

          box.innerHTML = items.slice(0, 7).map(term => `
            <div class="suggestion-item" onclick="selectSuggestion('${term.replace(/'/g, "\\'")}')">
              <span class="suggestion-icon">🔍</span>
              <span>${term}</span>
            </div>
          `).join('');
          box.style.display = 'block';
        } catch (e) {
          box.style.display = 'none';
        }
      }, 250);
    }

    function selectSuggestion(term) {
      document.getElementById('searchInput').value = term;
      document.getElementById('suggestionsBox').style.display = 'none';
      executeSearch(term);
    }

    // Ocultar sugerencias si se hace clic fuera
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-row')) {
        document.getElementById('suggestionsBox').style.display = 'none';
      }
    });

    async function executeSearch(query) {
      const q = query.trim();
      if (!q) return;

      document.getElementById('suggestionsBox').style.display = 'none';
      const loader = document.getElementById('loadingText');
      const container = document.getElementById('resultsContainer');
      loader.style.display = 'block';
      container.innerHTML = '';

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        loader.style.display = 'none';

        if (!data.results || data.results.length === 0) {
          container.innerHTML = '<div style="color:#888; font-size:13px; text-align:center;">Sin resultados</div>';
          return;
        }

        data.results.forEach(v => {
          const card = document.createElement('div');
          card.className = 'video-card';
          card.onclick = () => {
            socket.emit('send-command', {
              roomId: ROOM_ID,
              action: 'playVideo',
              payload: { videoId: v.videoId }
            });
          };
          card.innerHTML = `
            <img class="video-thumb" src="${v.thumbnail}" alt="thumb">
            <div class="video-info">
              <span class="video-title">${v.title}</span>
              <span class="video-meta">${v.author} • ${v.timestamp}</span>
            </div>
          `;
          container.appendChild(card);
        });
      } catch (e) {
        loader.style.display = 'none';
        container.innerHTML = '<div style="color:#e82127; font-size:13px; text-align:center;">Error al buscar</div>';
      }
    }

    function updateFavCount() {
      document.getElementById('favCount').textContent = favorites.length;
    }

    function toggleFavorite(channelId, event) {
      if (event) event.stopPropagation();
      const id = String(channelId);
      if (favorites.includes(id)) {
        favorites = favorites.filter(favId => favId !== id);
      } else {
        favorites.push(id);
      }
      localStorage.setItem('iptv_favorites', JSON.stringify(favorites));
      updateFavCount();
      filterChannels();
    }

    function setChannelFilter(mode) {
      currentFilterMode = mode;
      document.getElementById('filter-all-btn').classList.toggle('active', mode === 'all');
      document.getElementById('filter-fav-btn').classList.toggle('active', mode === 'fav');
      filterChannels();
    }

    function switchTab(mode) {
      const secYt = document.getElementById('section-yt');
      const secIptv = document.getElementById('section-iptv');
      const tabYt = document.getElementById('tab-yt-btn');
      const tabIptv = document.getElementById('tab-iptv-btn');

      if (mode === 'yt') {
        secYt.classList.remove('hidden');
        secIptv.classList.add('hidden');
        tabYt.classList.add('active');
        tabIptv.classList.remove('active');
      } else {
        secYt.classList.add('hidden');
        secIptv.classList.remove('hidden');
        tabYt.classList.remove('active');
        tabIptv.classList.add('active');
      }
    }

    function extractVideoId(url) {
      const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      return match ? match[1] : url.trim();
    }

    function sendDirectUrl() {
      const input = document.getElementById('ytUrl').value;
      if (!input) return;
      const videoId = extractVideoId(input);
      socket.emit('send-command', {
        roomId: ROOM_ID,
        action: 'playVideo',
        payload: { videoId }
      });
      document.getElementById('ytUrl').value = '';
    }

    async function loadXtreamChannels() {
      const host = document.getElementById('iptvHost').value.trim();
      const username = document.getElementById('iptvUser').value.trim();
      const password = document.getElementById('iptvPass').value.trim();
      const status = document.getElementById('iptvStatus');

      if (!host || !username || !password) return;

      status.textContent = 'Cargando canales...';
      status.style.color = '#888';

      try {
        const res = await fetch(`/api/iptv/channels?host=${encodeURIComponent(host)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`);
        const data = await res.json();

        if (data.error) {
          status.textContent = data.error;
          status.style.color = '#e82127';
          return;
        }

        allChannels = data.channels || [];
        localStorage.setItem('iptv_host', host);
        localStorage.setItem('iptv_user', username);
        localStorage.setItem('iptv_pass', password);

        document.getElementById('iptv-login-box').classList.add('hidden');
        document.getElementById('iptv-channels-box').classList.remove('hidden');
        document.getElementById('chCount').textContent = allChannels.length;

        filterChannels();
      } catch (e) {
        status.textContent = 'Error al conectar';
        status.style.color = '#e82127';
      }
    }

    function renderChannels(channels) {
      const container = document.getElementById('channelsListContainer');
      container.innerHTML = '';

      if (channels.length === 0) {
        container.innerHTML = '<div style="color:#888; font-size:13px; text-align:center; padding:15px;">Sin canales en esta vista</div>';
        return;
      }

      channels.forEach(ch => {
        const isFav = favorites.includes(String(ch.stream_id));
        const item = document.createElement('div');
        item.className = 'channel-item';

        const logoHtml = ch.logo ? `<img class="channel-logo" src="${ch.logo}" onerror="this.style.display='none'">` : '';

        item.innerHTML = `
          <div class="channel-left" onclick="playChannel('${ch.stream_url}', '${ch.name.replace(/'/g, "\\'")}')">
            ${logoHtml}
            <span class="channel-name">${ch.name}</span>
          </div>
          <div class="channel-actions">
            <button class="fav-btn ${isFav ? 'is-fav' : ''}" onclick="toggleFavorite('${ch.stream_id}', event)">
              ${isFav ? '★' : '☆'}
            </button>
            <span class="channel-play" onclick="playChannel('${ch.stream_url}', '${ch.name.replace(/'/g, "\\'")}')">VER ›</span>
          </div>
        `;
        container.appendChild(item);
      });
    }

    function playChannel(url, name) {
      socket.emit('send-command', {
        roomId: ROOM_ID,
        action: 'playIptv',
        payload: { url, name }
      });
    }

    function filterChannels() {
      const textQuery = document.getElementById('filterChannelInput').value.toLowerCase().trim();
      let filtered = allChannels;

      if (currentFilterMode === 'fav') {
        filtered = filtered.filter(c => favorites.includes(String(c.stream_id)));
      }

      if (textQuery) {
        filtered = filtered.filter(c => c.name.toLowerCase().includes(textQuery));
      }

      renderChannels(filtered.slice(0, 60));
    }

    function resetIptvLogin() {
      localStorage.removeItem('iptv_host');
      localStorage.removeItem('iptv_user');
      localStorage.removeItem('iptv_pass');
      document.getElementById('iptv-channels-box').classList.add('hidden');
      document.getElementById('iptv-login-box').classList.remove('hidden');
      document.getElementById('iptvStatus').textContent = '';
    }

    function sendCommand(action, payload = {}) {
      socket.emit('send-command', {
        roomId: ROOM_ID,
        action,
        payload
      });
    }
  </script>
</body>
</html>
