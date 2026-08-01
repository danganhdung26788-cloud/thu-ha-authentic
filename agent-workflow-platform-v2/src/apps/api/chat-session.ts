import { createHmac, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';
import type { ChatIdentity } from '../../chat/types.js';

export const CHAT_SESSION_COOKIE = 'workflow_v2_chat_session';

type SessionPayload = Readonly<{
  version: 1;
  ownerId: string;
  workspaceId: string;
  expiresAt: number;
}>;

export type ChatAuthenticatedRequest = FastifyRequest & {
  chatIdentity: ChatIdentity;
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signingKey(): string {
  const env = getEnv();
  const key = env.API_AUTH_TOKEN;
  if (!key && env.NODE_ENV === 'production') {
    throw new Error('API_AUTH_TOKEN is required to sign the local chat session.');
  }
  return key ?? 'workflow-v2-development-session-key';
}

function signature(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export function issueChatSession(identity?: ChatIdentity): string {
  const env = getEnv();
  const payload: SessionPayload = {
    version: 1,
    ownerId: identity?.ownerId ?? env.DEFAULT_OWNER_ID,
    workspaceId: identity?.workspaceId ?? env.DEFAULT_WORKSPACE_ID,
    expiresAt: Math.floor(Date.now() / 1_000) + env.CHAT_SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function serializeChatSessionCookie(value: string): string {
  return [
    `${CHAT_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${getEnv().CHAT_SESSION_TTL_SECONDS}`,
  ].join('; ');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of header?.split(';') ?? []) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    result[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return result;
}

export function verifyChatSession(value: string): ChatIdentity | null {
  const [encoded, suppliedSignature, extra] = value.split('.');
  if (!encoded || !suppliedSignature || extra) return null;
  if (!constantTimeEqual(suppliedSignature, signature(encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (
      payload.version !== 1
      || typeof payload.ownerId !== 'string'
      || typeof payload.workspaceId !== 'string'
      || typeof payload.expiresAt !== 'number'
      || payload.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      return null;
    }
    return { ownerId: payload.ownerId, workspaceId: payload.workspaceId };
  } catch {
    return null;
  }
}

function bearerIdentity(request: FastifyRequest): ChatIdentity | null {
  const expected = getEnv().API_AUTH_TOKEN;
  const header = request.headers.authorization;
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) return null;
  return {
    ownerId: getEnv().DEFAULT_OWNER_ID,
    workspaceId: getEnv().DEFAULT_WORKSPACE_ID,
  };
}

function assertSameOrigin(request: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return;
  try {
    if (new URL(origin).host !== host) throw new UnauthorizedException('Cross-origin chat request rejected.');
  } catch (error) {
    if (error instanceof UnauthorizedException) throw error;
    throw new UnauthorizedException('Invalid request origin.');
  }
}

@Injectable()
export class ChatSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ChatAuthenticatedRequest>();
    assertSameOrigin(request);
    const identity = bearerIdentity(request)
      ?? verifyChatSession(parseCookies(request.headers.cookie)[CHAT_SESSION_COOKIE] ?? '');
    if (!identity) throw new UnauthorizedException('Local chat session is missing or expired.');
    request.chatIdentity = identity;
    return true;
  }
}
