import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopProcess, dshPackageAnchor } from '../../core/dist/index.js';

assert.ok(dshPackageAnchor(), 'Install the compatible DSH client before running this integration test.');
const dir = mkdtempSync(join(tmpdir(), 'habor-dsh-concurrent-'));
const nativeHome = join(dir, 'native-home');
const conflict = join(nativeHome, 'profiles', 'node_modules', 'send');
mkdirSync(conflict, { recursive:true });
writeFileSync(join(conflict, 'sentinel'), 'do not change');
const workers = [];
try {
  for (let index = 0; index < 2; index++) {
    const script = `
      import { bootDsh } from ${JSON.stringify(new URL('../../dsh-acp/dist/dsh-runtime.js', import.meta.url).href)};
      const runtime = await bootDsh();
      console.log(JSON.stringify({ profileDir: runtime.profileDir }));
      for await (const chunk of process.stdin) {}
      await runtime.dispose(); process.exit(0);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, stdio: ['pipe','pipe','pipe'],
      env: { ...process.env, DSH_HOME:nativeHome, HABOR_DSH_BASE_URL:'', HABOR_DSH_API_KEY:'' }
    });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-6000); });
    const exited = new Promise(resolve => child.once('close', code => resolve(code)));
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Concurrent DSH startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error(diagnostics || 'DSH exited before ready')); });
      createInterface({ input:child.stdout }).on('line', line => {
        try { const info=JSON.parse(line); if(info.profileDir) { clearTimeout(timer); resolve(info.profileDir); } } catch {}
      });
    });
    // Observe both promises immediately so an early child failure is handled.
    ready.catch(() => {});
    workers.push({ child, exited, ready });
  }
  const paths = await Promise.all(workers.map(worker => worker.ready));
  assert.notEqual(paths[0], paths[1]);
  for (const path of paths) {
    assert.equal(readFileSync(join(path, 'cordis.yml'), 'utf8'), '[]\n');
    assert.ok(!path.startsWith(nativeHome));
  }
  assert.equal(readFileSync(join(conflict, 'sentinel'), 'utf8'), 'do not change');
  workers.forEach(worker => worker.child.stdin.end());
  assert.deepEqual(await Promise.all(workers.map(worker => worker.exited)), [0,0]);
  paths.forEach(path => assert.equal(existsSync(path), false));
  console.log('DSH isolation passed: concurrent processes, conflicting native directory, independent profiles and clean disposal.');
} finally {
  await Promise.all(workers.map(async worker => { await stopProcess(worker.child); await worker.exited; }));
  rmSync(dir, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
