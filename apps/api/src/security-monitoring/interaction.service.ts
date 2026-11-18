import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
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
      enabled: this.featureEnabled,
      ready: this.ready,
      captureMode: 'metadata' as const,
      ...contentStatus,
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
    const availableIds = await this.contents.availableInteractionIds(
      contentRecords.map((record) => record.interactionId),
    );
    const availableConversations = new Set(
      contentRecords
        .filter((record) => availableIds.has(record.interactionId))
        .map((record) => record.conversationId),
    );
    for (const summary of summaries) {
      summary.contentAvailable = availableConversations.has(summary.conversationId);
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
    const availableIds = await this.contents.availableInteractionIds(
      observations
        .filter(
          (record): record is InteractionContentRecord =>
            record.eventType === 'AgentInputObserved'
            || record.eventType === 'AgentOutputObserved',
        )
        .map((record) => record.interactionId),
    );
    conversation.contentAvailable = observations.some(
      (record) =>
        (record.eventType === 'AgentInputObserved'
          || record.eventType === 'AgentOutputObserved')
        && availableIds.has(record.interactionId),
    );
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
    return this.contents.directViewEnabled();
  }

  async content(interactionId: string) {
    const cleanId = interactionId.trim().slice(0, 160);
    if (!cleanId) return null;
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
    if (projection === 'clickhouse') {
      return deduplicateInteractionRecords(
        (await this.clickhouse.loadInteractionMetadata(normalized)) ?? [],
      );
    }
    if (projection === 'postgresql') {
      return deduplicateInteractionRecords(
        (await this.relational.loadInteractionMetadata(normalized)) ?? [],
      );
    }
    const postgres = await this.relational.loadInteractionMetadata(normalized);
    if (postgres !== null) return deduplicateInteractionRecords(postgres);
    return deduplicateInteractionRecords(
      (await this.clickhouse.loadInteractionMetadata(normalized)) ?? [],
    );
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
