import pino from 'pino';
import { getEnv } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.apiKey',
  '*.token',
  '*.secret',
  '*.password',
  'OPENAI_API_KEY',
  'MINIO_SECRET_KEY',
];

export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  base: {
    service: 'agent-workflow-platform-v2',
    environment: getEnv().NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
