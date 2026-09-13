import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppView } from '../dist/tui/app.js';
import { ZcodeStreamAdapter } from '../../adapters/dist/zcode-stream.js';
import { createRouter } from '../../router/dist/index.js';

test('missing native agent stays visible; setup retry preserves draft, handles failure and activates only after detection', async () => {
  let installed = false, opened = 0, frame;
  const adapter = {id:'codex-acp',harnessName:'Codex',models:[],async isAvailable(){return installed},
    async createSession(opts){return {id:'installed-session',model:opts.model,adapterId:'codex-acp',cwd:opts.cwd,async *prompt(){},async close(){},async cancel(){}}}};
  const {router,registry,tasks} = createRouter([adapter]);
  const model='GPT-6 Astra';
  const view = new AppView({terminal:{cols:100,rows:30,paint(screen){frame=screen}},version:'test',onInput(){throw new Error('Draft must not be sent')},
    async onOpenAgentDocs(target){assert.equal(target,model);opened++},
    async onSelectModel(target){if(!await router.isModelAvailable(target))throw new Error('未检测到 Codex');const task = await router.newTask({model:target,cwd:'/tmp'});view.setModel(target);view.setTask(task.id)} });
  view.modelInfo[model]={source:'local',agent:'Codex',adapterId:'codex-acp',modelId:'gpt-6-astra',installed:false};
  view.setModels([model]);view.setInput('draft to keep');view.editor.left();const caret=view.editor.cursor;
  view.openModels();
  const screen=()=>frame.cells.map(row=>row.map(cell=>cell.ch).join('')).join('\n');
  assert.match(screen(),/待安装/);
  view.handleKey({name:'return'});
  assert.ok(view.agentSetupPanel);assert.equal(tasks.listTasks().length,0);
  assert.match(screen(),/客户端：未检测到 Codex CLI/);assert.match(screen(),/原生客户端完成登录/);
  view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened,1);assert.equal(view.agentSetupPanel.index,1);
  view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.ok(view.agentSetupPanel.error);assert.equal(view.model,null);
  assert.equal(tasks.listTasks().length,0);
  assert.equal(view.input,'draft to keep');assert.equal(view.editor.cursor,caret);
  installed=true;view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(view.agentSetupPanel,null);assert.equal(view.model,model);assert.equal(view.input,'draft to keep');
  assert.equal(registry.entry(model).adapterId,'codex-acp');
  await router.close();
});

test('a saved API source missing its agent opens setup instead of losing the Key or reopening the old selection', async () => {
  const model='gpt-6-astra · Gateway';let saved=0;
  const view=new AppView({terminal:{cols:100,rows:30,paint(){}},version:'test',onInput(){},async onSaveProvider(profile,key,useModelId){
    saved++;assert.equal(key,undefined);assert.equal(useModelId,'gpt-6-astra');return model;
  }});
  view.modelInfo[model]={source:'custom',agent:'Codex',adapterId:'codex-acp',modelId:'gpt-6-astra',installed:false};
  view.providers=[{id:'gateway',name:'Gateway',kind:'custom',baseUrl:'https://example.com/v1',models:[{id:'gpt-6-astra',agent:'codex',protocol:'responses'}]}];
  view.setModels(['Old',model]);view.setModel('Old');view.setInput('keep draft');view.openProviders();
  for(const name of ['up','return','return','return','return','return','return','return'])view.handleKey({name});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(saved,1);assert.equal(view.providerPanel,null);assert.equal(view.agentSetupPanel.model,model);
  assert.match(view.agentSetupPanel.rows().map(row=>row.text).join('\n'),/Key 不需要重新填写/);
  view.handleKey({name:'escape'});
  assert.equal(view.agentSetupPanel,null);assert.ok(view.modelPicker);assert.equal(view.model,'Old');assert.equal(view.input,'keep draft');
});

test('rechecking ZCode detects a newly installed or removed explicit path in the same process', async () => {
  const dir=mkdtempSync(join(tmpdir(),'habor-zcode-install-')), previous=process.env.ZCODE_CLI;
  try {
    const path=join(dir,'zcode.cjs');process.env.ZCODE_CLI=path;
    const adapter=new ZcodeStreamAdapter();
    assert.equal(await adapter.isAvailable(),false);
    writeFileSync(path,'// isolated test fixture');assert.equal(await adapter.isAvailable(),true);
    rmSync(path);assert.equal(await adapter.isAvailable(),false);
  } finally {if(previous===undefined)delete process.env.ZCODE_CLI;else process.env.ZCODE_CLI=previous;rmSync(dir,{recursive:true,force:true})}
});
