import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from './audit.service';
import { IngestionSourceService } from './ingestion-source.service';
import { InteractionService } from './interaction.service';
import { UosSystemEvidenceService } from './uos-system-evidence.service';
import {
  AllowUnsafeLocalInteractionDirectView,
  managementAuthConfigured,
  ManagementAuthGuard,
  RequireManagementAuth,
} from './management-auth.guard';

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag | undefined, key: string): string | undefined {
  const value = headers?.[key] ?? headers?.[key.toLowerCase()];
  if (Array.isArray(value)) return value.find(Boolean);
  return value;
}

function bearerToken(headers: HeaderBag | undefined): string | undefined {
  const match = headerValue(headers, 'authorization')?.match(/^bearer\s+(.+)$/iu);
  return match?.[1]?.trim();
}

function numberQuery(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BadRequestException('time and limit query values must be non-negative integers');
  }
  return parsed;
}

function rawViewReason(headers: HeaderBag): string {
  const encoded = headerValue(headers, 'x-anysentry-raw-view-reason')?.trim() ?? '';
  let reason: string;
  try {
    reason = decodeURIComponent(encoded);
  } catch {
    throw new BadRequestException(
      'X-AnySentry-Raw-View-Reason must be URI-encoded UTF-8',
    );
  }
  if (
    reason.length < 12
    || reason.length > 500
    || /[\u0000-\u001f\u007f]/u.test(reason)
  ) {
    throw new BadRequestException(
      'raw content access requires a 12-500 character X-AnySentry-Raw-View-Reason',
    );
  }
  return reason;
}

function auditActor(headers: HeaderBag) {
  return {
    type: 'operator' as const,
    id: headerValue(headers, 'x-anysentry-actor-id')?.trim().slice(0, 160)
      || 'raw-view-operator',
    displayName: headerValue(headers, 'x-anysentry-actor-name')?.trim().slice(0, 160),
    sourceIp:
      headerValue(headers, 'x-forwarded-for')?.split(',')[0]?.trim().slice(0, 80),
    userAgent: headerValue(headers, 'user-agent')?.trim().slice(0, 240),
  };
}

function protectedInteractionSource(
  sources: IngestionSourceService,
  body: unknown,
  headers: HeaderBag,
) {
  const root =
    body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  const collectorId =
    typeof root.collectorId === 'string' ? root.collectorId.trim() : undefined;
  const workspacePath =
    typeof root.workspacePath === 'string' ? root.workspacePath.trim() : undefined;
  const sourceId = headerValue(headers, 'x-anysentry-source-id')?.trim();
  const token =
    headerValue(headers, 'x-anysentry-ingest-token')?.trim() || bearerToken(headers);
  let resolution = sources.resolve({
    sourceId,
    token,
    collectorId,
    workspacePath,
    type: 'forwarder',
  });
  const bindings = resolution.source?.correlationClaims?.bindings;
  if (resolution.accepted && resolution.source?.correlationClaims?.enabled && bindings) {
    resolution = sources.resolve({
      sourceId,
      token,
      collectorId,
      workspacePath,
      type: 'forwarder',
      correlationClaim: {
        authority: 'observer_runtime',
        collectorId,
        ...(bindings.workspacePaths.length > 0 ? { workspacePath } : {}),
      },
    });
  }
  if (
    !resolution.accepted
    || !resolution.authenticated
    || !resolution.source
    || resolution.source.discovered
    || !resolution.source.requireToken
  ) {
    throw new UnauthorizedException(
      resolution.reason || 'a protected ingestion source token is required',
    );
  }
  if (
    resolution.source.correlationClaims?.enabled
    && !resolution.claimAuthorization
  ) {
    throw new UnauthorizedException(
      `interaction correlation claim rejected: ${resolution.claimAuthorizationReason}`,
    );
  }
  return { resolution, collectorId, workspacePath };
}

@UseGuards(ManagementAuthGuard)
@Controller('security-center')
export class InteractionController {
  constructor(
    private readonly interactions: InteractionService,
    private readonly uosSystemEvidence: UosSystemEvidenceService,
    private readonly sources: IngestionSourceService,
    private readonly audit: AuditService,
  ) {}

