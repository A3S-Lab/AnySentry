import assert from 'node:assert/strict';
import { LocalRecordTrackingService } from '../apps/api/dist/security-monitoring/local-record-tracking.service.js';
const interactions = { status: () => ({enabled:false}) };
const results=[];
const service = new LocalRecordTrackingService(interactions, {
  resolveBinding: async c=>({bindingId:`${c.matchedPid}:${c.matchedStartTime}`,candidate:c}),
  evidence: async (b,w)=>{results.push({b,w});return {persistence:'persisted',completeness:'complete_as_observed'};},
});
const now=Date.now;
let time=1800000000000;Date.now=()=>time;
const summary={recordId:'record',sessionId:'session',adapter:'codex',processStatus:'running',startedAt:time-2000,updatedAt:time};
const exact={recordId:'record',pid:100,matchedPid:101,startTimeTicks:'999',matchedStartTimeTicks:'1000'};
const scan=matches=>({available:true,observedAt:time,exactByRecordId:new Map([['record',matches]]),liveRoots:new Map()});
async function tick(s,m){service.scheduleActiveSessionAttribution(s,scan(m));await service.activeAttributionInFlight;}
try {
  await tick([summary],[exact]);assert.equal(results.length,1);
  time+=15000;
  await tick([{...summary,processStatus:'exited',updatedAt:time}],[]);
  assert.equal(results.length,1,'exit discovery must respect throttle but retain generation');
  time+=60000;
  await tick([{...summary,processStatus:'exited',updatedAt:time-60000}],[]);
  assert.equal(results.length,2,'exited generation must receive a tail pass');
  assert.equal(results[1].b.candidate.matchedStartTime,'ticks:1000');
  assert.ok(results[1].w.since<=results[0].w.until);
  const tailWindow=results[1].w;
  time+=60000;await tick([],[]);
  assert.deepEqual(results[2].w,tailWindow,'late arrival retry must not move the tail head');
  // A recycled numeric PID is a different queue entry, never a replacement for pending old tail.
  time+=60000;await tick([{...summary,updatedAt:time}],[{...exact,matchedStartTimeTicks:'2000'}]);
  assert.equal(service.attributionGenerations.size,2);
  assert.ok(results.some(r=>r.b.candidate.matchedStartTime==='ticks:2000'));
  assert.ok(results.at(-2).b.candidate.matchedStartTime==='ticks:1000');
  const generation = [...service.attributionGenerations.values()].find(x=>x.exact.matchedStartTimeTicks==='2000');
  const checkpoint=generation.checkpoint;
  service.sessionAttribution.evidence=async()=>({persistence:'degraded',completeness:'partial'});
  time+=60000;await tick([{...summary,updatedAt:time}],[{...exact,matchedStartTimeTicks:'2000'}]);
  assert.equal(generation.checkpoint,checkpoint,'failed/partial persistence cannot acknowledge progress');
  time+=11*60000;await tick([],[]);assert.equal(service.attributionGenerations.size,0,'tail retention is bounded');
} finally {Date.now=now;}

const matches=[exact,{...exact,matchedPid:102,matchedStartTimeTicks:'2000'}];
// No live FD was observed: an explicit request may recover the exact generation,
// but neither a foreign Session nor an incomplete host identity may be guessed.
const discoveryCalls=[];
const discoveryNow=Date.now();
const observedRecord={observedAt:discoveryNow-1000,runtime:{sessionId:'short-session'},
  process:{hostId:'h',bootId:'b',pidNamespace:'ns',pid:303,startTimeTicks:'3000'}};
