#!/usr/bin/env python3
"""Real Kimi/Observer acceptance with a local deterministic model; no synthetic ingestion.

Writes only isolated test config, workspace artifacts, native Kimi sessions and reports.
Cloud TLS capture is deliberately not claimed by this HTTP fixture.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shlex
import subprocess
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path('/home/zhongyule/code/anysentry-e2e-work/kimi-20260916')
OUT = Path('/tmp') / ('anysentry-kimi-multiturn-' + time.strftime('%Y%m%d-%H%M%S'))
OUT.mkdir(parents=True)
TAG = uuid.uuid4().hex[:10]
CLI = '/tmp/anysentry-kimi-20260916/bin/kimi'
WORK = ROOT / 'workspace'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CASES = {}
REQUESTS = []
PROCESSES = []


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def case(label, command):
    marker = f'ASMT_{TAG}_{label}'
    value = {'label': label, 'marker': marker, 'callId': f'call_{TAG}_{label}', 'command': command}
    CASES[marker] = value
    return value


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        REQUESTS.append({'type': 'probe', 'path': self.path, 'at': time.time()})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ANYSENTRY_NETWORK_PROBE_OK')

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = data['messages']
        last_user = max(i for i, m in enumerate(messages) if m['role'] == 'user')
        matches = re.findall(r'ASMT_[A-Za-z0-9_]+', json.dumps(messages[last_user]))
        item = CASES[next(m for m in matches if m in CASES)]
        answered = any(m['role'] == 'tool' for m in messages[last_user + 1:])
        REQUESTS.append({'type': 'model', 'marker': item['marker'], 'afterTool': answered, 'at': time.time()})
        if answered:
            delta = {'content': 'Observed tool result for ' + item['marker']}
        else:
            assert any(t['function']['name'] == 'Shell' for t in data['tools'])
            delta = {'tool_calls': [{'index': 0, 'id': item['callId'], 'type': 'function',
                     'function': {'name': 'Shell', 'arguments': json.dumps({'command': item['command']})}}]}
        def chunk(value, finish=None):
            return {'id': item['callId'] + str(answered), 'object': 'chat.completion.chunk',
                    'created': int(time.time()), 'model': 'local-execution-test',
                    'choices': [{'index': 0, 'delta': value, 'finish_reason': finish}]}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for c in [chunk({'role': 'assistant'}), chunk(delta), chunk({}, 'stop' if answered else 'tool_calls')]:
            self.wfile.write(('data: ' + json.dumps(c) + '\n\n').encode())
            self.wfile.flush()
        self.wfile.write(b'data: [DONE]\n\n')


class Kimi:
    def __init__(self, label, session=None):
        self.label = label
        self.session = session or str(uuid.uuid4())
        self.queue = queue.Queue()
        self.messages = []
        self.stderr = (OUT / (label + '.stderr')).open('w')
        args = [CLI, '--config-file', str(CONFIG), '--work-dir', str(WORK), '--wire',
                '--no-thinking', '--yolo', '--max-steps-per-turn', '4', '--mcp-config', '{}',
                '--skills-dir', str(WORK / 'empty-skills'), '--session', self.session]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, text=True,
                                     env={**os.environ, 'KIMI_SHARE_DIR': str(ROOT / 'state'),
                                          'NO_PROXY': '127.0.0.1,localhost'})
        PROCESSES.append(self)
        def read():
            for line in self.proc.stdout:
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                self.messages.append(value)
                self.queue.put(value)
            self.queue.put({'closed': True})
        threading.Thread(target=read, daemon=True).start()

    def prompt(self, item):
        request = {'jsonrpc': '2.0', 'id': item['label'], 'method': 'prompt',
                   'params': {'user_input': f"Run the requested Shell test {item['marker']} and report the result."}}
        self.proc.stdin.write(json.dumps(request) + '\n')
        self.proc.stdin.flush()
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            value = self.queue.get(timeout=max(1, deadline - time.monotonic()))
            if value.get('closed'):
                raise RuntimeError(f'{self.label} exited; see stderr')
            if value.get('id') == item['label']:
                emit({'round': item['label'], 'rpc': value, 'session': self.session})
                if 'error' in value or value.get('result', {}).get('status') != 'finished':
                    raise RuntimeError(value)
                return value
        raise TimeoutError(item['label'])

    def snapshot(self, label, wait=True):
        files = list((ROOT / 'state/sessions').glob(f'*/{self.session}/wire.jsonl'))
        assert len(files) == 1
        relative = str(files[0].relative_to(ROOT / 'state/sessions'))
        record = hashlib.sha256(('kimi_cli:/host-agent-state/kimi/sessions:' + relative).encode()).hexdigest()[:24]
        url = (f'http://127.0.0.1:29653/security-center/local-records/{record}?limit=500'
               '&includeSystemEvidence=true&evidenceLimit=500&includeObservedLlmRequests=true')
        if wait:
            time.sleep(2)
        for attempt in range(8):
            try:
                d = json.load(OPENER.open(url, timeout=40))
                if d.get('data', {}).get('systemEvidence') or attempt == 7:
                    break
            except Exception:
                if attempt == 7:
                    raise
            time.sleep(2)
        (OUT / (label + '.json')).write_text(json.dumps(d))
        (OUT / (label + '.wire.jsonl')).write_text(files[0].read_text())
        x = d['data']
        e = x.get('systemEvidence') or {}
        tools = (x.get('toolEvidence') or {}).get('calls', [])
        summary = {'snapshot': label, 'session': self.session, 'record': record,
                   'counts': e.get('counts'), 'scope': e.get('evidenceScope'),
                   'completeness': e.get('completeness'), 'modelRequests': len(x.get('observedLlmRequests', [])),
                   'turns': len({v.get('turnId') for v in x['events'] if v.get('turnId')}),
                   'tools': [{'callId': t['callId'], 'status': t['status'],
                              'confirmed': len(t['confirmedEventIds']), 'candidates': len(t['candidates'])} for t in tools]}
        emit(summary)
        SUMMARIES.append(summary)
        return x

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                self.proc.wait(timeout=8)
        self.stderr.close()
        (OUT / (self.label + '.rpc.json')).write_text(json.dumps(self.messages))


server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
port = server.server_port
threading.Thread(target=server.serve_forever, daemon=True).start()
config = json.loads((ROOT / 'config.json').read_text())
for provider in config['providers'].values():
    provider['base_url'] = f'http://127.0.0.1:{port}/v1'
    provider['api_key'] = 'local-fixture-no-secret'
CONFIG = ROOT / ('config-multiturn-' + TAG + '.json')
CONFIG.write_text(json.dumps(config))
SUMMARIES = []
artifact = WORK / ('multiturn-' + TAG + '.txt')
repeat = f"/usr/bin/printf '%s\\n' 'ASMT_{TAG}_REPEAT'; /usr/bin/sleep 1"
rounds = [case('R1', f"/usr/bin/printf '%s\\n' 'ASMT_{TAG}_R1'; /usr/bin/sleep 1"),
          case('R2', repeat), case('R3', repeat),
          case('R4_FAIL', "/usr/bin/bash -c 'printf intentional_failure; exit 7'"),
          case('R5_FILE', '/usr/bin/python3 -c ' + shlex.quote(
              f"from pathlib import Path;p=Path({str(artifact)!r});p.write_text('ASMT_{TAG}_FILE');print(p.read_text())")),
          case('R6_NET', '/usr/bin/python3 -c ' + shlex.quote(
              f"import urllib.request;print(urllib.request.build_opener(urllib.request.ProxyHandler({{}})).open('http://127.0.0.1:{port}/probe/ASMT_{TAG}_NET').read().decode())"))]
manifest = {'tag': TAG, 'out': str(OUT), 'port': port, 'startedAt': int(time.time() * 1000),
            'config': str(CONFIG), 'artifact': str(artifact), 'rounds': rounds,
            'mode': 'real Kimi CLI with local controlled HTTP model responses'}
emit(manifest)
try:
    main = Kimi('main')
    manifest['mainSession'] = main.session
    for item in rounds:
        main.prompt(item)
        main.snapshot(item['label'])
    main.close()
    resumed = Kimi('resumed', main.session)
    resume_case = case('R7_RESUME', f"/usr/bin/printf '%s\\n' 'ASMT_{TAG}_RESUME'; /usr/bin/sleep 1")
    resumed.prompt(resume_case)
    resumed.snapshot('R7_RESUME')
    resumed.close()
    parallel_a, parallel_b = Kimi('parallel_a'), Kimi('parallel_b')
    manifest['parallelSessions'] = [parallel_a.session, parallel_b.session]
    ca, cb = case('R8_PARALLEL_A', repeat), case('R9_PARALLEL_B', repeat)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(parallel_a.prompt, ca), pool.submit(parallel_b.prompt, cb)]
        for job in jobs:
            job.result()
    parallel_a.snapshot('R8_PARALLEL_A')
    parallel_b.snapshot('R9_PARALLEL_B')
    parallel_a.close()
    parallel_b.close()
finally:
    for process in PROCESSES:
        process.close()
    server.shutdown()
    server.server_close()
    manifest['endedAt'] = int(time.time() * 1000)
    manifest['cases'] = list(CASES.values())
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (OUT / 'summary.json').write_text(json.dumps(SUMMARIES, indent=2))
    (OUT / 'fixture-requests.json').write_text(json.dumps(REQUESTS, indent=2))
    emit({'artifacts': str(OUT), 'completedSnapshots': len(SUMMARIES), 'fixtureStopped': True})
