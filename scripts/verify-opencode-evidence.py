"""Read-only verification of a completed verify-opencode-live.py run.

Verifies durable kernel events independently of Native Session content, then checks
candidate isolation. It never promotes command matches to authenticated Call bindings.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

root = Path(os.environ.get('ANYSENTRY_OPENCODE_TEST_ROOT', '/home/zhongyule/code/anysentry-e2e-work/opencode-20260917')) / 'results'
report = json.loads((root / 'live-report.json').read_text())
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
details = {}
rows = []
for run in report['runs']:
    command_hash = hashlib.sha256(run['command'].encode()).hexdigest()
    since, until = int(run['start']) - 250, int(run['end']) + 1000
    query = f"""SELECT eventId, processPid, subject, JSONExtractString(attribution,'agentScopeId') AS scope
      FROM anysentry.events WHERE at >= {since} AND at <= {until}
      AND eventKind='ToolExec' AND evidenceCommandHash='{command_hash}' FORMAT JSONEachRow"""
    output = subprocess.check_output(['docker', 'exec', 'anysentry-clickhouse-1', 'clickhouse-client', '--query', query], text=True)
    facts = [json.loads(line) for line in output.splitlines() if line]
    assert facts and all(fact['scope'] == 'opencode' for fact in facts), (run['label'], facts)
    record_id = run['recordId']
    if record_id not in details:
        with opener.open(f'http://127.0.0.1:29653/security-center/local-records/{record_id}?limit=500&includeObservedLlmRequests=true', timeout=40) as response:
            details[record_id] = json.load(response)['data']
        (root / f'{record_id}.json').write_text(json.dumps(details[record_id], ensure_ascii=False, indent=2))
    detail = details[record_id]
    call = next(call for call in detail['toolEvidence']['calls'] if call['callId'] == run['callId'])
    assert call['status'] == 'candidate' and not call['confirmedEventIds'], call
    ids = {candidate['eventId'] for candidate in call['candidates']}
    assert ids.intersection(fact['eventId'] for fact in facts), 'candidate must include the independently queried kernel exec'
    rows.append({'label': run['label'], 'nativeSessionId': run['sessionId'], 'callId': run['callId'], 'recordId': record_id,
                 'candidates': len(ids), 'confirmed': len(call['confirmedEventIds']), 'kernelExecIds': [fact['eventId'] for fact in facts]})
parallel = [details[run['recordId']]['toolEvidence']['calls'][0]['candidates'] for run in report['runs'][3:]]
assert not ({row['eventId'] for row in parallel[0]} & {row['eventId'] for row in parallel[1]})
result = {'pass': True, 'runs': rows, 'parallelEvidenceDisjoint': True, 'trustedCallBindings': 0,
          'observerModelRequests': sum(len(detail.get('observedLlmRequests', [])) for detail in details.values())}
(root / 'system-evidence-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
