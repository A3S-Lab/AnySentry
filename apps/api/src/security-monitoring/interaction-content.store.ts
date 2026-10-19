import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  managementAuthConfigured,
  unsafeLocalInteractionDirectViewConfigured,
} from './management-auth.guard';
import { RelationalBusinessStore } from './relational-business-store.service';
import type {
  InteractionContentFinalizeResult,
  InteractionContentView,
  StoredInteractionContent,
} from './interaction-content.types';
import {
  interactionContentMetadata,
  type InteractionContentRecord,
} from './interaction.types';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|on|yes)$/iu.test(value?.trim() ?? '');
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function decodeKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const clean = value.trim();
  let decoded: Buffer;
  if (/^(?:[a-f0-9]{64})$/iu.test(clean)) {
    decoded = Buffer.from(clean, 'hex');
  } else {
    const base64 = clean.startsWith('base64:') ? clean.slice(7) : clean;
    decoded = Buffer.from(base64, 'base64');
  }
  return decoded.byteLength === KEY_BYTES ? decoded : undefined;
}

function loadKeyring(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  const raw = process.env.ANYSENTRY_INTERACTION_CONTENT_KEYS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [tenantId, versions] of Object.entries(parsed)) {
        if (
          !tenantId
          || !versions
          || typeof versions !== 'object'
          || Array.isArray(versions)
        ) {
          continue;
        }
        for (const [version, encoded] of Object.entries(
          versions as Record<string, unknown>,
        )) {
          const key = decodeKey(encoded);
          if (key && version) keys.set(`${tenantId}\0${version}`, key);
        }
      }
    } catch {
      // Reported through status(). Never log the malformed keyring or any key material.
    }
  }
  const single = decodeKey(process.env.ANYSENTRY_INTERACTION_CONTENT_KEY);
  if (single) {
    const tenant =
      process.env.ANYSENTRY_INTERACTION_CONTENT_KEY_TENANT?.trim()
      || 'tenant_default';
    const version =
      process.env.ANYSENTRY_INTERACTION_CONTENT_KEY_VERSION?.trim()
      || 'v1';
    keys.set(`${tenant}\0${version}`, single);
  }
  return keys;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const left = createHash('sha256').update(presented).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function aad(record: {
  tenantId: string;
  sourceId: string;
  sourceEventId: string;
  interactionId: string;
  conversationId: string;
  contentRef: string;
  contentRole: string;
  contentSha256: string;
  contentBytes: number;
  keyVersion: string;
}): Buffer {
  return Buffer.from(
    [
      'anysentry.interaction-content.v1',
      record.tenantId,
      record.sourceId,
      record.sourceEventId,
      record.interactionId,
      record.conversationId,
      record.contentRef,
      record.contentRole,
      record.contentSha256,
      record.contentBytes,
      record.keyVersion,
    ].join('\0'),
    'utf8',
  );
}

