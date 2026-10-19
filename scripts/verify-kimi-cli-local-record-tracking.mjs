import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKimiCliRecord } from '../apps/api/dist/security-monitoring/local-record-kimi-cli.adapter.js';
import { LocalRecordTrackingService } from '../apps/api/dist/security-monitoring/local-record-tracking.service.js';
const dir = await mkdtemp(join(tmpdir(), 'anysentry-kimi-unit-'));
const prior = {...process.env};
try {
  const sessions = join(dir, 'sessions'), session = join(sessions, 'workspace', 'native-session');
  await mkdir(session, {recursive:true});
  const file = join(session, 'wire.jsonl');
  let at = 1789549500;
  const row = (type,payload={}) => JSON.stringify({timestamp:at+=0.1,message:{type,payload}})+'\n';
  const body = row('TurnBegin',{user_input:'Kimi 测试'})
    + row('ContentPart',{type:'text',text:'准备'})+row('ContentPart',{type:'text',text:'执行'})
    + row('ToolCall',{id:'shell-1',function:{name:'Shell',arguments:'{"command":'}})
    + row('ToolCallPart',{arguments_part:'"/usr/bin/printf marker"}'})
    + row('ToolResult',{tool_call_id:'shell-1',return_value:{is_error:false,output:'marker'}})
    + row('SubagentEvent',{event:{type:'ToolCall',payload:{id:'foreign',function:{name:'Shell'}}}})
    + row('StatusUpdate',{message_id:'response-1',token_usage:{input_other:10,input_cache_read:3,output:4}})
    + row('StatusUpdate',{message_id:'response-1',token_usage:{input_other:10,input_cache_read:3,output:4}})
    + row('TurnEnd');
  await writeFile(file,body);
  let parsed=await parseKimiCliRecord(file,'record');
  assert.equal(parsed.sessionId,'native-session');
  assert.equal(parsed.metrics.toolCallCount,1);
  assert.equal(parsed.metrics.tokenUsage.totalTokens,17);
  assert.equal(parsed.events.find(e=>e.kind==='assistant_message').content,'准备执行');
  const call=parsed.events.find(e=>e.kind==='tool_call');
  assert.equal(call.command,'/usr/bin/printf marker');
  assert.equal(parsed.events.find(e=>e.kind==='tool_result').turnId,call.turnId);
  assert.ok(parsed.events.every((e,i,a)=>!i || e.sourceOffset>a[i-1].sourceOffset));
  await appendFile(file,row('TurnBegin',{user_input:'恢复会话'})+row('ToolCall',{id:'shell-2',function:{name:'Shell',arguments:'{"command":"false"}'}})+row('ToolResult',{tool_call_id:'shell-2',return_value:{is_error:true,output:'failed'}})+'{"timestamp":');
  parsed=await parseKimiCliRecord(file,'record');
  assert.equal(parsed.events.find(e=>e.kind==='tool_call').eventId,call.eventId);
  assert.equal(parsed.metrics.completeTurnCount,1,'unfinished turn stays unfinished');
  assert.equal(parsed.metrics.turnCount,2);
  assert.equal(parsed.metrics.toolFailureCount,1);
  assert.equal(parsed.partial,true);
  const modern=join(sessions,'workspace','new-session','agents','main');
  await mkdir(modern,{recursive:true}); await writeFile(join(modern,'wire.jsonl'),body);
  await writeFile(join(session,'context.jsonl'),'{"role":"user","content":"not another session"}\n');
  await mkdir(join(session,'agents','child'),{recursive:true});
  await writeFile(join(session,'agents','child','wire.jsonl'),body);
  const proc=join(dir,'proc'), pid=43011, ticks='987654';
  await mkdir(join(proc,String(pid),'fd'),{recursive:true});
  await mkdir(join(proc,String(pid),'fdinfo'),{recursive:true});
  await writeFile(join(proc,String(pid),'comm'),'Kimi Code\n');
  await writeFile(join(proc,String(pid),'cmdline'),'/opt/kimi/bin/python3\0/opt/kimi/bin/kimi\0');
  const statFields=Array(50).fill('0');statFields[0]='S';statFields[1]='1';statFields[19]=ticks;
  await writeFile(join(proc,String(pid),'stat'),`${pid} (Kimi Code) ${statFields.join(' ')}\n`);
  await symlink(file,join(proc,String(pid),'fd','5'));
  await writeFile(join(proc,String(pid),'fdinfo','5'),'flags:\t0102001\n');
  Object.assign(process.env, {ANYSENTRY_LOCAL_RECORD_TRACKING:'on',ANYSENTRY_LOCAL_CODEX_SESSIONS_DIR:join(dir,'none'),ANYSENTRY_LOCAL_KIMI_SESSIONS_DIR:sessions,ANYSENTRY_LOCAL_PROCESS_TRACKING:'on',ANYSENTRY_LOCAL_PROCESS_ROOT:proc});
  delete process.env.ANYSENTRY_LOCAL_KIMI_SESSIONS_DIRS;
  for(const agent of ['A3S','CLAUDE','GEMINI']){process.env[`ANYSENTRY_LOCAL_${agent}_SESSIONS_DIR`]=join(dir,'none');delete process.env[`ANYSENTRY_LOCAL_${agent}_SESSIONS_DIRS`];}
  delete process.env.ANYSENTRY_LOCAL_HARBOR_JOBS_DIR;
  const candidates=[];
  const service=new LocalRecordTrackingService({status:()=>({enabled:false,projection:{postgresql:false,clickhouse:false}})}, {
    resolveBinding:async c=>{candidates.push(c);return undefined},
    resolveBindingFromSessionFile:async()=>undefined,
  });
  const list=await service.listRecords({limit:10});
  assert.equal(list.total,2,'main journals only; context and child not duplicate records');
  const incomplete=join(sessions,'workspace','incomplete-session');
  await mkdir(incomplete,{recursive:true});
  const incompleteWire=join(incomplete,'wire.jsonl');
  await writeFile(incompleteWire,'{"type":"metadata","protocol_version":"1.5"}\n');
  service.discoveryCache=undefined;
  const resilientList=await service.listRecords({limit:10});
  assert.equal(resilientList.total,2,'a metadata-only journal cannot break healthy Session discovery');
  await appendFile(incompleteWire,body);
  service.discoveryCache=undefined;
  const recoveredList=await service.listRecords({limit:10});
  assert.equal(recoveredList.total,3,'a journal is retried once valid events arrive');
  const item=list.items.find(x=>x.sessionId==='native-session');
  assert.equal(item.adapter,'kimi_cli');assert.equal(item.processPid,pid);
  const detail=await service.recordDetail(item.recordId,{limit:2,includeObservedLlmRequests:false});
  assert.equal(detail.provenance.source,'kimi_cli_local_session');
  assert.equal(detail.page.truncatedLines,1);
  assert.ok(candidates.some(c=>c.runtimeType==='kimi_cli'&&c.nativeSessionId==='native-session'&&c.matchedPid===pid));
  assert.equal(detail.page.hasMore,true);
  console.log(JSON.stringify({pass:true,streaming:true,resume:true,partialTail:true,nativeCallId:true,mainAgentIsolation:true,procFd:true,pagination:true}));
} finally {
  for(const key of Object.keys(process.env)) if(!(key in prior))delete process.env[key];
  Object.assign(process.env,prior);
  await rm(dir,{recursive:true,force:true});
}
