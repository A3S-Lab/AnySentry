import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { LocalRecordTrackingService } from './local-record-tracking.service';

function integerQuery(
  value: string | undefined,
  label: string,
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function booleanQuery(
  value: string | undefined,
  label: string,
): boolean | undefined {
  if (!value?.trim()) return undefined;
  if (/^(?:1|true|on|yes)$/iu.test(value.trim())) return true;
  if (/^(?:0|false|off|no)$/iu.test(value.trim())) return false;
  throw new BadRequestException(`${label} must be a boolean`);
}

@Controller('security-center/local-records')
export class LocalRecordTrackingController {
  constructor(private readonly records: LocalRecordTrackingService) {}

  @Get('status')
  status() {
    return this.records.status();
  }

  @Get()
  list(
    @Query('limit') limitValue?: string,
    @Query('search') search?: string,
    @Query('activityStatus') activityStatus?: string,
    @Query('processStatus') processStatus?: string,
  ) {
    const limit = integerQuery(limitValue, 'limit');
    if (limit !== undefined && (limit < 1 || limit > 500)) {
      throw new BadRequestException('limit must be between 1 and 500');
    }
    if (
      activityStatus
      && !['all', 'active', 'recent', 'stopped'].includes(activityStatus)
    ) {
      throw new BadRequestException(
        'activityStatus must be all, active, recent, or stopped',
      );
    }
    if (
      processStatus
      && !['all', 'running', 'exited', 'unknown'].includes(processStatus)
    ) {
      throw new BadRequestException(
        'processStatus must be all, running, exited, or unknown',
      );
    }
    return this.records.listRecords({
      limit,
      search,
      activityStatus,
      processStatus,
    });
  }

  @Get(':recordId/resources')
  resources(@Param('recordId') recordId: string) {
    if (!/^[a-f0-9]{24}$/u.test(recordId)) throw new BadRequestException('invalid local record id');
    return this.records.recordResources(recordId);
  }

  @Get(':recordId')
  detail(
    @Param('recordId') recordId: string,
    @Query('limit') limitValue?: string,
    @Query('beforeOffset') beforeOffsetValue?: string,
    @Query('evidenceLimit') evidenceLimitValue?: string,
    @Query('includeSystemEvidence') includeSystemEvidenceValue?: string,
    @Query('includeObservedLlmRequests') includeObservedLlmRequestsValue?: string,
    @Query('includeObservedLlmRequestContent') includeObservedLlmRequestContentValue?: string,
  ) {
    if (!/^[a-f0-9]{24}$/u.test(recordId)) {
      throw new BadRequestException('invalid local record id');
    }
    const limit = integerQuery(limitValue, 'limit');
    if (limit !== undefined && (limit < 1 || limit > 500)) {
      throw new BadRequestException('limit must be between 1 and 500');
    }
    const evidenceLimit = integerQuery(evidenceLimitValue, 'evidenceLimit');
    if (evidenceLimit !== undefined && (evidenceLimit < 1 || evidenceLimit > 5_000)) {
      throw new BadRequestException('evidenceLimit must be between 1 and 5000');
    }
    const includeSystemEvidence = booleanQuery(
      includeSystemEvidenceValue,
      'includeSystemEvidence',
    );
    return this.records.recordDetail(recordId, {
      limit,
      beforeOffset: integerQuery(beforeOffsetValue, 'beforeOffset'),
      evidenceLimit,
      includeSystemEvidence,
      includeObservedLlmRequests: booleanQuery(
        includeObservedLlmRequestsValue,
        'includeObservedLlmRequests',
      ),
      includeObservedLlmRequestContent: booleanQuery(
        includeObservedLlmRequestContentValue,
        'includeObservedLlmRequestContent',
      ),
    });
  }
}
