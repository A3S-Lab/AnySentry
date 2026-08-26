import { Module } from '@nestjs/common';
import { AgentRuntimeStateService } from './agent-runtime-state.service';
import { AgentAttributionService } from './agent-attribution.service';
import { AgentMetadataService } from './agent-metadata.service';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import { IngestionSourceService } from './ingestion-source.service';
import { IdentityEvidenceService } from './identity-evidence.service';
import { IdentityReviewAgentService } from './identity-review-agent.service';
import { JudgmentQueueService } from './judgment-queue.service';
import { DecisionResultApplyService } from './decision-result-apply.service';
import { KubeIdentityService } from './kube-identity.service';
import { ManagementAuthGuard } from './management-auth.guard';
import { MaintenanceWindowService } from './maintenance-window.service';
import { NotificationService } from './notification.service';
import { ObjectiveService } from './objective.service';
import { RemediationService } from './remediation.service';
import { SecurityMonitoringController } from './security-monitoring.controller';
import { InfrastructureRuleController } from './infrastructure-rule.controller';
import { InfrastructureRuleService } from './infrastructure-rule.service';
import { SecurityAssistantService } from './security-assistant.service';
import { SentryJudgeService } from './sentry-judge.service';
import { StreamingFindingService } from './streaming-finding.service';
import { StreamingQueueService } from './streaming-queue.service';
import { SupplyChainService } from './supply-chain.service';
import { RuntimeModelConfigService } from './runtime-model-config';
import { DistributedCurrentStateService } from './distributed-current-state.service';
import { RelationalBusinessStore } from './relational-business-store.service';
import { WorkspaceDirectoryService } from './workspace-directory.service';
import { SystemContextService } from './system-context.service';
import { PrometheusContextService } from './prometheus-context.service';
import { UnknownLearningRuntimeService } from './unknown-learning-runtime.service';
import { ObservedAssetLifecycleController } from './observed-asset-lifecycle.controller';
import { ObservedAssetLifecycleService } from './observed-asset-lifecycle.read.service';
import { InfrastructureAssetSnapshotService } from './infrastructure-asset-snapshot.service';
import { INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER } from './infrastructure-rule-governance';
import { ObservedAssetReviewService } from './observed-asset-review.service';
import { FilterRuleCatalogService } from './filter-rule-catalog.service';
import { FilterRuleSystemService } from './filter-rule-system.service';
import { FilterRuleController } from './filter-rule.controller';

@Module({
  controllers: [SecurityMonitoringController, InfrastructureRuleController, FilterRuleController, ObservedAssetLifecycleController],
  providers: [AgentRuntimeStateService, AgentAttributionService, RelationalBusinessStore, AgentMetadataService, WorkspaceDirectoryService, AlertingService, AuditService, InfrastructureRuleService, FilterRuleCatalogService, FilterRuleSystemService, IngestionSourceService, MaintenanceWindowService, NotificationService, ObjectiveService, DistributedCurrentStateService, SentryJudgeService, AggregationService, IdentityEvidenceService, RuntimeModelConfigService, IdentityReviewAgentService, RemediationService, KubeIdentityService, PrometheusContextService, ManagementAuthGuard, JudgmentQueueService, DecisionResultApplyService, StreamingQueueService, StreamingFindingService, SupplyChainService, SecurityAssistantService, SystemContextService, UnknownLearningRuntimeService, ObservedAssetLifecycleService, ObservedAssetReviewService, InfrastructureAssetSnapshotService, { provide: INFRASTRUCTURE_ASSET_SNAPSHOT_PROVIDER, useExisting: InfrastructureAssetSnapshotService }],
})
export class SecurityMonitoringModule {}
