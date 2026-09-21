// Real DSH, ordinary local settings/credential path, private mock API. No personal keys.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../../adapters/dist/index.js';
import { AppView } from '../dist/tui/app.js';
import { TurnEvents } from '../dist/tui/events.js';

const dir = mkdtempSync(join(tmpdir(), 'habor-dsh-local-'));
const oldHome = process.env.DSH_HOME;
const key = 'habor-dsh-local-test-key';
const requests = [];
let healthy = false;
const server = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  const body = JSON.parse(data);
  requests.push({ model: body.model, keyMatches: req.headers.authorization === `Bearer ${key}` });
  if (!healthy) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'InvalidSubscription', message: 'InvalidSubscription: Your account does not have a valid AgentPlan subscription, or your subscription has expired.' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id:'test', object:'chat.completion.chunk', created:1, model:body.model, choices:[{ index:0, delta:{ role:'assistant', content:'Local DSH recovered' }, finish_reason:null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id:'test', object:'chat.completion.chunk', created:1, model:body.model, choices:[{ index:0, delta:{}, finish_reason:'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.DSH_HOME = join(dir, 'dsh-home');
mkdirSync(process.env.DSH_HOME, { mode:0o700 });
// Reproduce a conflicting native dependency directory and a broken native
// profile. Habor must leave both untouched while reusing settings/credentials.
const nativeDependency = join(process.env.DSH_HOME, 'profiles', 'node_modules', 'send');
mkdirSync(nativeDependency, { recursive:true });
writeFileSync(join(nativeDependency, 'keep.txt'), 'native dependency: preserve me');
const nativeProfile = join(process.env.DSH_HOME, 'profiles', 'headless');
mkdirSync(nativeProfile, { recursive:true });
writeFileSync(join(nativeProfile, 'package.json'), '{ deliberately invalid user profile');
writeFileSync(join(nativeProfile, 'cordis.yml'), '# native configuration: preserve me');
writeFileSync(join(process.env.DSH_HOME, 'settings.yaml'), JSON.stringify({
  'agent-default-model': { provider:'deepseek', model:'deepseek-v4-flash' },
  'llm-pi-ai': { providers:{ deepseek:{ baseURL, apiKeyEnv:'HABOR_DSH_LOCAL_TEST_KEY', api:'openai-completions', models:[{ id:'deepseek-v4-flash' }] } } }
}), { mode:0o600 });
writeFileSync(join(process.env.DSH_HOME, '.credentials.yaml'), `HABOR_DSH_LOCAL_TEST_KEY: ${key}\n`, { mode:0o600 });
const session = await createAdapters().find(adapter => adapter.id === 'dsh-acp').createSession({ model:'DeepSeek V4 Flash', modelId:'deepseek-v4-flash', cwd:dir, permission:'ask' });
let frame;
const view = new AppView({ terminal:{ cols:100, rows:30, paint(screen){frame=screen;} }, version:'test', onInput(){} });
const timeout = setTimeout(() => void session.cancel(), 30000);
try {
  const first = [], projector = new TurnEvents(view);
  for await (const event of session.prompt('Only say OK without tools.')) { first.push(event); projector.accept(event); }
  assert.equal(first.find(event => event.type === 'connection')?.connection?.endpointHost, new URL(baseURL).host);
  const error = first.find(event => event.type === 'error');
  assert.equal(error?.error?.code, 'InvalidSubscription', JSON.stringify({error:error?.error,requests}));
  assert.match(error.error.message, /订阅无效或已过期/);
  assert.doesNotMatch(error.error.message, /^Internal error$/);
  view.setBusy(false);
  const screen = frame.cells.map(row => row.map(cell => cell.ch).join('')).join('\n');
  assert.ok(screen.includes(new URL(baseURL).host)); assert.match(screen, /InvalidSubscription/);
  healthy = true;
  const next = [];
  for await (const event of session.prompt('Try again, only reply OK.')) next.push(event);
  assert.ok(next.some(event => event.type === 'message' && (event.delta ?? event.text).includes('Local DSH recovered')));
  assert.ok(requests.length >= 2 && requests.every(request => request.keyMatches && request.model === 'deepseek-v4-flash'));
  assert.ok(!JSON.stringify([...first,...next]).includes(key));
  assert.equal(lstatSync(nativeDependency).isSymbolicLink(), false);
  assert.equal(readFileSync(join(nativeDependency, 'keep.txt'), 'utf8'), 'native dependency: preserve me');
  assert.equal(readFileSync(join(nativeProfile, 'cordis.yml'), 'utf8'), '# native configuration: preserve me');
  assert.equal(readFileSync(join(nativeProfile, 'package.json'), 'utf8'), '{ deliberately invalid user profile');
  console.log('Local DSH passed: native settings/credentials preserved, conflicting profiles untouched, subscription diagnosis and next-turn recovery.');
} finally {
  clearTimeout(timeout); await session.close();
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive:true, force:true });
}
