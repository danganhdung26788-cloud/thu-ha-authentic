import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CHAT_PAGE } from './chat-page.js';
import { issueChatSession, serializeChatSessionCookie } from './chat-session.js';

@Controller()
export class ChatWebController {
  @Get('/')
  root(@Res() reply: FastifyReply): void {
    reply.redirect('/app');
  }

  @Get('/app')
  @Header('content-type', 'text/html; charset=utf-8')
  app(@Res({ passthrough: true }) reply: FastifyReply): string {
    reply.header('set-cookie', serializeChatSessionCookie(issueChatSession()));
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return CHAT_PAGE;
  }
}
