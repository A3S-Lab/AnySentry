import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions, JobsOptions, Queue, Worker, WorkerOptions } from 'bullmq';
import {
  DECISION_RESULTS_QUEUE,
  DecisionResultJob,
  FAST_JUDGE_QUEUE,
  FastJudgeJob,
  L3_JOBS_QUEUE,
  L3JudgeJob,
} from './async-judgment.types';

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 20_000 },
};

function resultApplyConcurrency(): number {
  const parsed = Number(process.env.ANYSENTRY_RESULT_APPLY_CONCURRENCY || 128);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(512, Math.trunc(parsed))) : 128;
}

export function redisConnection(urlText = process.env.ANYSENTRY_REDIS_URL || 'redis://redis:6379/0'): ConnectionOptions {
  const url = new URL(urlText);
  const dbText = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: dbText ? Number(dbText) : 0,
    maxRetriesPerRequest: null,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Injectable()
export class JudgmentQueueService implements OnModuleDestroy {
  readonly enabled = process.env.ANYSENTRY_ASYNC_JUDGE === 'on';
  readonly connection = redisConnection();
  private readonly fastQueue?: Queue<FastJudgeJob>;
  private readonly l3Queue?: Queue<L3JudgeJob>;
  private readonly resultQueue?: Queue<DecisionResultJob>;

  constructor() {
    if (!this.enabled) return;
    this.fastQueue = new Queue<FastJudgeJob>(FAST_JUDGE_QUEUE, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.l3Queue = new Queue<L3JudgeJob>(L3_JOBS_QUEUE, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.resultQueue = new Queue<DecisionResultJob>(DECISION_RESULTS_QUEUE, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  }

  async enqueueFast(job: FastJudgeJob): Promise<void> {
    if (!this.fastQueue) throw new Error('asynchronous judgment queue is disabled');
    await this.fastQueue.add('judge-by-identity-route', job, {
      jobId: job.evaluationId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }

  async enqueueL3(job: L3JudgeJob): Promise<void> {
    if (!this.l3Queue) throw new Error('L3 queue is disabled');
    await this.l3Queue.add('deep-investigation', job, {
      jobId: job.evaluationId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }

  async enqueueResult(result: DecisionResultJob): Promise<void> {
    if (!this.resultQueue) throw new Error('decision result queue is disabled');
    await this.resultQueue.add('apply-decision', result, {
      jobId: [result.evaluationId, result.stage].join('-'),
      attempts: 10,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  }

  createResultWorker(processor: (result: DecisionResultJob) => Promise<void>, options: Partial<WorkerOptions> = {}): Worker<DecisionResultJob> | undefined {
    if (!this.enabled) return undefined;
    return new Worker<DecisionResultJob>(
      DECISION_RESULTS_QUEUE,
      async (job) => processor(job.data),
      { connection: this.connection, concurrency: resultApplyConcurrency(), ...options },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.fastQueue?.close(), this.l3Queue?.close(), this.resultQueue?.close()]);
  }
}
