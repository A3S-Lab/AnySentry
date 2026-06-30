import { Module } from '@nestjs/common';
import { AgentMetadataService } from './agent-metadata.service';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import { IngestionSourceService } from './ingestion-source.service';
import { KubeIdentityService } from './kube-identity.service';
import { ManagementAuthGuard } from './management-auth.guard';
import { MaintenanceWindowService } from './maintenance-window.service';
import { NotificationService } from './notification.service';
import { ObjectiveService } from './objective.service';
import { RemediationService } from './remediation.service';
import { SecurityMonitoringController } from './security-monitoring.controller';
import { SentryJudgeService } from './sentry-judge.service';

@Module({
  controllers: [SecurityMonitoringController],
  providers: [AgentMetadataService, AlertingService, AuditService, IngestionSourceService, MaintenanceWindowService, NotificationService, ObjectiveService, SentryJudgeService, AggregationService, RemediationService, KubeIdentityService, ManagementAuthGuard],
})
export class SecurityMonitoringModule {}
