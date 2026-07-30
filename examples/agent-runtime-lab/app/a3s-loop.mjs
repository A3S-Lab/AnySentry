import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import process from 'node:process';
import { Agent } from '@a3s-lab/code';

const workspace = process.env.AGENT_WORKSPACE || '/workspace';
const aclPath = process.env.A3S_CODE_ACL || '/opt/agent-lab/config/agent.acl';
const intervalMs = Math.max(1, Number(process.env.AGENT_INTERVAL_SECONDS || 20)) * 1000;
const agentId = process.env.AGENT_ID || 'a3s-code-tool-loop';

let stopping = false;
let session;

function log(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    runtime: 'a3s-code',
    agentId,
    event,
    ...fields,
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitLocalIdentityProbe() {
  const socket = connect({ host: '127.0.0.1', port: 9 });
  socket.setTimeout(1_000);
  socket.once('connect', () => socket.destroy());
  socket.once('error', () => socket.destroy());
  socket.once('timeout', () => socket.destroy());
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    log('shutdown_requested', { signal });
  });
}

async function closeSession() {
  if (!session) return;
  try {
    await session.closeAsync();
    log('session_closed');
  } catch (error) {
    log('session_close_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  await mkdir(workspace, { recursive: true });
  await writeFile(`${workspace}/canary.txt`, 'AnySentry A3S Code tool-loop canary\n', 'utf8');

  const agent = await Agent.create(aclPath);
  session = await agent.sessionAsync(workspace, {
    planningMode: 'disabled',
    toolTimeoutMs: 30_000,
  });

  log('started', {
    pid: process.pid,
    workspace,
    intervalSeconds: intervalMs / 1000,
    tools: session.toolNames(),
  });
  await writeFile('/tmp/agent-ready', `${Date.now()}\n`, 'utf8');

  let round = 0;
  while (!stopping) {
    round += 1;
    const marker = `${agentId}-round-${round}`;
    const startedAt = Date.now();
    try {
      await session.writeFile('last-round.txt', `${marker}\n`);
      const canary = await session.readFile('canary.txt');
      const shellOutput = await session.bash(
        `printf '%s\\n' '${marker}' >> tool-events.log && printf '%s' '${marker}'`,
      );
      emitLocalIdentityProbe();
      await writeFile('/tmp/agent-ready', `${Date.now()}\n`, 'utf8');
      log('tool_round_completed', {
        round,
        marker,
        elapsedMs: Date.now() - startedAt,
        canary: canary.trim(),
        shellOutput: shellOutput.trim(),
      });
    } catch (error) {
      log('tool_round_failed', {
        round,
        marker,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!stopping) await delay(intervalMs);
  }
}

try {
  await main();
} catch (error) {
  log('fatal', {
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await closeSession();
}
