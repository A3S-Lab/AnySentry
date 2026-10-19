// Read-only sampler. No stats reset, schema change, or service restart.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const seconds = Number(process.argv[2] || 45);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 60) throw new Error('window must be 5..60 seconds');
async function snapshot() {
  const { stdout } = await run('docker', ['exec', 'anysentry-postgres-1', 'psql', '-X', '-U', 'anysentry', '-d', 'anysentry', '-Atc',
    "SELECT json_build_object('at',clock_timestamp(),'tables',(SELECT json_agg(t) FROM (SELECT relname,n_tup_ins,n_tup_upd,n_tup_del,n_dead_tup FROM pg_stat_user_tables WHERE relname IN ('anysentry_alerts','anysentry_incidents','anysentry_remediations')) t));"], { timeout: 10000 });
  return JSON.parse(stdout);
}
const before = await snapshot();
console.log(JSON.stringify({ phase: 'before', ...before }));
await new Promise(resolve => setTimeout(resolve, seconds * 1000));
const after = await snapshot();
const elapsed = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
const rates = after.tables.map(table => {
  const prior = before.tables.find(t => t.relname === table.relname);
  const updates = Number(table.n_tup_upd) - Number(prior.n_tup_upd);
  if (updates < 0) throw new Error('statistics reset during sample; comparison invalid');
  return { table: table.relname, updates, updatesPerSecond: updates / elapsed,
    inserts: Number(table.n_tup_ins) - Number(prior.n_tup_ins) };
});
console.log(JSON.stringify({ phase: 'after', ...after, elapsedSeconds: elapsed, rates }));
