import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentedReasoning, reasoningLabel, reasoningLevels, assertReasoningLevel, reasoningPreferenceKey } from '../../core/dist/index.js';
import { ReasoningPreferences } from '../dist/reasoning-preferences.js';
import { AppView } from '../dist/tui/app.js';
import { createRouter } from '../../router/dist/index.js';
import { claudeLaunch } from '../../adapters/dist/claude-native.js';

const ids = capabilities => capabilities.levels.map(level => level.id);

test('each model has its own levels and xhigh is never converted into max', () => {
  assert.deepEqual(ids(documentedReasoning('codex-acp','gpt-5.5')),['low','medium','high','xhigh']);
  assert.deepEqual(ids(documentedReasoning('claude-acp','claude-fable-5')),['low','medium','high','xhigh','max']);
  assert.deepEqual(ids(documentedReasoning('claude-acp','claude-sonnet-4-6')),['low','medium','high','max']);
  assert.deepEqual(ids(documentedReasoning('dsh-acp','deepseek-v4-flash')),['off','low','high','max']);
  assert.equal(reasoningLabel('xhigh'),'极高');assert.equal(reasoningLabel('max'),'最高');
  assert.deepEqual(ids(documentedReasoning('codex-acp','private-model')),[]);
  assert.throws(()=>assertReasoningLevel(documentedReasoning('dsh-acp','deepseek-v4-flash'),'xhigh'),/不支持/);
});

