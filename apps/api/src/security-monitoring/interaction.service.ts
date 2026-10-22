import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  Admin,
  Consumer,
  Kafka,
  logLevel,
  Producer,
  SASLOptions,
} from 'kafkajs';
import { ClickHouseStore } from './clickhouse-store';
import { InteractionContentStore } from './interaction-content.store';
import {
  INTERACTION_CONTENT_MAX_BYTES,
  INTERACTION_KAFKA_SCHEMA,
  InteractionConversationDetail,
  InteractionConversationList,
  InteractionContentRecord,
  InteractionInstructionRecord,
  InteractionMetadataIngest,
  InteractionRecord,
  InteractionReceipt,
  deduplicateInteractionRecords,
  interactionContentRef,
  interactionContentMetadata,
  interactionInstructionRecord,
  interactionPayloadFingerprint,
  interactionRecord,
  interactionResponseRecord,
  summarizeInteractionRecords,
  validateInteractionInstructionIngest,
  validateInteractionInstructionMetadataIngest,
  validateInteractionMetadataIngest,
  validateInteractionResponseIngest,
  validateInteractionResponseMetadataIngest,
} from './interaction.types';
import {
  extractAssistantResponse,
  extractUserInstruction,
  isLlmShapedRow,
  isUosContentInteractionId,
  parseUosPayload,
  uosBaseInteractionId,
  uosConversationAnchor,
  uosConversationId,
  uosRowToRecords,
} from './interaction-uos-plaintext';
import { RelationalBusinessStore } from './relational-business-store.service';
import { canonicalProcessLifecycleIdentity } from './process-lifecycle';

const DEFAULT_TOPIC = 'anysentry.interactions.v1';
const DEFAULT_GROUP = 'anysentry-interaction-projection-v1';
const MAX_INGEST_BYTES = 64 * 1024;
const MAX_CONTENT_INGEST_BYTES = INTERACTION_CONTENT_MAX_BYTES + 32 * 1024;
const MAX_QUERY_RECORDS = 10_000;

export interface InteractionSourceContext {
  sourceId: string;
  tenantId?: string;
  environmentId?: string;
  workspacePath?: string;
}

export interface InteractionQuery {
  limit?: number;
  collectorId?: string;
  agentInstanceId?: string;
  workspacePath?: string;
  since?: number;
  until?: number;
  /** Read-only consumers may select the ClickHouse projection and avoid a degraded SQL pool. */
  projection?: 'auto' | 'clickhouse' | 'postgresql';
}

export interface RuntimeInstructionObservation {
  record: InteractionInstructionRecord;
  contentAvailability: 'available' | 'deleted' | 'unavailable' | 'not_authorized' | 'not_requested';
  content?: string;
}

function envEnabled(name: string): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env[name]?.trim() ?? '');
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.trunc(parsed)))
    : fallback;
}

function kafkaSasl(): SASLOptions | undefined {
  const username = process.env.ANYSENTRY_STREAM_USERNAME;
  const password = process.env.ANYSENTRY_STREAM_PASSWORD;
  const mechanism = process.env.ANYSENTRY_STREAM_SASL_MECHANISM;
  if (!username || !password) return undefined;
  if (mechanism === 'plain') return { mechanism: 'plain', username, password };
  if (mechanism === 'scram-sha-256') {
    return { mechanism: 'scram-sha-256', username, password };
  }
  if (mechanism === 'scram-sha-512') {
    return { mechanism: 'scram-sha-512', username, password };
  }
  return undefined;
}

export function parseInteractionKafkaRecord(value: Buffer | null): InteractionRecord {
  if (!value) throw new Error('interaction Kafka payload is empty');
  if (value.byteLength > MAX_INGEST_BYTES * 2) {
    throw new Error('interaction Kafka payload exceeds the projection limit');
  }
  const parsed = JSON.parse(value.toString('utf8')) as Partial<InteractionRecord>;
  if (
    !parsed.interactionId
    || !parsed.conversationId
    || !parsed.sourceId
    || !parsed.sourceEventId
  ) {
    throw new Error('interaction projection record is missing its stable identity');
  }
  if (
    typeof parsed.sourceId !== 'string'
    || typeof parsed.tenantId !== 'string'
    || !Number.isSafeInteger(parsed.acceptedAt)
    || Number(parsed.acceptedAt) <= 0
  ) {
    throw new Error('interaction projection record has invalid producer-owned metadata');
  }
  let reconstructed: InteractionRecord;
  if (parsed.eventType === 'LlmTransportObserved') {
    // Re-run the public metadata validator on the producer-owned subset. This ensures a corrupt or
    // manually produced Kafka message cannot smuggle content into either projection.
    const input = validateInteractionMetadataIngest({
      schemaVersion: parsed.schemaVersion,
      eventType: parsed.eventType,
      sourceEventId: parsed.sourceEventId,
      collectorId: parsed.collectorId,
      observedAt: parsed.observedAt,
      agentInstanceId: parsed.agentInstanceId,
      workspacePath: parsed.workspacePath,
      process: parsed.process,
      transport: parsed.transport,
      capture: parsed.capture,
    });
    reconstructed = interactionRecord(input, {
      sourceId: parsed.sourceId as string,
      tenantId: parsed.tenantId as string,
      environmentId: parsed.environmentId,
      workspacePath: input.workspacePath,
    }, Number(parsed.acceptedAt));
  } else if (parsed.eventType === 'AgentInputObserved') {
    const instruction = parsed.userInstruction;
    if (
      !instruction
      || typeof instruction !== 'object'
      || !('contentRef' in instruction)
      || typeof instruction.contentRef !== 'string'
    ) {
      throw new Error('Interaction instruction projection has no contentRef');
    }
    const input = validateInteractionInstructionMetadataIngest({
      schemaVersion: parsed.schemaVersion,
      eventType: parsed.eventType,
      sourceEventId: parsed.sourceEventId,
      collectorId: parsed.collectorId,
      observedAt: parsed.observedAt,
      agentInstanceId: parsed.agentInstanceId,
      workspacePath: parsed.workspacePath,
      turn: parsed.turn,
      process: parsed.process,
      runtime: parsed.runtime,
      input: parsed.input,
      capture: parsed.capture,
      userInstruction: {
        eventType: instruction.eventType,
        messageRole: instruction.messageRole,
        contentBytes: instruction.contentBytes,
        contentSha256: instruction.contentSha256,
      },
    });
    reconstructed = interactionInstructionRecord(input, {
      sourceId: parsed.sourceId as string,
      tenantId: parsed.tenantId as string,
      environmentId: parsed.environmentId,
      workspacePath: input.workspacePath,
    }, instruction.contentRef, Number(parsed.acceptedAt));
  } else if (parsed.eventType === 'AgentOutputObserved') {
    const response = parsed.assistantResponse;
    if (
      !response
      || typeof response !== 'object'
      || !('contentRef' in response)
      || typeof response.contentRef !== 'string'
    ) {
      throw new Error('Interaction response projection has no contentRef');
    }
    const input = validateInteractionResponseMetadataIngest({
      schemaVersion: parsed.schemaVersion,
      eventType: parsed.eventType,
      sourceEventId: parsed.sourceEventId,
      collectorId: parsed.collectorId,
      observedAt: parsed.observedAt,
      agentInstanceId: parsed.agentInstanceId,
      workspacePath: parsed.workspacePath,
      turn: parsed.turn,
      process: parsed.process,
      runtime: parsed.runtime,
      output: parsed.output,
      capture: parsed.capture,
      assistantResponse: {
        eventType: response.eventType,
        messageRole: response.messageRole,
        phase: response.phase,
        contentBytes: response.contentBytes,
        contentSha256: response.contentSha256,
      },
    });
    reconstructed = interactionResponseRecord(input, {
      sourceId: parsed.sourceId as string,
      tenantId: parsed.tenantId as string,
      environmentId: parsed.environmentId,
      workspacePath: input.workspacePath,
    }, response.contentRef, Number(parsed.acceptedAt));
  } else {
    throw new Error('unsupported Interaction projection event type');
  }
  if (
    reconstructed.interactionId !== parsed.interactionId
    || reconstructed.conversationId !== parsed.conversationId
    || reconstructed.processInstanceId !== parsed.processInstanceId
  ) {
    throw new Error('interaction projection record stable identity does not match its metadata');
  }
  // Return only a freshly reconstructed allow-listed record. Unknown Kafka fields are discarded,
  // so a manually produced message cannot bypass the public content-key rejection.
  return reconstructed;
}

