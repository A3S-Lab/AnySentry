import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const dir=resolve(process.argv[2]??'');
if(!dir.startsWith('/tmp/anysentry-daily-codex-')) throw new Error('Explicit daily test directory required');
const data=JSON.parse(await fs.readFile(join(dir,'results.json'),'utf8'));
const {stamp,states}=data;
if(!/^[a-z0-9]+$/.test(stamp)) throw new Error('Invalid test marker');
const since=Math.min(...states.map(s=>s.startedAt))-1000;
const until=Math.max(...states.map(s=>s.finishedAt))+180000;
const run=args=>execFileSync('docker',args,{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024});
const rows=s=>s.trim().split('\n').filter(Boolean).map(JSON.parse);
const events=rows(run(['exec','anysentry-clickhouse-1','clickhouse-client','--max_execution_time=8','--max_threads=1','--query',
  `SELECT eventId, argMax(process,tuple(decisionRevision,decisionUpdatedAt,at)) p,
    argMax(attributes,tuple(decisionRevision,decisionUpdatedAt,at)) a
   FROM anysentry.events WHERE at BETWEEN ${since} AND ${until}
    AND eventKind='ToolExec' AND position(attributes,'DAILY_${stamp}_')>0
   GROUP BY eventId LIMIT 1001 FORMAT JSONEachRow`])).map(e=>({...e,process:JSON.parse(e.p),attributes:JSON.parse(e.a)}));
if(events.length>=1001)throw new Error('Truncated global query');
const eventIds=events.filter(e=>e.attributes.argv?.startsWith('/usr/bin/printf ')).map(e=>e.eventId);
if(eventIds.some(id=>!/^evt_[a-f0-9]+$/.test(id)))throw new Error('Unexpected event ID');
const persisted=eventIds.length?rows(run(['exec','anysentry-postgres-1','psql','-X','-At','-U','anysentry','-d','anysentry','-c',
  `SELECT json_build_object('eventId',r.record->>'eventId','relation',r.record->>'relation',
    'bindingId',b.binding_id,'nativeSessionId',b.native_session_id)
   FROM anysentry_event_session_relations r JOIN anysentry_session_process_bindings b
     ON b.binding_id=r.record->>'bindingId'
   WHERE r.record->>'eventId' IN (${eventIds.map(id=>`'${id}'`).join(',')})
    AND COALESCE((r.record->>'active')::boolean,true)`])):[];
const details=new Map();
for(const s of states){
  if(!s.recordId)continue;
  const r=await fetch(`http://127.0.0.1:29653/security-center/local-records/${s.recordId}?limit=200&includeSystemEvidence=true&evidenceLimit=1000&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`,{signal:AbortSignal.timeout(20000)});
  const body=await r.json();if(!r.ok||body.code!==200)throw new Error(`detail HTTP ${r.status}`);
  details.set(s.sessionId,body.data);
  await fs.writeFile(join(dir,`${s.name}-detail.json`),JSON.stringify(body.data),{mode:0o600});
}
const summaries=[];
for(const s of states){
  const log=rows(await fs.readFile(join(dir,`${s.name}.jsonl`),'utf8'));
  const executions=log.filter(r=>r.type==='item.completed'&&r.item?.type==='command_execution').map(r=>r.item);
  const d=details.get(s.sessionId);
  const evidenceIds=new Set((d?.systemEvidence?.events??[]).map(e=>e.eventId));
  const markers=s.markers.map(marker=>{
    const actual=executions.filter(e=>e.exit_code===0&&e.command?.includes(marker));
    const found=events.filter(e=>e.attributes.argv?.startsWith('/usr/bin/printf ')
      &&e.attributes.argv.includes(marker)&&e.attributes.exec_confirmed===true);
    const wrongSessions=[...details].filter(([id,other])=>id!==s.sessionId&&found.some(e=>other.systemEvidence?.events?.some(x=>x.eventId===e.eventId))).map(([id])=>id);
    return {marker,successfulShellCalls:actual.length,kernelEvents:found.map(e=>({eventId:e.eventId,pid:e.process.pid,ppid:e.process.ppid,
      argvComplete:e.attributes.argv_truncated===false&&e.attributes.argv_incomplete===false})),
      attributedEventIds:found.filter(e=>evidenceIds.has(e.eventId)).map(e=>e.eventId),wrongSessions,
      persistedRelations:persisted.filter(r=>found.some(e=>e.eventId===r.eventId)),
      persistedCorrect:found.length>0&&found.every(e=>persisted.some(r=>r.eventId===e.eventId&&r.nativeSessionId===s.sessionId&&['DIRECT','LINEAGE'].includes(r.relation)))};
  });
  summaries.push({name:s.name,sessionId:s.sessionId,recordId:s.recordId,exitCode:s.code,
    successfulShellCalls:executions.filter(e=>e.exit_code===0).length,
    cliReplies:log.filter(r=>r.type==='item.completed'&&r.item?.type==='agent_message').length,
    nativeEvents:d?.events?.length,observedRequests:d?.observedLlmRequests?.length,
    nativePromptMatched:d?.events?.some(e=>e.kind==='user_message'&&e.content===s.prompt)??false,
    nativeOkReply:d?.events?.some(e=>e.kind==='assistant_message'&&e.content?.trim()==='OK')??false,
    promptSha256Matched:d?.observedLlmRequests?.some(r=>r.capture?.parseStatus==='parsed'
      &&r.contentSha256===createHash('sha256').update(s.prompt).digest('hex'))??false,
    binding:d?.systemEvidence?.binding,counts:d?.systemEvidence?.counts,
    persistence:d?.systemEvidence?.persistence,page:d?.systemEvidence?.page,markers});
}
const outside=events.filter(e=>e.attributes.argv?.startsWith('/usr/bin/printf ')&&e.attributes.argv.includes(`DAILY_${stamp}_OUTSIDE`));
const outsideInTestSessions=[...details].filter(([,d])=>outside.some(e=>d.systemEvidence?.events?.some(x=>x.eventId===e.eventId))).map(([id])=>id);
const sharedEventIds=[];
const detailEntries=[...details];
for(let i=0;i<detailEntries.length;i++)for(let j=i+1;j<detailEntries.length;j++){
  const [left,a]=detailEntries[i], [right,b]=detailEntries[j];
  const ids=new Set((a.systemEvidence?.events??[]).map(e=>e.eventId));
  const shared=(b.systemEvidence?.events??[]).filter(e=>ids.has(e.eventId)).map(e=>e.eventId);
  if(shared.length)sharedEventIds.push({left,right,events:shared});
}
const report={at:new Date().toISOString(),scope:'controlled daily Codex CLI tests; unique printf markers validate actual behavior, not total production Shell coverage',summaries,
  sharedEventIds,outsideControl:{capturedEvents:outside.map(e=>e.eventId),wrongSessions:outsideInTestSessions}};
await fs.writeFile(join(dir,'analysis.json'),JSON.stringify(report,null,2),{mode:0o600});
await fs.copyFile(join(dir,'analysis.json'),join(dir,`analysis-${Date.now()}.json`));
console.log(JSON.stringify(report,null,2));
