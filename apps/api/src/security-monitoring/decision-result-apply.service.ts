import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { DecisionResultJob } from './async-judgment.types';
import { AggregationService } from './aggregation.service';
import { JudgmentQueueService } from './judgment-queue.service';
import { SentryJudgeService } from './sentry-judge.service';

@Injectable()
export class DecisionResultApplyService implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<DecisionResultJob>;

  constructor(
    private readonly queues: JudgmentQueueService,
    private readonly judge: SentryJudgeService,
    private readonly aggregation: AggregationService,
  ) {}

  onModuleInit(): void {
    this.worker = this.queues.createResultWorker(async (result) => {
      await this.judge.applyAsyncResult(result);
      this.aggregation.invalidateWindowCache();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