  @Post('interactions/ingest')
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ) {
    const { resolution, collectorId, workspacePath } =
      protectedInteractionSource(this.sources, body, headers);
    try {
      const receipt = await this.interactions.ingest(body, {
        sourceId: resolution.source!.sourceId,
        environmentId: resolution.source!.environment,
      });
      this.sources.recordAccepted(resolution, 'event', {
        collectorId,
        workspacePath,
      });
      return receipt;
    } catch (error) {
      if (
        error instanceof UnauthorizedException
        || (error && typeof error === 'object' && 'getStatus' in error)
      ) {
        throw error;
      }
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid interaction metadata',
      );
    }
  }

  @Post('interactions/ingest-content')
  @HttpCode(202)
  async ingestContent(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ) {
    const { resolution, collectorId, workspacePath } =
      protectedInteractionSource(this.sources, body, headers);
    try {
      const receipt = await this.interactions.ingestContent(body, {
        sourceId: resolution.source!.sourceId,
        environmentId: resolution.source!.environment,
      });
      this.sources.recordAccepted(resolution, 'event', {
        collectorId,
        workspacePath,
      });
      return receipt;
    } catch (error) {
      if (error && typeof error === 'object' && 'getStatus' in error) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid Interaction content envelope',
      );
    }
  }

  @Get('interactions/status')
  @RequireManagementAuth()
  @AllowUnsafeLocalInteractionDirectView()
  status() {
    return {
      ...this.interactions.status(),
      managementAuthenticationConfigured: managementAuthConfigured(),
    };
  }

  @Get('conversations')
  @RequireManagementAuth()
  @AllowUnsafeLocalInteractionDirectView()
  conversations(
    @Query('limit') limit?: string,
    @Query('collectorId') collectorId?: string,
    @Query('agentInstanceId') agentInstanceId?: string,
    @Query('workspacePath') workspacePath?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    return this.interactions.conversations({
      limit: numberQuery(limit),
      collectorId,
      agentInstanceId,
      workspacePath,
      since: numberQuery(since),
      until: numberQuery(until),
    });
  }

  @Get('conversations/:conversationId/system-evidence')
  @RequireManagementAuth()
  @AllowUnsafeLocalInteractionDirectView()
  conversationSystemEvidence(
    @Param('conversationId') conversationId: string,
    @Query('evidenceLimit') evidenceLimitValue?: string,
  ) {
    const evidenceLimit = numberQuery(evidenceLimitValue);
    if (evidenceLimit !== undefined && (evidenceLimit < 1 || evidenceLimit > 5_000)) {
      throw new BadRequestException('evidenceLimit must be between 1 and 5000');
    }
    return this.uosSystemEvidence.evidence(conversationId, evidenceLimit);
  }

  @Get('conversations/:conversationId')
  @RequireManagementAuth()
  @AllowUnsafeLocalInteractionDirectView()
  async conversation(@Param('conversationId') conversationId: string) {
    const detail = await this.interactions.conversation(conversationId);
    if (!detail) throw new NotFoundException('observed conversation was not found');
    return detail;
  }

  @Get('interactions/:interactionId/content')
  @RequireManagementAuth()
  @AllowUnsafeLocalInteractionDirectView()
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  async content(
    @Param('interactionId') interactionId: string,
    @Headers() headers: HeaderBag,
  ) {
    const reason = this.authorizeRawView(interactionId, headers, 'view');
    try {
      const content = await this.interactions.content(interactionId);
      if (!content) throw new NotFoundException('Interaction content was not found or was deleted');
      this.audit.record({
        actor: auditActor(headers),
        action: 'interaction.content.viewed',
        resourceType: 'interaction',
        resourceId: interactionId,
        summary: `Viewed encrypted Agent ${content.messageRole} message content`,
        details: {
          reason,
          messageRole: content.messageRole,
          contentRole: content.contentRole,
          contentRef: content.contentRef,
          contentBytes: content.contentBytes,
          keyVersion: content.keyVersion,
        },
      });
      return content;
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        this.audit.record({
          actor: auditActor(headers),
          action: 'interaction.content.viewed',
          resourceType: 'interaction',
          resourceId: interactionId,
          summary: 'Failed to view encrypted Agent conversation content',
          result: 'failure',
          details: { reason, error: error instanceof Error ? error.message : 'unknown' },
        });
      }
      throw error;
    }
  }

  @Delete('interactions/:interactionId/content')
  @RequireManagementAuth()
  @Header('Cache-Control', 'no-store, max-age=0')
  async deleteContent(
    @Param('interactionId') interactionId: string,
    @Headers() headers: HeaderBag,
  ) {
    const reason = this.authorizeRawView(interactionId, headers, 'delete');
    const result = await this.interactions.deleteContent(interactionId);
    if (result === 'unavailable') {
      throw new ForbiddenException('Interaction content store is unavailable');
    }
    if (result === 'not_found') {
      throw new NotFoundException('Interaction content was not found');
    }
    this.audit.record({
      actor: auditActor(headers),
      action: 'interaction.content.deleted',
      resourceType: 'interaction',
      resourceId: interactionId,
      summary: 'Deleted encrypted Agent conversation content',
      details: { reason },
    });
    return {
      schemaVersion: 'anysentry.interaction-content-deletion.v1',
      interactionId,
      deleted: true,
      deletedAt: Date.now(),
    };
  }

  private authorizeRawView(
    interactionId: string,
    headers: HeaderBag,
    operation: 'view' | 'delete',
  ): string {
    if (operation === 'view' && this.interactions.directViewEnabled()) {
      return 'unsafe_local_direct_view';
    }
    if (!managementAuthConfigured()) {
      throw new ForbiddenException(
        'raw Interaction content requires configured management authentication',
      );
    }
    const reason = rawViewReason(headers);
    const rawToken = headerValue(headers, 'x-anysentry-raw-view-token')?.trim();
    if (!this.interactions.rawViewAuthorized(rawToken)) {
      this.audit.record({
        actor: auditActor(headers),
        action: operation === 'view'
          ? 'interaction.content.viewed'
          : 'interaction.content.deleted',
        resourceType: 'interaction',
        resourceId: interactionId,
        summary: `Rejected encrypted Agent instruction content ${operation}`,
        result: 'failure',
        details: { reason, cause: 'raw_view_capability_rejected' },
      });
      throw new ForbiddenException(
        'raw Interaction content capability is disabled or invalid',
      );
    }
    return reason;
  }
}