@Injectable()
export class InteractionContentStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InteractionContentStore.name);
  private readonly featureEnabled = enabled(
    process.env.ANYSENTRY_INTERACTION_CONTENTS,
  );
  private readonly captureProfile =
    process.env.ANYSENTRY_INTERACTION_CONTENT_CAPTURE_MODE?.trim();
  private readonly fixtureMode = this.captureProfile === 'isolated_fixture';
  private readonly localRuntimeMode = this.captureProfile === 'local_runtime';
  private readonly rawViewRequested = enabled(
    process.env.ANYSENTRY_INTERACTION_RAW_VIEW,
  );
  private readonly rawViewToken =
    process.env.ANYSENTRY_INTERACTION_RAW_VIEW_TOKEN?.trim();
  private readonly currentKeyVersion =
    process.env.ANYSENTRY_INTERACTION_CONTENT_KEY_VERSION?.trim()
    || 'v1';
  private readonly keys = loadKeyring();
  private readonly orphanTtlMs = positiveInteger(
    process.env.ANYSENTRY_INTERACTION_CONTENT_ORPHAN_TTL_MS,
    24 * 60 * 60 * 1_000,
    30 * 24 * 60 * 60 * 1_000,
  );
  private cleanupTimer?: NodeJS.Timeout;
  private readonly counters = {
    finalized: 0,
    duplicates: 0,
    conflicts: 0,
    reads: 0,
    deleted: 0,
    orphanPurges: 0,
    failures: 0,
  };

  constructor(private readonly relational: RelationalBusinessStore) {}

  async onModuleInit(): Promise<void> {
    if (!this.featureEnabled) return;
    await this.purgeOrphans();
    this.cleanupTimer = setInterval(
      () => void this.purgeOrphans(),
      Math.max(60_000, Math.min(this.orphanTtlMs / 4, 60 * 60 * 1_000)),
    );
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  status() {
    const contentCaptureAllowed =
      this.featureEnabled
      && (this.fixtureMode || this.localRuntimeMode)
      && this.keys.size > 0
      && this.relational.configured();
    const directViewEnabled =
      contentCaptureAllowed
      && unsafeLocalInteractionDirectViewConfigured();
    const protectedRawViewEnabled =
      contentCaptureAllowed
      && this.rawViewRequested
      && Boolean(this.rawViewToken)
      && managementAuthConfigured();
    const rawViewEnabled = directViewEnabled || protectedRawViewEnabled;
    return {
      contentCaptureAllowed,
      contentCaptureMode: contentCaptureAllowed
        ? this.localRuntimeMode
          ? 'local_runtime_encrypted' as const
          : 'isolated_fixture_encrypted' as const
        : 'metadata_only' as const,
      contentStore: {
        enabled: this.featureEnabled,
        fixtureMode: this.fixtureMode,
        localRuntimeMode: this.localRuntimeMode,
        encryptionReady: this.keys.size > 0,
        backend: 'postgresql_encrypted' as const,
        keyVersion: this.keys.size > 0 ? this.currentKeyVersion : undefined,
      },
      rawViewEnabled,
      directViewEnabled,
      rawViewAuthentication: directViewEnabled
        ? 'unsafe_local_direct_view' as const
        : protectedRawViewEnabled
          ? 'management_plus_raw_capability' as const
          : 'disabled' as const,
      counters: { ...this.counters },
    };
  }

  rawViewAuthorized(token: string | undefined): boolean {
    return Boolean(
      this.status().contentCaptureAllowed
      && this.rawViewRequested
      && this.rawViewToken
      && managementAuthConfigured()
      && tokenMatches(token, this.rawViewToken),
    );
  }

  directViewEnabled(): boolean {
    return this.status().directViewEnabled;
  }

  async finalize(
    record: InteractionContentRecord,
    content: string,
  ): Promise<InteractionContentFinalizeResult> {
    const status = this.status();
    if (!status.contentCaptureAllowed) {
      this.counters.failures += 1;
      throw new ServiceUnavailableException(
        'encrypted Interaction content capture is disabled or missing its tenant key',
      );
    }
    const key = this.keyFor(record.tenantId, this.currentKeyVersion);
    if (!key) {
      this.counters.failures += 1;
      throw new ServiceUnavailableException(
        `no Interaction content key is configured for tenant ${record.tenantId}`,
      );
    }
    const plaintext = Buffer.from(content, 'utf8');
    const nonce = randomBytes(NONCE_BYTES);
    try {
      const metadata = interactionContentMetadata(record);
      const descriptor = {
        contentRef: metadata.contentRef,
        interactionId: record.interactionId,
        conversationId: record.conversationId,
        sourceId: record.sourceId,
        sourceEventId: record.sourceEventId,
        tenantId: record.tenantId,
        contentRole: metadata.contentRole,
        contentSha256: metadata.contentSha256,
        contentBytes: metadata.contentBytes,
        keyVersion: this.currentKeyVersion,
      };
      const cipher = createCipheriv(ALGORITHM, key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad(descriptor), { plaintextLength: plaintext.byteLength });
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const result = await this.relational.finalizeInteractionContent({
        ...descriptor,
        algorithm: ALGORITHM,
        nonce,
        authTag: cipher.getAuthTag(),
        ciphertext,
        finalizedAt: Date.now(),
      });
      if (result.state === 'stored') this.counters.finalized += 1;
      else if (result.state === 'duplicate') this.counters.duplicates += 1;
      else if (result.state === 'conflict') this.counters.conflicts += 1;
      else this.counters.failures += 1;
      return result;
    } finally {
      plaintext.fill(0);
    }
  }

  async markAccepted(contentRef: string, acceptedAt: number): Promise<void> {
    const saved = await this.relational.markInteractionContentAccepted(
      contentRef,
      acceptedAt,
    );
    if (!saved) {
      // Kafka already acknowledged the reference. This row remains recoverable by reconciliation;
      // do not convert the successful durable boundary into a false HTTP failure.
      this.logger.warn(
        `encrypted Interaction content acceptance acceleration failed for ${contentRef}`,
      );
    }
  }

  async read(interactionId: string): Promise<InteractionContentView | null> {
    const stored = await this.relational.loadInteractionContent(interactionId);
    if (stored === undefined) {
      this.counters.failures += 1;
      throw new ServiceUnavailableException('encrypted Interaction content store is unavailable');
    }
    if (!stored || stored.state === 'deleted') return null;
    const key = this.keyFor(stored.tenantId, stored.keyVersion);
    if (!key) {
      this.counters.failures += 1;
      throw new ServiceUnavailableException(
        `Interaction content key ${stored.keyVersion} is unavailable`,
      );
    }
    const plaintext = this.decrypt(stored, key);
    try {
      const digest = createHash('sha256').update(plaintext).digest('hex');
      if (
        digest !== stored.contentSha256
        || plaintext.byteLength !== stored.contentBytes
      ) {
        this.counters.failures += 1;
        throw new ServiceUnavailableException(
          'encrypted Interaction content integrity verification failed',
        );
      }
      this.counters.reads += 1;
      return {
        schemaVersion: 'anysentry.interaction-content.v1',
        interactionId: stored.interactionId,
        conversationId: stored.conversationId,
        contentRef: stored.contentRef,
        messageRole:
          stored.contentRole === 'assistant_response' ? 'assistant' : 'user',
        contentRole: stored.contentRole,
        content: plaintext.toString('utf8'),
        contentBytes: stored.contentBytes,
        contentSha256: stored.contentSha256,
        keyVersion: stored.keyVersion,
        rawRetentionState: 'encrypted',
        presentationState: 'raw_authorized',
      };
    } finally {
      plaintext.fill(0);
    }
  }

  async availableInteractionIds(
    interactionIds: readonly string[],
  ): Promise<Set<string>> {
    return (
      await this.relational.loadAvailableInteractionContentIds(interactionIds)
    ) ?? new Set();
  }

  async delete(
    interactionId: string,
  ): Promise<'deleted' | 'not_found' | 'unavailable'> {
    const result = await this.relational.deleteInteractionContent(interactionId);
    if (result === 'deleted') this.counters.deleted += 1;
    else if (result === 'unavailable') this.counters.failures += 1;
    return result;
  }

  private keyFor(tenantId: string, version: string): Buffer | undefined {
    return this.keys.get(`${tenantId}\0${version}`);
  }

  private decrypt(stored: StoredInteractionContent, key: Buffer): Buffer {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, stored.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad(stored), { plaintextLength: stored.contentBytes });
      decipher.setAuthTag(stored.authTag);
      return Buffer.concat([
        decipher.update(stored.ciphertext),
        decipher.final(),
      ]);
    } catch {
      this.counters.failures += 1;
      throw new ServiceUnavailableException(
        'encrypted Interaction content authentication failed',
      );
    }
  }

  private async purgeOrphans(): Promise<void> {
    const purged = await this.relational.purgeOrphanInteractionContents(
      Date.now() - this.orphanTtlMs,
    );
    if (purged === null) return;
    this.counters.orphanPurges += purged;
    if (purged > 0) {
      this.logger.warn(`purged ${purged} orphaned encrypted Interaction content object(s)`);
    }
  }
}
