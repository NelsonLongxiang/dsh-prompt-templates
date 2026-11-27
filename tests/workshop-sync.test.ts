import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {TemplateStore} from '../src/store.ts'
import {DEFAULT_WORKSHOP_SYNC,applyWorkshopCards,collectCardHistory,parseWorkshopPayload,syncWorkshop,SyncFailure,createGitRunner} from '../src/workshop-sync.ts'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {createTestDirectory} from './temp-dir.mjs'
const pack=(content='new',category='工坊',name='card')=>JSON.stringify({format:'dsh-prompt-templates',version:1,kind:'templates',categories:[{name:category,scope:'global',session_id:null}],templates:[{id:'stable-'+name,name,content,category,scope:'global',session_id:null,inject_enabled:true,inject_every:2,mode:'visible'}]})
const payload=(content='new',category='工坊',name='card',main=true)=>parseWorkshopPayload(pack(content,category,name),main?'assets/injection-templates.json':'assets/injection-templates-extra.json')

test('Git subprocess argv, noninteractive env, safe credential errors, missing executable and timeout',async()=>{
 let options:any,argv:string[]=[]
 const fake=(kind:string)=>(_command:string,args:string[],opts:any)=>{
  options=opts;argv=args
  const child:any=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough()
  child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true}
  queueMicrotask(()=>{if(kind==='credentials'){child.stderr.write('fatal: Authentication failed for https://USER:SECRET@example.invalid/?token=PRIVATE');child.emit('close',128)}else if(kind==='missing'){child.emit('error',Object.assign(new Error('PRIVATE'),{code:'ENOENT'}));child.emit('close',null)}else if(kind==='unicode'){child.stdout.write(Buffer.from([0xe5]));child.stdout.write(Buffer.from([0xb7,0xa5]));child.emit('close',0)}})
  return child
 }
 for(const [kind,code]of [['credentials','git-credentials'],['missing','git-missing'],['timeout','git-timeout']]){
  await assert.rejects(createGitRunner(fake(kind!) as any)('safe path',['fetch','origin'],10),(e:any)=>e.code===code&&!e.message.includes('SECRET'))
  assert.equal(options.shell,false);assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');assert.equal(options.env.GCM_INTERACTIVE,'Never');assert.ok(argv.includes('credential.interactive=false'));assert.ok(argv.includes('core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes'))
 }
 assert.equal(await createGitRunner(fake('unicode') as any)('safe',['show','HEAD:a'],1000),'工')
})

test('actual owned subprocess timeout settles promptly without killing the host',async()=>{
 let child:ReturnType<typeof spawn>|undefined
 const actual=((_command:string,_args:string[],options:any)=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);return child}) as typeof spawn
 const before=Date.now()
 await assert.rejects(createGitRunner(actual)(process.cwd(),['synthetic'],100),(error:any)=>error.code==='git-timeout')
 assert.ok(Date.now()-before<10000);assert.ok(child?.exitCode!==null||child?.signalCode!==null)
})

