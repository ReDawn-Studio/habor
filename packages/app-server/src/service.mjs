import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createAdapters } from '@agent-router/adapters';
import { createRouter, TaskStore } from '@agent-router/router';
import { AGENT_RUNTIMES, agentExecutable, executableOnPath, commandInvocation, stopProcess, redactSecrets } from '@agent-router/core';
import { ProviderStore } from '@agent-router/cli/dist/providers.js';
import { AgentInstaller, installPlan } from '@agent-router/cli/dist/agent-installer.js';
import { AUTH_ACTIONS, nativeAuthStatus, nativeLoginCommand } from '@agent-router/cli/dist/agent-auth.js';
import { AGENT_SETUP, openAgentInstallPage } from '@agent-router/cli/dist/agent-setup.js';
import { safeProcessText } from '@agent-router/cli/dist/agent-process.js';
import { WorkspaceTrust } from '@agent-router/cli/dist/workspace-trust.js';
import { ReasoningPreferences } from '@agent-router/cli/dist/reasoning-preferences.js';
import { listOfficialHistories } from '@agent-router/cli/dist/official-history.js';
import * as fsView from './workspace.mjs';

function text(value, name, limit = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function readJson(path, fallback) { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path,'utf8')); }
function atomic(path, value) { const temp = path + '.' + randomUUID() + '.tmp'; writeFileSync(temp,value,{mode:0o600,flag:'wx'}); renameSync(temp,path); }
const activeStates = new Set(['running','connecting','waiting']);

