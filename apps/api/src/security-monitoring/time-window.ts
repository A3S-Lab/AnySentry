import { SecurityTimeFilter } from './types';

const MINUTE = 60_000;
const HOUR = 3_600_000;
type RelativeSecurityTimeType = Exclude<NonNullable<SecurityTimeFilter['timeType']>, 'custom'>;

export const DEFAULT_SECURITY_TIME_TYPE: RelativeSecurityTimeType = 'last_30m';

const WINDOW_MS: Record<RelativeSecurityTimeType, number> = {
  last_30m: 30 * MINUTE,
  last_1h: HOUR,
  last_2h: 2 * HOUR,
  last_3h: 3 * HOUR,
  last_1d: 24 * HOUR,
  last_7d: 7 * 24 * HOUR,
  last_30d: 30 * 24 * HOUR,
};

export function securityTimeSpanMs(timeType?: SecurityTimeFilter['timeType']): number {
  const relativeTimeType = timeType && timeType !== 'custom'
    ? timeType
    : DEFAULT_SECURITY_TIME_TYPE;
  return WINDOW_MS[relativeTimeType] ?? WINDOW_MS[DEFAULT_SECURITY_TIME_TYPE];
}

export interface ResolvedTimeWindow {
  startMs: number;
  endMs: number;
  spanMs: number;
  custom: boolean;
  cacheKey: string;
}

/**
 * Hard cap for catalogue-style Agent interaction reads (directory / timeline / fair history).
 * UOS field 2026-10-16: an unclamped 30-day window scanned 969 MiB / 5.1 万行 and blew the API's
 * 5s bounded budget (read 892 MiB typically), degrading the directory to the hot ring and
 * back-pressuring the forwarder spool. One day stays ~17x under a 30-day scan (measured:
 * 1h window reads 57 MiB in 0.59s; the full table 969 MiB in 12.2s). Exact membership point
 * reads (interactionIds) are exempt — their ids target specific rows regardless of age.
 */
export const INTERACTION_READ_MAX_SPAN_MS = 24 * 3_600_000;

export function clampInteractionReadWindow(
  window: ResolvedTimeWindow,
  exactMembershipRead: boolean,
): ResolvedTimeWindow {
  if (exactMembershipRead || window.spanMs <= INTERACTION_READ_MAX_SPAN_MS) return window;
  const startMs = window.endMs - INTERACTION_READ_MAX_SPAN_MS;
  return {
    startMs,
    endMs: window.endMs,
    spanMs: INTERACTION_READ_MAX_SPAN_MS,
    custom: window.custom,
    cacheKey: `${window.cacheKey}|clamped24h@${window.endMs}`,
  };
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
  const requestedSnapshot = parsedTime(filter.snapshotAsOf);
  const snapshotMs = Math.min(requestedSnapshot ?? clockMs, clockMs);
  // A future client clock is semantically the same as an omitted snapshot: both clamp to server
  // "now". Keep the relative cache key so concurrent callers share one in-flight history query
  // instead of producing a distinct millisecond key for every request.
  const hasFixedSnapshot = requestedSnapshot !== undefined && requestedSnapshot <= clockMs;
  if (filter.timeType === 'custom') {
    const requestedStart = parsedTime(filter.startTime);
    const requestedEnd = parsedTime(filter.endTime);
    if (requestedStart !== undefined && requestedEnd !== undefined && requestedEnd >= requestedStart) {
      const endMs = Math.min(requestedEnd, snapshotMs);
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

  const timeType = filter.timeType && filter.timeType !== 'custom'
    ? filter.timeType
    : DEFAULT_SECURITY_TIME_TYPE;
  const spanMs = securityTimeSpanMs(timeType);
  return {
    startMs: snapshotMs - spanMs,
    endMs: snapshotMs,
    spanMs,
    custom: false,
    cacheKey: hasFixedSnapshot ? `${timeType}|${snapshotMs}` : timeType,
  };
}
