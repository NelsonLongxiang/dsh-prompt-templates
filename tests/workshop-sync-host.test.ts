import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {TemplateStore} from '../src/store.ts'
import {registerWorkshopSync} from '../src/workshop-sync-host.ts'
import {DEFAULT_WORKSHOP_SYNC,type WorkshopSyncConfig,type WorkshopSyncResult} from '../src/workshop-sync.ts'
const tick=()=>new Promise<void>(r=>setImmediate(r))
const result:WorkshopSyncResult={started_at:new Date().toISOString(),finished_at:new Date().toISOString(),commit:'a'.repeat(40),status:'ok',added:[],updated:[],skipped:[],error:null}
test('disabled lifecycle never opens a store or runs; enabling starts once, unrelated settings do not retry',async()=>{
 const ctx=new Context(),db=new TemplateStore(':memory:');let config:WorkshopSyncConfig={...DEFAULT_WORKSHOP_SYNC},calls=0,opens=0,handle!:ReturnType<typeof registerWorkshopSync>
 const fiber=await ctx.plugin((c:Context)=>{handle=registerWorkshopSync(c,()=>{opens++;return db},()=>config,async()=>{calls++;return result})})
 try{
  await tick();assert.equal(calls,0);assert.equal(opens,0);assert.equal(handle.status().enabled,false)
  config={...config,enabled:true,repository:'configured'};await ctx.emit('settings/document-updated' as never,{} as never);await tick()
  assert.equal(calls,1);assert.equal(db.workshopSyncResult()?.commit,result.commit)
  for(let n=0;n<5;n++)await ctx.emit('settings/document-updated' as never,{} as never)
  await tick();assert.equal(calls,1)
  config={...config,enabled:false};await ctx.emit('settings/document-updated' as never,{} as never);await tick();assert.equal(calls,1)
 }finally{await fiber.dispose();db.close()}
})
test('interval belongs to host lifecycle, default 30 minutes, no tight retries on credential errors',async()=>{
 const ctx=new Context(),db=new TemplateStore(':memory:');let calls=0,callback:(()=>void)|undefined,delay=0,cleared=0
 const timers={set:((fn:()=>void,ms:number)=>{callback=fn;delay=ms;return {unref(){}}}) as any,clear:((_id:unknown)=>{cleared++}) as any}
 const fiber=await ctx.plugin((c:Context)=>{registerWorkshopSync(c,()=>db,()=>({...DEFAULT_WORKSHOP_SYNC,enabled:true,repository:'configured'}),async()=>{calls++;return{...result,status:'error',error:'git-credentials'}},timers)})
 try{
  await tick();assert.equal(calls,1);assert.equal(delay,30*60000)
  for(let n=0;n<5;n++)await ctx.emit('settings/document-updated' as never,{} as never)
  assert.equal(calls,1);callback!();await tick();assert.equal(calls,2);assert.equal(delay,30*60000)
 }finally{await fiber.dispose();assert.equal(cleared,1);db.close()}
})

test('startup runs once; disposal aborts and awaits active work without writing completion',async()=>{
 const ctx=new Context(),db=new TemplateStore(':memory:');let calls=0,aborted=false,handle!:ReturnType<typeof registerWorkshopSync>
 const fiber=await ctx.plugin((c:Context)=>{handle=registerWorkshopSync(c,()=>db,()=>({...DEFAULT_WORKSHOP_SYNC,enabled:true,repository:'configured'}),async(_c,_s,_g,signal)=>{calls++;await new Promise<void>(r=>signal!.addEventListener('abort',()=>{aborted=true;r()},{once:true}));return result})})
 await tick();assert.equal(calls,1);assert.equal(handle.status().running,true)
 await ctx.emit('settings/document-updated' as never,{} as never);assert.equal(calls,1)
 await fiber.dispose();assert.equal(aborted,true);assert.equal(handle.status().running,false);assert.equal(db.workshopSyncResult(),null);db.close()
})
