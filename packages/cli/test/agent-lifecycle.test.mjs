import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {AgentInstaller,installPlan} from '../dist/agent-installer.js';
import {runAgentCommand} from '../dist/agent-process.js';
import {managedAgentExecutable,agentExecutable} from '../../core/dist/index.js';
import {AppView} from '../dist/tui/app.js';
import {Terminal,Screen} from '../dist/tui/vendor/term.js';
import {nativeLoginCommand,nativeAuthStatus} from '../dist/agent-auth.js';

function materialize(stage,version='1.2.3'){
  const dir=join(stage,'node_modules','@openai','codex');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'@openai/codex',version}));
  const bin=join(stage,'node_modules','.bin','codex');mkdirSync(dirname(bin),{recursive:true});
  writeFileSync(bin,'#!/bin/sh\nexit 0\n',{mode:0o755});
}

test('managed installation verifies a staged official package and keeps the working version after a failed upgrade',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'habor-install-unit-'));let fail=false;const calls=[];
  try{
    const installer=new AgentInstaller(dir,async(spec)=>{
      calls.push(spec);
      if(spec.args.includes('install')){
        const stage=spec.args[spec.args.indexOf('--prefix')+1];materialize(stage);
        return{code:fail?1:0,output:fail?'mock network failure':''};
      }
      assert.deepEqual(spec.args,['--version']);return{code:0,output:'1.2.3'};
    });
    assert.equal(await installer.install('codex-acp'),'1.2.3');
    const old=managedAgentExecutable('codex-acp',dir);assert.ok(old);
    assert.ok(calls[0].args.includes('@openai/codex@latest'));
    assert.ok(calls[0].args.includes('--registry=https://registry.npmjs.org'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--cache')+1],join(dir,'npm-cache'));
    assert.ok(!calls[0].args.includes('-g'));assert.ok(calls[0].cwd.startsWith(dir));
    fail=true;await assert.rejects(installer.install('codex-acp'),/安装失败/);
    assert.equal(managedAgentExecutable('codex-acp',dir),old);
    assert.equal(readdirSync(join(dir,'agents','codex-acp','versions')).length,1);
    assert.throws(()=>installPlan('../../bad',dir),/安装程序/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});


test('cancelled installation cannot activate a package and releases the installation lock',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'habor-install-cancel-')),controller=new AbortController();
  try{
    const installer=new AgentInstaller(dir,async(spec)=>{
      if(spec.args.includes('install')){materialize(spec.cwd);controller.abort()}
      return{code:0,output:'test'};
    });
    await assert.rejects(installer.install('codex-acp',{signal:controller.signal}),/取消/);
    assert.equal(managedAgentExecutable('codex-acp',dir),undefined);
    assert.deepEqual(readdirSync(join(dir,'agents','codex-acp','versions')),[]);
    assert.ok(!readdirSync(join(dir,'agents','codex-acp')).includes('install.lock'));
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('process output redacts a secret split across chunks; cancellation terminates the child',async()=>{
  const lines=[];
  const result=await runAgentCommand({command:process.execPath,args:['-e',"process.stdout.write('sk-abcd');setTimeout(()=>process.stdout.write('12345678\\n'),10)"],cwd:tmpdir()},{onOutput:line=>lines.push(line)});
  assert.equal(result.code,0);assert.equal(lines.join(''),'[REDACTED]');
  const controller=new AbortController();
  const work=runAgentCommand({command:process.execPath,args:['-e',"console.log('ready');setInterval(()=>{},1000)"],cwd:tmpdir()},{signal:controller.signal,onOutput:()=>controller.abort()});
  await assert.rejects(work,/取消/);
});

test('install review executes only after confirmation, then presents authentication and preserves draft',async()=>{
  let installs=0;const view=new AppView({terminal:{cols:100,rows:32,paint(){}},version:'test',onInput(){},onInstallAgent:async(model,output)=>{installs++;output('Installed');return'1.0'},onLoginAgent:async()=>({state:'authenticated',text:'已认证'}),onSelectModel:async()=>{}});
  const model='GPT-6 Astra';view.modelInfo[model]={source:'local',modelId:'gpt-6-astra',agent:'Codex',adapterId:'codex-acp',installed:false};
  view.setModels([model]);view.setInput('keep draft');view.openAgentSetup(model);
  view.handleKey({name:'return'});assert.equal(view.agentSetupPanel.stage,'install-review');assert.equal(installs,0);
  view.handleKey({name:'escape'});assert.equal(installs,0);
  view.handleKey({name:'return'});view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(installs,1);assert.equal(view.agentSetupPanel.installed,true);
  assert.ok(view.agentSetupPanel.actions.some(action=>action.id==='browser'));
  assert.ok(view.agentSetupPanel.actions.some(action=>action.id==='device'));
  assert.equal(view.input,'keep draft');assert.equal(view.blocks.length,0);
});

test('API-source setup skips subscription login and selecting API setup opens the masked key form',()=>{
  const view=new AppView({terminal:{cols:100,rows:32,paint(){}},version:'test',onInput(){},onLoginAgent:async()=>({state:'unknown',text:''})});
  const model='API';view.modelInfo[model]={source:'official',modelId:'gpt-6-astra',agent:'Codex',adapterId:'codex-acp',installed:true};view.openAgentSetup(model);
  assert.ok(!view.agentSetupPanel.actions.some(action=>action.id==='browser'));
  view.agentSetupPanel.index=view.agentSetupPanel.actions.findIndex(action=>action.id==='api');view.handleKey({name:'return'});
  assert.equal(view.agentSetupPanel,null);assert.equal(view.providerPanel.stage,'form');assert.equal(view.providerPanel.index,2);
});

test('terminal resumes with a full repaint after native login handed it back',()=>{
  let output='';const input={isTTY:true,setRawMode(){},resume(){},pause(){},on(){},off(){}};
  const terminal=new Terminal({input,output:{columns:40,rows:12,write(text){output+=text},on(){},off(){}}});
  const screen=new Screen(40,12);screen.text(0,0,'Preserved conversation');terminal.start();terminal.paint(screen);terminal.stop();
  output='';terminal.start();terminal.paint(screen);assert.ok(output.includes('Preserved conversation'));terminal.stop();
});

test('login commands preserve native authentication ownership and are fixed, not provider-supplied',()=>{
  assert.deepEqual(nativeLoginCommand('codex-acp','device','/tmp').args,['login','--device-auth']);
  assert.deepEqual(nativeLoginCommand('claude-acp','browser','/tmp').args,['auth','login']);
  assert.deepEqual(nativeLoginCommand('kimi-acp','device','/tmp').args,['login']);
  assert.throws(()=>nativeLoginCommand('dsh-acp','browser','/tmp'),/不支持/);
});

test('DSH installation uses the validated bridge version while model selection remains independent',()=>{
  const plan=installPlan('dsh-acp','/tmp/state');
  assert.equal(plan.package,'@deepseek-ai/dsh');assert.equal(plan.version,'0.1.0-rc.8');
  assert.deepEqual(plan.flags,['--legacy-peer-deps','--prefer-offline']);
  assert.match(plan.description,/@deepseek-ai\/dsh@0\.1\.0-rc\.8/);
  assert.equal(installPlan('codex-acp','/tmp/state').version,'latest');
});

test('a negative native login report cannot be mistaken for a successful login from an exit code alone',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'habor-auth-state-')),old=process.env.HABOR_CODEX_BIN;
  try{
    const bin=join(dir,'codex');writeFileSync(bin,'#!/bin/sh\necho "Not logged in"\nexit 0\n',{mode:0o755});
    process.env.HABOR_CODEX_BIN=bin;
    assert.equal((await nativeAuthStatus('codex-acp',dir)).state,'signed-out');
    assert.equal((await nativeAuthStatus('kimi-acp',dir)).state,'unknown');
  }finally{if(old===undefined)delete process.env.HABOR_CODEX_BIN;else process.env.HABOR_CODEX_BIN=old;rmSync(dir,{recursive:true,force:true})}
});

