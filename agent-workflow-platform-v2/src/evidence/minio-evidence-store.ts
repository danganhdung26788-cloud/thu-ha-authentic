import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'minio';
import { getEnv } from '../config/env.js';

export type EvidenceDescriptor = Readonly<{
  evidenceId: string;
  objectKey: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
}>;

export class MinioEvidenceStore {
  readonly #client: Client;
  readonly #bucket: string;

  constructor() {
    const env = getEnv();
    this.#client = new Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
    });
    this.#bucket = env.MINIO_BUCKET;
  }

  async ensureBucket(): Promise<void> {
    if (!(await this.#client.bucketExists(this.#bucket))) {
      await this.#client.makeBucket(this.#bucket);
    }
  }

  async put(
    ownerId: string,
    workspaceId: string,
    taskId: string,
    content: Buffer,
    mediaType: string,
    filename = 'evidence.bin',
  ): Promise<EvidenceDescriptor> {
    await this.ensureBucket();
    const evidenceId = `EVD-${randomUUID()}`;
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${ownerId}/${workspaceId}/${taskId}/${evidenceId}/${safeName}`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    await this.#client.putObject(this.#bucket, objectKey, content, content.length, {
      'Content-Type': mediaType,
      'X-Amz-Meta-Sha256': sha256,
    });
    return {
      evidenceId,
      objectKey,
      sha256,
      mediaType,
      sizeBytes: content.length,
    };
  }

  async healthCheck(): Promise<boolean> {
    await this.ensureBucket();
    return true;
  }
}
