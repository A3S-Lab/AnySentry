// Offline mechanism check: no agents, probes, network calls or production writes.
const { AgentAttributor } = require('../../../scripts/observer-agent-attribution.js');

function reproduce(hasGeneration) {
  const attributor = new AgentAttributor({
    hostId: 'test-host', bootId: 'test-boot', rootNames: 'kimi',
    readProc: () => undefined, readStartTime: () => undefined, listPids: () => [],
  });
  const common = { hostId: 'test-host', bootId: 'test-boot', cgroupId: '900' };
  attributor.classify({ process: { ...common, pid: 10001, ppid: 1, startTimeTicks: '100',
    comm: 'kimi', exe: '/opt/kimi', cwd: '/workspace' },
    event: { ToolExec: { pid: 10001, ppid: 1, argv: ['kimi'] } } });
  const exec = attributor.classify({ process: { ...common, pid: 10002, ppid: 10001,
    comm: 'bash', exe: '/app/cmain', ...(hasGeneration ? { startTimeTicks: '101' } : {}) },
    event: { ToolExec: { pid: 10002, ppid: 10001, argv: ['/app/cmain', '0'] } } });
  const grandchild = attributor.classify({ process: { ...common, pid: 10003, ppid: 10002,
    comm: 'bash', exe: '/usr/bin/gcc' },
    event: { ToolExec: { pid: 10003, ppid: 10002, argv: ['gcc', 'main.c'] } } });
  const exit = attributor.classify({ process: { ...common, pid: 10002, comm: 'cmain' },
    event: { ProcessExit: { pid: 10002, exit_code: 0, signal: 0 } } });
  return { hasGeneration, exec: exec.state, grandchildExec: grandchild.state, exit: exit.state };
}

const results = [reproduce(false), reproduce(true)];
if (results[0].exit !== 'unknown' || results[1].exit !== 'agent') throw new Error(JSON.stringify(results));
console.log(JSON.stringify(results, null, 2));
