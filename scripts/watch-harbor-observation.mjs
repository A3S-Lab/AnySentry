// Bounded per-job observation audit; stores counts/identities only, not prompts or credentials.
import fs from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
const job = resolve(process.argv[2] ?? '');
if (!job.includes('/terminal-bench/.harbor-jobs/') || basename(job).startsWith('.')) throw new Error('Explicit Harbor job directory required');
await fs.access(join(job, 'config.json'));
const audit = join(job, 'observer-audit.jsonl');
const report = join(job, 'observer-audit.md');
const seen = new Map();
const bindingHistory = new Map();
function rememberBinding(session) {
  const binding = session.evidence?.binding;
  if (!binding) return;
  const variants = bindingHistory.get(session.sessionId) ?? new Map();
  variants.set(binding.bindingId, {bindingId:binding.bindingId, pid:binding.matchedPid, key:binding.matchedOsProcessInstanceKey});
  bindingHistory.set(session.sessionId, variants);
}
for (const line of (await fs.readFile(audit, 'utf8').catch(() => '')).split('\n')) {
  try { for (const session of JSON.parse(line).sessions ?? []) rememberBinding(session); } catch {}
}
let finalPasses = 0;
async function sessionFiles(dir, depth = 0) {
  if (depth > 9) return [];
  const files = [];
  for (const item of await fs.readdir(dir, {withFileTypes:true}).catch(() => [])) {
    const path = join(dir, item.name);
    if (item.isDirectory() && !['artifacts','verifier','environment'].includes(item.name)) files.push(...await sessionFiles(path, depth + 1));
    else if (item.isFile() && item.name.startsWith('rollout-') && item.name.endsWith('.jsonl') && path.includes('/agent/sessions/')) files.push(path);
  }
  return files;
}
async function nativeCount(path) {
  const count = {sessionId:undefined,toolCalls:0,directShellCalls:0,wrappedExecCalls:0,userMessages:0,assistantMessages:0};
  const lines = createInterface({input:createReadStream(path),crlfDelay:Infinity});
  for await (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload ?? {};
    if (row.type === 'session_meta') count.sessionId = p.id;
    if (row.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') count.userMessages++;
    if (p.type === 'message' && p.role === 'assistant') count.assistantMessages++;
    if (['function_call','custom_tool_call'].includes(p.type)) {
      count.toolCalls++;
      if (['exec_command','shell','shell_command','functions.exec_command','functions.shell'].includes(p.name)) count.directShellCalls++;
      // A JS orchestration call can contain zero, one or many tool executions. Do not
      // treat the wrapper count as a Shell count, or regex occurrences as actual executions.
      if (p.type === 'custom_tool_call' && p.name === 'exec') count.wrappedExecCalls++;
    }
  }
  return count;
}
async function api(path) {
  const res = await fetch('http://127.0.0.1:29653/security-center/' + path, {signal:AbortSignal.timeout(15_000)});
  const body = await res.json();
  if (!res.ok || body.code !== 200) throw new Error(`API HTTP ${res.status}: code=${body.code}`);
  return body.data;
}
const started = Date.now();
for (let round = 0; Date.now() - started < 9 * 3600_000; round++) {
  const outcome = await fs.readFile(join(job,'result.json'),'utf8').then(JSON.parse).catch(() => ({}));
  const finished = Boolean(outcome.finished_at);
  try {
    // The existing API scheduler persists exact live bindings when the list is polled.
    const list = await api('local-records?limit=500');
    const states = [];
    for (const file of await sessionFiles(job)) {
      const native = await nativeCount(file);
      if (!native.sessionId) continue;
      const item = list.items.find(i => i.sessionId === native.sessionId);
      const state = {...native,apiVisible:Boolean(item),processStatus:item?.processStatus,processPid:item?.processPid,recordId:item?.recordId};
      if (item && (round % 3 === 0 || finished)) {
        try {
          const detail = await api(`local-records/${item.recordId}?limit=1&includeSystemEvidence=true&evidenceLimit=5000&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`);
          const evidence = detail.systemEvidence;
          state.evidence = evidence ? {counts:evidence.counts,page:evidence.page,persistence:evidence.persistence,
            completeness:evidence.completeness,binding:evidence.binding,
            eventKinds: (evidence.events ?? []).reduce((counts,e) => { const k=e.eventKind ?? e.kind ?? 'unknown'; counts[k]=(counts[k]??0)+1; return counts; },{})} : null;
          state.observedRequestsInWindow = detail.observedLlmRequests?.length ?? 0;
        } catch (e) { state.evidenceError = e.message; }
      }
      seen.set(native.sessionId, {...seen.get(native.sessionId), ...state});
      rememberBinding(state);
      if ((bindingHistory.get(native.sessionId)?.size ?? 0) > 1) state.bindingIdentityWarning = 'multiple binding identities observed; inspect generation/namespace before declaring coverage';
      states.push(state);
    }
    const snapshot = {at:new Date().toISOString(),job:basename(job),finished,sessions:states};
    await fs.appendFile(audit, JSON.stringify(snapshot)+'\n', {mode:0o600});
    console.log(JSON.stringify(snapshot));
    if (finished) {
      finalPasses++;
      if (finalPasses >= 3) {
        await fs.writeFile(report, '# Terminal-Bench / Observer audit\n\n'
          + 'This is one task, not the full dataset. System relation counts are not exact Tool Call match coverage.\n\n'
          + '```json\n' + JSON.stringify({job:basename(job),finishedAt:outcome.finished_at,stats:outcome.stats,sessions:[...seen.values()],
            bindingIdentityVariants:Object.fromEntries([...bindingHistory].map(([id,values]) => [id,[...values.values()]]))},null,2)
          + '\n```\n\nNative counts reflect raw response_item records; injected context may be counted as user messages. wrappedExecCalls are orchestration calls, NOT Shell executions; their nested tools need separate reconciliation. TLS request count is only the detail response window.\n', {mode:0o600});
        console.log(`AUDIT COMPLETE: ${report}`);
        process.exit(0);
      }
    }
  } catch (error) {
    const status = {at:new Date().toISOString(),error:error.message};
    await fs.appendFile(audit,JSON.stringify(status)+'\n',{mode:0o600});
    console.log(JSON.stringify(status));
  }
  await new Promise(r => setTimeout(r, 20_000));
}
throw new Error('Audit time limit reached without completed evaluation');
