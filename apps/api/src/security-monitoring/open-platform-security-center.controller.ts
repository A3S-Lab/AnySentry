import { Body, Controller, HttpCode, Post, UseFilters } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SkipWrap } from '../shared/api-response.interceptor';
import { AggregationService } from './aggregation.service';
import { OpenPlatformExceptionFilter } from './open-platform-exception.filter';
import { validateOpenSecurityFilter } from './security-window';

interface OpenPlatformSuccess<T> {
  code: 200;
  status: 'SUCCESS';
  message: '成功';
  data: T;
  requestId: string;
  timestamp: string;
}

function success<T>(data: T): OpenPlatformSuccess<T> {
  return {
    code: 200,
    status: 'SUCCESS',
    message: '成功',
    data,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

@SkipWrap()
@UseFilters(OpenPlatformExceptionFilter)
@Controller('api/v1/open/security-center')
export class OpenPlatformSecurityCenterController {
  constructor(private readonly agg: AggregationService) {}

  @Post('top/healthCard')
  @HttpCode(200)
  healthCard(@Body() body: unknown) {
    return success(this.agg.healthCard(validateOpenSecurityFilter(body)));
  }

  @Post('top/explainabilityScan')
  @HttpCode(200)
  explainabilityScan(@Body() body: unknown) {
    return success(this.agg.explainabilityScan(validateOpenSecurityFilter(body, true)));
  }

  @Post('top/performanceCard')
  @HttpCode(200)
  performanceCard(@Body() body: unknown) {
    return success(this.agg.performanceCard(validateOpenSecurityFilter(body)));
  }

  @Post('risks/summary')
  @HttpCode(200)
  riskSummary(@Body() body: unknown) {
    return success(this.agg.riskSummary(validateOpenSecurityFilter(body)));
  }

  @Post('risks/breakdown')
  @HttpCode(200)
  riskBreakdown(@Body() body: unknown) {
    return success(this.agg.riskBreakdown(validateOpenSecurityFilter(body)));
  }

  @Post('sessions/highestRisk')
  @HttpCode(200)
  highestRisk(@Body() body: unknown) {
    return success(this.agg.highestRiskSession(validateOpenSecurityFilter(body)));
  }

  @Post('sessions/decisionFunnel')
  @HttpCode(200)
  decisionFunnel(@Body() body: unknown) {
    return success(this.agg.decisionFunnel(validateOpenSecurityFilter(body)));
  }

  @Post('sessions/workspaceRiskDistribution')
  @HttpCode(200)
  workspaceRiskDistribution(@Body() body: unknown) {
    return success(this.agg.workspaceRiskDistribution(validateOpenSecurityFilter(body)));
  }
}
