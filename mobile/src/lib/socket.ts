/**
 * Single shared socket.io client. Reconnect-driven; the parent screen wires
 * up listeners for price:update / ema:update / alert:crossover / alert:rsi.
 */
import { io, Socket } from 'socket.io-client';
import { API_BASE_URL } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (socket) return socket; // reuse — let socket.io reconnect itself
  socket = io(API_BASE_URL, {
    path: '/socket.io',
    // Let socket.io use polling first then upgrade to websocket. Render's free
    // tier occasionally fails the ws upgrade on cold start, and websocket-only
    // leaves the client stuck OFFLINE forever in that case.
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });
  return socket;
}

export function joinUserRoom(userId: string) {
  const s = getSocket();
  if (s.connected) s.emit('join:user', userId);
  else s.once('connect', () => s.emit('join:user', userId));
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
