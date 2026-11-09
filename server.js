const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API de sugerencias de YouTube (Autocompletado oficial JSONP/JSON)
app.get('/api/yt-suggest', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`;
  https.get(url, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.json(json[1] || []);
      } catch (e) {
        res.json([]);
      }
    });
  }).on('error', () => res.json([]));
});

// API de búsqueda básica de videos de YouTube sin API Key
app.get('/api/yt-search', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (resp) => {
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
      } catch (err) {
        res.json([]);
      }
    });
  }).on('error', () => res.json([]));
});

// Socket.io para enlace remoto
io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('send-command', ({ roomId, action, payload }) => {
    socket.to(roomId).emit('execute-command', { action, payload });
  });
});

server.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
