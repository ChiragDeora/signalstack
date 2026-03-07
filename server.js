const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const next = require('next');
const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const server = express();
  const httpServer = createServer(server);

  // Socket.IO server
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Make io accessible to API routes via global
  global.__io = io;

  // Socket.IO connection handling
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  // Let Next.js handle all routes (catch-all). Avoid server.all('*') — Express 5 path-to-regexp rejects bare '*'.
  server.use((req, res) => handle(req, res));

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  httpServer.listen(PORT, HOST, (err) => {
    if (err) throw err;
    console.log(`\n🚀 SignalStack ready on http://localhost:${PORT}`);
    console.log(`📡 WebSocket server running`);
    console.log(`📊 EMA Crossover Detection Engine loaded\n`);

    const base = `http://127.0.0.1:${PORT}`;
    // Pre-warm the Dhan scrip master so the first search is instant
    fetch(`${base}/api/warmup`)
      .then(r => r.json())
      .then(d => console.log(d.ok ? '✅ Scrip master pre-loaded' : `⚠️  Warmup: ${d.reason}`))
      .catch(e => console.warn('⚠️  Warmup fetch failed:', e.message));
    // Restore persisted watches so monitoring runs 24/7 without opening the app
    fetch(`${base}/api/monitor`)
      .then(r => r.json())
      .then(d => (d.success && d.watchedSymbols?.length > 0 ? console.log('✅ Restored', d.watchedSymbols?.length, 'watch(es)') : null))
      .catch(e => console.warn('⚠️  Monitor restore fetch failed:', e.message));
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    httpServer.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    httpServer.close(() => process.exit(0));
  });
});
