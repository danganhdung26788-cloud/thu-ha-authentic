import net from 'node:net';
import { getEnv } from '../config/env.js';

export type MalwareScanResult = Readonly<{
  clean: boolean;
  scanner: 'clamav';
  signature: string | null;
  response: string;
}>;

function writeAsync(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off('error', onError);
      reject(error);
    };
    socket.once('error', onError);
    socket.write(data, (error) => {
      socket.off('error', onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

function collectResponse(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('ClamAV response timed out.'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      if (chunk.includes(0)) onEnd();
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/g, '').trim());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onError);
  });
}

async function connectClamAv(): Promise<net.Socket> {
  const env = getEnv();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('ClamAV connection timed out.'));
    }, env.CLAMAV_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function clamAvHealthCheck(): Promise<boolean> {
  const env = getEnv();
  if (!env.CLAMAV_REQUIRED) return true;
  const socket = await connectClamAv();
  try {
    const responsePromise = collectResponse(socket, env.CLAMAV_TIMEOUT_MS);
    await writeAsync(socket, Buffer.from('zPING\0', 'ascii'));
    const response = await responsePromise;
    return response === 'PONG';
  } finally {
    socket.destroy();
  }
}

export async function scanBufferForMalware(content: Buffer): Promise<MalwareScanResult> {
  const env = getEnv();
  if (!env.CLAMAV_REQUIRED) {
    return { clean: true, scanner: 'clamav', signature: null, response: 'SCAN_DISABLED_BY_EXPLICIT_CONFIGURATION' };
  }
  if (content.length > env.CHAT_MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment exceeds the configured malware scan limit.');
  }
  const socket = await connectClamAv();
  try {
    const responsePromise = collectResponse(socket, env.CLAMAV_TIMEOUT_MS);
    await writeAsync(socket, Buffer.from('zINSTREAM\0', 'ascii'));
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < content.length; offset += chunkSize) {
      const chunk = content.subarray(offset, Math.min(offset + chunkSize, content.length));
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(chunk.length, 0);
      await writeAsync(socket, length);
      await writeAsync(socket, chunk);
    }
    await writeAsync(socket, Buffer.alloc(4));
    const response = await responsePromise;
    if (/\bOK$/u.test(response)) {
      return { clean: true, scanner: 'clamav', signature: null, response };
    }
    const found = response.match(/:\s*(.+)\s+FOUND$/u);
    if (found) {
      return { clean: false, scanner: 'clamav', signature: found[1]?.trim() ?? 'UNKNOWN', response };
    }
    throw new Error(`ClamAV returned an unexpected response: ${response}`);
  } finally {
    socket.destroy();
  }
}