test('sync defaults disabled and makes no Git or database calls',async()=>{
  const r=await syncWorkshop(DEFAULT_WORKSHOP_SYNC,()=>{throw Error('db called')},async()=>{throw Error('git called')})
  assert.equal(r.status,'disabled');assert.equal(r.commit,null)
})
test('missing cards/categories use primary declarations, new cards remain off with no interval',()=>{
 const s=new TemplateStore(':memory:');try{
  const p=payload();const r=applyWorkshopCards(s,[p,payload('extra','optional','extra',false)],collectCardHistory([p]))
  assert.equal(r.added.length,1);assert.equal(r.skipped[0]?.reason,'category-missing')
  const row=s.list()[0]!;assert.equal(row.inject_enabled,false);assert.equal(row.inject_every,null);assert.equal(row.system_prompt,false)
  assert.deepEqual(s.listCategories().map(c=>c.name),['工坊'])
 }finally{s.close()}
})
test('historically unmodified text updates while schedule, mode and other owner fields remain',()=>{
 const s=new TemplateStore(':memory:');try{
  s.createCategory({name:'工坊'});const row=s.create({name:'card',content:'old',category:'工坊',inject_enabled:true,inject_every:17,mode:'inject',description:'owner',position:5})
  const p=payload(),old=payload('old');const r=applyWorkshopCards(s,[p],collectCardHistory([p,old]));assert.equal(r.updated.length,1)
  const after=s.get(row.id)!;assert.equal(after.content,'new');assert.equal(after.inject_enabled,true);assert.equal(after.inject_every,17);assert.equal(after.mode,'inject');assert.equal(after.description,'owner');assert.equal(after.position,5)
  assert.equal(applyWorkshopCards(s,[p],collectCardHistory([p,old])).skipped[0]?.reason,'unchanged')
 }finally{s.close()}
})
test('human edits, foreign categories, session names and active global system prompts are never overwritten',()=>{
 for(const reason of ['human-edited','name-conflict','global-confirmation-required']){
  const s=new TemplateStore(':memory:');try{
   s.createCategory({name:'工坊'});s.createCategory({name:'other'})
   const row=s.create({name:'card',content:reason==='human-edited'?'human':'old',category:reason==='name-conflict'?'other':'工坊'})
   if(reason==='global-confirmation-required')s.update(row.id,{system_prompt:true,confirm_global:true})
   const p=payload(),r=applyWorkshopCards(s,[p],collectCardHistory([p,payload('old')]))
   assert.equal(r.skipped[0]?.reason,reason);assert.equal(s.list().length,1);assert.equal(s.get(row.id)!.content,reason==='human-edited'?'human':'old')
  }finally{s.close()}
 }
 const s=new TemplateStore(':memory:');try{s.create({name:'card',content:'private',scope:'session',session_id:'s'});const p=payload();assert.equal(applyWorkshopCards(s,[p],collectCardHistory([p])).skipped[0]?.reason,'name-conflict');assert.equal(s.list().length,1)}finally{s.close()}
})
test('ambiguous source payloads roll back the complete card transaction',()=>{
 const s=new TemplateStore(':memory:');try{const p=payload();assert.throws(()=>applyWorkshopCards(s,[p,p],collectCardHistory([p])),SyncFailure);assert.equal(s.list().length,0);assert.equal(s.listCategories().length,0)}finally{s.close()}
})
function fixture(t:{after(fn:()=>void):void}){
 const dir=createTestDirectory('workshop-sync-');t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const remote=join(dir,'remote.git'),work=join(dir,'skill repo 空间'),source=join(dir,'source')
 const git=(cwd:string,...args:string[])=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
 mkdirSync(remote);mkdirSync(work);mkdirSync(source);git(remote,'init','--bare','--initial-branch=main')
 for(const cwd of [source,work]){git(cwd,'init','--initial-branch=main');git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.invalid');git(cwd,'remote','add','origin',remote)}
 mkdirSync(join(source,'assets'));writeFileSync(join(source,'assets/injection-templates.json'),pack('old'));git(source,'add','assets/injection-templates.json');git(source,'commit','-m','old');git(source,'push','-u','origin','main')
 git(work,'fetch','origin','main');git(work,'merge','--ff-only','origin/main')
 writeFileSync(join(source,'assets/injection-templates.json'),pack('new'));git(source,'add','assets/injection-templates.json');git(source,'commit','-m','new');git(source,'push','origin','main')
 return{dir,work,source,git,config:{...DEFAULT_WORKSHOP_SYNC,enabled:true,repository:work}}
}
test('real argv Git: clean default checkout fast-forwards and updates old historical card',async t=>{
 const f=fixture(t),s=new TemplateStore(':memory:');try{
  s.createCategory({name:'工坊'});s.create({name:'card',content:'old',category:'工坊',inject_enabled:true,inject_every:5})
  const r=await syncWorkshop(f.config,()=>s);assert.equal(r.status,'ok',r.error??'');assert.equal(r.commit,f.git(f.source,'rev-parse','HEAD'));assert.equal(r.updated.length,1);assert.equal(s.list()[0]!.content,'new');assert.equal(s.list()[0]!.inject_every,5)
 }finally{s.close()}
})
test('dirty, wrong branch and divergent checkouts retain HEAD and every local file',async t=>{
 for(const mode of ['dirty','branch','diverged']){
  const f=fixture(t),s=new TemplateStore(':memory:');try{
   if(mode==='dirty')writeFileSync(join(f.work,'human.txt'),'keep')
   if(mode==='branch')f.git(f.work,'switch','-c','human-branch')
   if(mode==='diverged'){writeFileSync(join(f.work,'human.txt'),'keep');f.git(f.work,'add','human.txt');f.git(f.work,'commit','-m','local')}
   const before=f.git(f.work,'rev-parse','HEAD'),r=await syncWorkshop(f.config,()=>s)
   assert.equal(r.status,'skipped',r.error??'');assert.equal(r.error,{dirty:'dirty-worktree',branch:'non-default-branch',diverged:'not-fast-forward'}[mode]);assert.equal(f.git(f.work,'rev-parse','HEAD'),before);assert.equal(s.list().length,0)
  }finally{s.close()}
 }
})
test('ignored local files are not overwritten by a fast-forward and detached HEAD is retained',async t=>{
 for(const mode of ['ignored','detached']){
  const f=fixture(t),s=new TemplateStore(':memory:');try{
   if(mode==='ignored'){
    writeFileSync(join(f.work,'.git/info/exclude'),'local.txt\n');writeFileSync(join(f.work,'local.txt'),'HUMAN')
    writeFileSync(join(f.source,'local.txt'),'REMOTE');f.git(f.source,'add','local.txt');f.git(f.source,'commit','-m','track file');f.git(f.source,'push','origin','main')
   }else f.git(f.work,'switch','--detach')
   const before=f.git(f.work,'rev-parse','HEAD');const r=await syncWorkshop(f.config,()=>s)
   assert.equal(f.git(f.work,'rev-parse','HEAD'),before)
   if(mode==='ignored'){assert.equal(r.status,'error');assert.equal((await import('node:fs')).readFileSync(join(f.work,'local.txt'),'utf8'),'HUMAN')}
   else{assert.equal(r.status,'skipped');assert.equal(r.error,'non-default-branch')}
   assert.equal(s.list().length,0)
  }finally{s.close()}
 }
})
test('persisted latest status survives database reopen without changing delivery consent',t=>{
 const f=fixture(t),path=join(f.dir,'status.sqlite3'),s=new TemplateStore(path)
 const result={started_at:'2026-11-27T00:00:00Z',finished_at:'2026-11-27T00:00:01Z',commit:'a'.repeat(40),status:'ok' as const,added:[],updated:[],skipped:[],error:null}
 s.saveWorkshopSyncResult(result);s.close();const reopened=new TemplateStore(path)
 try{assert.deepEqual(reopened.workshopSyncResult(),result);assert.equal(reopened.list().length,0)}finally{reopened.close()}
})

test('noninteractive failures return safe codes and concurrent callers cannot run a second round',async t=>{
 const f=fixture(t);let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 let calls=0;const runner=async()=>{calls++;entered();await gate;throw new SyncFailure('git-timeout')}
 const first=syncWorkshop(f.config,()=>{throw Error('no db')},runner);await ready
 const secondPromise=syncWorkshop(f.config,()=>{throw Error('no db')},runner)
 try{await new Promise<void>(r=>setTimeout(r,50));assert.equal(calls,1,'a concurrent run must not reach Git')}finally{release()}
 const [r,second]=await Promise.all([first,secondPromise]);assert.equal(second.error,'already-running');assert.equal(r.error,'git-timeout');assert.equal(JSON.stringify(r).includes(f.work),false)
 const error=await syncWorkshop(f.config,()=>{throw Error('no db')},async()=>{throw Error('https://secret:password@host/?token=PRIVATE')});assert.equal(error.error,'sync-failed');assert.equal(JSON.stringify(error).includes('password'),false)
})