test('external official CLIs are installed and opened explicitly as independent terminals, never as model routes',async()=>{
  const opened=[],sent=[];
  const view=new AppView({terminal:{cols:100,rows:32,paint(){}},version:'test',onInput:text=>sent.push(text),onSelectModel:async model=>opened.push(model)});
  const external='Qwen Code · 原生终端';
  view.setModels(['Existing']);view.setModel('Existing');view.setInput('private draft');
  view.modelInfo[external]={source:'local',modelId:'qwen3.8-max-0902',agent:'Qwen Code',adapterId:'qwen-cli',installed:true,nativeTerminalOnly:true};
  view.externalAgentModels=[external];
  view.openModels();assert.ok(!view.availableModels.includes(external));view.handleKey({name:'escape'});
  view.openAgents();for(const ch of 'Qwen')view.handleKey({name:ch,text:ch});view.handleKey({name:'return'});
  assert.ok(view.agentSetupPanel);assert.match(view.agentSetupPanel.actions[0].label,/独立会话/);
  assert.ok(!view.agentSetupPanel.actions.some(action=>action.id==='api'));
  view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(opened,[external]);assert.deepEqual(sent,[]);assert.equal(view.model,'Existing');assert.equal(view.input,'private draft');
  assert.equal(installPlan('qwen-cli').package,'@qwen-code/qwen-code');
  assert.equal(installPlan('gemini-cli').package,'@google/gemini-cli');
  assert.deepEqual(nativeLoginCommand('qwen-cli','native','/tmp').args,[]);
});

test('multiline installer failures cannot inject line breaks into the terminal cell buffer',async()=>{
  let screen;
  const view=new AppView({terminal:{cols:100,rows:32,paint(value){screen=value}},version:'test',onInput(){},onInstallAgent:async()=>{throw new Error('Install failed\nnpm error detail\rretry')}});
  view.modelInfo.Test={source:'local',modelId:'test',agent:'Codex',adapterId:'codex-acp',installed:false};view.openAgentSetup('Test');
  view.handleKey({name:'return'});view.handleKey({name:'return'});await new Promise(resolve=>setImmediate(resolve));
  assert.match(view.agentSetupPanel.error,/Install failed/);
  assert.ok(screen.cells.flat().every(cell=>!/[\r\n\t\x1b]/.test(cell.ch)));
});
