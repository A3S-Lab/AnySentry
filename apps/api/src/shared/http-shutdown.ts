import type { Request, Response, NextFunction } from 'express';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { defer, finalize } from 'rxjs';

type Entry = {
  response: Response;
  handler: boolean;
  done: boolean;
  finished: boolean;
  method: string;
  path: string;
  streamRequested: boolean;
  phase?: string;
};

const HTTP_SHUTDOWN_ENTRY = Symbol('anysentry.http-shutdown-entry');
type TrackedRequest = Request & { [HTTP_SHUTDOWN_ENTRY]?: Entry };

/** Add bounded diagnostic context without coupling controllers to the shutdown coordinator. */
export function setHttpShutdownPhase(request: Request | undefined | null, phase: string): void {
  if (!request) return;
  const entry = (request as TrackedRequest)[HTTP_SHUTDOWN_ENTRY];
  if (entry) entry.phase = phase.replace(/[^a-z0-9_.:-]/giu, '_').slice(0, 80);
}

/** Admission and execution tracking are separate: a disconnected socket is not a completed write. */
export class HttpShutdown implements NestInterceptor {
  private draining = false;
  private entries = new Map<Response, Entry>();
  private waiters = new Set<() => void>();

  middleware = (_req: Request, response: Response, next: NextFunction) => {
    if (this.draining) {
      response.setHeader('Connection', 'close');
      response.setHeader('Retry-After', '1');
      response.status(503).json({ code: 'SERVICE_DRAINING', retrySafe: true });
      return;
    }
    const entry: Entry = {
      response,
      handler: false,
      done: false,
      finished: false,
      method: _req.method,
      path: _req.originalUrl.split('?')[0].slice(0, 240),
      streamRequested: String(_req.headers.accept || '').includes('text/event-stream'),
    };
    (_req as TrackedRequest)[HTTP_SHUTDOWN_ENTRY] = entry;
    this.entries.set(response, entry);
    response.once('finish', () => {
      entry.finished = true;
      if (!entry.handler || entry.done) this.release(response);
    });
    // Do not release on socket close: an async controller can still be committing a receipt.
    next();
  };

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const entry = this.entries.get(response);
    if (entry) entry.handler = true;
    return defer(() => next.handle()).pipe(finalize(() => {
      if (!entry) return;
      entry.done = true;
      if (entry.finished || response.destroyed) this.release(response);
    }));
  }

  private release(response: Response) {
    this.entries.delete(response);
    if (!this.entries.size) for (const resolve of this.waiters) resolve();
  }

  pending() { return this.entries.size; }

  pendingSummary() {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      const key = `${entry.method} ${entry.path}${entry.streamRequested ? ' [stream]' : ''}`
        + `${entry.phase ? ` [${entry.phase}]` : ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([route, count]) => ({ route, count }));
  }

  begin() {
    this.draining = true;
    for (const { response, streamRequested } of this.entries.values()) {
      if (!response.headersSent) response.setHeader('Connection', 'close');
      // Read-only SSE subscriptions are intentionally ended; clients can reconnect after rollout.
      if (streamRequested || String(response.getHeader('content-type') || '').startsWith('text/event-stream')) {
        response.end();
      }
    }
  }

  waitForRequests() {
    if (!this.entries.size) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { this.waiters.delete(done); resolve(); };
      this.waiters.add(done);
    });
  }
}

function deadline(work: () => Promise<void>, ms: number, phase: string) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} deadline exceeded (${ms}ms)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Own SIGTERM/SIGINT instead of Nest's listener, so admission drains BEFORE provider hooks. */
export function shutdownCoordinator(options: {
  gate: HttpShutdown;
  close: (signal: string) => Promise<void>;
  exit: (code: number) => void;
  log?: (message: string) => void;
  requestMs?: number;
  closeMs?: number;
}) {
  let running: Promise<void> | undefined;
  const log = options.log ?? console.error;
  return (signal: string): Promise<void> => {
    if (running) return running;
    options.gate.begin();
    running = (async () => {
      try {
        log(
          `[shutdown] admission closed; pending=${options.gate.pending()}; `
          + `routes=${JSON.stringify(options.gate.pendingSummary())}; signal=${signal}`,
        );
        await deadline(() => options.gate.waitForRequests(), options.requestMs ?? 20_000, 'http-drain');
        log('[shutdown] HTTP drained; closing providers');
        await deadline(() => options.close(signal), options.closeMs ?? 30_000, 'provider-close');
        log('[shutdown] complete');
        options.exit(0);
      } catch (error) {
        // No successful shutdown declaration, no fabricated receipt, and no silent wait for SIGKILL.
        log(`[shutdown] INCOMPLETE pending=${options.gate.pending()} routes=${JSON.stringify(options.gate.pendingSummary())}: ${(error as Error).message}`);
        options.exit(1);
      }
    })();
    return running;
  };
}
