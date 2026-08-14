import dayjs, { type Dayjs } from "dayjs";

// ClickHouse DateTime columns are stored as UTC, but the JSON response uses
// `YYYY-MM-DD HH:mm:ss` without a zone suffix. Browsers otherwise interpret
// that shape as local time and display it eight hours behind in UTC+8.
const NAIVE_UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export type SecurityTimestamp = string | number | Date | null | undefined;

export function normalizeSecurityTimestamp(value: SecurityTimestamp): string | number | Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;
  return NAIVE_UTC_TIMESTAMP.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

export function parseSecurityTimestamp(value: SecurityTimestamp): Dayjs {
  return dayjs(normalizeSecurityTimestamp(value));
}

export function securityTimestampValue(value: SecurityTimestamp): number {
  const parsed = parseSecurityTimestamp(value);
  return parsed.isValid() ? parsed.valueOf() : 0;
}

export function formatSecurityDateTime(
  value: SecurityTimestamp,
  format = "MM-DD HH:mm:ss",
  fallback = "--",
): string {
  const parsed = parseSecurityTimestamp(value);
  return parsed.isValid() ? parsed.format(format) : fallback;
}

/**
 * Relative ranges are live views. Align their snapshot so every request in the same polling
 * cycle sees one consistent boundary, while the next cycle advances instead of reusing the
 * snapshot captured in the URL when the page was opened.
 */
export function liveSecuritySnapshotAsOf(
  custom: boolean,
  configuredSnapshot?: string,
  quantumMs = 10_000,
): string | undefined {
  if (custom) return configuredSnapshot;
  const quantum = Math.max(1, Math.trunc(quantumMs));
  return new Date(Math.floor(Date.now() / quantum) * quantum).toISOString();
}
