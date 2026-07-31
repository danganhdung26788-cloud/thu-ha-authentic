import { logger } from '../../observability/logger.js';
import { createTaskWorker } from '../../queue/task-queue.js';
import { ControlPlanePump } from './control-plane-pump.js';
import { processTaskJob } from './task-processor.js';

const worker = createTaskWorker(processTaskJob);
const pump = new ControlPlanePump();
const pumpTimer = setInterval(() => {
  void pump.tick().catch((error: unknown) => logger.error({ err: error }, 'Control-plane pump failed'));
}, 2_000);
pumpTimer.unref();
void pump.tick().catch((error: unknown) => logger.error({ err: error }, 'Initial control-plane pump failed'));

worker.on('ready', () => logger.info('Agent Workflow V2 worker ready'));
worker.on('completed', (job, result) => logger.info({ jobId: job.id, result }, 'Task job completed'));
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, err: error }, 'Task job failed at queue level'));
worker.on('stalled', (jobId) => logger.warn({ jobId }, 'BullMQ detected a stalled task job'));
worker.on('error', (error) => logger.error({ err: error }, 'Worker runtime error'));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown requested');
  clearInterval(pumpTimer);
  await worker.close();
  await pump.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
