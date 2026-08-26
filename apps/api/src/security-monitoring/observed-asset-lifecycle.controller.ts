import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ObservedAssetLifecycleService } from './observed-asset-lifecycle.read.service';
import type { ObservedAssetListQuery } from './observed-asset-lifecycle.types';
import type { ObservedAssetReviewDecision } from './observed-asset-review.service';
import { ManagementAuthGuard, RequireManagementAuth } from './management-auth.guard';

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()];
  return (Array.isArray(value) ? value.find(Boolean) : value)?.trim();
}

function assetId(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new BadRequestException('assetId is invalid');
  }
  return normalized;
}

function limit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, Math.trunc(parsed))) : 200;
}

@UseGuards(ManagementAuthGuard)
@Controller('security-center/assets')
export class ObservedAssetLifecycleController {
  constructor(private readonly assets: ObservedAssetLifecycleService) {}

  @Post('list')
  list(@Body() body: ObservedAssetListQuery = {}) {
    return this.assets.list(body);
  }

  @Get('summary')
  summary() {
    return this.assets.summary();
  }

  @Get(':assetId/timeline')
  async timeline(@Param('assetId') rawAssetId: string, @Query('limit') rawLimit?: string) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = this.assets.timeline(id, limit(rawLimit));
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }

  @Get(':assetId/coverage')
  async coverage(@Param('assetId') rawAssetId: string, @Query('limit') rawLimit?: string) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = this.assets.coverage(id, limit(rawLimit));
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }

  @Get(':assetId/rules')
  async rules(@Param('assetId') rawAssetId: string) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = this.assets.rules(id);
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }

  @Post(':assetId/review-impact')
  @RequireManagementAuth()
  async reviewImpact(@Param('assetId') rawAssetId: string) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = this.assets.reviewImpact(id);
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }

  @Put(':assetId/review')
  @RequireManagementAuth()
  async review(
    @Param('assetId') rawAssetId: string,
    @Body() body: {
      decision?: ObservedAssetReviewDecision;
      expectedReviewRevision?: number;
      expectedBindingRevision?: number;
      effectiveAt?: number;
      reason?: string;
    },
    @Headers() headers: HeaderBag,
  ) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = await this.assets.reviewAsset(id, body ?? {}, {
      type: 'operator',
      id: header(headers, 'x-forwarded-user')
        ?? header(headers, 'x-user-email')
        ?? header(headers, 'x-anysentry-actor')
        ?? 'operator',
      displayName: header(headers, 'x-user-name') ?? header(headers, 'x-anysentry-actor-name'),
      userAgent: header(headers, 'user-agent'),
    });
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }

  @Get(':assetId')
  async detail(@Param('assetId') rawAssetId: string) {
    const id = assetId(rawAssetId);
    await this.assets.ensureAsset(id);
    const result = this.assets.detail(id);
    if (!result) throw new NotFoundException(`asset not found: ${id}`);
    return result;
  }
}
