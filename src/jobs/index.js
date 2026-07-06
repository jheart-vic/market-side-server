// Background jobs (SPEC §2.13) — interval sweeps started by server.js after the
// DB connects. Each job is overlap-guarded (a slow run never stacks on itself)
// and failure-isolated (errors are logged, the next tick still fires).
// 60-second contracts make the settlement sweep the tight one (every 5s).

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as priceService from '../services/price.service.js';
import * as signalService from '../services/signal.service.js';

const timers = [];

function guarded(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, 'Job run failed');
    } finally {
      running = false;
    }
  };
}

export function startJobs() {
  timers.push(
    setInterval(guarded('price-refresh', priceService.refreshCache), env.PRICE_REFRESH_SECONDS * 1000),
    setInterval(guarded('signal-release', signalService.releaseDueSignals), 60 * 1000),
    setInterval(guarded('signal-settle', signalService.settleDuePositions), 5 * 1000),
  );
  logger.info('Background jobs started (price refresh, signal release, signal settlement)');
}

export function stopJobs() {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}