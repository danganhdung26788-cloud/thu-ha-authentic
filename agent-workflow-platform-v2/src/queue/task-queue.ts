import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { getEnv } from '../config/env.js';

export type TaskJobData = Readonly<{
  taskId: string;
  ownerId: string;
  workspaceId: string;
  correlationId: string;
}>;

export type TaskJobResult = Readonly<{
  taskId: string;
  status: 'COMPLETED' | 'WAITING_APPROVAL' | 'RETRY_WAIT' | 'FAILED';
}>;

export function createRedisConnection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

export function createTaskQueue(connection = createRedisConnection()): Queue<TaskJobData, TaskJobResult> {
  return new Queue<TaskJobData, TaskJobResult>(getEnv().QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 20_000 },
      attempts: 1,
    },
  });
}

export async function enqueueTask(
  queue: Queue<TaskJobData, TaskJobResult>,
  data: TaskJobData,
  options: JobsOptions = {},
): Promise<void> {
  await queue.add('execute-task', data, {
    jobId: `${data.ownerId}:${data.workspaceId}:${data.taskId}`,
    ...options,
  });
}

export function createTaskWorker(
  processor: Processor<TaskJobData, TaskJobResult>,
  connection = createRedisConnection(),
): Worker<TaskJobData, TaskJobResult> {
  return new Worker<TaskJobData, TaskJobResult>(getEnv().QUEUE_NAME, processor, {
    connection,
    concurrency: getEnv().WORKER_CONCURRENCY,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });
}
