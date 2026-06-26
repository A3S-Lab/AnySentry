import { Module } from '@nestjs/common';
import { AggregationService } from './aggregation.service';
import { KubeIdentityService } from './kube-identity.service';
import { SecurityMonitoringController } from './security-monitoring.controller';
import { SentryJudgeService } from './sentry-judge.service';

@Module({
  controllers: [SecurityMonitoringController],
  providers: [SentryJudgeService, AggregationService, KubeIdentityService],
})
export class SecurityMonitoringModule {}
