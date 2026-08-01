import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { getEnv, resetEnvForTests } from '../src/config/env.js';
import { clamAvHealthCheck, scanBufferForMalware } from '../src/security/clamav-scanner.js';

async function startFakeClamAv(): Promise<Readonly<{ server: net.Server; port: number }>> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.subarray(0, 6).toString('ascii') === 'zPING\0') {
        socket.end(Buffer.from('PONG\0', 'ascii'));
        return;
      }
      const command = Buffer.from('zINSTREAM\0', 'ascii');
      if (buffer.length < command.length || !buffer.subarray(0, command.length).equals(command)) return;
      let offset = command.length;
      while (buffer.length >= offset + 4) {
        const length = buffer.readUInt32BE(offset);
        if (length === 0) {
          const infected = payload.includes(Buffer.from('malicious-marker', 'utf8'));
          socket.end(Buffer.from(
            infected ? 'stream: Unit-Test-Signature FOUND\0' : 'stream: OK\0',
            'utf8',
          ));
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        payload = Buffer.concat([payload, buffer.subarray(offset + 4, offset + 4 + length)]);
        offset += 4 + length;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake ClamAV did not bind to TCP.');
  return { server, port: address.port };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('ClamAV scanner health and INSTREAM protocol work with clean and detected files', async () => {
  const fake = await startFakeClamAv();
  resetEnvForTests();
  getEnv({
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: String(fake.port),
    CLAMAV_TIMEOUT_MS: '5000',
    CLAMAV_REQUIRED: 'true',
    CHAT_MAX_ATTACHMENT_BYTES: '26214400',
  });
  try {
    assert.equal(await clamAvHealthCheck(), true);
    const clean = await scanBufferForMalware(Buffer.from('ordinary document content', 'utf8'));
    assert.equal(clean.clean, true);
    assert.equal(clean.signature, null);
    const infected = await scanBufferForMalware(Buffer.from('contains malicious-marker here', 'utf8'));
    assert.equal(infected.clean, false);
    assert.equal(infected.signature, 'Unit-Test-Signature');
  } finally {
    resetEnvForTests();
    await closeServer(fake.server);
  }
});

test('ClamAV can be disabled only by explicit configuration', async () => {
  resetEnvForTests();
  getEnv({ CLAMAV_REQUIRED: 'false' });
  try {
    assert.equal(await clamAvHealthCheck(), true);
    const result = await scanBufferForMalware(Buffer.from('content', 'utf8'));
    assert.equal(result.clean, true);
    assert.equal(result.response, 'SCAN_DISABLED_BY_EXPLICIT_CONFIGURATION');
  } finally {
    resetEnvForTests();
  }
});
