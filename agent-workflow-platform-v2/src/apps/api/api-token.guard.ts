import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class ApiTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = getEnv().API_AUTH_TOKEN;
    if (!expected) {
      if (getEnv().NODE_ENV === 'production') {
        throw new UnauthorizedException('API_AUTH_TOKEN is required in production.');
      }
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!supplied || !constantTimeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid API bearer token.');
    }
    return true;
  }
}
