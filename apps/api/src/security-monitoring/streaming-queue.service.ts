import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import { redisConnection } from './judgment-queue.service';
import { canonicalizeEvent } from './streaming-normalizer';
import {
  DEFAULT_CANONICAL_TOPIC,
  DEFAULT_EPISODES_TOPIC,
  DEFAULT_JUDGMENTS_TOPIC,
  JudgmentStreamEvent,
  STREAM_PUBLISH_QUEUE,
  StreamPublishJob,
  StreamingStatus,
} from './streaming.types';
import { DecisionResultJob } from './async-judgment.types';
import { JudgedEvent } from './types';

const STREAM_JOB_OPTIONS: JobsOptions = {
  attempts: 100,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 50_000 },
  removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
};

@Injectable()
export class StreamingQueueService implements OnModuleDestroy {
  readonly enabled = process.env.ANYSENTRY_STREAMING === 'on';
  readonly agentOnly = process.env.ANYSENTRY_STREAM_AGENT_ONLY !== 'off';
  private readonly canonicalTopic = process.env.ANYSENTRY_STREAM_CANONICAL_TOPIC || DEFAULT_CANONICAL_TOPIC;
  private readonly judgmentsTopic = process.env.ANYSENTRY_STREAM_JUDGMENTS_TOPIC || DEFAULT_JUDGMENTS_TOPIC;
  private readonly queue?: Queue<StreamPublishJob>;

  constructor() {
    if (!this.enabled) return;
    this.queue = new Queue<StreamPublishJob>(STREAM_PUBLISH_QUEUE, {
      connection: redisConnection(),
      defaultJobOptions: STREAM_JOB_OPTIONS,
    });
  }

  status(): StreamingStatus {
    return {
      enabled: this.enabled,
      agentOnly: this.agentOnly,
      brokerConfigured: Boolean(process.env.ANYSENTRY_STREAM_BOOTSTRAP_SERVERS),
      canonicalTopic: this.canonicalTopic,
      judgmentsTopic: this.judgmentsTopic,
      episodesTopic: process.env.ANYSENTRY_STREAM_EPISODES_TOPIC || DEFAULT_EPISODES_TOPIC,
      findingsTopic: process.env.ANYSENTRY_STREAM_FINDINGS_TOPIC || 'anysentry.stream.findings.v1',
      dlqTopic: process.env.ANYSENTRY_STREAM_DLQ_TOPIC || 'anysentry.stream.dlq.v1',
    };
  }

  async enqueueCanonical(event: JudgedEvent, observerLine: string): Promise<boolean> {
    if (!this.queue || (this.agentOnly && !isAgentStreamEvent(event))) return false;
    const job = this.canonicalJob(event, observerLine);
    await this.queue.add('publish-canonical-event', job, { jobId: `canonical-${job.messageId}` });
    return true;
  }

  async enqueueCanonicalBatch(
    events: ReadonlyArray<{ event: JudgedEvent; observerLine: string }>,
  ): Promise<number> {
    if (!this.queue) return 0;
    const jobs = events
      .filter(({ event }) => !this.agentOnly || isAgentStreamEvent(event))
      .map(({ event, observerLine }) => this.canonicalJob(event, observerLine));
    if (!jobs.length) return 0;
    await this.queue.addBulk(jobs.map((job) => ({
      name: 'publish-canonical-event',
      data: job,
      opts: { jobId: `canonical-${job.messageId}` },
    })));
    return jobs.length;
  }

  private canonicalJob(event: JudgedEvent, observerLine: string): StreamPublishJob {
    const payload = canonicalizeEvent(event, observerLine);
    return {
      schemaVersion: 'anysentry.stream_publish_job.v1',
      topic: this.canonicalTopic,
      key: [payload.tenantId, payload.environmentId, payload.agentCorrelationId].join(':'),
      messageId: payload.eventId,
      payload,
      queuedAt: Date.now(),
    };
  }

  async enqueueJudgment(result: DecisionResultJob): Promise<boolean> {
    if (!this.queue || (this.agentOnly && !isAgentStreamEvent(result.event))) return false;
    const payload = judgmentStreamEvent(result);
    const job: StreamPublishJob = {
      schemaVersion: 'anysentry.stream_publish_job.v1',
      topic: this.judgmentsTopic,
      key: payload.eventId,
      messageId: payload.judgmentId,
      payload,
      queuedAt: Date.now(),
    };
    await this.queue.add('publish-judgment-update', job, {
      jobId: `judgment-${result.evaluationId}-${result.stage}-${result.attempt}`,
    });
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}

export function judgmentStreamEvent(result: DecisionResultJob, publishedAt = Date.now()): JudgmentStreamEvent {
  const canonical = canonicalizeEvent(result.event, result.event.rawPreview ?? '');
  return {
    schemaVersion: 'anysentry.judgment_update.v1',
    judgmentId: [result.evaluationId, result.stage, result.attempt].join(':'),
    evaluationId: result.evaluationId,
    eventId: canonical.eventId,
    eventTime: canonical.eventTime,
    publishedAt,
    revision: result.attempt,
    policyVersion: result.policyVersion,
    stage: result.stage,
    status: result.status,
    verdict: result.decision?.verdict,
    severity: result.decision?.severity,
    reason: result.decision?.reason ?? result.error,
    riskCategory: result.decision?.risk?.category ?? result.decision?.risk?.riskType ?? result.decision?.risk?.risk_type,
    riskName: result.decision?.risk?.name,
    latencyMs: Math.max(0, result.completedAt - result.startedAt),
    attempt: result.attempt,
    awaitingL3: result.awaitingL3 === true,
    tenantId: canonical.tenantId,
    environmentId: canonical.environmentId,
    workspaceId: canonical.workspaceId,
    workspacePath: canonical.workspacePath,
    agentCorrelationId: canonical.agentCorrelationId,
    agentType: canonical.agentType,
    sessionId: canonical.sessionId,
    traceId: canonical.traceId,
    spanId: canonical.spanId,
    eventKind: canonical.eventKind,
    subject: canonical.subject,
  };
}

export function isAgentStreamEvent(event: JudgedEvent): boolean {
  const attribution = event.attribution;
  return attribution?.monitored === true
    && attribution.conflict !== true
    && typeof attribution.agentScopeId === 'string'
    && attribution.agentScopeId.trim().length > 0;
}