test('effort preferences are isolated by source, model and agent and survive provider renames', () => {
  const dir=mkdtempSync(join(tmpdir(),'habor-effort-'));
  try {
    const first={model:'GPT source A',modelId:'gpt-6-astra',adapterId:'codex-acp',providerId:'a',vendor:'A'};
    const second={...first,model:'GPT source B',providerId:'b'};
    const prefs=new ReasoningPreferences(dir);prefs.set(first,'max');prefs.set(second,'low');
    const loaded=new ReasoningPreferences(dir);
    assert.equal(loaded.get({...first,model:'Renamed A'}),'max');assert.equal(loaded.get(second),'low');
    assert.notEqual(reasoningPreferenceKey(first),reasoningPreferenceKey({...first,adapterId:'claude-acp'}));
    loaded.set(first,undefined);assert.equal(new ReasoningPreferences(dir).get(first),undefined);assert.equal(loaded.get(second),'low');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('F4 displays only available levels, preserves the draft, and handles a stale saved effort explicitly', async () => {
  const applied=[];let screen;
  const view=new AppView({terminal:{cols:96,rows:25,paint(frame){screen=frame}},version:'test',onInput(){},
    onGetReasoning:async()=>({source:'native',levels:reasoningLevels(['low','high','max'])}),onSetReasoning:async effort=>applied.push(effort)});
  view.setModel('DeepSeek V4 Flash');view.reasoningEffort='xhigh';view.setInput('my unfinished draft');
  view.handleKey({name:'f4'});await new Promise(resolve=>setImmediate(resolve));
  const text=screen.cells.map(row=>row.map(cell=>cell.ch).join('')).join('\n');
  assert.match(text,/已不受支持/);assert.doesNotMatch(text,/极高 \(xhigh\)|中 \(medium\)/);
  view.handleKey({name:'down'});view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(applied,['low']);assert.equal(view.input,'my unfinished draft');assert.equal(view.reasoningEffort,'low');
  view.handleKey({name:'f4'});await new Promise(resolve=>setImmediate(resolve));view.handleKey({name:'escape'});assert.equal(view.input,'my unfinished draft');
});

test('changing effort keeps the current native session and remembers each model on switch', async () => {
  const sessions=[];
  const adapter={id:'codex-acp',harnessName:'Test Codex',models:[],async isAvailable(){return true},async createSession(opts){
    const session={id:`native-${sessions.length}`,adapterId:'codex-acp',model:opts.model,cwd:opts.cwd,effort:opts.reasoningEffort,closed:false,
      async getReasoningCapabilities(){return {source:'native',levels:reasoningLevels(opts.modelId==='gpt-5.5'?['low','high','xhigh']:['low','high','max'])}},
      async setReasoningEffort(value){this.effort=value},async *prompt(){yield {type:'message',delta:'answer'}},async cancel(){},async close(){this.closed=true}};
    sessions.push(session);return session;
  }};
  const {router}=createRouter([adapter]);
  const task=await router.newTask({model:'GPT-5.5',cwd:'/tmp'});const binding=task.bindings.at(-1).sessionId;
  for await(const event of router.continueTask(task.id,'hello')){}
  await router.setReasoningEffort(task.id,'xhigh');
  assert.equal(task.bindings.at(-1).sessionId,binding);assert.equal(sessions[0].closed,false);assert.equal(task.conversation.length,2);
  await assert.rejects(router.setReasoningEffort(task.id,'max'),/不支持/);assert.equal(sessions[0].effort,'xhigh');
  await router.switchTaskModel(task.id,'GPT-6 Astra');assert.equal(router.getReasoningEffort(task.id),undefined);
  await router.setReasoningEffort(task.id,'max');await router.switchTaskModel(task.id,'GPT-5.5');assert.equal(router.getReasoningEffort(task.id),'xhigh');
  assert.equal(sessions.at(-1).effort,'xhigh');await router.close();
});

test('Claude sends the selected raw effort through the explicit invocation settings and supports reset', () => {
  const opts={model:'Fable',modelId:'claude-fable-5',cwd:'/tmp',reasoningEffort:'xhigh'};
  const launch=claudeLaunch(opts,'test',false);
  assert.equal(launch.argv[launch.argv.indexOf('--effort')+1],'xhigh');assert.equal(launch.settings.env.CLAUDE_CODE_EFFORT_LEVEL,'xhigh');
  const reset=claudeLaunch({...opts,reasoningEffort:undefined},'test',true,true);
  assert.equal(reset.env.CLAUDE_CODE_EFFORT_LEVEL,'auto');assert.ok(!reset.argv.includes('--effort'));
  assert.throws(()=>claudeLaunch({...opts,modelId:'claude-sonnet-4-6'},'test',false),/不支持/);
});

test('Codex native capabilities include its extra modes and turn parameters reset without replacing the thread', async () => {
  const {CodexNativeAdapter}=await import('../../adapters/dist/codex-native.js');
  const {fileURLToPath}=await import('node:url');
  const before=process.env.HABOR_CODEX_BIN;
  process.env.HABOR_CODEX_BIN=fileURLToPath(new URL('./fixtures/codex-reasoning.cjs',import.meta.url));
  const session=await new CodexNativeAdapter().createSession({model:'GPT-6 Astra',modelId:'gpt-6-astra',cwd:process.cwd()});
  try {
    const caps=await session.getReasoningCapabilities();assert.equal(caps.source,'native');assert.ok(ids(caps).includes('ultra'));
    const answers=[];
    for(const level of ['low','max',undefined]){
      await session.setReasoningEffort(level);
      for await(const event of session.prompt('hello'))if(event.type==='message')answers.push(JSON.parse(event.delta));
    }
    assert.deepEqual(answers.map(answer=>answer.effort),['low','max','medium']);
    assert.ok(answers.every(answer=>answer.threadId==='stable-thread'));
  } finally {await session.close();if(before===undefined)delete process.env.HABOR_CODEX_BIN;else process.env.HABOR_CODEX_BIN=before}
});

test('custom provider effort declarations cannot invent a parameter unsupported by its native agent', async () => {
  const {validateProvider}=await import('../../core/dist/index.js');
  const base={id:'custom',kind:'custom',name:'Gateway',baseUrl:'https://gateway.example/v1'};
  assert.throws(()=>validateProvider({...base,models:[{id:'private-claude',agent:'claude',protocol:'anthropic',reasoningLevels:['low','ultra']}]}),/不能发送 ultra/);
  assert.doesNotThrow(()=>validateProvider({...base,models:[{id:'private-gpt',agent:'codex',protocol:'responses',reasoningLevels:['low','max']}]}));
});