export class DesktopService {
  constructor({ stateDir = process.env.HABOR_STATE_DIR || join(homedir(),'.habor'), adapters = createAdapters(), emit = () => {} } = {}) {
    this.dir = stateDir; mkdirSync(stateDir,{recursive:true,mode:0o700});
    this.file = join(stateDir,'desktop-state.jsonl');
    this.configFile = join(stateDir,'desktop.json');
    this.config = readJson(this.configFile, { cwd:null, projects:[], templates:[] });
    this.providers = new ProviderStore(stateDir); this.trust = new WorkspaceTrust(stateDir);
    this.efforts = new ReasoningPreferences(stateDir); this.installer = new AgentInstaller(stateDir);
    this.emitRaw = emit; this.pending = new Map(); this.jobs = new Map(); this.operations = new Map(); this.secrets = [];
    this.switches = new Map(); this.availability = {}; this.sequence = 0; this.closed = false;
    const runtime = createRouter(adapters,{onPermissionWithTask:(request,taskId)=>this.permission(request,taskId)});
    Object.assign(this,runtime);
    this.registry.configure(this.providers.entries(),entry => { const connection=this.providers.connection(entry); if(connection?.apiKey) this.secrets.push(connection.apiKey); return connection; });
    if(existsSync(this.file)) this.tasks.loadFromJSON(readFileSync(this.file,'utf8'));
    for(const task of this.tasks.listTasks()) {
      const meta=this.meta(task);
      if(activeStates.has(meta.status)) { meta.status='interrupted'; meta.error='App Server stopped. Continue the task to recover its context.'; }
      if(meta.workflow?.status === 'running') meta.workflow.status='interrupted';
      for(const member of meta.members) if(activeStates.has(member.status)) member.status='interrupted';
      for(const check of meta.checks) if(check.status==='running') check.status='interrupted';
      for(const run of task.runs) if(run.status==='in_progress') this.tasks.finishRun(task,run.id,'failed',{message:'App Server interrupted',retryable:true,phase:'finalizing'});
    }
    this.persist();
  }
  safeError(error) { return redactSecrets(safeProcessText(error instanceof Error ? error.message : String(error)), this.secrets); }
  publish(event) { this.emitRaw({ ...event, seq:++this.sequence, ts:Date.now() }); }
  meta(task) { return task.meta.desktop ??= { status:'idle', events:[], members:[], messages:[], checks:[], live:'', thinking:'' }; }
  persist() { atomic(this.file, this.tasks.toJSON()); }
  saveConfig() { atomic(this.configFile,JSON.stringify(this.config,null,2)); }
  changed(task) { task.updatedAt=Date.now(); this.publish({type:'task', task:this.publicTask(task)}); }
  publicTask(task) {
    return structuredClone({ ...task, meta:{...task.meta, desktop:{...this.meta(task), busy:this.jobs.has(task.id), switching:this.switches.has(task.id)}}, approvals:[...this.pending].filter(([,p])=>p.taskId===task.id).map(([id,p])=>({...p.request, id,taskId:p.taskId,memberId:p.memberId})) });
  }
  requireWorkspace() { const cwd=this.config.cwd; if(!cwd || !this.trust.isTrusted(cwd)) throw new Error('Trust the selected workspace first'); return cwd; }
  requireTask(id) { const task=this.router.getTask(text(id,'task ID',100)); if(!task || task.cwd!==this.requireWorkspace()) throw new Error('Task is outside this workspace or does not exist'); return task; }
  idle(task) { if(this.jobs.has(task.id) || this.switches.has(task.id)) throw new Error('Stop the running task before changing its configuration'); }
  async snapshot(refresh = false) {
    const cwd=this.config.cwd, trusted=!!cwd && this.trust.isTrusted(cwd);
    if(trusted && (refresh || !Object.keys(this.availability).length)) this.availability=await this.registry.availableAdapters();
    return {cwd, trusted, projects:this.config.projects, templates:this.config.templates, models:trusted?this.registry.listModels().map(m=>({...m,available:!!this.availability[m.adapterId]})):[],
      tasks:trusted?this.tasks.listTasksForCwd(cwd).map(t=>this.publicTask(t)):[],
      providers:trusted?this.providers.list().map(p=>({...p,hasKey:this.providers.hasKey(p.id)})):[],
      agents:trusted?Object.entries(AGENT_SETUP).map(([id,spec])=>({id,name:spec.name,url:spec.url,installed:!!this.availability[id],auth:AUTH_ACTIONS[id]??[],install:AGENT_RUNTIMES[id]?.package?installPlan(id,this.dir):null})):[],
      preferredModel:this.providers.preferredModel(this.registry.listModels())?.model, operations:[...this.operations.values()].map(({controller,process,completion,...rest})=>rest), seq:this.sequence};
  }
  async permission(request,taskId) {
    const task=this.router.getTask(taskId), id=randomUUID(), memberId=this.jobs.get(taskId)?.memberId;
    return new Promise(resolve => {
      this.pending.set(id,{request,taskId,memberId,resolve});
      if(task){this.meta(task).status='waiting';this.changed(task);}
      this.publish({type:'approval', approval:{...request,id,taskId,memberId}});
    });
  }
  denyPending(taskId) { for(const [id,p] of this.pending) if(!taskId || p.taskId===taskId){p.resolve({allow:false,message:'Task stopped'});this.pending.delete(id);} }
  async newTask(p) {
    const cwd=this.requireWorkspace(), model=text(p.model,'model',200), entry=this.registry.entry(model);
    if(!entry) throw new Error('Unknown model');
    const permission=p.permission==='auto'?'auto':'ask';
    const task=await this.router.newTask({cwd,model,title:text(p.title||'New task','title',500),permission,reasoningEffort:this.efforts.get(entry)});
    this.meta(task); this.providers.rememberModel(entry);this.persist();this.changed(task);return task;
  }
  async runTurn(task,input,job,member) {
    if(job.cancelled) return;
    const meta=this.meta(task); meta.status='connecting'; meta.error=null;meta.live='';meta.thinking='';
    const before=task.conversation.length;
    meta.pendingInput=input;
    let lastPublish=0;
    const prompt = member ? `Your assigned responsibility: ${member.role}\n${member.instructions || ''}\n\n${input}\n\nTeam messages:\n${meta.messages.filter(m=>!m.to||m.to===member.id).slice(-12).map(m=>`${m.from}: ${m.text}`).join('\n')}`:input;
    this.changed(task);
    for await(const event of this.router.continueTask(task.id,prompt)) {
      if(job.cancelled) break;
      meta.status=this.pending.size && [...this.pending.values()].some(p=>p.taskId===task.id)?'waiting':'running';
      if(event.type==='message') meta.live=event.delta!==undefined?meta.live+event.delta:event.text??meta.live;
      if(event.type==='thinking') meta.thinking=event.delta!==undefined?meta.thinking+event.delta:event.thinking??event.text??meta.thinking;
      if(event.type!=='message'&&event.type!=='thinking') { meta.events.push({ ...event, memberId:member?.id });meta.events=meta.events.slice(-200); }
      if(event.type==='error') meta.error=event.error?.message || 'Agent error';
      if(Date.now()-lastPublish>80 || !['message','thinking'].includes(event.type)){this.changed(task);lastPublish=Date.now();this.persist();}
    }
    meta.pendingInput='';
    if(task.conversation.length>before && task.conversation.at(-1)?.role==='assistant') meta.live='';
    if(meta.error || task.runs.at(-1)?.status==='failed') throw new Error(meta.error||task.runs.at(-1).error?.message||'Agent failed');
  }
  start(task, input, { memberId, workflow=false }={}) {
    this.idle(task); const meta=this.meta(task); const job={cancelled:false,memberId,completion:null};this.jobs.set(task.id,job);
    job.completion=(async()=>{
      try {
        if(!this.tasks.activeBinding(task)) this.router.resumeTask(task.id);
        const members=workflow?meta.members:memberId?[meta.members.find(m=>m.id===memberId)]:[];
        if(workflow && !members.length) throw new Error('Add team members first');
        if(memberId && !members[0]) throw new Error('Unknown team member');
        if(members.length){
          meta.workflow={status:'running',input,index:0};
          for(const [index,member] of members.entries()) {
            if(job.cancelled) break;
            job.memberId=member.id;meta.workflow.index=index;member.status='running';this.changed(task);
            await this.router.switchTaskModel(task.id,member.model,{permission:task.meta.permission});
            if(job.cancelled) break;
            await this.runTurn(task,input,job,member);
            member.status=job.cancelled?'cancelled':'completed';
            if(!job.cancelled){ const answer=task.conversation.at(-1)?.role==='assistant'?task.conversation.at(-1).text:''; meta.messages.push({id:randomUUID(),from:member.role,to:members[index+1]?.id||null,text:answer.slice(-12000),ts:Date.now()}); }
            this.persist();
          }
          meta.workflow.status=job.cancelled?'paused':'completed';
        } else await this.runTurn(task,input,job);
        meta.status=job.cancelled?'cancelled':'completed';
      } catch(error){meta.status=job.cancelled?'cancelled':'failed';meta.error=this.safeError(error);if(meta.workflow?.status==='running')meta.workflow.status=meta.status;const member=meta.members.find(m=>m.id===job.memberId);if(member)member.status=meta.status;}
      finally {meta.pendingInput='';if(task.conversation.at(-1)?.role==='assistant')meta.live='';this.denyPending(task.id);this.jobs.delete(task.id);this.persist();this.changed(task);}
    })();
    this.changed(task);return {accepted:true,taskId:task.id};
  }
  async switchModel(task, model) {
    if (!this.registry.entry(model)) throw new Error('Unknown model');
    if (this.switches.has(task.id)) throw new Error('A model switch is already in progress');
    if (this.tasks.currentTarget(task)?.model === model) return this.publicTask(task);
    if (!await this.router.isModelAvailable(model)) throw new Error('Install the selected native Agent before switching');
    if (this.switches.has(task.id)) throw new Error('A model switch is already in progress');
    const meta=this.meta(task); this.switches.set(task.id, true); this.changed(task);
    try {
      if(this.jobs.has(task.id)) await this.stop(task);
      await this.router.switchTaskModel(task.id,model,{permission:task.meta.permission});
      this.providers.rememberModel(this.registry.entry(model)); meta.status='idle';meta.error=null;
    } catch(error) {meta.error=this.safeError(error);throw error;}
    finally {this.switches.delete(task.id);this.persist();this.changed(task);}
    return this.publicTask(task);
  }
  async stop(task) {
    const job=this.jobs.get(task.id);if(job)job.cancelled=true;this.denyPending(task.id);
    if(job?.child) await stopProcess(job.child); else await this.router.cancelTask(task.id);
    await job?.completion;return this.publicTask(task);
  }
  operation(type,adapterId,execute) {
    if([...this.operations.values()].some(o=>o.status==='running'&&o.adapterId===adapterId)) throw new Error('An operation is already running for this agent');
    const id=randomUUID(),op={id,type,adapterId,status:'running',output:'',controller:new AbortController()};this.operations.set(id,op);
    const output=line=>{op.output=(op.output+this.safeError(line)+'\n').slice(-32000);this.publish({type:'operation',operation:{id,type,adapterId,status:op.status,output:op.output}});};
    op.completion=Promise.resolve().then(()=>execute(op,output)).then(result=>{op.status=op.controller.signal.aborted?'cancelled':'completed';output(typeof result==='string'?result:JSON.stringify(result??{}));}).catch(error=>{op.status=op.controller.signal.aborted?'cancelled':'failed';output(this.safeError(error));}).finally(()=>this.publish({type:'operation',operation:{id,type,adapterId,status:op.status,output:op.output}}));
    return {id};
  }
  async call(method,p={}) {
    if(this.closed) throw new Error('Server is shutting down');
    if(!p || typeof p!=='object' || Array.isArray(p)) throw new Error('Invalid parameters');
    if(method==='snapshot') return this.snapshot(!!p.refresh);
    if(method==='workspace.open') {const cwd=await fsView.directory(p.path);if(this.jobs.size)throw new Error('Stop running tasks before changing workspace');this.config.cwd=cwd;this.config.projects=[cwd,...this.config.projects.filter(x=>x!==cwd)].slice(0,30);this.saveConfig();return this.snapshot(true);}
    if(method==='workspace.trust') {if(p.path!==this.config.cwd)throw new Error('Workspace changed; review it again');await fsView.directory(p.path);this.trust.trust(p.path);return this.snapshot(true);}
    if(method==='approval.resolve') {
      const item=this.pending.get(p.id);if(!item)throw new Error('Approval no longer pending');this.requireTask(item.taskId);
      if(typeof p.allow!=='boolean')throw new Error('Explicit approval decision required');
      if(p.allow && !item.request.options.some(o=>o.id===p.optionId))throw new Error('Select a native permission option');
      this.pending.delete(p.id);item.resolve(p.allow?{allow:true,optionId:p.optionId}:{allow:false,message:'User denied'});const task=this.router.getTask(item.taskId);this.changed(task);return {ok:true};
    }
    if(method==='tasks.create') return this.publicTask(await this.newTask(p));
    if(method==='tasks.send') return this.start(this.requireTask(p.taskId),text(p.input,'message'),{memberId:p.memberId,workflow:!!p.workflow});
    if(method==='tasks.cancel') return this.stop(this.requireTask(p.taskId));
    if(method==='tasks.model') return this.switchModel(this.requireTask(p.taskId), text(p.model,'model',200));
    if(method==='tasks.permission') {const task=this.requireTask(p.taskId);this.idle(task);if(!['ask','auto'].includes(p.permission))throw new Error('Invalid permission');task.meta.permission=p.permission;if(task.harnessProfile)task.harnessProfile.permission=p.permission;await this.router.refreshSession(task.id);this.persist();this.changed(task);return this.publicTask(task);}
    if(method==='tasks.reasoning') {const task=this.requireTask(p.taskId);this.idle(task);return {capabilities:await this.router.reasoningCapabilities(task.id),effort:this.router.getReasoningEffort(task.id)};}
    if(method==='tasks.effort') {const task=this.requireTask(p.taskId);this.idle(task);await this.router.setReasoningEffort(task.id,p.effort||undefined);const entry=this.registry.entry(this.tasks.currentTarget(task).model);this.efforts.set(entry,p.effort||undefined);this.persist();return {ok:true};}
    if(method==='tasks.resume') {const task=this.requireTask(p.taskId);this.idle(task);this.router.resumeTask(task.id);this.persist();return this.publicTask(task);}
    if(method==='history.list') {
      const cwd=this.requireWorkspace();const store=new TaskStore();const file=join(this.dir,'state.jsonl');if(existsSync(file))store.loadFromJSON(readFileSync(file,'utf8'));
      return [...store.listTasksForCwd(cwd).map(t=>({id:'habor:'+t.id,source:'habor CLI',title:t.title,turns:t.conversation.filter(m=>['user','assistant'].includes(m.role)),updatedAt:t.updatedAt})),...listOfficialHistories(cwd)].map(({turns,...entry})=>({...entry,turnCount:turns.length}));
    }
    if(method==='history.import') {
      const cwd=this.requireWorkspace();let source;
      if(p.id?.startsWith('habor:')) {const store=new TaskStore();store.loadFromJSON(readFileSync(join(this.dir,'state.jsonl'),'utf8'));const task=store.getTask(p.id.slice(6));if(task?.cwd===cwd)source={title:task.title,turns:task.conversation.filter(m=>['user','assistant'].includes(m.role))};}
      else source=listOfficialHistories(cwd).find(h=>h.id===p.id);
      if(!source)throw new Error('History is not in this workspace');const task=await this.newTask({...p,title:source.title});for(const turn of source.turns)this.tasks.appendTurn(task,{role:turn.role,text:turn.text});task.bindings.at(-1).reason='switch';this.persist();return this.publicTask(task);
    }
    if(method==='files.list')return fsView.listFiles(this.requireWorkspace(),p.path);
    if(method==='files.read')return fsView.readText(this.requireWorkspace(),text(p.path,'path',4096));
    if(method==='git.diff')return fsView.diff(this.requireWorkspace());
    if(method==='verify.list')return fsView.checks(this.requireWorkspace());
    if(method==='verify.run') {
      const task=this.requireTask(p.taskId);this.idle(task);const check=(await fsView.checks(task.cwd)).find(c=>c.id===p.script);
      if(!check || p.command!==check.command)throw new Error('Script changed. Review the command and try again');
      const npm=executableOnPath('npm');if(!npm)throw new Error('npm is required to run package scripts');
      const result={id:randomUUID(),script:check.id,command:check.command,status:'running',output:'',startedAt:Date.now()};this.meta(task).checks.push(result);this.persist();this.changed(task);
      const launch=commandInvocation(npm,['run',check.id]);const child=spawn(launch.command,launch.args,{cwd:task.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const job={cancelled:false,child,completion:null};this.jobs.set(task.id,job);
      const output=data=>{result.output=(result.output+this.safeError(data.toString())).slice(-100000);this.changed(task);};child.stdout.on('data',output);child.stderr.on('data',output);
      job.completion=new Promise(resolveJob=>{child.once('error',error=>{result.error=this.safeError(error);});child.once('close',code=>{clearTimeout(timer);result.code=code;result.status=job.cancelled?'cancelled':code===0?'completed':'failed';result.finishedAt=Date.now();this.jobs.delete(task.id);this.persist();this.changed(task);resolveJob();});});
      const timer=setTimeout(()=>{result.error='Verification timed out after 10 minutes';void stopProcess(child);},600000);
      return {accepted:true};
    }
    if(method==='verify.cancel') {const task=this.requireTask(p.taskId),job=this.jobs.get(task.id);if(job?.child){job.cancelled=true;await stopProcess(job.child);await job.completion;}return this.publicTask(task);}
    if(method==='team.save') {
      const task=this.requireTask(p.taskId);this.idle(task);if(!Array.isArray(p.members)||p.members.length>8)throw new Error('Use up to 8 members');
      const ids=new Set();const members=p.members.map(m=>{if(!this.registry.entry(m.model))throw new Error('Select a model for each member');const id=text(m.id,'member ID',100);if(ids.has(id))throw new Error('Duplicate member ID');ids.add(id);return {id,role:text(m.role,'role',100),model:m.model,instructions:typeof m.instructions==='string'?m.instructions.slice(0,4000):'',status:'idle'};});this.meta(task).members=members;this.persist();this.changed(task);return this.publicTask(task);
    }
    if(method==='team.message') {const task=this.requireTask(p.taskId);const meta=this.meta(task);if(p.to && !meta.members.some(m=>m.id===p.to))throw new Error('Unknown recipient');meta.messages.push({id:randomUUID(),from:'You',to:p.to||null,text:text(p.text,'message',12000),ts:Date.now()});this.persist();this.changed(task);return this.publicTask(task);}
    if(method==='templates.save') {const task=this.requireTask(p.taskId);const members=this.meta(task).members;if(!members.length)throw new Error('Add members first');const template={id:randomUUID(),name:text(p.name,'template name',120),members:members.map(({status,...m})=>m)};this.config.templates.push(template);this.saveConfig();return this.config.templates;}
    if(method==='templates.apply') {const template=this.config.templates.find(t=>t.id===p.id);if(!template)throw new Error('Template not found');return this.call('team.save',{taskId:p.taskId,members:template.members});}
    if(method==='templates.delete') {this.config.templates=this.config.templates.filter(t=>t.id!==p.id);this.saveConfig();return this.config.templates;}
    if(method==='providers.save') {this.requireWorkspace();if(p.apiKey)this.secrets.push(p.apiKey);this.providers.save(p.profile,p.apiKey||undefined);this.registry.configure(this.providers.entries(),entry=>{const c=this.providers.connection(entry);if(c?.apiKey)this.secrets.push(c.apiKey);return c;});return this.snapshot(true);}
    if(method==='agents.guide') {this.requireWorkspace();await openAgentInstallPage(p.adapterId);return {ok:true};}
    if(method==='agents.status') {this.requireWorkspace();if(!AGENT_SETUP[p.adapterId])throw new Error('Unknown agent');return nativeAuthStatus(p.adapterId,this.config.cwd);}
    if(method==='agents.install') {this.requireWorkspace();if(p.confirm!==true)throw new Error('Installation confirmation required');return this.operation('install',p.adapterId,(op,output)=>this.installer.install(p.adapterId,{signal:op.controller.signal,onOutput:output}));}
    if(method==='agents.login') {
      const cwd=this.requireWorkspace();const spec=nativeLoginCommand(p.adapterId,p.method,cwd);return this.operation('login',p.adapterId,async(op,output)=>{
        const launch=commandInvocation(spec.command,spec.args);const child=spawn(launch.command,launch.args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});op.process=child;
        // Authentication I/O is ephemeral and never enters task history or disk.
        child.stdout.on('data',d=>output(d.toString()));child.stderr.on('data',d=>output(d.toString()));
        const abort=()=>void stopProcess(child);op.controller.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15*60000);
        try {await new Promise((resolveOp,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolveOp():reject(new Error(`Native login exited with ${code}; use the official setup guide if this client requires a terminal`)));});return await nativeAuthStatus(p.adapterId,cwd);}
        finally {clearTimeout(timer);op.controller.signal.removeEventListener('abort',abort);}
      });
    }
    if(method==='agents.input') {const op=this.operations.get(p.id);if(op?.type!=='login'||op.status!=='running'||!op.process?.stdin)throw new Error('Login is not waiting for input');op.process.stdin.write(text(p.text,'login input',4000)+'\n');return {ok:true};}
    if(method==='agents.cancel') {const op=this.operations.get(p.id);op?.controller.abort();return {ok:true};}
    throw new Error('Unknown method: '+method);
  }
  async close() {
    this.closed=true;this.denyPending();
    for(const op of this.operations.values())op.controller.abort();
    for(const job of this.jobs.values()){job.cancelled=true;if(job.child)void stopProcess(job.child);}
    await this.router.close();await Promise.allSettled([...this.jobs.values(),...this.operations.values()].map(j=>j.completion));this.persist();
  }
}
