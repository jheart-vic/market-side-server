// Socket.IO gateway (SPEC §2.5 price push / §2.9 notification push).
// Attaches to the HTTP server, authenticates the handshake from the ms_access
// cookie (same jose verification as middleware/auth), and joins sockets to
// their rooms: user:<id> for personal notifications, plus 'admins' for staff.
// Anonymous sockets stay connected for the public broadcasts (prices,
// announcements, signal releases) — an invalid/expired token never drops the
// connection, it just means no private room.
//
// Events emitted:
//   'prices'          → every successful PriceService refresh (all quotes)
//   'notification'    → on notifyUser/notifyAdmins (room-scoped)
//   'announcement'    → announcement publish fan-out (broadcast)
//   'signal_released' → daily signal release (broadcast)

import { Server } from 'socket.io';
import { jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { COOKIES } from '../config/constants.js';
import * as notificationService from '../services/notification.service.js';
import * as priceService from '../services/price.service.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

function readAccessToken(handshake) {
  const header = handshake.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIES.access) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = readAccessToken(socket.handshake);
      if (token) {
        const { payload } = await jwtVerify(token, accessSecret);
        socket.data.userId = String(payload.sub);
        socket.data.role = payload.role ?? 'user';
      }
    } catch {
      // anonymous socket — public events only
    }
    next();
  });

  io.on('connection', (socket) => {
    const { userId, role } = socket.data;
    if (userId) {
      socket.join(notificationService.userRoom(userId));
      if (role === 'admin' || role === 'superadmin') {
        socket.join(notificationService.ADMIN_ROOM);
      }
    }
  });

  notificationService.bindSocketServer(io);
  const unsubscribePrices = priceService.onPriceUpdate((prices) => io.emit('prices', prices));

  logger.info('Socket.IO gateway ready (rooms user:<id> + admins; events: prices, notification, announcement, signal_released)');

  return {
    io,
    close() {
      unsubscribePrices();
      io.close();
    },
  };
}
