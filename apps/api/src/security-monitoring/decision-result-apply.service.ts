import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { DecisionResultJob } from './async-judgment.types';
import { AggregationService } from './aggregation.service';
import { JudgmentQueueService } from './judgment-queue.service';
import { SentryJudgeService } from './sentry-judge.service';
import { StreamingQueueService } from './streaming-queue.service';

@Injectable()
export class DecisionResultApplyService implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<DecisionResultJob>;

  constructor(
    private readonly queues: JudgmentQueueService,
    private readonly judge: SentryJudgeService,
    private readonly aggregation: AggregationService,
    private readonly streaming: StreamingQueueService,
  ) {}

  onModuleInit(): void {
    this.worker = this.queues.createResultWorker(async (result) => {
      await this.judge.applyAsyncResult(result);
      this.aggregation.invalidateWindowCache();
      try {
        await this.streaming.enqueueJudgment(result);
      } catch (error) {
        console.error('[streaming] judgment outbox enqueue failed', {
          evaluationId: result.evaluationId,
          stage: result.stage,
          error: error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error).slice(0, 300),
        });
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
