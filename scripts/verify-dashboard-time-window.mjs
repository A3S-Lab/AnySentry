import assert from "node:assert/strict";
import { resolveTimeWindow } from "../apps/api/dist/security-monitoring/time-window.js";

const clock = Date.parse("2026-08-03T06:00:00.000Z");

const threeHours = resolveTimeWindow({ timeType: "last_3h" }, clock);
assert.equal(threeHours.endMs, clock);
assert.equal(threeHours.spanMs, 3 * 60 * 60_000);

const oneDay = resolveTimeWindow({ timeType: "last_1d" }, clock);
assert.equal(oneDay.endMs, clock);
assert.equal(oneDay.spanMs, 24 * 60 * 60_000);

const customEnd = Date.parse("2026-07-25T23:59:59.999Z");
const custom = resolveTimeWindow({
  timeType: "custom",
  startTime: "2026-07-24T00:00:00.000Z",
  endTime: "2026-07-25T23:59:59.999Z",
}, clock);
assert.equal(custom.endMs, customEnd);
assert.ok(custom.cacheKey.includes(String(customEnd)), "custom cache key must include endTime");

const invalidCustom = resolveTimeWindow({
  timeType: "custom",
  startTime: "2026-07-26T00:00:00.000Z",
  endTime: "2026-07-25T00:00:00.000Z",
}, clock);
assert.equal(invalidCustom.spanMs, 3 * 60 * 60_000);

console.log("dashboard time-window verification passed");
