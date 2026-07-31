import { Controller, Get, Header } from '@nestjs/common';
import { ADMIN_PAGE } from './admin-page.js';

@Controller()
export class AdminWebController {
  @Get('/admin')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  page(): string {
    return ADMIN_PAGE;
  }
}
