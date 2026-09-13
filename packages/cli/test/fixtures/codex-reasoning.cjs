#!/usr/bin/env node
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let turn=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize')send({id:request.id,result:{}});
 if(request.method==='model/list')send({id:request.id,result:{data:[
  {model:'gpt-6-astra',defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))},
  {model:'gpt-5.5',defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort}))}
 ]}});
 if(request.method==='thread/start')send({id:request.id,result:{model:request.params.model,reasoningEffort:'medium',thread:{id:'stable-thread'}}});
 if(request.method==='turn/start'){
  const id=`turn-${++turn}`;send({id:request.id,result:{turn:{id}}});
  send({method:'item/agentMessage/delta',params:{threadId:request.params.threadId,itemId:id,delta:JSON.stringify({effort:request.params.effort,threadId:request.params.threadId})}});
  send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id,status:'completed'}}});
 }
});
