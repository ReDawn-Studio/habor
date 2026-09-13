"""A clean-machine TTY flow: no native agents -> save Key -> install fixture -> recheck -> use.

No installers or external APIs run. PATH, files and credentials are isolated.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

root = Path(__file__).resolve().parents[3]
node = shutil.which('node')
key = 'isolated-missing-agent-test-key'
fixture = '''#!/usr/bin/env node
const readline=require('node:readline'), fs=require('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);
 if(req.method==='initialize')send({id:req.id,result:{}});
 if(req.method==='thread/start'){
  fs.writeFileSync(process.env.HABOR_TEST_REQUEST,JSON.stringify({model:req.params.model,keyMatches:process.env.HABOR_PROVIDER_KEY==='isolated-missing-agent-test-key'}));
  send({id:req.id,result:{model:req.params.model,modelProvider:'habor',thread:{id:'installed-thread'}}});
 }
 if(req.method==='turn/start'){
  send({id:req.id,result:{turn:{id:'turn-1'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'installed-thread',itemId:'reply',delta:'Installed agent replied'}});
  send({method:'turn/completed',params:{threadId:'installed-thread',turn:{id:'turn-1',status:'completed',error:null}}});
 }
});
'''

with tempfile.TemporaryDirectory(prefix='habor-no-agents-') as work:
    state, bin_dir = Path(work, 'state'), Path(work, 'bin')
    state.mkdir()
    bin_dir.mkdir()
    (state / 'state.jsonl').write_text('')
    os.symlink(node, bin_dir / 'node')
    os.symlink('/bin/sh', bin_dir / 'sh')
    codex, request_file = bin_dir / 'codex-fixture', Path(work, 'request.json')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
    captured = bytearray()
    proc = subprocess.Popen([node, str(root / 'packages/cli/dist/index.js')], cwd=work, stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, 'TERM':'xterm-256color', 'PATH':str(bin_dir), 'HABOR_STATE_DIR':str(state),
             'HABOR_CODEX_BIN':str(codex), 'HABOR_CLAUDE_BIN':str(bin_dir / 'absent-claude'),
             'ZCODE_CLI':str(bin_dir / 'absent-zcode'), 'HABOR_TEST_REQUEST':str(request_file)})

    def send(text):
        os.write(master, text.encode())

    def paste(text):
        send('\x1b[200~' + text + '\x1b[201~')

    def wait_for(predicate, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
            if predicate():
                return
        raise AssertionError(f'Expected UI/state did not arrive; exit={proc.poll()}')

    def wait_text(text, since=0):
        wait_for(lambda: text.encode() in captured[since:])

    try:
        wait_text('未检测到 Agent。')
        wait_text('待安装')
        send('\r')
        wait_text('安装所需 Agent')
        wait_text('DeepSeek Harness')
        send('\x1b')
        time.sleep(0.06)
        send('\x1b')
        time.sleep(0.06)
        paste('draft from before installation')
        send('\x1bOR')  # F3
        wait_text('连接与提供商')
        send('\x1b[B\x1b[B\r')
        for value in ['Saved gateway', 'http://127.0.0.1:9/v1', key, 'gpt-6-astra']:
            paste(value)
            send('\r')
        send('\r')  # native Codex route
        wait_text('保存并使用')
        send('\r')
        wait_text('客户端：未检测到 Codex CLI')
        wait_text('Key 不需要重新填写')
        wait_for(lambda: (state / 'providers.json').exists())
        assert len(json.loads((state / 'providers.json').read_text())['providers']) == 1
        assert (state / 'state.jsonl').read_text() == '', 'Missing agent created a phantom task'
        assert not request_file.exists()

        send('\x1b[B\r')  # retry before installation: stays in setup
        wait_text('Codex CLI。安装说明')
        assert not request_file.exists()
        codex.write_text(fixture)
        codex.chmod(0o755)
        send('\r')
        wait_text('已选择 gpt-6-astra · Saved gateway')
        wait_for(lambda: (state / 'selection.json').exists())
        time.sleep(0.1)
        send('\r')  # send the draft that survived every panel and failed retry
        wait_text('Installed agent replied')
        wait_for(lambda: 'draft from before installation' in (state / 'state.jsonl').read_text())
        observed = json.loads(request_file.read_text())
        assert observed == {'model':'gpt-6-astra', 'keyMatches':True}
        tasks = [json.loads(line) for line in (state / 'state.jsonl').read_text().splitlines() if line]
        assert len(tasks) == 1
        assert tasks[0]['bindings'][-1]['adapterId'] == 'codex-acp'
        assert key.encode() not in captured
        assert key not in (state / 'state.jsonl').read_text()
        send('/quit\r')
        wait_text('bye')
        assert proc.wait(timeout=3) == 0
        print('Missing-agent TTY passed: empty machine, visible models, saved API Key, failed recheck, install detection, correct native route and preserved draft')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
