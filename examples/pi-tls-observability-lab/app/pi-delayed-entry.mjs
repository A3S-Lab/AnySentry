import { writeFile } from 'node:fs/promises';
import process from 'node:process';

function boundedSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(120, parsed)) : 5;
}

process.title = 'pi';
process.env.PI_CODING_AGENT = 'true';

const graceSeconds = boundedSeconds(process.env.PI_LAB_ATTACH_GRACE_SECONDS);
const ready = {
  schemaVersion: 'anysentry.pi_attach_ready.v1',
  pid: process.pid,
  executable: process.execPath,
  processTitle: process.title,
  readyAt: new Date().toISOString(),
  graceSeconds,
};
if (process.env.PI_LAB_READY_FILE) {
  await writeFile(process.env.PI_LAB_READY_FILE, `${JSON.stringify(ready)}\n`, { encoding: 'utf8', mode: 0o600 });
}
process.stderr.write(`${JSON.stringify({ event: 'pi_attach_grace_started', ...ready })}\n`);
if (graceSeconds > 0) {
  await new Promise((resolve) => setTimeout(resolve, graceSeconds * 1_000));
}

await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));
