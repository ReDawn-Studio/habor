"""Real habor TTY -> native auth terminal -> cancel/success -> restored draft and native session.
Uses an isolated executable fixture. No real authorization is initiated.
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
fixture = r'''#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
if(process.argv[2]==='login'){
 if(process.argv[3]==='status'){console.log(fs.existsSync(process.env.HABOR_TEST_AUTH)?'Logged in using ChatGPT':'Not logged in');process.exit(fs.existsSync(process.env.HABOR_TEST_AUTH)?0:1)}
 if(!process.stdin.isTTY){console.error('Native auth requires a real terminal');process.exit(2)}
 console.log('Native authorization https://example.invalid/one-time-code-only');
 console.log('Enter verification:');
 readline.createInterface({input:process.stdin}).once('line',line=>{fs.writeFileSync(process.env.HABOR_TEST_AUTH,'ok');process.exit(0)});
}else{
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const req=JSON.parse(line);
  if(req.method==='initialize')send({id:req.id,result:{}});
  if(req.method==='thread/start')send({id:req.id,result:{model:req.params.model,modelProvider:'openai',thread:{id:'logged-in'}}});
  if(req.method==='turn/start'){
   send({id:req.id,result:{turn:{id:'turn'}}});
   send({method:'item/agentMessage/delta',params:{threadId:'logged-in',itemId:'reply',delta:'Authorized native reply'}});
   send({method:'turn/completed',params:{threadId:'logged-in',turn:{id:'turn',status:'completed',error:null}}});
  }
 });
}
'''

with tempfile.TemporaryDirectory(prefix='habor-login-') as work:
    state = Path(work, 'state')
    state.mkdir()
    (state / 'state.jsonl').write_text('')
    (state / 'trust.json').write_text(json.dumps({'version': 1, 'paths': [str(Path(work).resolve())]}))
    binary, auth = Path(work, 'codex-auth.cjs'), Path(work, 'auth-marker')
    binary.write_text(fixture)
    binary.chmod(0o755)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
    captured = bytearray()

    def child_setup():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen([shutil.which('node'), str(root / 'packages/cli/dist/index.js')], cwd=work,
                            stdin=slave, stdout=slave, stderr=slave, preexec_fn=child_setup,
                            env={**os.environ, 'TERM':'xterm-256color', 'HABOR_STATE_DIR':str(state),
                                 'HABOR_CODEX_BIN':str(binary), 'HABOR_TEST_AUTH':str(auth)})

    def send(text):
        os.write(master, text.encode())

    def wait(text, since=0, timeout=12):
        end = time.monotonic() + timeout
        while text.encode() not in captured[since:] and time.monotonic() < end:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        assert text.encode() in captured[since:], f'Missing {text!r}; exit={proc.poll()}'

    try:
        wait('Ask your question')
        time.sleep(0.06)
        send('\x1b[200~draft before authorization\x1b[201~')
        send('\x1b[15~')  # F5
        wait('Agent 安装与认证')
        send('Codex\r')
        wait('原生客户端报告：尚未登录')
        offset = len(captured)
        send('\x1b[B\r')  # browser login
        wait('Enter verification:', since=offset)
        assert termios.tcgetattr(slave)[3] & termios.ICANON, 'native login did not receive cooked terminal input'
        offset = len(captured)
        send('\x03')  # the native child exits on SIGINT; habor must survive
        wait('登录未完成或已取消', since=offset)
        assert proc.poll() is None
        assert not auth.exists()
        assert not termios.tcgetattr(slave)[3] & termios.ICANON, 'habor did not restore raw input'
        offset = len(captured)
        send('\r')
        wait('Enter verification:', since=offset)
        send('test-verification-code\r')
        wait('原生客户端报告：已认证', since=offset)
        offset = len(captured)
        send('\r')  # use existing authenticated session
        wait('已选择 GPT-5.5', since=offset)
        time.sleep(0.1)
        offset = len(captured)
        send('\r')  # send preserved draft
        wait('Authorized native reply', since=offset)
        wait('已完成', since=offset)
        send('/quit\r')
        wait('bye')
        assert proc.wait(timeout=3) == 0
        saved = (state / 'state.jsonl').read_text()
        assert 'draft before authorization' in saved
        assert 'one-time-code-only' not in saved and 'test-verification-code' not in saved
        assert 'Native authorization' not in saved
        assert b'\x1b[?1049l' in captured and b'\x1b[?2004l' in captured
        print('Native login TTY passed: genuine terminal ownership, Ctrl+C recovery, login completion, full repaint, preserved draft and no auth data in history')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
