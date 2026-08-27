import { BadRequestException, ConflictException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { RelationalBusinessStore } from './relational-business-store.service';
import type {
  AssetBindingQuality,
  ObservedAgentIdentity,
  ObservedAssetDto,
} from './observed-asset-lifecycle.types';
import { AuditService } from './audit.service';
import type { AuditActor } from './types';

const CONFIG_KEY = 'observed_asset_reviews_v1';
const MAX_HISTORY = 10_000;

export type ObservedAssetReviewDecision = 'non_agent' | 'unknown' | 'clear';

export interface ObservedAssetReviewRevision {
  assetId: string;
  revision: number;
  globalRevision: number;
  decision: ObservedAssetReviewDecision;
  effectiveAt: number;
  reviewedAt: number;
  reviewedBy: string;
  reason: string;
  expectedBindingRevision: number;
  bindingQuality: AssetBindingQuality;
  durable: boolean;
}
export type ActiveObservedAssetReviewRevision = ObservedAssetReviewRevision & {
  decision: Exclude<ObservedAssetReviewDecision, 'clear'>;
};

interface ObservedAssetReviewDocument {
  schemaVersion: 'anysentry.observed_asset_reviews.v1';
  globalRevision: number;
  history: ObservedAssetReviewRevision[];
  current?: Record<string, ActiveObservedAssetReviewRevision>;
  latestRevision?: Record<string, number>;
  historyByAsset?: Record<string, ObservedAssetReviewRevision[]>;
  updatedAt: number;
}

function text(value: unknown, limit: number): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized.slice(0, limit)
    : undefined;
}

function validDecision(value: unknown): ObservedAssetReviewDecision | undefined {
  return value === 'non_agent' || value === 'unknown' || value === 'clear' ? value : undefined;
}

