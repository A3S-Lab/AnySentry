import { SecurityTimeFilter } from './types';

const HOUR = 3_600_000;
const WINDOW_MS: Record<Exclude<NonNullable<SecurityTimeFilter['timeType']>, 'custom'>, number> = {
  last_3h: 3 * HOUR,
  last_1d: 24 * HOUR,
  last_7d: 7 * 24 * HOUR,
  last_30d: 30 * 24 * HOUR,
};

export interface ResolvedTimeWindow {
  startMs: number;
  endMs: number;
  spanMs: number;
  custom: boolean;
  cacheKey: string;
}

function parsedTime(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve every dashboard filter to one closed interval. Preset ranges end at the supplied clock;
 * custom ranges honor both boundaries and never silently extend through "now".
 */
export function resolveTimeWindow(filter: SecurityTimeFilter, clockMs = Date.now()): ResolvedTimeWindow {
  if (filter.timeType === 'custom') {
    const requestedStart = parsedTime(filter.startTime);
    const requestedEnd = parsedTime(filter.endTime);
    if (requestedStart !== undefined && requestedEnd !== undefined && requestedEnd >= requestedStart) {
      const endMs = Math.min(requestedEnd, clockMs);
      const startMs = Math.min(requestedStart, endMs);
      return {
        startMs,
        endMs,
        spanMs: Math.max(1, endMs - startMs),
        custom: true,
        cacheKey: `custom|${startMs}|${endMs}`,
      };
    }
  }

  const timeType = filter.timeType && filter.timeType !== 'custom' ? filter.timeType : 'last_3h';
  const spanMs = WINDOW_MS[timeType] ?? WINDOW_MS.last_3h;
  return {
    startMs: clockMs - spanMs,
    endMs: clockMs,
    spanMs,
    custom: false,
    cacheKey: timeType,
  };
}