let observations=[observedRecord];
const shortService=new LocalRecordTrackingService({
  status:()=>({enabled:true,projection:{clickhouse:true}}),
  instructionsForRuntimeSession:async()=>observations.map(record=>({record})),
},{
  resolveBinding:async candidate=>({candidate}),
  evidence:async(binding,window)=>{discoveryCalls.push({binding,window});return {persistence:'persisted',completeness:'complete_as_observed'};},
});
const shortSummary={...summary,recordId:'short-record',sessionId:'short-session',processStatus:'unknown',startedAt:discoveryNow-10000,updatedAt:discoveryNow};
const emptyScan={available:true,observedAt:discoveryNow,exactByRecordId:new Map(),liveRoots:new Map()};
async function discover(){shortService.activeAttributionLastStartedAt=0;shortService.scheduleActiveSessionAttribution([shortSummary],emptyScan);await shortService.activeAttributionInFlight;}
observations=[{...observedRecord,runtime:{sessionId:'other-session'}}];
await discover();assert.equal(shortService.attributionGenerations.size,0);
observations=[{...observedRecord,process:{...observedRecord.process,bootId:undefined}}];
await discover();assert.equal(shortService.attributionGenerations.size,0);
observations=[{...observedRecord,runtime:{}}];
await discover();assert.equal(shortService.attributionGenerations.size,0);
observations=[observedRecord];await discover();
assert.equal(shortService.attributionGenerations.size,1);
assert.equal(discoveryCalls[0].binding.candidate.matchedPid,303);
assert.equal(discoveryCalls[0].binding.candidate.matchedStartTime,'ticks:3000');
assert.equal(discoveryCalls[0].binding.candidate.method,'observer_request');
assert.equal([...shortService.attributionGenerations.values()][0].tailVerified,true);
await discover();assert.equal(discoveryCalls.length,2,'observed-only tail must retry delayed facts');
assert.equal(shortService.attributionGenerations.size,1,'discovery must not duplicate a generation');

const records=matches.map((m,i)=>({observedAt:1800000000000+i*1000,process:{hostId:'h',bootId:'b',pidNamespace:'ns',pid:m.matchedPid,startTimeTicks:m.matchedStartTimeTicks}}));
for(let round=0;round<3;round++){
  const selected=service.interactiveExactProcessMatches(matches,records,true);
  assert.deepEqual(selected.map(x=>x.matchedPid),[102,101],'recent old/new generations must both remain visible, newest first');
}
const many=Array.from({length:10},(_,i)=>({...exact,matchedPid:100+i,matchedStartTimeTicks:String(1000+i)}));
const resumed={...exact,matchedPid:103,matchedStartTimeTicks:'3000'};
assert.deepEqual(service.interactiveExactProcessMatches([...matches,resumed],records,true,[resumed]).map(x=>x.matchedPid),[103,102,101],
  'live Session FD owner must remain visible before its first observed model request');
assert.deepEqual(service.interactiveExactProcessMatches([...matches,resumed],records,true,[{...resumed,matchedStartTimeTicks:'4000'}]).map(x=>x.matchedPid),[102,101],
  'live PID with a different generation cannot promote an unrelated match');
assert.equal(service.interactiveExactProcessMatches(many,records,true,many).length,4,'live generation fan-out stays bounded');
assert.equal(service.interactiveExactProcessMatches(many,[],false).length,4,'historical fan-out is bounded too');
const e=id=>({binding:{},counts:{direct:1,lineage:0,ambiguous:0,conflict:0,unattributed:0},events:[{eventId:id,at:1}],lineage:[],exceptions:[],calculatedAt:1,completeness:'complete_as_observed',persistence:'persisted',page:{hasMore:false}});
assert.equal(service.mergeSystemEvidence([e('a'),e('b')],1).page.hasMore,true,'merged pagination must expose truncated events');
const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval;
let callback,cleared=false,release,polls=0;
try{
  globalThis.setInterval=fn=>(callback=fn,{unref(){}});
  globalThis.clearInterval=()=>{cleared=true;};
  service.isEnabled=()=>true;
  service.listRecords=async()=>{polls++;await new Promise(r=>{release=r;});};
  service.onModuleInit();callback();callback();
  assert.equal(polls,1,'autonomous polling must not overlap itself');
  release();await new Promise(r=>setImmediate(r));
  service.onModuleDestroy();assert.ok(cleared);
}finally{globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;}
console.log('PASS tail retry after exit, delayed arrivals, PID reuse, failed persistence, bounded retention, 3 resume selections and merge pagination');
