import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** Mark a handler (e.g. SSE) so the response wrapper leaves its stream untouched. */
export const SkipWrap = () => SetMetadata('skipWrap', true);

/** Wrap every JSON response as { code, message, data, requestId, timestamp }. */
@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.reflector.get<boolean>('skipWrap', ctx.getHandler())) return next.handle();
    return next.handle().pipe(
      map((data) => ({
        code: 200,
        message: 'Success',
        data,
        requestId: randomUUID(),
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
