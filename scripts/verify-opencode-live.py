"""Real CLI canary: isolated XDG state, fixed loopback model, no external API calls.

Start opencode-live-model-fixture.py first. This script runs actual Bash tools.
OPENCODE_BIN and ANYSENTRY_OPENCODE_TEST_ROOT override the executable/test state.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

root = Path(os.environ.get('ANYSENTRY_OPENCODE_TEST_ROOT', '/home/zhongyule/code/anysentry-e2e-work/opencode-20260917'))
binary = os.environ.get('OPENCODE_BIN', '/tmp/anysentry-opencode-20260917/cli/node_modules/opencode-linux-x64/bin/opencode')
artifact = root / 'results'
artifact.mkdir(parents=True, exist_ok=True)
env = {key: value for key, value in os.environ.items() if key.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
env.update({f'XDG_{key}_HOME': str(root / value) for key, value in [('DATA', 'data'), ('CONFIG', 'config'), ('CACHE', 'cache'), ('STATE', 'state')]})
env.update(OPENCODE_DISABLE_PROJECT_CONFIG='1', OPENCODE_DISABLE_MODELS_FETCH='1', NO_PROXY='127.0.0.1,localhost')
stamp = str(int(time.time()))


def run(label, session=None):
    marker = f'ANYSENTRY_OPENCODE_{label}_{stamp}'
    args = [binary, 'run', '--format', 'json']
    if session:
        args.extend(['--session', session])
    args.append(marker)
    result = subprocess.run(args, cwd=root / 'workspace', env=env, capture_output=True, text=True, timeout=90)
    (artifact / f'{label}.jsonl').write_text(result.stdout)
    (artifact / f'{label}.stderr').write_text(result.stderr)
    assert result.returncode == 0, (label, result.returncode, result.stderr[-1000:])
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    tools = [row for row in rows if row.get('type') == 'tool_use']
    assert len(tools) == 1, (label, rows)
    call = tools[0]['part']
    assert call['tool'] == 'bash' and marker in call['state']['output']
    assert call['state']['metadata']['exit'] == (1 if 'FAIL' in label else 0)
    value = {'label': label, 'marker': marker, 'sessionId': tools[0]['sessionID'], 'callId': call['callID'],
             'command': call['state']['input']['command'], 'start': call['state']['time']['start'], 'end': call['state']['time']['end']}
    print(json.dumps(value), flush=True)
    return value


results = [run('LIVE_A')]
results.append(run('RESUME_B', results[0]['sessionId']))
results.append(run('FAIL_C', results[0]['sessionId']))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results.extend(pool.map(run, ['PARALLEL_D', 'PARALLEL_E']))
assert len({value['sessionId'] for value in results[:3]}) == 1
assert len({value['sessionId'] for value in results[3:]}) == 2
assert max(value['start'] for value in results[3:]) < min(value['end'] for value in results[3:]), 'parallel tool lifetimes must actually overlap'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(path):
    with opener.open('http://127.0.0.1:29653/security-center/' + path, timeout=30) as response:
        return json.load(response)['data']


for attempt in range(20):
    records = get('local-records?search=opencode&limit=500')['items']
    if all(any(record['sessionId'] == value['sessionId'] for record in records) for value in results):
        break
    time.sleep(1)
details = {}
for value in results:
    record = next(record for record in records if record['sessionId'] == value['sessionId'])
    value['recordId'] = record['recordId']
    if record['recordId'] not in details:
        details[record['recordId']] = get(f"local-records/{record['recordId']}?limit=500&includeObservedLlmRequests=false")
    detail = details[record['recordId']]
    assert detail['provenance']['source'] == 'opencode_local_session'
    assert any(event.get('callId') == value['callId'] and event.get('command') == value['command'] for event in detail['events'])
    assert any(event['kind'] == 'tool_result' and event.get('callId') == value['callId'] and value['marker'] in event.get('content', '') for event in detail['events'])
    assert not any(event.get('callId') == other['callId'] for other in results if other['sessionId'] != value['sessionId'] for event in detail['events'])
for record_id, detail in details.items():
    (artifact / f'{record_id}.json').write_text(json.dumps(detail, ensure_ascii=False, indent=2))
resumed = details[results[0]['recordId']]
assert resumed['metrics']['turnCount'] == 3 and resumed['metrics']['toolFailureCount'] == 1
report = {'pass': True, 'cliVersion': subprocess.check_output([binary, '--version'], env=env, text=True).strip(),
          'realTurns': len(results), 'resume': True, 'parallelIsolation': True, 'apiRecords': len(details), 'runs': results}
(artifact / 'live-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False), flush=True)
