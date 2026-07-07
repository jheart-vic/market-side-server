import http from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { logger } from './config/logger.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { initSocket } from './socket/index.js';
import './models/index.js'; // register all schemas up front

const server = http.createServer(app);
const socketGateway = initSocket(server);

async function start() {
  await connectDb();
  startJobs();
  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  stopJobs();
  socketGateway.close();
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
