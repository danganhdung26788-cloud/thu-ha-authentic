import {
  Queue,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
  type Processor,
} from 'bullmq';
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

function jobKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function defaultTaskJobId(data: TaskJobData): string {
  return [data.ownerId, data.workspaceId, data.taskId].map(jobKeySegment).join('--');
}

export function redisConnectionOptions(): ConnectionOptions {
  const url = new URL(getEnv().REDIS_URL);
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error(`Unsupported Redis protocol: ${url.protocol}`);
  }
  const database = url.pathname && url.pathname !== '/'
    ? Number.parseInt(url.pathname.slice(1), 10)
    : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error(`Invalid Redis database index: ${url.pathname}`);
  }
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || '6379', 10),
    db: database,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export function createTaskQueue(
  connection: ConnectionOptions = redisConnectionOptions(),
): Queue<TaskJobData, TaskJobResult> {
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
  const { jobId, ...rest } = options;
  const safeJobId = jobId ? jobKeySegment(String(jobId)) : defaultTaskJobId(data);
  await queue.add('execute-task', data, { jobId: safeJobId, ...rest });
}

export function createTaskWorker(
  processor: Processor<TaskJobData, TaskJobResult>,
  connection: ConnectionOptions = redisConnectionOptions(),
): Worker<TaskJobData, TaskJobResult> {
  return new Worker<TaskJobData, TaskJobResult>(getEnv().QUEUE_NAME, processor, {
    connection,
    concurrency: getEnv().WORKER_CONCURRENCY,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });
}
