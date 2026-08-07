import { Module } from '@nestjs/common';
import { AgentAttributionService } from './agent-attribution.service';
import { AgentMetadataService } from './agent-metadata.service';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import { IngestionSourceService } from './ingestion-source.service';
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

@Module({
  controllers: [SecurityMonitoringController],
  providers: [AgentAttributionService, AgentMetadataService, AlertingService, AuditService, IngestionSourceService, MaintenanceWindowService, NotificationService, ObjectiveService, SentryJudgeService, AggregationService, RemediationService, KubeIdentityService, ManagementAuthGuard, JudgmentQueueService, DecisionResultApplyService, StreamingQueueService, StreamingFindingService, SupplyChainService, SecurityAssistantService],
})
export class SecurityMonitoringModule {}
