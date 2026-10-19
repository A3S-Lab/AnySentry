// Run inside the API container with an explicit binding ID and <= 15 minute window.
// Default is read-only. --apply uses the existing attribution service, never fabricated relations.
const assert = require('node:assert/strict');
const [id, start, end, mode] = process.argv.slice(2);
assert.match(id ?? '', /^spb_[a-f0-9]{24}$/);
const since=Number(start), until=Number(end);
assert.ok(Number.isSafeInteger(since)&&Number.isSafeInteger(until)&&since>0&&until>since&&until-since<=900000);
assert.ok(mode===undefined||mode==='--apply');
const {ClickHouseStore}=require('/app/dist/security-monitoring/clickhouse-store.js');
const {RelationalBusinessStore}=require('/app/dist/security-monitoring/relational-business-store.service.js');
const {SessionEventAttributionService}=require('/app/dist/security-monitoring/session-event-attribution.service.js');
const ch=new ClickHouseStore(),pg=new RelationalBusinessStore();
(async()=>{
  try {
    assert.ok(await ch.init());
    const binding=await pg.loadLatestSessionProcessBinding(id);
    assert.ok(binding?.pidNamespace&&binding?.matchedStartTime,'Full durable generation required');
    const e=await new SessionEventAttributionService(ch,pg).evidence(binding,{since,until},undefined,1000,{persist:mode==='--apply'});
    console.log(JSON.stringify({binding:id,session:binding.nativeSessionId,apply:mode==='--apply',counts:e.counts,persistence:e.persistence,completeness:e.completeness,page:e.page}));
    if(mode==='--apply')assert.equal(e.persistence,'persisted');
  } finally {await ch.close();await pg.onApplicationShutdown();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
