import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info({ uri: env.MONGODB_URI.replace(/\/\/.*@/, '//***@') }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}
