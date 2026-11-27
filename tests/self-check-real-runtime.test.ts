import assert from 'node:assert/strict'
import test from 'node:test'
import {Context, Service} from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {registerSelfCheck} from '../src/self-check.ts'
import {TemplateStore} from '../src/store.ts'
import {withOutput} from '../src/tool-registry.ts'
class Prompt extends Service {
  static inject:string[]=[]
  tools(){}
  constructor(ctx:Context){super(ctx,'systemPrompt')}
}
test('#100 real ToolRuntime emits maintenance results without a new self-check; business still counts',async()=>{
  const ctx=new Context(),store=new TemplateStore(':memory:'),messages:unknown[]=[]
  const agent={id:'native-a',session:{header:{id:'native-a'},snapshotEvents:()=>[]},steer:(m:unknown)=>messages.push(m)}
  await ctx.plugin(Prompt as never);await ctx.plugin(ToolRuntime as never)
  ctx.provide('goals',{get:()=>({phase:'active'})} as never)
  const fiber=await ctx.plugin((c:Context)=>{registerSelfCheck(c,()=>store,()=>true)})
  const runtime=ctx.tools as any
  runtime.register(withOutput({name:'diagnostic_business',description:'Synthetic native business event',parameters:{type:'object',properties:{}},execute:async()=>({ok:true})}))
  const resultNames:string[]=[]
  ctx.on('tools/result',(exec:any)=>{resultNames.push(exec.name)})
  let id=0;const call=(name:string,args:unknown)=>runtime.execute({callId:'r'+(++id),name,arguments:args,agent,signal:new AbortController().signal})
  const stop=(turn:number)=>ctx.emit('agent/turn-stopping' as never,{agent,turn,step:1,signal:new AbortController().signal,summary:{status:'completed'}} as never)
  try{
    await call('diagnostic_business',{});await stop(1);const initial=messages.length
    assert.ok(initial>0)
    const conclude=await call('selfcheck_conclude',{conclusion:'continue'});assert.ok(!conclude.isError)
    await stop(2);assert.equal(messages.length,initial)
    assert.ok(resultNames.includes('selfcheck_conclude'))
    await call('diagnostic_business',{});await stop(3);assert.ok(messages.length>initial)
    await call('selfcheck_conclude',{conclusion:'waiting',wake:'a2a receipt',deadline:'2099-01-01T00:00:00Z'})
    const waitingCount=messages.length
    await call('selfcheck_conclude',{conclusion:'waiting',wake:'a2a receipt',deadline:'2099-01-01T00:00:00Z'});await stop(4)
    assert.equal(messages.length,waitingCount);assert.equal(store.selfChecks.waiting('native-a')?.suppressed,true)
    await call('diagnostic_business',{});await stop(5);assert.ok(messages.length>waitingCount)
  }finally{await fiber.dispose();store.close()}
})
