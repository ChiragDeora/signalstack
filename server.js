const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const next = require('next');
require('dotenv').config();

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

  // Let Next.js handle all routes
  server.all('/{*path}', (req, res) => handle(req, res));

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`\n🚀 SignalStack ready on http://localhost:${PORT}`);
    console.log(`📡 WebSocket server running`);
    console.log(`📊 EMA Crossover Detection Engine loaded\n`);

    // Pre-warm the Dhan scrip master so the first search is instant
    fetch(`http://localhost:${PORT}/api/warmup`)
      .then(r => r.json())
      .then(d => console.log(d.ok ? '✅ Scrip master pre-loaded' : `⚠️  Warmup: ${d.reason}`))
      .catch(e => console.warn('⚠️  Warmup fetch failed:', e.message));
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    httpServer.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('\nSIGINT received, shutting down...');
    httpServer.close(() => process.exit(0));
  });
});
