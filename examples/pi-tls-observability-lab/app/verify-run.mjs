import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const resultsDirectory = path.resolve(process.env.PI_LAB_RESULTS_DIR || process.argv[2] || '.runtime/results');
const workspace = path.resolve(process.env.PI_LAB_WORKSPACE || process.argv[3] || '.runtime/workspace');
const expectFixture = !['0', 'false', 'no'].includes((process.env.PI_LAB_EXPECT_FIXTURE || '1').toLowerCase());
const fakeTranscriptPath = path.join(resultsDirectory, 'fake-llm.ndjson');
const piTranscriptPath = path.join(resultsDirectory, 'pi-events.ndjson');
const reportPath = path.join(resultsDirectory, 'verification.json');
const FINAL_PROMPT_SENTINEL = 'PI_FINAL_PROMPT_SENTINEL_20260827';
const CANARY_SENTINEL = 'PI_CANARY_RESULT_SENTINEL_20260827';
const TOOL_RESULT_SENTINEL = 'PI_BASH_RESULT_SENTINEL_20260827';
const INTERNAL_RAG_SENTINEL = 'PI_INTERNAL_RAG_MUST_NOT_LEAK_20260827';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readNdjson(filePath, required = true) {
  try {
    return (await readFile(filePath, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`${filePath}:${index + 1} is not valid JSON`);
        }
      });
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return [];
    throw error;
  }
}

function content(value) {
  return JSON.stringify(value);
}

const assertions = [];
function assert(name, condition, details = {}) {
  assertions.push({ name, passed: Boolean(condition), details });
}

function eventNs(event, field = 'atUnixNs') {
  try {
    return BigInt(event[field]);
  } catch {
    return -1n;
  }
}

const piEvents = await readNdjson(piTranscriptPath);
const fakeEvents = await readNdjson(fakeTranscriptPath, expectFixture);
const processExit = piEvents.findLast((event) => event.event === 'pi_process_exited');
assert('pi process exits successfully', processExit?.code === 0 && processExit?.timedOut === false, processExit);

const stdoutRecords = piEvents
  .filter((event) => event.event === 'pi_stdout_line' && event.parsed)
  .map((event) => ({ envelope: event, record: event.parsed }));
const toolStarts = stdoutRecords.filter(({ record }) => record.type === 'tool_execution_start');
const toolEnds = stdoutRecords.filter(({ record }) => record.type === 'tool_execution_end');
assert('Pi emits read then bash tool starts',
  toolStarts.length === 2 && toolStarts[0].record.toolName === 'read' && toolStarts[1].record.toolName === 'bash',
  { toolStarts: toolStarts.map(({ envelope, record }) => ({ at: envelope.observedAt, ...record })) });
assert('Pi emits matching tool end records',
  toolEnds.length === 2
    && toolEnds.every(({ record }) => toolStarts.some(({ record: start }) => start.toolCallId === record.toolCallId))
    && toolEnds.every(({ record }) => record.isError === false),
  { toolEnds: toolEnds.map(({ envelope, record }) => ({ at: envelope.observedAt, ...record })) });
for (const toolStart of toolStarts) {
  const toolEnd = toolEnds.find(({ record }) => record.toolCallId === toolStart.record.toolCallId);
  assert(`tool ${toolStart.record.toolName} has non-negative observed duration`,
    Boolean(toolEnd) && eventNs(toolEnd.envelope, 'observedAtMonotonicNs') >= eventNs(toolStart.envelope, 'observedAtMonotonicNs'),
    {
      toolCallId: toolStart.record.toolCallId,
      startedAt: toolStart.envelope.observedAt,
      endedAt: toolEnd?.envelope.observedAt,
    });
}
assert('read tool input is verifiable', content(toolStarts[0]?.record.args).includes('canary.txt'), toolStarts[0]?.record.args);
assert('bash tool input is verifiable', content(toolStarts[1]?.record.args).includes(TOOL_RESULT_SENTINEL), toolStarts[1]?.record.args);
assert('read result is verifiable', content(toolEnds[0]?.record.result).includes(CANARY_SENTINEL), toolEnds[0]?.record.result);
assert('bash result is verifiable', content(toolEnds[1]?.record.result).includes(TOOL_RESULT_SENTINEL), toolEnds[1]?.record.result);

