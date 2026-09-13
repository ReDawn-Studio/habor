"""Exercise the actual CLI in an isolated POSIX terminal, without starting a model."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

root = Path(__file__).resolve().parents[3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
captured = bytearray()


def read_for(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([master], [], [], min(0.1, max(0, end - time.monotonic())))[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            captured.extend(data)


with tempfile.TemporaryDirectory(prefix='habor-pty-') as state:
    proc = subprocess.Popen(['node', 'packages/cli/dist/index.js'], cwd=root,
                            stdin=slave, stdout=slave, stderr=slave,
                            env={**os.environ, 'TERM': 'xterm-256color', 'HABOR_STATE_DIR': state})
    try:
        read_for(2)
        assert b'\x1b[?1049h' in captured, 'alternate screen did not start'
        assert b'habor' in captured, 'welcome screen was not rendered'
        assert '选择模型'.encode() in captured, 'startup model picker did not appear'
        # Built-in DSH adapters create sessions lazily; selecting them sends no model request.
        os.write(master, b'\x1b[B\r')
        read_for(0.5)
        assert '已选择 DeepSeek V4 Pro'.encode() in captured, 'arrow + Enter did not select the model'
        os.write(master, b'\x1bOQ')  # F2 opens at the currently selected model
        read_for(0.1)
        os.write(master, b'\x1b[A\r')
        read_for(0.5)
        assert '已切换到 DeepSeek V4 Flash'.encode() in captured, 'F2 + arrow + Enter did not switch the model'
        os.write(master, b'\x1bOS')  # F4 opens native reasoning options without sending a prompt
        read_for(1.5)
        assert '思考强度 · DeepSeek V4 Flash'.encode() in captured, 'F4 picker did not appear'
        os.write(master, b'\x1b[B\x1b[B\r')  # native default -> off -> low
        read_for(0.5)
        assert '低 (low)'.encode() in captured, 'reasoning selection was not applied'
        preferences = json.loads(Path(state, 'reasoning.json').read_text())
        assert list(preferences.values()) == ['low'], 'per-model preference was not persisted'
        os.write(master, b'/')
        read_for(0.25)
        assert '选择或切换模型'.encode() in captured, 'slash menu did not appear'
        os.write(master, b'\x15/help\r')
        read_for(0.4)
        assert '快捷键'.encode() in captured, 'help command was not rendered'
        os.write(master, '\x1b[200~第一行\n第二行 👋\x1b[201~'.encode())
        read_for(0.25)
        assert '第一行'.encode() in captured and '第二行'.encode() in captured, 'paste was lost'
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 44, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        read_for(0.25)
        assert proc.poll() is None, 'resize terminated the CLI'
        os.write(master, b'\x03')  # clear the draft
        read_for(0.1)
        os.write(master, b'\x03')  # arm exit
        read_for(0.1)
        assert proc.poll() is None, 'one Ctrl+C exited unexpectedly'
        os.write(master, b'\x03')  # confirm exit
        read_for(0.5)
        assert proc.wait(timeout=3) == 0
        assert b'\x1b[?1049l' in captured and b'\x1b[?2004l' in captured, 'terminal modes were not restored'
        assert not (termios.tcgetattr(slave)[3] & termios.ICANON) == 0, 'raw mode remained enabled'
        assert Path(state, 'state.jsonl').exists(), 'isolated state was not saved'
        print('PTY smoke passed: model selection, F4 reasoning and persistence, slash menu, help, multiline paste, resize and terminal restoration')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
