import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Response } from 'express';

function publicMessage(exception: unknown): string {
  if (!(exception instanceof HttpException)) return '服务内部错误';
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : exception.message;
}

@Catch()
export class OpenPlatformExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = host.switchToHttp().getResponse<Response>();
    response.status(statusCode).json({
      code: statusCode,
      status: HttpStatus[statusCode] ?? 'ERROR',
      message: publicMessage(exception),
      requestId: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }
}
