import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ZodError } from 'zod';
import { CutoverStore } from '../../cutover/cutover-store.js';
import { ShadowRunStore } from '../../cutover/shadow-store.js';
import { ApiTokenGuard } from './api-token.guard.js';

@Controller('/v1/cutover')
@UseGuards(ApiTokenGuard)
export class CutoverController {
  readonly #cutover = new CutoverStore();
  readonly #shadow = new ShadowRunStore();

  @Get()
  state() {
    return this.#cutover.getState();
  }

  @Post('/transition')
  async transition(@Body() body: unknown) {
    try {
      return await this.#cutover.transition(body as never);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid cutover transition.', issues: error.issues });
      }
      if (error instanceof Error) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Post('/shadow-runs')
  async recordShadow(@Body() body: unknown) {
    try {
      return await this.#shadow.record(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid shadow result.', issues: error.issues });
      }
      throw error;
    }
  }

  @Get('/shadow-summary')
  summary(
    @Query('ownerId') ownerId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    if (!ownerId || !workspaceId) throw new BadRequestException('ownerId and workspaceId are required.');
    return this.#shadow.summary(ownerId, workspaceId);
  }
}
