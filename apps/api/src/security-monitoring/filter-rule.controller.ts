import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { FilterRuleError } from './filter-rule-catalog.service';
import { FilterRuleSystemError, FilterRuleSystemService } from './filter-rule-system.service';
import {
  FilterRuleActor,
  FilterRuleCatalogQuery,
  FilterRuleCategory,
  FilterRuleDraftRequest,
  FilterRuleExplainRequest,
  FilterRuleKind,
  FilterRuleLifecycleStage,
  FilterRuleSimulationRequest,
  FilterRuleSourceType,
  FilterRuleStage,
  FilterRuleTransitionRequest,
} from './filter-rule.types';
import { InfrastructureRuleError } from './infrastructure-rule.service';
import type { InfrastructureAssetDraftRequest } from './infrastructure-rule.types';
import { ManagementAuthGuard, RequireManagementAuth } from './management-auth.guard';

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()];
  return (Array.isArray(value) ? value.find(Boolean) : value)?.trim();
}

function actor(headers: HeaderBag): FilterRuleActor {
  const typeValue = header(headers, 'x-anysentry-actor-type');
  return {
    type: typeValue === 'system' || typeValue === 'api' || typeValue === 'operator' ? typeValue : 'operator',
    id: (
      header(headers, 'x-forwarded-user')
      ?? header(headers, 'x-user-email')
      ?? header(headers, 'x-anysentry-actor')
      ?? 'operator'
    ).slice(0, 160),
    displayName: header(headers, 'x-user-name') ?? header(headers, 'x-anysentry-actor-name'),
  };
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

@UseGuards(ManagementAuthGuard)
@Controller('security-center/filter-rules')
export class FilterRuleController {
  constructor(
    private readonly system: FilterRuleSystemService,
  ) {}

  @Get('catalog')
  list(
    @Query('q') q?: string,
    @Query('category') category?: FilterRuleCategory | 'all',
    @Query('kind') kind?: FilterRuleKind | 'all',
    @Query('stage') stage?: FilterRuleStage | 'all',
    @Query('lifecycleStage') lifecycleStage?: FilterRuleLifecycleStage | 'all',
    @Query('source') source?: FilterRuleSourceType | 'all',
    @Query('editable') editable?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const query: FilterRuleCatalogQuery = {
        q,
        category,
        kind,
        stage,
        lifecycleStage,
        source,
        editable: bool(editable),
        cursor,
        limit: limit ? Number(limit) : undefined,
      };
      return this.system.list(query);
    } catch (error) {
      this.fail(error);
    }
  }

  @Get('stages/status')
  status() {
    return this.system.status();
  }

  @Get('materializations')
  materializations() {
    return this.system.materializations();
  }

  @Post('explain')
  async explain(@Body() body: FilterRuleExplainRequest = {}) {
    try {
      return await this.system.explain(body);
    } catch (error) {
      this.fail(error);
    }
  }

  @Get('examples/:exampleId')
  example(@Param('exampleId') exampleId: string) {
    try {
      return this.system.example(exampleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post('simulate')
  @RequireManagementAuth()
  simulate(@Body() body: FilterRuleSimulationRequest = {}) {
    try {
      return this.system.simulate(body);
    } catch (error) {
      this.fail(error);
    }
  }

  @Get('projections/forwarder')
  @RequireManagementAuth()
  projection() {
    return this.system.projection();
  }

  @Get('operations')
  @RequireManagementAuth()
  operations(
    @Query('ruleId') ruleId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.system.operations(ruleId, limit ? Number(limit) : undefined);
  }

  @Post('drafts')
  @RequireManagementAuth()
  async createDraft(
    @Body() body: FilterRuleDraftRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      const rule = await this.system.createDraft(body, actor(headers));
      return { rule: this.system.get(rule.ruleId) };
    } catch (error) {
      this.fail(error);
    }
  }

  @Post('drafts/from-asset')
  @RequireManagementAuth()
  async createInfrastructureDraft(
    @Body() body: InfrastructureAssetDraftRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      const result = await this.system.createInfrastructureDraft(body, actor(headers));
      return { ...result, rule: this.system.get(result.rule.ruleId) };
    } catch (error) {
      this.fail(error);
    }
  }

  @Get('raw/:ruleId')
  @RequireManagementAuth()
  raw(@Param('ruleId') ruleId: string) {
    try {
      return this.system.raw(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/preview')
  @RequireManagementAuth()
  async preview(
    @Param('ruleId') ruleId: string,
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.system.preview(ruleId, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/shadow')
  @RequireManagementAuth()
  async shadow(
    @Param('ruleId') ruleId: string,
    @Body() body: FilterRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      await this.system.shadow(ruleId, body, actor(headers));
      return this.system.get(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/promote')
  @RequireManagementAuth()
  async promote(
    @Param('ruleId') ruleId: string,
    @Body() body: FilterRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      await this.system.promote(ruleId, body, actor(headers));
      return this.system.get(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/revoke')
  @RequireManagementAuth()
  async revoke(
    @Param('ruleId') ruleId: string,
    @Body() body: FilterRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      await this.system.revoke(ruleId, body, actor(headers));
      return this.system.get(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Get(':ruleId')
  get(@Param('ruleId') ruleId: string) {
    try {
      return this.system.get(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): never {
    if (error instanceof FilterRuleSystemError) {
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code === 'stale_cursor') throw new ConflictException(error.message);
      throw new BadRequestException({ code: error.code, message: error.message });
    }
    if (error instanceof FilterRuleError) {
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code === 'revision_conflict') throw new ConflictException(error.message);
      if (error.code === 'persistence_unavailable') throw new ServiceUnavailableException({ code: error.code, message: error.message });
      throw new BadRequestException({ code: error.code, message: error.message });
    }
    if (error instanceof InfrastructureRuleError) {
      if (error.code === 'not_found') throw new NotFoundException(error.message);
      if (error.code === 'revision_conflict') throw new ConflictException(error.message);
      if (error.code === 'asset_provider_unavailable') throw new ServiceUnavailableException({ code: error.code, message: error.message });
      throw new BadRequestException({ code: error.code, message: error.message });
    }
    throw error;
  }
}
