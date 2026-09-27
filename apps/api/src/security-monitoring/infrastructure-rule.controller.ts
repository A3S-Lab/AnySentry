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
import {
  InfrastructureMaterializationReportRequest,
  InfrastructureAssetDraftRequest,
  InfrastructureRuleActor,
  InfrastructureRuleAuthority,
  InfrastructureRuleCreateRequest,
  InfrastructureRuleSourceType,
  InfrastructureRuleStage,
  InfrastructureRuleTransitionRequest,
  InfrastructureRuleValidationRequest,
} from './infrastructure-rule.types';
import { InfrastructureRuleError, InfrastructureRuleService } from './infrastructure-rule.service';
import { ManagementAuthGuard, RequireManagementAuth } from './management-auth.guard';

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()];
  return (Array.isArray(value) ? value.find(Boolean) : value)?.trim();
}

function actor(headers: HeaderBag): InfrastructureRuleActor {
  const typeValue = header(headers, 'x-anysentry-actor-type');
  const type = typeValue === 'system' || typeValue === 'api' || typeValue === 'operator'
    ? typeValue
    : 'operator';
  return {
    type,
    id: (
      header(headers, 'x-forwarded-user') ??
      header(headers, 'x-user-email') ??
      header(headers, 'x-anysentry-actor') ??
      'operator'
    ).slice(0, 160),
    displayName: header(headers, 'x-user-name') ?? header(headers, 'x-anysentry-actor-name'),
  };
}

@UseGuards(ManagementAuthGuard)
@Controller('security-center/infrastructure-rules')
export class InfrastructureRuleController {
  constructor(private readonly rules: InfrastructureRuleService) {}

  @Get('status')
  @RequireManagementAuth()
  status() {
    return this.rules.status();
  }

  @Get('policy')
  @RequireManagementAuth()
  policy() {
    return this.rules.policySnapshot();
  }

  @Post('materializations/report')
  @RequireManagementAuth()
  async reportMaterialization(
    @Body() body: InfrastructureMaterializationReportRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.reportMaterialization(body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Get()
  @RequireManagementAuth()
  list(
    @Query('q') q?: string,
    @Query('stage') stage?: InfrastructureRuleStage | 'all',
    @Query('authority') authority?: InfrastructureRuleAuthority | 'all',
    @Query('source') source?: InfrastructureRuleSourceType | 'all',
    @Query('limit') limit?: string,
  ) {
    return this.rules.list({ q, stage, authority, source, limit: limit ? Number(limit) : undefined });
  }

  @Get('ui/list')
  // This is the bounded, human-safe read model used by the dashboard. It deliberately omits raw
  // selectors, cgroup bindings and transport grants, so operators can inspect current rules before
  // providing a browser-local management token. Every mutation and raw control-plane view below
  // remains explicitly guarded.
  humanList(
    @Query('q') q?: string,
    @Query('stage') stage?: InfrastructureRuleStage | 'all',
    @Query('authority') authority?: InfrastructureRuleAuthority | 'all',
    @Query('source') source?: InfrastructureRuleSourceType | 'all',
    @Query('limit') limit?: string,
  ) {
    return this.rules.listHuman({ q, stage, authority, source, limit: limit ? Number(limit) : undefined });
  }

  @Get('ui/operations')
  @RequireManagementAuth()
  operations(
    @Query('ruleId') ruleId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rules.listOperations({ ruleId, limit: limit ? Number(limit) : undefined });
  }

  @Get('ui/operations/:operationId')
  @RequireManagementAuth()
  operation(@Param('operationId') operationId: string) {
    try {
      return this.rules.getOperation(operationId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Get('ui/:ruleId')
  humanDetail(@Param('ruleId') ruleId: string) {
    try {
      return this.rules.getHuman(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post('drafts/from-asset')
  @RequireManagementAuth()
  async createFromAsset(
    @Body() body: InfrastructureAssetDraftRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.createDraftFromAsset(body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Get(':ruleId')
  @RequireManagementAuth()
  get(@Param('ruleId') ruleId: string) {
    try {
      return this.rules.get(ruleId);
    } catch (error) {
      this.fail(error);
    }
  }

  @Post()
  @RequireManagementAuth()
  async create(
    @Body() body: InfrastructureRuleCreateRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.create(body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/validate')
  @RequireManagementAuth()
  async validate(
    @Param('ruleId') ruleId: string,
    @Body() body: InfrastructureRuleValidationRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      // Compatibility readers may still submit a v1 inventory preview. It remains useful for
      // diagnostics but is explicitly non-authorizing; only the server-owned preview below can
      // satisfy promotion.
      if (body.inventory !== undefined) return this.rules.validate(ruleId, body, actor(headers));
      return await this.rules.impactPreview(ruleId, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/impact-preview')
  @RequireManagementAuth()
  async impactPreview(
    @Param('ruleId') ruleId: string,
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.impactPreview(ruleId, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/shadow')
  @RequireManagementAuth()
  async shadow(
    @Param('ruleId') ruleId: string,
    @Body() body: InfrastructureRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.shadow(ruleId, body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/promote')
  @RequireManagementAuth()
  async promote(
    @Param('ruleId') ruleId: string,
    @Body() body: InfrastructureRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.promote(ruleId, body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  @Post(':ruleId/revoke')
  @RequireManagementAuth()
  async revoke(
    @Param('ruleId') ruleId: string,
    @Body() body: InfrastructureRuleTransitionRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    try {
      return await this.rules.revoke(ruleId, body, actor(headers));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): never {
    if (!(error instanceof InfrastructureRuleError)) throw error;
    if (error.code === 'not_found') throw new NotFoundException(error.message);
    if (error.code === 'revision_conflict') throw new ConflictException(error.message);
    if (error.code === 'asset_provider_unavailable') throw new ServiceUnavailableException({ code: error.code, message: error.message });
    throw new BadRequestException({ code: error.code, message: error.message });
  }
}