let toolLog = '';
try {
  toolLog = await readFile(path.join(workspace, 'tool-events.log'), 'utf8');
} catch {}
assert('bash side effect occurs exactly once', toolLog.split(TOOL_RESULT_SENTINEL).length - 1 === 1, { toolLog });

if (expectFixture) {
  const fakeTranscriptRaw = await readFile(fakeTranscriptPath, 'utf8');
  const requests = fakeEvents.filter((event) => event.event === 'request_received');
  const starts = fakeEvents.filter((event) => event.event === 'response_started');
  const completions = fakeEvents.filter((event) => event.event === 'response_completed');
  assert('fake LLM receives exactly three model requests', requests.length === 3, { requestCount: requests.length });
  assert('model requests follow read, bash, final stages',
    requests.map((event) => event.stage).join(',') === 'read,bash,final',
    { stages: requests.map((event) => event.stage) });
  assert('all requests use one declared transport',
    requests.length === 3 && new Set(requests.map((event) => event.transport)).size === 1,
    { transports: requests.map((event) => event.transport) });
  assert('request raw bodies have valid hashes',
    requests.every((event) => sha256(event.rawBody) === event.bodySha256),
    { hashes: requests.map((event) => event.bodySha256) });
  assert('Authorization value is absent from the fixture transcript',
    !fakeTranscriptRaw.includes('fixture-key-not-secret'), {});
  assert('final prompt reaches the first LLM request', requests[0]?.rawBody.includes(FINAL_PROMPT_SENTINEL), {});
  assert('internal RAG sentinel never reaches the LLM boundary',
    requests.every((event) => !event.rawBody.includes(INTERNAL_RAG_SENTINEL)), {});
  assert('read result reaches the second LLM request', requests[1]?.rawBody.includes(CANARY_SENTINEL), {});
  assert('bash result reaches the third LLM request', requests[2]?.rawBody.includes(TOOL_RESULT_SENTINEL), {});
  assert('LLM response lifecycle is complete for every request', starts.length === 3 && completions.length === 3, {
    responseStarts: starts.length,
    responseCompletions: completions.length,
  });
  assert('request and response times are ordered', requests.every((request, index) => {
    const start = starts.find((event) => event.sequence === request.sequence);
    const completion = completions.find((event) => event.sequence === request.sequence);
    const nextRequest = requests[index + 1];
    return start
      && completion
      && eventNs(request) <= eventNs(start)
      && eventNs(start) <= eventNs(completion)
      && (!nextRequest || eventNs(completion) <= eventNs(nextRequest));
  }), {});
  const responseChunks = fakeEvents.filter((event) => event.event === 'response_chunk_sent');
  assert('LLM responses contain read/bash tool calls and final assistant text',
    content(responseChunks).includes('call_read_fixture')
      && content(responseChunks).includes('call_bash_fixture')
      && content(responseChunks).includes('Fixture complete'), {});
}

const failed = assertions.filter((item) => !item.passed);
const runtimeInfo = JSON.parse(await readFile(path.join(resultsDirectory, 'tls-runtime.json'), 'utf8'));
const report = {
  schemaVersion: 'anysentry.pi_fixture_verification.v1',
  verifiedAt: new Date().toISOString(),
  passed: failed.length === 0,
  expectFixture,
  runtimeInfo,
  evidence: {
    piTranscriptPath,
    fakeTranscriptPath: expectFixture ? fakeTranscriptPath : undefined,
    workspaceToolLog: path.join(workspace, 'tool-events.log'),
  },
  assertions,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({
  event: 'pi_tls_lab_verification',
  passed: report.passed,
  assertionCount: assertions.length,
  failed: failed.map((item) => item.name),
  reportPath,
  tlsAttachHint: runtimeInfo.tlsAttachHint,
}));
if (failed.length > 0) process.exitCode = 1;
