import { logger } from '../../observability/logger.js';
import { createTaskWorker } from '../../queue/task-queue.js';
import { processTaskJob } from './task-processor.js';

const worker = createTaskWorker(processTaskJob);

worker.on('ready', () => logger.info('Agent Workflow V2 worker ready'));
worker.on('completed', (job, result) => logger.info({ jobId: job.id, result }, 'Task job completed'));
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, err: error }, 'Task job failed at queue level'));
worker.on('stalled', (jobId) => logger.warn({ jobId }, 'BullMQ detected a stalled task job'));
worker.on('error', (error) => logger.error({ err: error }, 'Worker runtime error'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutdown requested');
  await worker.close();
  process.exitCode = 0;
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
