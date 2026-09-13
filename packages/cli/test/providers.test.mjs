import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderStore } from '../dist/providers.js';
import { AppView } from '../dist/tui/app.js';
import { inferAgent, protocolForAgent, validateProvider } from '../../core/dist/index.js';
import { createRouter } from '../../router/dist/index.js';
import { codexLaunch } from '../../adapters/dist/codex-native.js';
import { claudeLaunch } from '../../adapters/dist/claude-native.js';
import { kimiAcpSpec, dshAcpSpec } from '../../adapters/dist/specs-acp.js';
const key = 'test-provider-secret-not-real';
const profile = { id:'gateway', name:'测试网关', kind:'custom', baseUrl:'https://gateway.example/v1', models:[
  {id:'gpt-6-astra',agent:'codex',protocol:'responses'}, {id:'claude-fable-5',agent:'claude',protocol:'anthropic'}
] };

test('model family suggests its native agent, unknown models require an explicit binding', () => {
  assert.equal(inferAgent('gpt-6 astra'),'codex'); assert.equal(inferAgent('fable 5'),'claude');
  assert.equal(inferAgent('gateway/claude-fable-5'),'claude'); assert.equal(inferAgent('my-private-model'),undefined);
  assert.throws(()=>validateProvider({...profile,models:[{id:'private',agent:undefined,protocol:'responses'}]}),/选择执行/);
  assert.throws(()=>validateProvider({...profile,models:[{id:'gpt-6-astra',agent:'codex',protocol:'openai'}]}),/需要 responses/);
});

test('provider keys are separate and private; routing passes exact model ID and only the selected source key', async () => {
  const dir=mkdtempSync(join(tmpdir(),'habor-provider-'));
  try {
    const store=new ProviderStore(dir); store.save(profile,key);
    assert.equal(statSync(join(dir,'credentials.json')).mode & 0o777,0o600);
    assert.ok(!readFileSync(join(dir,'providers.json'),'utf8').includes(key));
    assert.ok(!JSON.stringify(store.list()).includes(key)); assert.ok(!JSON.stringify(store.entries()).includes(key));
    const seen=[];
    const fake=agent=>({id:agent,harnessName:agent,models:[],async isAvailable(){return true},async createSession(opts){seen.push({agent,opts});return{id:agent+seen.length,adapterId:agent,model:opts.model,cwd:opts.cwd,async *prompt(){},async cancel(){},async close(){}}}});
    const {router,registry,tasks}=createRouter([fake('codex-acp'),fake('claude-acp')]);
    registry.configure(store.entries(),entry=>store.connection(entry));
    const task=await router.newTask({model:store.entries()[0].model,cwd:dir});
    assert.equal(seen[0].agent,'codex-acp'); assert.equal(seen[0].opts.modelId,'gpt-6-astra'); assert.equal(seen[0].opts.connection.apiKey,key);
    await router.switchTaskModel(task.id,store.entries()[1].model);
    assert.equal(seen[1].agent,'claude-acp'); assert.equal(seen[1].opts.modelId,'claude-fable-5');
    assert.ok(!tasks.toJSON().includes(key));
    await router.newTask({model:'GPT-5.5',cwd:dir});
    assert.equal(seen[2].opts.modelId,'gpt-5.5'); assert.equal(seen[2].opts.connection,undefined);
    const reloaded=new ProviderStore(dir); assert.equal(reloaded.connection(reloaded.entries()[0]).apiKey,key);
    reloaded.save({...profile,name:'更新网关'}); assert.equal(reloaded.connection(reloaded.entries()[0]).apiKey,key);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native launch options bind the provider, key and wire model without changing global config', () => {
  const connection={providerId:'gateway',name:'网关',baseUrl:'https://gateway.example/v1',protocol:'responses',apiKey:key};
  const opts={model:'Display label',modelId:'gpt-6-astra',cwd:'/tmp',permission:'auto',connection};
  const codex=codexLaunch(opts);
  assert.ok(codex.argv.includes('model="gpt-6-astra"'));
  assert.ok(codex.argv.includes('model_provider="habor"'));
  assert.ok(codex.argv.includes('model_providers.habor.base_url="https://gateway.example/v1"'));
  assert.equal(codex.env.HABOR_PROVIDER_KEY,key); assert.ok(!codex.argv.join(' ').includes(key));
  const claude=claudeLaunch({...opts,modelId:'fable-5-custom',connection:{...connection,protocol:'anthropic'}},'session',false);
  assert.equal(claude.argv[claude.argv.indexOf('--model')+1],'fable-5-custom');
  assert.equal(claude.env.ANTHROPIC_API_KEY,key); assert.equal(claude.env.ANTHROPIC_CUSTOM_MODEL_OPTION,'fable-5-custom');
  assert.equal(claude.env.ANTHROPIC_BASE_URL,'https://gateway.example'); assert.ok(!claude.argv.join(' ').includes(key));
  const kimi=kimiAcpSpec.command({...opts,modelId:'kimi-custom',connection:{...connection,protocol:'openai'}});
  assert.equal(kimi.env.KIMI_MODEL_NAME,'kimi-custom'); assert.equal(kimi.env.KIMI_MODEL_API_KEY,key);
  assert.equal(kimiAcpSpec.command({model:'Kimi K3',modelId:'kimi-code/k3'}).env,undefined);
  const dsh=dshAcpSpec.command({...opts,modelId:'deepseek-custom',connection:{...connection,protocol:'openai'}});
  assert.equal(dsh.env.DSH_ACP_MODEL,'deepseek-custom'); assert.equal(dsh.env.HABOR_DSH_API_KEY,key);
});

test('provider wizard masks secrets, routes each model, saves and preserves the conversation draft', async () => {
  const saves=[]; let frame;
  const view=new AppView({terminal:{cols:100,rows:30,paint(screen){frame=screen}},version:'test',onInput(){},async onSaveProvider(...args){saves.push(args)}});
  view.setInput('my draft');view.handleKey({name:'f3'});
  const press=name=>view.handleKey({name});
  const type=text=>{for(const ch of text)view.handleKey({name:ch,text:ch})};
  const screen=()=>frame.cells.map(row=>row.map(c=>c.ch).join('')).join('\n');
  press('down');press('down');press('return');
  type('My gateway');press('return');type('https://gateway.example/v1');press('return');type(key);
  assert.ok(!screen().includes(key)); assert.match(screen(),/•/);
  press('return');type('gpt-6-astra, fable-5');press('return');
  assert.equal(view.providerPanel.stage,'route'); assert.match(screen(),/Codex/);
  press('return');assert.equal(view.providerPanel.stage,'route');press('return');
  assert.equal(view.providerPanel.stage,'review');assert.ok(!screen().includes(key));
  press('return');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saves.length,1);assert.equal(saves[0][1],key);
  assert.equal(saves[0][2],'gpt-6-astra');
  assert.deepEqual(saves[0][0].models.map(m=>[m.id,m.agent,m.protocol]),[['gpt-6-astra','codex','responses'],['fable-5','claude','anthropic']]);
  assert.equal(view.input,'my draft'); assert.equal(view.providerPanel,null); assert.equal(view.modelPicker,null);
});

