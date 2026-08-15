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
import { SecurityAssistantService } from './security-assistant.service';
import { SentryJudgeService } from './sentry-judge.service';
import { StreamingFindingService } from './streaming-finding.service';
import { StreamingQueueService } from './streaming-queue.service';
import { SupplyChainService } from './supply-chain.service';
import { RuntimeModelConfigService } from './runtime-model-config';
import { DistributedCurrentStateService } from './distributed-current-state.service';
import { RelationalBusinessStore } from './relational-business-store.service';
import { WorkspaceDirectoryService } from './workspace-directory.service';

@Module({
  controllers: [SecurityMonitoringController],
  providers: [AgentRuntimeStateService, AgentAttributionService, RelationalBusinessStore, AgentMetadataService, WorkspaceDirectoryService, AlertingService, AuditService, IngestionSourceService, MaintenanceWindowService, NotificationService, ObjectiveService, DistributedCurrentStateService, SentryJudgeService, AggregationService, IdentityEvidenceService, RuntimeModelConfigService, IdentityReviewAgentService, RemediationService, KubeIdentityService, ManagementAuthGuard, JudgmentQueueService, DecisionResultApplyService, StreamingQueueService, StreamingFindingService, SupplyChainService, SecurityAssistantService],
})
export class SecurityMonitoringModule {}
