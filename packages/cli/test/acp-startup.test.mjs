import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter } from '../../adapters/dist/acp.js';
import { ProcessDiagnostics } from '../../adapters/dist/process-diagnostics.js';

test('ACP startup reports the actual stderr and exit code, redacts keys, and retries a failed session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'habor-acp-failure-'));
  const key = 'private-test-credential';
  let attempt = 0;
  const session = await createAcpAdapter({
    id: 'broken', harnessName: 'Broken Agent', models: ['test'],
    command() {
      attempt++;
      return { cmd: process.execPath, argv: ['-e', `process.stderr.write('配置错误 ${attempt}: exists and is not a symlink; private-test-');setTimeout(()=>{process.stderr.write('credential');process.exit(7)},20)`] };
    }
  }).createSession({ model: 'test', cwd: dir, connection: { providerId: 'test', name: 'test', baseUrl: 'http://127.0.0.1', protocol: 'openai', apiKey: key } });
  try {
    for (let index = 1; index <= 2; index++) {
      const events = [];
      for await (const event of session.prompt('hello')) events.push(event);
      assert.equal(events.filter(event => event.type === 'error').length, 1);
      const error = events.find(event => event.type === 'error').error.message;
      assert.match(error, /退出码 7/);
      assert.ok(error.includes(`配置错误 ${index}`));
      assert.match(error, /exists and is not a symlink/);
      assert.match(error, /\[REDACTED\]/);
      assert.ok(!JSON.stringify(events).includes(key));
      assert.equal(events.at(-1).type, 'done');
    }
    assert.equal(attempt, 2);
  } finally { await session.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('process diagnostics decode split UTF-8, remove terminal controls and discard oversized raw lines', () => {
  const diagnostics = new ProcessDiagnostics(['private-value']);
  const content = Buffer.from('\x1b[31m中文 private-value\x1b[0m\n');
  for (const byte of content) diagnostics.push(Buffer.from([byte]));
  diagnostics.push(Buffer.from('x'.repeat(16385)));
  diagnostics.push(Buffer.from('private-value\nfinal error'));
  diagnostics.finish();
  assert.equal(diagnostics.text(), '中文 [REDACTED]\nfinal error');
});

test('a silent ACP client times out, releases its process and can be retried', async () => {
  let launches = 0;
  const session = await createAcpAdapter({
    id:'silent', harnessName:'Silent Agent', models:['test'], startupTimeoutMs:150,
    command() { launches++; return {cmd:process.execPath,argv:['-e','setInterval(()=>{},1000)']}; }
  }).createSession({model:'test',cwd:tmpdir()});
  try {
    for (let attempt=0; attempt<2; attempt++) {
      const events=[];
      for await (const event of session.prompt('hello')) events.push(event);
      assert.equal(events.find(event=>event.type==='error').error.code,'ACP_STARTUP_TIMEOUT');
      assert.match(events.find(event=>event.type==='error').error.message,/启动超时/);
      assert.equal(events.at(-1).type,'done');
    }
    assert.equal(launches,2);
  } finally { await session.close(); }
});