@Injectable()
export class ObservedAssetReviewService implements OnModuleInit {
  private history: ObservedAssetReviewRevision[] = [];
  private currentByAsset = new Map<string, ActiveObservedAssetReviewRevision>();
  private latestRevisionByAsset = new Map<string, number>();
  private historyByAsset = new Map<string, ObservedAssetReviewRevision[]>();
  private globalRevision = 0;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly relational: RelationalBusinessStore,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.history = [];
    this.currentByAsset.clear();
    this.latestRevisionByAsset.clear();
    this.historyByAsset.clear();
    this.globalRevision = 0;
    const saved = await this.relational.loadPlatformConfig<ObservedAssetReviewDocument>(CONFIG_KEY);
    if (saved?.record?.schemaVersion === 'anysentry.observed_asset_reviews.v1') {
      this.history = (Array.isArray(saved.record.history) ? saved.record.history : [])
        .filter((item) => Boolean(
          text(item?.assetId, 240)
          && Number.isSafeInteger(item?.revision)
          && item.revision > 0
          && Number.isSafeInteger(item?.globalRevision)
          && item.globalRevision > 0
          && validDecision(item?.decision)
          && Number.isSafeInteger(item?.effectiveAt)
          && item.effectiveAt >= 0,
        ))
        .sort((left, right) => left.globalRevision - right.globalRevision)
        .slice(-MAX_HISTORY);
      this.globalRevision = Math.max(
        Number(saved.record.globalRevision) || 0,
        ...this.history.map((item) => item.globalRevision),
      );
      const currentEntries = Object.values(saved.record.current ?? {})
        .filter((item) => item?.durable === true);
      if (currentEntries.length) {
        for (const item of currentEntries) this.currentByAsset.set(item.assetId, { ...item });
      } else {
        for (const item of this.history) {
          if (item.durable !== true) continue;
          if (item.decision === 'clear') this.currentByAsset.delete(item.assetId);
          else this.currentByAsset.set(item.assetId, { ...item, decision: item.decision });
        }
      }
      for (const [assetId, revision] of Object.entries(saved.record.latestRevision ?? {})) {
        if (Number.isSafeInteger(revision) && revision > 0) this.latestRevisionByAsset.set(assetId, revision);
      }
      for (const item of this.history) {
        const perAsset = this.historyByAsset.get(item.assetId) ?? [];
        perAsset.push(item);
        this.historyByAsset.set(item.assetId, perAsset);
        this.latestRevisionByAsset.set(
          item.assetId,
          Math.max(this.latestRevisionByAsset.get(item.assetId) ?? 0, item.revision),
        );
      }
      for (const [assetId, items] of Object.entries(saved.record.historyByAsset ?? {})) {
        const valid = (Array.isArray(items) ? items : [])
          .filter((item) => item.assetId === assetId && item.durable === true && validDecision(item.decision))
          .sort((left, right) => left.effectiveAt - right.effectiveAt || left.globalRevision - right.globalRevision)
          .slice(-64);
        if (valid.length) this.historyByAsset.set(assetId, valid);
      }
    }
    this.initialized = true;
  }

  version(): number {
    return this.globalRevision;
  }

  current(assetIdInput: string): ActiveObservedAssetReviewRevision | undefined {
    const assetId = text(assetIdInput, 240);
    if (!assetId) return undefined;
    const current = this.currentByAsset.get(assetId);
    return current ? { ...current } : undefined;
  }

  effectiveAt(assetIdInput: string, eventAt: number): ActiveObservedAssetReviewRevision | undefined {
    const assetId = text(assetIdInput, 240);
    if (!assetId || !Number.isSafeInteger(eventAt) || eventAt < 0) return undefined;
    const items = this.historyByAsset.get(assetId) ?? [];
    let low = 0;
    let high = items.length - 1;
    let found: ObservedAssetReviewRevision | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = items[middle];
      if (candidate.effectiveAt <= eventAt) {
        if (candidate.durable === true) found = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const latest = found;
    return latest && latest.decision !== 'clear'
      ? { ...latest, decision: latest.decision }
      : undefined;
  }

  historyFor(assetIdInput: string): ObservedAssetReviewRevision[] {
    const assetId = text(assetIdInput, 240);
    if (!assetId) return [];
    return (this.historyByAsset.get(assetId) ?? []).map((item) => ({ ...item }));
  }

  latestRevision(assetIdInput: string): number {
    const assetId = text(assetIdInput, 240);
    return assetId ? this.latestRevisionByAsset.get(assetId) ?? 0 : 0;
  }

  allHistory(): ObservedAssetReviewRevision[] {
    return this.history.map((item) => ({ ...item }));
  }

  effectiveIdentity(asset: ObservedAssetDto): {
    classification: ObservedAgentIdentity;
    source: string;
    effectiveAt?: number;
    revision?: number;
  } {
    const review = this.current(asset.subjectAssetId);
    return review
      ? {
          classification: review.decision,
          source: 'human_asset_review',
          effectiveAt: review.effectiveAt,
          revision: review.revision,
        }
      : { classification: asset.identity.classification, source: asset.identity.source };
  }

  async review(
    asset: ObservedAssetDto,
    input: {
      decision?: ObservedAssetReviewDecision;
      expectedReviewRevision?: number;
      expectedBindingRevision?: number;
      effectiveAt?: number;
      reason?: string;
    },
    actorInput: Partial<AuditActor>,
  ): Promise<ObservedAssetReviewRevision> {
    const run = this.mutationTail.catch(() => undefined).then(async () => {
      if (!this.initialized) await this.onModuleInit();
      const decision = validDecision(input.decision);
      if (!decision) throw new BadRequestException('asset review decision is invalid');
      const actor = text(actorInput.id, 160) ?? 'operator';
      const reason = text(input.reason, 500);
      if (!reason) throw new BadRequestException('asset review reason is required');
      const currentRevision = this.latestRevision(asset.subjectAssetId);
      if (input.expectedReviewRevision !== undefined && input.expectedReviewRevision !== currentRevision) {
        throw new ConflictException('asset review revision changed; refresh impact before applying');
      }
      if (
        input.expectedBindingRevision !== undefined
        && input.expectedBindingRevision !== asset.bindingRevision
      ) throw new ConflictException('asset binding changed; refresh impact before applying');
      if (decision !== 'clear' && asset.bindingQuality !== 'exact' && asset.bindingQuality !== 'logical') {
        throw new BadRequestException('only exact or logical asset bindings can receive a durable review');
      }
      if (asset.bindingQuality === 'conflict') throw new BadRequestException('identity conflict must be investigated before review');
      const previousEffectiveAt = this.historyByAsset.get(asset.subjectAssetId)?.at(-1)?.effectiveAt ?? -1;
      const effectiveAt = Math.max(Date.now(), previousEffectiveAt + 1);
      const revision = currentRevision + 1;
      const globalRevision = this.globalRevision + 1;
      const record: ObservedAssetReviewRevision = {
        assetId: asset.subjectAssetId,
        revision,
        globalRevision,
        decision,
        effectiveAt,
        reviewedAt: Date.now(),
        reviewedBy: actor,
        reason,
        expectedBindingRevision: asset.bindingRevision,
        bindingQuality: asset.bindingQuality,
        durable: true,
      };
      const nextHistory = [...this.history, record].slice(-MAX_HISTORY);
      const nextCurrent = new Map(this.currentByAsset);
      const nextLatestRevision = new Map(this.latestRevisionByAsset);
      const nextHistoryByAsset = new Map(this.historyByAsset);
      nextHistoryByAsset.set(
        asset.subjectAssetId,
        [...(nextHistoryByAsset.get(asset.subjectAssetId) ?? []), record].slice(-64),
      );
      nextLatestRevision.set(asset.subjectAssetId, revision);
      if (decision === 'clear') nextCurrent.delete(asset.subjectAssetId);
      else nextCurrent.set(asset.subjectAssetId, { ...record, decision });
      const document: ObservedAssetReviewDocument = {
        schemaVersion: 'anysentry.observed_asset_reviews.v1',
        globalRevision,
        history: nextHistory,
        current: Object.fromEntries(nextCurrent),
        latestRevision: Object.fromEntries(nextLatestRevision),
        historyByAsset: Object.fromEntries(nextHistoryByAsset),
        updatedAt: Date.now(),
      };
      const saved = await this.relational.compareAndSwapPlatformConfig(
        CONFIG_KEY,
        this.globalRevision,
        document,
        document.updatedAt,
      );
      if (saved === 'conflict') {
        this.initialized = false;
        await this.onModuleInit();
        throw new ConflictException('asset review changed in another API instance; refresh and retry');
      }
      if (saved !== 'saved') {
        throw new ServiceUnavailableException('asset review storage is unavailable; identity was not changed');
      }
      this.history = nextHistory;
      this.historyByAsset = nextHistoryByAsset;
      this.currentByAsset = nextCurrent;
      this.latestRevisionByAsset = nextLatestRevision;
      this.globalRevision = globalRevision;
      this.audit.record({
        actor: actorInput,
        action: decision === 'clear' ? 'asset.review.cleared' : 'asset.review.updated',
        resourceType: 'asset',
        resourceId: asset.subjectAssetId,
        summary: decision === 'clear'
          ? `Asset review cleared: ${asset.displayName}`
          : `Asset review updated: ${asset.displayName} → ${decision}`,
        details: {
          assetId: asset.subjectAssetId,
          assetType: asset.subjectAssetType,
          decision,
          revision,
          globalRevision,
          effectiveAt,
          bindingRevision: asset.bindingRevision,
          bindingQuality: asset.bindingQuality,
          durable: true,
        },
      });
      return { ...record };
    });
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
