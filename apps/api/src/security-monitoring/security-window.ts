import { BadRequestException } from '@nestjs/common';
import * as T from './types';

const HOUR = 3_600_000;
const WINDOW: Record<Exclude<T.SecurityTimeFilter['timeType'], 'custom' | undefined>, number> = {
  last_3h: 3 * HOUR,
  last_1d: 24 * HOUR,
  last_7d: 7 * 24 * HOUR,
  last_30d: 30 * 24 * HOUR,
};
const TIME_TYPES = new Set([...Object.keys(WINDOW), 'custom']);

export interface SecurityWindow {
  sinceMs: number;
  endMs: number;
  spanMs: number;
}

function parsedTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveSecurityWindow(filter: T.SecurityTimeFilter, currentTime = Date.now()): SecurityWindow {
  if (filter.timeType !== 'custom') {
    const duration = WINDOW[filter.timeType ?? 'last_3h'] ?? WINDOW.last_3h;
    return { sinceMs: currentTime - duration, endMs: currentTime, spanMs: duration };
  }

  const endMs = parsedTime(filter.endTime) ?? currentTime;
  const sinceMs = parsedTime(filter.startTime) ?? endMs - WINDOW.last_3h;
  return { sinceMs, endMs, spanMs: Math.max(1, endMs - sinceMs) };
}

export function validateOpenSecurityFilter(input: unknown, allowSeriesPoints = false): T.ExplainabilityScanRequest {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('请求体必须是 JSON 对象');

  const value = input as Record<string, unknown>;
  const allowedFields = new Set(['timeType', 'startTime', 'endTime', ...(allowSeriesPoints ? ['seriesPoints'] : [])]);
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new BadRequestException('不支持的请求字段: ' + unknownFields.join(', '));
  const normalized = { ...value };

  if (value.timeType !== undefined && (typeof value.timeType !== 'string' || !TIME_TYPES.has(value.timeType))) {
    throw new BadRequestException('timeType 无效');
  }

  for (const field of ['startTime', 'endTime'] as const) {
    const fieldValue = value[field];
    if (fieldValue === null || (typeof fieldValue === 'string' && fieldValue.trim() === '')) {
      delete normalized[field];
      continue;
    }
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || parsedTime(fieldValue) === undefined)) {
      throw new BadRequestException(field + ' 必须是有效时间');
    }
  }

  const startMs = parsedTime(normalized.startTime as string | undefined);
  const endMs = parsedTime(normalized.endTime as string | undefined);
  if (startMs !== undefined && endMs !== undefined && endMs < startMs) {
    throw new BadRequestException('endTime 不能早于 startTime');
  }

  if (value.seriesPoints !== undefined) {
    if (!allowSeriesPoints) throw new BadRequestException('不支持的请求字段: seriesPoints');
    if (!Number.isInteger(value.seriesPoints) || (value.seriesPoints as number) < 1 || (value.seriesPoints as number) > 1000) {
      throw new BadRequestException('seriesPoints 必须是 1 到 1000 之间的整数');
    }
  }

  return normalized as T.ExplainabilityScanRequest;
}