@Injectable()
export class InteractionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InteractionService.name);
  private readonly featureEnabled = envEnabled('ANYSENTRY_INTERACTIONS');
  private readonly uosPlaintextEnabled = !/^(?:0|false|off|no)$/iu.test(
    process.env.ANYSENTRY_INTERACTION_UOS_PLAINTEXT?.trim() ?? 'on',
  );
  private readonly uosDirectViewEnabled = envEnabled('ANYSENTRY_INTERACTION_UOS_DIRECT_VIEW');
  private readonly topic = process.env.ANYSENTRY_INTERACTION_TOPIC?.trim() || DEFAULT_TOPIC;
  private readonly groupId =
    process.env.ANYSENTRY_INTERACTION_CONSUMER_GROUP?.trim() || DEFAULT_GROUP;
  private producer?: Producer;
  private consumer?: Consumer;
  private admin?: Admin;
  private consumerRun?: Promise<void>;
  private ready = false;
  private closing = false;
  private lastDurabilityError?: string;
  private readonly projectionErrors = new Map<string, string>();
  private inFlightRequests = 0;
  private inFlightBytes = 0;
  private readonly maxInFlightRequests = boundedInteger(
    process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_REQUESTS,
    512,
    1,
    10_000,
  );
  private readonly maxInFlightBytes = boundedInteger(
    process.env.ANYSENTRY_INTERACTION_MAX_INFLIGHT_BYTES,
    16 * 1024 * 1024,
    64 * 1024,
    256 * 1024 * 1024,
  );
  private readonly counters = {
    accepted: 0,
    rejected: 0,
    projected: 0,
    projectionBatches: 0,
    projectionDuplicates: 0,
    projectionFailures: 0,
    duplicates: 0,
    lastAcceptedAt: undefined as number | undefined,
    lastProjectedAt: undefined as number | undefined,
  };

  constructor(
    private readonly relational: RelationalBusinessStore,
    private readonly clickhouse: ClickHouseStore,
    private readonly contents: InteractionContentStore,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.featureEnabled) return;
    try {
      await this.start();
    } catch (error) {
      this.lastDurabilityError = error instanceof Error ? error.message : String(error);
      this.logger.error(`Interaction lane is unavailable: ${this.lastDurabilityError}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await this.consumer?.stop().catch(() => undefined);
    await this.consumerRun?.catch(() => undefined);
    await Promise.allSettled([
      this.consumer?.disconnect(),
      this.producer?.disconnect(),
      this.admin?.disconnect(),
    ]);
    this.consumer = undefined;
    this.producer = undefined;
    this.admin = undefined;
    this.ready = false;
  }

  status() {
    const projectionErrors = [...this.projectionErrors.entries()];
    const lastProjectionError = projectionErrors.at(-1)?.[1];
    const contentStatus = this.contents.status();
    return {
      schemaVersion: 'anysentry.interaction-status.v1' as const,
      // UOS plaintext lane counts as an enabled, ready capture path when ClickHouse is up;
      // the Kafka lane keeps reporting its own flags alongside.
      enabled: this.featureEnabled || this.uosPlaintextEnabled,
      ready: this.ready || (this.uosPlaintextEnabled && this.clickhouse.enabled),
      captureMode: 'metadata' as const,
      ...contentStatus,
      directViewEnabled: contentStatus.directViewEnabled || this.uosDirectViewEnabled,
      rawViewEnabled: contentStatus.rawViewEnabled || this.uosDirectViewEnabled,
      durableBoundary: 'kafka_ack' as const,
      contentDurableBoundary: contentStatus.contentCaptureAllowed
        ? 'content_store_finalize+kafka_ack' as const
        : 'not_applicable' as const,
      topic: this.topic,
      durability: {
        state: this.ready ? 'ready' as const : 'unavailable' as const,
        lastError: this.lastDurabilityError,
      },
      projection: {
        postgresql: this.relational.isReady(),
        clickhouse: this.clickhouse.enabled,
        state: projectionErrors.length === 0 ? 'ready' as const : 'degraded' as const,
        failingPartitions: projectionErrors.map(([key]) => key),
        lastError: lastProjectionError,
      },
      backpressure: {
        inFlightRequests: this.inFlightRequests,
        inFlightBytes: this.inFlightBytes,
        maxInFlightRequests: this.maxInFlightRequests,
        maxInFlightBytes: this.maxInFlightBytes,
      },
      ...this.counters,
      lastError: this.lastDurabilityError ?? lastProjectionError,
    };
  }

  async ingest(
    raw: unknown,
    source: InteractionSourceContext,
  ): Promise<InteractionReceipt> {
    if (!this.featureEnabled || !this.ready || !this.producer) {
      this.counters.rejected += 1;
      throw new ServiceUnavailableException(
        'interaction lane is disabled or not durably connected to Kafka',
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (bytes > MAX_INGEST_BYTES) {
      this.counters.rejected += 1;
      throw new Error(`interaction metadata exceeds ${MAX_INGEST_BYTES} bytes`);
    }
    if (
      this.inFlightRequests >= this.maxInFlightRequests
      || this.inFlightBytes + bytes > this.maxInFlightBytes
    ) {
      this.counters.rejected += 1;
      throw new ServiceUnavailableException(
        'interaction durable-ack backpressure limit reached',
      );
    }
    let input: InteractionMetadataIngest;
    try {
      input = validateInteractionMetadataIngest(raw);
    } catch (error) {
      this.counters.rejected += 1;
      throw error;
    }
    this.inFlightRequests += 1;
    this.inFlightBytes += bytes;
    try {
      let record = interactionRecord(input, source);
      const reservation = await this.relational.reserveInteractionReceipt(record);
      if (reservation.state === 'unavailable') {
        this.counters.rejected += 1;
        throw new ServiceUnavailableException(
          'interaction immutable receipt registry is unavailable',
        );
      }
      if (reservation.state === 'conflict') {
        this.counters.rejected += 1;
        throw new ConflictException(
          'sourceEventId was already accepted with different immutable metadata',
        );
      }
      if (reservation.acceptedAt !== undefined) {
        record = { ...record, acceptedAt: reservation.acceptedAt };
      }
      if (reservation.state === 'accepted') {
        this.counters.duplicates += 1;
        return this.receipt(record);
      }

      try {
        await this.producer.send({
          topic: this.topic,
          acks: -1,
          messages: [{
            key: record.conversationId,
            value: JSON.stringify(record),
            headers: {
              'content-type': 'application/json',
              'schema-version': INTERACTION_KAFKA_SCHEMA,
              'message-id': record.interactionId,
              'source-id': record.sourceId,
            },
          }],
        });
        this.lastDurabilityError = undefined;
      } catch (error) {
        this.counters.rejected += 1;
        this.lastDurabilityError = error instanceof Error ? error.message : String(error);
        throw new ServiceUnavailableException(
          'interaction metadata was not durably acknowledged by Kafka',
        );
      }
      // Kafka's acks=-1 is the durable boundary. Failure to update this acceleration registry
      // may cause a safe duplicate send on retry, never a false durable acknowledgement.
      await this.relational.markInteractionReceiptAccepted(record);
      this.counters.accepted += 1;
      this.counters.lastAcceptedAt = record.acceptedAt;
      return this.receipt(record);
    } finally {
      this.inFlightRequests -= 1;
      this.inFlightBytes -= bytes;
    }
  }

  async ingestContent(
    raw: unknown,
    source: InteractionSourceContext,
  ): Promise<InteractionReceipt> {
    if (!this.featureEnabled || !this.ready || !this.producer) {
      this.counters.rejected += 1;
      throw new ServiceUnavailableException(
        'interaction lane is disabled or not durably connected to Kafka',
      );
    }
    if (!this.contents.status().contentCaptureAllowed) {
      this.counters.rejected += 1;
      throw new ServiceUnavailableException(
        'encrypted Interaction content capture is not enabled for this isolated environment',
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (bytes > MAX_CONTENT_INGEST_BYTES) {
      this.counters.rejected += 1;
      throw new Error(`Interaction content envelope exceeds ${MAX_CONTENT_INGEST_BYTES} bytes`);
    }
    if (
      this.inFlightRequests >= this.maxInFlightRequests
      || this.inFlightBytes + bytes > this.maxInFlightBytes
    ) {
      this.counters.rejected += 1;
      throw new ServiceUnavailableException(
        'interaction durable-ack backpressure limit reached',
      );
    }

    let validated:
      | ReturnType<typeof validateInteractionInstructionIngest>
      | ReturnType<typeof validateInteractionResponseIngest>;
    try {
      const eventType =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as { eventType?: unknown }).eventType
          : undefined;
      validated = eventType === 'AgentOutputObserved'
        ? validateInteractionResponseIngest(raw)
        : validateInteractionInstructionIngest(raw);
    } catch (error) {
      this.counters.rejected += 1;
      throw error;
    }

    this.inFlightRequests += 1;
    this.inFlightBytes += bytes;
    try {
      let record: InteractionContentRecord =
        validated.metadata.eventType === 'AgentOutputObserved'
          ? interactionResponseRecord(
              validated.metadata,
              source,
              interactionContentRef(
                source.sourceId,
                validated.metadata.sourceEventId,
                'assistant_response',
              ),
            )
          : interactionInstructionRecord(
              validated.metadata,
              source,
              interactionContentRef(
                source.sourceId,
                validated.metadata.sourceEventId,
                'user_instruction',
              ),
            );
      const reservation = await this.relational.reserveInteractionReceipt(record);
      if (reservation.state === 'unavailable') {
        this.counters.rejected += 1;
        throw new ServiceUnavailableException(
          'interaction immutable receipt registry is unavailable',
        );
      }
      if (reservation.state === 'conflict') {
        this.counters.rejected += 1;
        throw new ConflictException(
          'sourceEventId was already accepted with different immutable Interaction content',
        );
      }
      if (reservation.acceptedAt !== undefined) {
        record = {
          ...record,
          acceptedAt: reservation.acceptedAt,
        };
      }

      const finalized = await this.contents.finalize(record, validated.content);
      if (finalized.state === 'unavailable') {
        this.counters.rejected += 1;
        throw new ServiceUnavailableException(
          'Interaction content was not durably finalized',
        );
      }
      if (finalized.state === 'conflict') {
        this.counters.rejected += 1;
        throw new ConflictException(
          'contentRef was already finalized with different immutable content',
        );
      }
      if (reservation.state === 'accepted') {
        this.counters.duplicates += 1;
        return this.receipt(record);
      }

      try {
        const contentMetadata = interactionContentMetadata(record);
        await this.producer.send({
          topic: this.topic,
          acks: -1,
          messages: [{
            key: record.conversationId,
            value: JSON.stringify(record),
            headers: {
              'content-type': 'application/json',
              'schema-version': INTERACTION_KAFKA_SCHEMA,
              'message-id': record.interactionId,
              'source-id': record.sourceId,
              'content-ref': contentMetadata.contentRef,
            },
          }],
        });
        this.lastDurabilityError = undefined;
      } catch (error) {
        this.counters.rejected += 1;
        this.lastDurabilityError = error instanceof Error ? error.message : String(error);
        throw new ServiceUnavailableException(
          'Interaction content reference was not durably acknowledged by Kafka',
        );
      }

      // ContentStore finalize + Kafka acks=-1 is the content durable boundary. The following
      // PostgreSQL flags are reconciliation accelerators and may safely be repaired after a crash.
      await Promise.all([
        this.relational.markInteractionReceiptAccepted(record),
        this.contents.markAccepted(
          interactionContentMetadata(record).contentRef,
          record.acceptedAt,
        ),
      ]);
      this.counters.accepted += 1;
      this.counters.lastAcceptedAt = record.acceptedAt;
      return this.receipt(record);
    } finally {
      this.inFlightRequests -= 1;
      this.inFlightBytes -= bytes;
    }
  }

  async conversations(query: InteractionQuery = {}): Promise<InteractionConversationList> {
    const limit = boundedInteger(query.limit, 100, 1, 500);
    // `limit` is a conversation-page size, not an observation cap. A single native Agent thread
    // can legitimately contain hundreds of user/assistant items; summarize the full bounded
    // observation window before slicing conversation rows.
    const records = await this.loadRecords({
      ...query,
      limit: MAX_QUERY_RECORDS,
    });
    const summaries = summarizeInteractionRecords(records);
    const contentRecords = records.filter(
      (record): record is InteractionContentRecord =>
        record.eventType === 'AgentInputObserved'
        || record.eventType === 'AgentOutputObserved',
    );
    // UOS plaintext ids are served by the adapter; exclude them from the PostgreSQL content
    // store lookup so a 4k-id conversation window does not become a 4k-key PG round trip.
    const projectedContentIds = contentRecords
      .map((record) => record.interactionId)
      .filter((interactionId) => !isUosContentInteractionId(interactionId));
    const availableIds = projectedContentIds.length > 0
      ? await this.contents.availableInteractionIds(projectedContentIds)
      : new Set<string>();
    // UOS plaintext records carry their content in the stored payload itself; their uos://
    // contentRef is always readable through the adapter, so mark them available directly.
    for (const record of contentRecords) {
      const ref = record.eventType === 'AgentInputObserved'
        ? record.userInstruction.contentRef
        : record.assistantResponse.contentRef;
      if (ref?.startsWith('uos://')) availableIds.add(record.interactionId);
    }
    const availableConversations = new Set(
      contentRecords
        .filter((record) => availableIds.has(record.interactionId))
        .map((record) => record.conversationId),
    );
    // UOS enrichment: human title (first user instruction preview) + aggregated token usage,
    // both derived from the already-loaded plaintext records.
    const uosRecordsByConversation = new Map<string, InteractionContentRecord[]>();
    for (const record of contentRecords) {
      if (!isUosContentInteractionId(record.interactionId)) continue;
      const list = uosRecordsByConversation.get(record.conversationId) ?? [];
      list.push(record);
      uosRecordsByConversation.set(record.conversationId, list);
    }
    for (const summary of summaries) {
      summary.contentAvailable = availableConversations.has(summary.conversationId);
      const uosRecords = uosRecordsByConversation.get(summary.conversationId);
      if (!uosRecords) continue;
      const firstInstruction = uosRecords
        .filter((record) => record.eventType === 'AgentInputObserved')
        .sort((a, b) => a.observedAt - b.observedAt)[0];
      if (firstInstruction) {
        // Older captures may have an empty request body (pre-D3 truncation window); walk forward
        // to the first instruction that actually produced a preview instead of giving up on the
        // conversation title entirely.
        const preview = uosRecords
          .filter((record) => record.eventType === 'AgentInputObserved')
          .sort((a, b) => a.observedAt - b.observedAt)
          .map((record) => this.uosPreviewFor(record))
          .find((text) => Boolean(text));
        if (preview) summary.title = preview;
      }
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      for (const record of uosRecords) {
        if (record.eventType !== 'AgentOutputObserved') continue;
        const output = record.output;
        if (output.protocol === 'native_stdio' || output.protocol === 'codex_app_server') continue;
        inputTokens += output.inputTokens ?? 0;
        outputTokens += output.outputTokens ?? 0;
        totalTokens += output.totalTokens ?? 0;
      }
      if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
        summary.tokenUsage = { inputTokens, outputTokens, totalTokens };
      }
    }
    const contentAvailable = summaries.some((item) => item.contentAvailable);
    return {
      schemaVersion: 'anysentry.interaction-conversations.v1',
      items: summaries.slice(0, limit),
      total: summaries.length,
      contentCapture: contentAvailable
        ? 'encrypted_available'
        : 'metadata_only',
      queryCompleteness: records.length > 0 || this.relational.isReady() || this.clickhouse.enabled
        ? 'projected'
        : 'unavailable',
      updateTime: new Date().toISOString(),
    };
  }

  async conversation(conversationId: string): Promise<InteractionConversationDetail | null> {
    const cleanId = conversationId.trim().slice(0, 160);
    if (!cleanId) return null;
    const observations = await this.loadRecords({ limit: MAX_QUERY_RECORDS }, cleanId);
    const conversation = summarizeInteractionRecords(observations)[0];
    if (!conversation) return null;
    // Detail header parity with the list: surface the first user instruction as the title so the
    // page header never falls back to the raw "LLM 会话 sess_*" anchor when plaintext is available.
    if (!conversation.title) {
      // Same walk-forward as the list path: skip early observations whose request body was never
      // captured (empty preview) and use the first instruction that actually parsed.
      const preview = observations
        .filter((record) => record.eventType === 'AgentInputObserved'
          && isUosContentInteractionId(record.interactionId))
        .sort((a, b) => a.observedAt - b.observedAt)
        .map((record) => this.uosPreviewFor(record))
        .find((text) => Boolean(text));
      if (preview) conversation.title = preview;
    }
    const projectedContentIds = observations
      .filter(
        (record): record is InteractionContentRecord =>
          record.eventType === 'AgentInputObserved'
          || record.eventType === 'AgentOutputObserved',
      )
      .map((record) => record.interactionId)
      .filter((interactionId) => !isUosContentInteractionId(interactionId));
    const availableIds = projectedContentIds.length > 0
      ? await this.contents.availableInteractionIds(projectedContentIds)
      : new Set<string>();
    for (const record of observations) {
      if (record.eventType !== 'AgentInputObserved' && record.eventType !== 'AgentOutputObserved') continue;
      const ref = record.eventType === 'AgentInputObserved'
        ? record.userInstruction.contentRef
        : record.assistantResponse.contentRef;
      if (ref?.startsWith('uos://')) availableIds.add(record.interactionId);
    }
    conversation.contentAvailable = observations.some(
      (record) =>
        (record.eventType === 'AgentInputObserved'
          || record.eventType === 'AgentOutputObserved')
        && availableIds.has(record.interactionId),
    );
    // UOS plaintext: batch-resolve inline bodies for the merged timeline view. Bounded per
    // conversation; full-fidelity reads remain available through the content endpoint.
    const uosInlineContentById = new Map<string, { content?: string; rawBody?: string; rawMeta?: Record<string, unknown> }>();
    if (this.uosPlaintextEnabled && this.directViewEnabled()) {
      const uosIds = observations
        .map((record) => record.interactionId)
        .filter((interactionId) => isUosContentInteractionId(interactionId))
        .slice(0, 200);
      await Promise.all(uosIds.map(async (interactionId) => {
        const view = await this.uosPlaintextContent(interactionId);
        if (view) {
          uosInlineContentById.set(interactionId, {
            ...(view.content
              ? { content: view.content.length > 12_000 ? `${view.content.slice(0, 12_000)}…` : view.content }
              : {}),
            ...(view.rawBody ? { rawBody: view.rawBody } : {}),
            ...(view.rawMeta ? { rawMeta: view.rawMeta as Record<string, unknown> } : {}),
          });
        }
      }));
    }
    return {
      schemaVersion: 'anysentry.interaction-conversation-detail.v1',
      conversation,
      observations: observations
        .map((record) =>
          record.eventType === 'AgentInputObserved'
          || record.eventType === 'AgentOutputObserved'
            ? {
                ...record,
                contentAvailability: availableIds.has(record.interactionId)
                  ? 'available' as const
                  : 'deleted' as const,
                ...(uosInlineContentById.has(record.interactionId)
                  ? uosInlineContentById.get(record.interactionId)
                  : {}),
              }
            : record)
        .sort(
          (left, right) =>
            left.observedAt - right.observedAt
            || left.interactionId.localeCompare(right.interactionId),
        ),
      contentCapture: conversation.contentAvailable
        ? 'encrypted_available'
        : 'metadata_only',
    };
  }

  async instructionsForRuntimeSession(
    sessionId: string,
    query: Pick<InteractionQuery, 'since' | 'until' | 'limit' | 'projection'> & {
      /** Metadata-only callers (for example System Evidence) do not need to decrypt bodies. */
      includeContent?: boolean;
      /**
       * Exact Process-generation identities (`startTime` as `ticks:<startTimeTicks>`) allowed to
       * bind a kimi_cli_ebpf_openssl observation whose wire format carries no runtime Session id.
       */
      processIdentities?: ReadonlyArray<{ pid: number; startTime: string }>;
    } = {},
  ): Promise<RuntimeInstructionObservation[]> {
    const cleanSessionId = sessionId.trim().slice(0, 240);
    if (!cleanSessionId) return [];
    const processIdentities = query.processIdentities ?? [];
    const matchesKimiProcessIdentity = (record: InteractionInstructionRecord): boolean => {
      if (record.runtime?.runtimeType !== 'kimi_cli_ebpf_openssl') return false;
      if (processIdentities.length === 0) return false;
      const identity = canonicalProcessLifecycleIdentity(record.process);
      return Boolean(
        identity
        && processIdentities.some(
          (candidate) =>
            candidate.pid === identity.pid && candidate.startTime === identity.startTime,
        ),
      );
    };
    const limit = boundedInteger(query.limit, 200, 1, 500);
    const records = (await this.loadRecords({
      ...query,
      limit: MAX_QUERY_RECORDS,
    }))
      .filter(
        (record): record is InteractionInstructionRecord =>
          record.eventType === 'AgentInputObserved'
          && (
            record.runtime?.runtimeType === 'codex_ebpf_rustls'
            || record.runtime?.runtimeType === 'a3s_code_ebpf_tls'
            || record.runtime?.runtimeType === 'claude_code_ebpf_tls'
            || record.runtime?.runtimeType === 'gemini_cli_ebpf_openssl'
            || record.runtime?.runtimeType === 'kimi_cli_ebpf_openssl'
          )
          && (
            record.runtime.sessionId === cleanSessionId
            || matchesKimiProcessIdentity(record)
          ),
      )
      .sort(
        (left, right) =>
          left.observedAt - right.observedAt
          || left.interactionId.localeCompare(right.interactionId),
      )
      .slice(-limit);
    if (query.includeContent === false || !this.contents.directViewEnabled()) {
      return records.map((record) => ({
        record,
        contentAvailability: query.includeContent === false
          ? 'not_requested' as const
          : 'not_authorized' as const,
      }));
    }
    return Promise.all(
      records.map(async (record): Promise<RuntimeInstructionObservation> => {
        try {
          const content = await this.contents.read(record.interactionId);
          return content
            ? {
                record,
                contentAvailability: 'available',
                content: content.content,
              }
            : {
                record,
                contentAvailability: 'deleted',
              };
        } catch {
          return {
            record,
            contentAvailability: 'unavailable',
          };
        }
      }),
    );
  }

  rawViewAuthorized(token: string | undefined): boolean {
    return this.contents.rawViewAuthorized(token);
  }

  directViewEnabled(): boolean {
    // UOS plaintext lane: the raw-view gate for observer-collected plaintext on this host. The
    // encrypted content store keeps its own stricter direct-view semantics.
    return this.contents.directViewEnabled() || this.uosDirectViewEnabled;
  }

  async content(interactionId: string) {
    const cleanId = interactionId.trim().slice(0, 160);
    if (!cleanId) return null;
    if (this.uosPlaintextEnabled && isUosContentInteractionId(cleanId)) {
      return this.uosPlaintextContent(cleanId);
    }
    return this.contents.read(cleanId);
  }

  async deleteContent(
    interactionId: string,
  ): Promise<'deleted' | 'not_found' | 'unavailable'> {
    const cleanId = interactionId.trim().slice(0, 160);
    if (!cleanId) return 'not_found';
    return this.contents.delete(cleanId);
  }

  private async start(): Promise<void> {
    const brokers = (
      process.env.ANYSENTRY_INTERACTION_BOOTSTRAP_SERVERS
      || process.env.ANYSENTRY_STREAM_BOOTSTRAP_SERVERS
      || ''
    )
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
    if (brokers.length === 0) {
      throw new Error(
        'ANYSENTRY_INTERACTION_BOOTSTRAP_SERVERS or ANYSENTRY_STREAM_BOOTSTRAP_SERVERS is required',
      );
    }
    if (!(await this.relational.initialize())) {
      throw new Error('PostgreSQL is required for the Interaction current-state projection');
    }
    if (!(await this.clickhouse.init())) {
      throw new Error('ClickHouse is required for the Interaction fact projection');
    }

    const sasl = kafkaSasl();
    const kafka = new Kafka({
      clientId:
        process.env.ANYSENTRY_INTERACTION_CLIENT_ID?.trim()
        || `anysentry-interaction-api-${process.pid}`,
      brokers,
      logLevel: logLevel.WARN,
      ssl:
        process.env.ANYSENTRY_STREAM_SECURITY_PROTOCOL === 'SSL'
        || process.env.ANYSENTRY_STREAM_SECURITY_PROTOCOL === 'SASL_SSL',
      ...(sasl ? { sasl } : {}),
    });
    this.admin = kafka.admin();
    await this.admin.connect();
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: [{
        topic: this.topic,
        numPartitions: boundedInteger(
          process.env.ANYSENTRY_INTERACTION_TOPIC_PARTITIONS,
          6,
          1,
          64,
        ),
        replicationFactor: boundedInteger(
          process.env.ANYSENTRY_INTERACTION_TOPIC_REPLICATION_FACTOR,
          1,
          1,
          9,
        ),
      }],
    });

    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    this.consumer = kafka.consumer({ groupId: this.groupId });
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: true });
    this.consumerRun = this.consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: boundedInteger(
        process.env.ANYSENTRY_INTERACTION_PROJECTION_CONCURRENCY,
        2,
        1,
        16,
      ),
      eachBatch: async ({
        batch,
        resolveOffset,
        heartbeat,
        isRunning,
        isStale,
      }) => {
        if (!isRunning() || isStale()) return;
        const partitionKey = `${batch.topic}:${batch.partition}`;
        const logicalRecords = new Map<
          string,
          { record: InteractionRecord; fingerprint: string }
        >();
        try {
          for (const message of batch.messages) {
            const record = parseInteractionKafkaRecord(message.value);
            const fingerprint = interactionPayloadFingerprint(record);
            const previous = logicalRecords.get(record.interactionId);
            if (previous && previous.fingerprint !== fingerprint) {
              throw new Error(
                `Interaction projection batch has conflicting duplicate ${record.interactionId}`,
              );
            }
            if (!previous) logicalRecords.set(record.interactionId, { record, fingerprint });
          }
          const records = [...logicalRecords.values()].map(({ record }) => record);
          if (records.length > 0) {
            const saved = await this.relational.saveInteractionMetadataBatch(records);
            if (!saved) throw new Error('PostgreSQL interaction projection is unavailable');
            const inserted = await this.clickhouse.saveInteractionMetadataBatch(records);
            if (!inserted) throw new Error('ClickHouse interaction projection is unavailable');
          }
          for (const message of batch.messages) {
            resolveOffset(message.offset);
          }
          this.counters.projected += records.length;
          this.counters.projectionBatches += 1;
          this.counters.projectionDuplicates += batch.messages.length - records.length;
          this.counters.lastProjectedAt = Date.now();
          this.projectionErrors.delete(partitionKey);
          await heartbeat();
        } catch (error) {
          this.counters.projectionFailures += 1;
          this.projectionErrors.set(
            partitionKey,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
        const last = batch.messages[batch.messages.length - 1];
        if (last) {
          await this.consumer!.commitOffsets([{
            topic: batch.topic,
            partition: batch.partition,
            offset: (BigInt(last.offset) + 1n).toString(),
          }]);
        }
      },
    });
    void this.consumerRun.catch((error) => {
      if (this.closing) return;
      this.ready = false;
      const message = error instanceof Error ? error.message : String(error);
      this.projectionErrors.set('consumer', message);
      this.logger.error(`Interaction projection consumer stopped: ${message}`);
    });
    this.ready = true;
    this.lastDurabilityError = undefined;
    this.projectionErrors.clear();
    this.logger.log(`Interaction metadata lane ready on Kafka topic ${this.topic}`);
  }

  private uosRecordsCache?: { key: string; at: number; records: InteractionRecord[] };
  /** Parsed-and-projected record cache keyed by interactionId. Interaction rows are immutable
   *  after argMax(revision) resolution, so the expensive work (tolerant payload parse, template
   *  extraction, record shaping) is done once per interaction instead of on every 10s-cache miss.
   *  Bounded LRU: 4000 entries of small record objects, payloads are never retained here. */
  private readonly uosParsedCache = new Map<string, {
    llm: boolean;
    collectorId: string;
    workspacePath: string;
    records: InteractionRecord[];
    previewIn?: string;
    previewOut?: string;
  }>();

  /** Title preview for a projected record. Reads the parsed-cache entry directly: the separate
   *  inline cache used to be wholesale-cleared at 4000 entries while parsed entries survived,
   *  permanently orphaning their titles (2026-10-21 empty-title incident). */
  private uosPreviewFor(record: InteractionRecord): string | undefined {
    const base = uosBaseInteractionId(record.interactionId);
    const entry = this.uosParsedCache.get(base);
    if (!entry) return undefined;
    return record.interactionId.endsWith(':in') ? entry.previewIn : entry.previewOut;
  }

  /** Load observer-plaintext interactions (agent_interactions_v1) as upstream-model records. */
  private async loadUosPlaintextRecordsCached(
    normalized: Parameters<InteractionService['loadUosPlaintextRecords']>[0],
    conversationId?: string,
  ): Promise<InteractionRecord[]> {
    const key = JSON.stringify({
      limit: normalized.limit,
      collectorId: normalized.collectorId,
      agentInstanceId: normalized.agentInstanceId,
      workspacePath: normalized.workspacePath,
      // Bucket the window so a 10s TTL never serves a genuinely new window stale.
      since: normalized.since ?? 'default',
      until: normalized.until ?? 'default',
      conversationId: conversationId ?? '',
    });
    const now = Date.now();
    if (this.uosRecordsCache && this.uosRecordsCache.key === key && now - this.uosRecordsCache.at < 10_000) {
      return this.uosRecordsCache.records;
    }
    const records = await this.loadUosPlaintextRecords(normalized, conversationId);
    this.uosRecordsCache = { key, at: now, records };
    return records;
  }

  /** Load observer-plaintext interactions (agent_interactions_v1) as upstream-model records. */
  private async loadUosPlaintextRecords(
    normalized: {
      limit: number;
      collectorId?: string;
      agentInstanceId?: string;
      workspacePath?: string;
      since?: number;
      until?: number;
    },
    conversationId?: string,
  ): Promise<InteractionRecord[]> {
    if (!this.uosPlaintextEnabled) return [];
    // An absent `until` arrives as MAX_SAFE_INTEGER from the shared query normalizer; anchoring
    // the default window to that sentinel would select nothing, so clamp it to now first.
    const now = Date.now();
    const until = normalized.until && normalized.until < now + 86_400_000
      ? normalized.until
      : now;
    const since = normalized.since ?? until - 7 * 24 * 3_600_000;
    const anchor = conversationId ? uosConversationAnchor(conversationId) : undefined;
    const sessionFilter = anchor && anchor.startsWith('sess_') ? anchor : undefined;
    // Index-only read first (scalar columns, ~1MB); payloads are fetched only for interactions
    // absent from the parsed-record cache, so a polling list call re-reads a few KB instead of
    // hundreds of MiB of plaintext bodies.
    const indexRows = await this.clickhouse.queryAgentInteractionIndex({
      startMs: since,
      endMs: until,
      limit: normalized.limit,
      ...(sessionFilter ? { sessionId: sessionFilter } : {}),
    });
    if (!indexRows || indexRows.length === 0) return [];
    const uncachedIds = indexRows
      .map((row) => row.interactionId)
      .filter((id) => !this.uosParsedCache.has(id));
    const payloadById = uncachedIds.length > 0
      ? await this.clickhouse.queryAgentInteractionPayloadsByIds(uncachedIds)
      : new Map<string, string>();
    if (uncachedIds.length > 0 && payloadById === null) return [];
    const payloadOf = (interactionId: string): string | undefined => payloadById?.get(interactionId);
    return indexRows
      .filter((row) => {
        if (normalized.collectorId) {
          const cached = this.uosParsedCache.get(row.interactionId);
          if (cached) {
            if (cached.collectorId !== normalized.collectorId) return false;
          } else {
            const payload = payloadOf(row.interactionId);
            if (payload && !payload.includes(`"collectorId":"${normalized.collectorId}"`)) return false;
          }
        }
        if (normalized.agentInstanceId && row.agentInstanceId !== normalized.agentInstanceId) return false;
        return true;
      })
      .flatMap((row) => {
        const cacheKey = row.interactionId ?? '';
        let entry = cacheKey ? this.uosParsedCache.get(cacheKey) : undefined;
        if (entry) {
          // LRU refresh: move to the tail so long-lived conversations survive eviction.
          this.uosParsedCache.delete(cacheKey);
          this.uosParsedCache.set(cacheKey, entry);
        } else {
          const payload = payloadOf(row.interactionId);
          if (payload === undefined) {
            // Payload fetch missed this id (transient CH failure or race): do not cache, so the
            // next poll retries the fetch instead of pinning an empty verdict.
            return [];
          }
          const parsed = parseUosPayload(payload);
          if (!parsed) {
            entry = { llm: false, collectorId: '', workspacePath: '', records: [] };
          } else {
            const llm = isLlmShapedRow(parsed);
            let records: InteractionRecord[] = [];
            let previewIn: string | undefined;
            let previewOut: string | undefined;
            if (llm) {
              previewIn = extractUserInstruction(parsed.request?.body).replace(/\s+/gu, ' ').trim().slice(0, 80);
              previewOut = extractAssistantResponse(parsed.response?.body).replace(/\s+/gu, ' ').trim().slice(0, 80);
              if (!parsed.sessionId && row.sessionId) parsed.sessionId = row.sessionId;
              if (!parsed.agentInstanceId && row.agentInstanceId) parsed.agentInstanceId = row.agentInstanceId;
              if (!parsed.at && row.at) parsed.at = row.at;
              records = uosRowToRecords(parsed);
            }
            entry = {
              llm,
              collectorId: parsed.collectorId ?? '',
              workspacePath: parsed.workspacePath ?? '',
              records,
              ...(previewIn ? { previewIn } : {}),
              ...(previewOut ? { previewOut } : {}),
            };
          }
          if (cacheKey) {
            if (this.uosParsedCache.size >= 4_000) {
              const oldest = this.uosParsedCache.keys().next().value;
              if (oldest !== undefined) this.uosParsedCache.delete(oldest);
            }
            this.uosParsedCache.set(cacheKey, entry);
          }
        }
        if (!entry.llm) return [];
        if (normalized.workspacePath && entry.workspacePath !== normalized.workspacePath) return [];
        if (conversationId && entry.records.length > 0 && entry.records[0].conversationId !== conversationId) return [];
        return entry.records;
      });
  }

  /** Build a content view straight from a stored plaintext payload (no encrypted store involved). */
  private async uosPlaintextContent(interactionId: string) {
    const baseId = uosBaseInteractionId(interactionId);
    const rows = await this.clickhouse.queryAgentInteractionPayloads({
      startMs: 0,
      endMs: Date.now() + 60_000,
      interactionId: baseId,
      limit: 1,
    });
    const row = rows?.[0];
    if (!row) return null;
    const parsed = parseUosPayload(row.payload);
    if (!parsed) return null;
    const isInput = interactionId.endsWith(':in');
    let content = isInput
      ? extractUserInstruction(parsed.request?.body)
      : extractAssistantResponse(parsed.response?.body);
    // Provider/gateway failures (402 欠费、403 禁止、502 网关错误…) are not chat completions:
    // label them so the bubble reads as a failed call instead of unexplained raw error text.
    if (!isInput && (parsed.statusCode ?? 200) >= 400) {
      content = `【调用失败】HTTP ${parsed.statusCode} ${parsed.endpoint ?? ''}${parsed.path ?? ''}${content ? `\n${content}` : ''}`;
    }
    const rawBodyText = (isInput ? parsed.request?.body : parsed.response?.body) ?? '';
    if (!content && !rawBodyText) return null;
    const rawMeta = {
      endpoint: parsed.endpoint ?? '',
      method: parsed.method ?? '',
      path: parsed.path ?? '',
      statusCode: parsed.statusCode ?? 0,
      model: parsed.model ?? '',
      transport: parsed.transport ?? '',
      tlsAdapterId: parsed.tlsAdapterId ?? '',
      agentProduct: parsed.agentProduct ?? '',
      sessionId: parsed.sessionId ?? parsed.canonicalSessionId ?? '',
      agentInstanceId: parsed.agentInstanceId ?? '',
      collectorId: parsed.collectorId ?? '',
      workspacePath: parsed.workspacePath ?? '',
      startedAtUnixNs: parsed.startedAtUnixNs ?? '',
      durationNs: parsed.durationNs ?? '',
      capturedBytes: isInput ? parsed.request?.capturedBytes ?? 0 : parsed.response?.capturedBytes ?? 0,
      parseState: content ? 'parsed' : 'unparsed',
    };
    const conversationId = uosConversationId(parsed);
    return {
      schemaVersion: 'anysentry.interaction-content.v1' as const,
      interactionId,
      conversationId,
      contentRef: `uos://${baseId}/${isInput ? 'request' : 'response'}`,
      messageRole: isInput ? 'user' as const : 'assistant' as const,
      contentRole: isInput ? 'user_instruction' as const : 'assistant_response' as const,
      content,
      contentBytes: Buffer.byteLength(content),
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      keyVersion: 'uos-plaintext',
      rawRetentionState: 'encrypted' as const,
      presentationState: 'raw_authorized' as const,
      rawBody: rawBodyText.length > 20_000 ? `${rawBodyText.slice(0, 20_000)}…` : rawBodyText,
      rawMeta,
    };
  }

  private async loadRecords(
    query: InteractionQuery,
    conversationId?: string,
  ): Promise<InteractionRecord[]> {
    const projection = query.projection ?? 'auto';
    const normalized = {
      limit: boundedInteger(query.limit, 5_000, 1, MAX_QUERY_RECORDS),
      collectorId: query.collectorId?.trim().slice(0, 180),
      agentInstanceId: query.agentInstanceId?.trim().slice(0, 240),
      workspacePath: query.workspacePath?.trim().slice(0, 500),
      since: boundedInteger(query.since, 0, 0, Number.MAX_SAFE_INTEGER) || undefined,
      until:
        boundedInteger(
          query.until,
          Number.MAX_SAFE_INTEGER,
          1,
          Number.MAX_SAFE_INTEGER,
        ) || undefined,
      conversationId,
    };
    if (projection === 'clickhouse' || projection === 'postgresql') {
      const projected = projection === 'clickhouse'
        ? (await this.clickhouse.loadInteractionMetadata(normalized)) ?? []
        : (await this.relational.loadInteractionMetadata(normalized)) ?? [];
      const uos = await this.loadUosPlaintextRecordsCached(normalized, conversationId);
      return deduplicateInteractionRecords([...projected, ...uos]);
    }
    const uos = await this.loadUosPlaintextRecordsCached(normalized, conversationId);
    const postgres = await this.relational.loadInteractionMetadata(normalized);
    if (postgres !== null) return deduplicateInteractionRecords([...postgres, ...uos]);
    return deduplicateInteractionRecords([
      ...((await this.clickhouse.loadInteractionMetadata(normalized)) ?? []),
      ...uos,
    ]);
  }

  private receipt(record: InteractionRecord): InteractionReceipt {
    const encrypted =
      record.eventType === 'AgentInputObserved'
      || record.eventType === 'AgentOutputObserved';
    const contentMetadata = encrypted
      ? interactionContentMetadata(record)
      : undefined;
    return {
      schemaVersion: 'anysentry.interaction-receipt.v1',
      accepted: true,
      interactionId: record.interactionId,
      sourceEventId: record.sourceEventId,
      conversationId: record.conversationId,
      contentDisposition: encrypted ? 'encrypted' : 'metadata_only',
      ...(contentMetadata ? { contentRef: contentMetadata.contentRef } : {}),
      contentStoreDurable: encrypted,
      kafkaDurable: true,
      projectionStatus: 'pending',
      acceptedAt: record.acceptedAt,
    };
  }
}
