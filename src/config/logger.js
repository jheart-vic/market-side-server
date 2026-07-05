import pino from 'pino';
import { env, isProd } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      }),
});