test('provider review can select the second model or save without switching, and failed activation stays reviewable', async () => {
  for (const selection of [1, 2]) {
    const saves=[];
    const view=new AppView({terminal:{cols:100,rows:30,paint(){}},version:'test',onInput(){},async onSaveProvider(...args){saves.push(args)}});
    view.providers=[profile];view.setModel('DeepSeek V4 Flash');view.setInput('keep draft');view.openProviders();
    const press=name=>view.handleKey({name});
    press('up');press('return'); // edit saved provider, leave the Key blank
    press('return');press('return');press('return');press('return');press('return');press('return');
    assert.equal(view.providerPanel.stage,'review');
    for(let i=0;i<selection;i++)press('down');
    press('return');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(saves[0][1],undefined);
    assert.equal(saves[0][2],selection===1?'claude-fable-5':undefined);
    assert.equal(view.input,'keep draft');assert.equal(view.modelPicker,null);
  }
  const view=new AppView({terminal:{cols:100,rows:30,paint(){}},version:'test',onInput(){},async onSaveProvider(){throw new Error('Agent unavailable')}});
  view.providers=[profile];view.openProviders();
  for(const name of ['up','return','return','return','return','return','return','return','return'])view.handleKey({name});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(view.providerPanel.stage,'review');assert.match(view.providerPanel.error,/Agent unavailable/);
});

test('remembered connection survives provider rename and distinguishes local and third-party models', () => {
  const dir=mkdtempSync(join(tmpdir(),'habor-selection-'));
  try {
    const store=new ProviderStore(dir);store.save(profile,key);store.rememberModel(store.entries()[0]);
    const reloaded=new ProviderStore(dir);reloaded.save({...profile,name:'Renamed'});
    assert.equal(reloaded.preferredModel(reloaded.entries()).model,'gpt-6-astra · Renamed');
    const local={model:'GPT-6 Astra',modelId:'gpt-6-astra',adapterId:'codex-acp',vendor:'OpenAI',sourceKind:'local'};
    assert.equal(reloaded.preferredModel([local]),undefined);
    reloaded.rememberModel(local);
    assert.equal(new ProviderStore(dir).preferredModel([local,...reloaded.entries()]).model,local.model);
    assert.ok(!readFileSync(join(dir,'selection.json'),'utf8').includes(key));
  } finally {rmSync(dir,{recursive:true,force:true})}
});

test('official DeepSeek shows the version name while sending the API ID, without rewriting custom model names', () => {
  const dir=mkdtempSync(join(tmpdir(),'habor-official-label-'));
  try {
    const store=new ProviderStore(dir);
    const official={id:'official',name:'DeepSeek 官方 API',kind:'official',baseUrl:'https://api.deepseek.com',models:[{id:'deepseek-flash',agent:'dsh',protocol:'openai'}]};
    store.save(official,key);
    assert.equal(store.entries()[0].model,'DeepSeek V4.1 Flash · DeepSeek 官方 API');
    assert.equal(store.entries()[0].modelId,'deepseek-flash');
    store.save({...official,id:'third-party',name:'Third party',kind:'custom',baseUrl:'https://example.com/v1',models:[{id:'deepseek-v4.1-flash',agent:'dsh',protocol:'openai'}]},key);
    assert.equal(store.entries()[1].modelId,'deepseek-v4.1-flash');
  } finally {rmSync(dir,{recursive:true,force:true})}
});
