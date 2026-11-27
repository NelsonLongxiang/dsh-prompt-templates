import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createTestDirectory } from './temp-dir.mjs'
import { exportDatabase, importDatabase, databaseSha256 } from '../src/cli/database.ts'
import { createSnapshot } from '../src/cli/model.ts'
import { registerSystemPrompt } from '../src/system-prompt.ts'
import test from 'node:test'
import { TemplateStore, ConfirmGlobalError } from '../src/store.ts'
import { contentDigest } from '../src/interventions.ts'
import { createSystemPromptProvider, DEFAULT_SYSTEM_PROMPT, renderSystemPrompt, selectPromptLessons, type PromptLesson } from '../src/system-prompt.ts'

function memory(t: { after: (fn: () => void) => void }) { const store = new TemplateStore(':memory:'); t.after(() => store.close()); return store }
function lesson(store: TemplateStore, type: string, right: number, wrong: number) {
  if (!store.listCategories('a').some(c=>c.name==='体会' && c.session_id==='a')) store.createCategory({name:'体会',scope:'session',session_id:'a'})
  const row = store.create({ name: '体会·'+type, content: 'current wrong', scope: 'session', session_id: 'a', category: '体会' })
  store.lessons.setOutcome(row.id, contentDigest(row.content), 'wrong')
  for (let i=0;i<right;i++) { const text = 'right '+i; store.keepVersion(row.id,'r'+i,row.name,text,'test'); store.lessons.setOutcome(row.id,contentDigest(text),'right') }
  for (let i=1;i<wrong;i++) { const text = 'wrong '+i; store.keepVersion(row.id,'w'+i,row.name,text,'test'); store.lessons.setOutcome(row.id,contentDigest(text),'wrong') }
  store.keepVersion(row.id,'untagged',row.name,'legacy untagged','test')
  return row
}

test('v11 migrates once with opt-in off, preserving text and scheduling', () => {
  const path = join(createTestDirectory('system-v11-'), 'db.sqlite3')
  const first = new TemplateStore(path)
  const original = first.create({name:'existing',content:'unchanged',inject_enabled:true,inject_every:3})
  first.close()
  const raw = new DatabaseSync(path)
  raw.exec('ALTER TABLE templates DROP COLUMN system_prompt; PRAGMA user_version=11');raw.close()
  const migrated = new TemplateStore(path)
  assert.deepEqual(migrated.get(original.id),original)
  migrated.close()
  const again = new TemplateStore(path)
  assert.equal(again.get(original.id)?.system_prompt,false);again.close()
})

test('CLI cannot overwrite or silently disable active global prompts, but session imports reset off', async () => {
  const path=join(createTestDirectory('system-import-'),'db.sqlite3')
  const store=new TemplateStore(path)
  const g=store.create({name:'protected',content:'global'})
  store.update(g.id,{system_prompt:true,confirm_global:true})
  const s=store.create({name:'own',content:'session',scope:'session',session_id:'a'})
  store.update(s.id,{system_prompt:true})
  const snapshot=exportDatabase(path)
  const incoming=createSnapshot(snapshot.categories,snapshot.templates.map(t=>({...t,content:'changed'})))
  const dry=await importDatabase(path,incoming,{apply:false,maxChanges:10})
  await assert.rejects(()=>importDatabase(path,incoming,{apply:true,maxChanges:10,expectedDbSha256:databaseSha256(path),confirmedSummarySha256:dry.plan.summary_sha256}),/confirm-global/)
  assert.equal(store.get(g.id)?.content,'global');assert.equal(store.get(g.id)?.system_prompt,true)
  const privateOnly=createSnapshot([],snapshot.templates.filter(t=>t.id===s.id).map(t=>({...t,content:'new private'})))
  const plan=await importDatabase(path,privateOnly,{apply:false,maxChanges:10})
  await importDatabase(path,privateOnly,{apply:true,maxChanges:10,expectedDbSha256:databaseSha256(path),confirmedSummarySha256:plan.plan.summary_sha256})
  assert.equal(store.get(s.id)?.system_prompt,false);assert.equal(store.get(g.id)?.system_prompt,true)
  store.close()
})

test('actual Cordis registration binds scoped Agent session and disposes providers; disabled means no registration',async t=>{
  const store=memory(t);const g=store.create({name:'registered',content:'marker {{unknown}}'})
  store.update(g.id,{system_prompt:true,confirm_global:true})
  const ctx=new Context();const sections:any[]=[];const variables=new Map<string,(c:unknown)=>string>()
  ctx.provide('systemPrompt',{section:(s:unknown)=>{sections.push(s);return()=>{sections.pop()}},variable:(name:string,p:(c:unknown)=>string)=>{variables.set(name,p);return()=>{variables.delete(name)}}})
  const disabled=ctx.plugin((c:Context)=>registerSystemPrompt(c,()=>store,()=>({...DEFAULT_SYSTEM_PROMPT})))
  await disabled;assert.equal(sections.length,0);await disabled.dispose()
  const fiber=ctx.plugin((c:Context)=>registerSystemPrompt(c,()=>store,()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true})))
  await fiber;assert.equal(sections[0].order,9000);assert.equal(sections[0].text,'{{prompt_templates}}')
  assert.match(variables.get('prompt_templates')!({scope:{session:{header:{id:'a'}}}}),/marker {{unknown}}/)
  assert.equal(variables.get('prompt_templates')!({}),'')
  await fiber.dispose();assert.equal(variables.size,0);assert.equal(sections.length,0)
})

test('live config reconciliation enables from false, changes order, and disables without a plugin restart',async t=>{
  const store=memory(t),ctx=new Context(),sections:any[]=[];const vars=new Map<string,unknown>()
  ctx.provide('systemPrompt',{section:(s:unknown)=>{sections.push(s);return()=>{sections.splice(sections.indexOf(s),1)}},variable:(n:string,p:unknown)=>{vars.set(n,p);return()=>{vars.delete(n)}}})
  let cfg={...DEFAULT_SYSTEM_PROMPT}
  let ready:()=>boolean=()=>false
  const fiber=ctx.plugin((c:Context)=>{ready=registerSystemPrompt(c,()=>store,()=>cfg)})
  await fiber;assert.equal(ready(),false);assert.equal(sections.length,0)
  cfg={...cfg,enabled:true};ctx.emit('settings/document-updated','test',1)
  assert.equal(ready(),true);assert.equal(sections.length,1);assert.equal(sections[0].order,9000)
  cfg={...cfg,order:9100};ctx.emit('settings/document-updated','test',2)
  assert.equal(sections.length,1);assert.equal(sections[0].order,9100);assert.equal(vars.size,1)
  cfg={...cfg,enabled:false};ctx.emit('settings/document-updated','test',3)
  assert.equal(ready(),false);assert.equal(sections.length,0);assert.equal(vars.size,0)
  await fiber.dispose()
})

test('v12 new records default off; global transitions and edits cannot bypass confirmation', t => {
  const store = memory(t)
  const row = store.create({ name:'global',content:'old' })
  assert.equal(row.system_prompt,false)
  assert.throws(() => store.update(row.id,{system_prompt:true}),ConfirmGlobalError)
  assert.equal(store.get(row.id)?.system_prompt,false)
  store.update(row.id,{system_prompt:true,confirm_global:true})
  for(const patch of [{content:'new'},{name:'new'},{system_prompt:false},{category:null,position:1}]) assert.throws(() => store.update(row.id,patch),ConfirmGlobalError)
  assert.throws(() => store.delete(row.id),ConfirmGlobalError)
  assert.equal(store.delete(row.id,true),true)
})

test('session opt-in needs no confirmation; promotion always resets off; lessons reject individual opt-in', t => {
  const store=memory(t)
  const row=store.create({name:'private',content:'text',scope:'session',session_id:'a'})
  assert.equal(store.update(row.id,{system_prompt:true})?.system_prompt,true)
  assert.equal(store.makeGlobal(row.id)?.system_prompt,false)
  const l=lesson(store,'找',2,3)
  assert.throws(()=>store.update(l.id,{system_prompt:true}),/lessonDepth/)
  assert.throws(()=>store.update(row.id,{system_prompt:'true' as never}),/boolean/)
})

test('per-class depth selects tagged right majority, ignores untagged and unapproved types',t=>{
  const store=memory(t)
  lesson(store,'收',2,3); lesson(store,'放',4,4); lesson(store,'找',0,3);lesson(store,'custom',3,2)
  assert.deepEqual(selectPromptLessons(store,'a',0),[])
  const chosen=selectPromptLessons(store,'a',5)
  assert.equal(chosen.filter(i=>i.type==='收'&&i.outcome==='right').length,2)
  assert.equal(chosen.filter(i=>i.type==='收'&&i.outcome==='wrong').length,1)
  assert.equal(chosen.some(i=>i.type==='找'||i.type==='custom'||i.content==='legacy untagged'),false)
  const three=selectPromptLessons(store,'a',3).filter(i=>i.type==='放')
  assert.equal(three.length,3);assert.equal(three.every(i=>i.outcome==='right'),true)
  const one=selectPromptLessons(store,'a',1)
  assert.equal(one.every(i=>i.outcome==='right'),true)
  store.lessons.proposeType('a','custom','synthetic');store.lessons.decideType('a','custom',true)
  assert.equal(selectPromptLessons(store,'a',5).some(i=>i.type==='custom'),true)
})

test('provider defaults off, isolates sessions, refreshes same-second writes and preserves literal unknown placeholders',t=>{
  const store=memory(t); let enabled=false
  const global=store.create({name:'g',content:'global {{session}} {{unknown}}'})
  store.update(global.id,{system_prompt:true,confirm_global:true})
  const own=store.create({name:'own',content:'only a',scope:'session',session_id:'a'})
  store.update(own.id,{system_prompt:true})
  const cfg=()=>({...DEFAULT_SYSTEM_PROMPT,enabled})
  const provider=createSystemPromptProvider(()=>store,cfg)
  assert.equal(provider('a'),'');enabled=true
  assert.match(provider('a'),/global a {{unknown}}/);assert.match(provider('a'),/only a/)
  assert.doesNotMatch(provider('b'),/only a/);assert.equal(provider(undefined),'')
  store.update(own.id,{content:'new immediately'})
  assert.match(provider('a'),/new immediately/);assert.doesNotMatch(provider('a'),/only a/)
})

test('another database connection invalidates cached templates and outcome changes', () => {
  const path=join(createTestDirectory('system-cache-'),'db.sqlite3')
  const first=new TemplateStore(path), second=new TemplateStore(path)
  try {
    const row=first.create({name:'cross',content:'old'})
    first.update(row.id,{system_prompt:true,confirm_global:true})
    const provider=createSystemPromptProvider(()=>first,()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true}))
    assert.match(provider('a'),/old/)
    second.update(row.id,{content:'cross connection',confirm_global:true})
    assert.match(provider('a'),/cross connection/);assert.doesNotMatch(provider('a'),/old/)
    second.update(row.id,{system_prompt:false,confirm_global:true})
    assert.equal(provider('a'),'')
  } finally {first.close();second.close()}
})

test('next-step preview uses the actual text path, expands variables at request time, and does not write',t=>{
  const store=memory(t),row=store.create({name:'preview',content:'at {{time}} {{session}} {{unknown}}'})
  store.update(row.id,{system_prompt:true,confirm_global:true})
  lesson(store,'找',2,3);lesson(store,'custom',1,1)
  let cfg={...DEFAULT_SYSTEM_PROMPT,enabled:true,lessonDepth:5}
  const provider=createSystemPromptProvider(()=>store,()=>cfg)
  const before=store.revision(),now=new Date(2026,10,27,9,15)
  const view=provider.preview('a',now)
  assert.equal(view.status,'ready');assert.equal(view.text,provider('a',now));assert.equal(view.chars,view.text.length)
  assert.match(view.text,/09:15 a {{unknown}}/)
  const finding=view.lessons.find(i=>i.type==='找')!
  assert.equal(finding.right,2);assert.equal(finding.wrong,3);assert.equal(finding.untagged,1)
  assert.equal(finding.included_right,2);assert.equal(finding.included_wrong,1)
  assert.ok(finding.reasons.includes('balance-limit'));assert.ok(finding.reasons.includes('untagged'))
  assert.ok(view.lessons.find(i=>i.type==='custom')!.reasons.includes('unapproved-type'))
  assert.equal(provider.preview('b',now).lessons.some(i=>i.type==='custom'),false)
  assert.equal(store.revision(),before)
  cfg={...cfg,enabled:false};const disabled=provider.preview('a',now)
  assert.equal(disabled.text,'');assert.equal(disabled.chars,0);assert.equal(disabled.status,'disabled')
  assert.ok(disabled.lessons.find(i=>i.type==='找')!.reasons.includes('master-off'))
  cfg={...cfg,enabled:true,lessonDepth:0};const zero=provider.preview('a',now)
  assert.ok(zero.lessons.find(i=>i.type==='找')!.reasons.includes('depth-zero'))
})

test('preview explains budget removal and preserves strict majority after rendering',t=>{
  const store=memory(t);lesson(store,'找',2,3)
  const row=store.create({name:'long',content:'long'.repeat(1000)})
  store.update(row.id,{system_prompt:true,confirm_global:true})
  const p=createSystemPromptProvider(()=>store,()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true,lessonDepth:5,maxChars:500}))
  const v=p.preview('a',new Date(0));assert.equal(v.text,p('a',new Date(0)))
  assert.ok(v.chars<=500);assert.equal(v.budget_applied,true)
  assert.ok(v.lessons.find(i=>i.type==='找')!.reasons.includes('budget'))
  for(const summary of v.lessons)assert.ok(summary.included_right===0?summary.included_wrong===0:summary.included_right>summary.included_wrong)
})

test('preview reports read failures without empty-success claims or leaking exception text',t=>{
  const store=memory(t),p=createSystemPromptProvider(()=>{throw Error('secret diagnostic path')},()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true}))
  const result=p.preview('a',new Date(0))
  assert.equal(result.status,'unavailable');assert.equal(result.text,'');assert.equal(result.error_code,'read-failed')
  assert.equal(JSON.stringify(result).includes('secret diagnostic path'),false)
})

test('preview distinguishes no-right, depth exclusion and absent types',t=>{
  const store=memory(t);lesson(store,'收',0,3);lesson(store,'放',4,4)
  const p=createSystemPromptProvider(()=>store,()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true,lessonDepth:3}))
  const v=p.preview('a');assert.equal(v.lessons.find(l=>l.type==='收')!.included_right,0)
  assert.ok(v.lessons.find(l=>l.type==='收')!.reasons.includes('no-right'))
  const depthReasons=v.lessons.find(l=>l.type==='放')!.reasons
  assert.ok(depthReasons.includes('depth-limit'))
  assert.equal(depthReasons.length,new Set(depthReasons).size,'a diagnostic reason is displayed only once per class')
  assert.ok(v.lessons.find(l=>l.type==='找')!.reasons.includes('no-lessons'))
  assert.deepEqual(v.lessons.map(l=>l.type),['收','放','找','落','验','记','续'])
})

test('read failure always returns a string without making model assembly fail',()=>{
  const error=console.error;console.error=()=>{}
  try { assert.equal(createSystemPromptProvider(()=>{throw Error('test read failed')},()=>({...DEFAULT_SYSTEM_PROMPT,enabled:true}))('a'),'') } finally {console.error=error}
})

test('hard budget counts header, labels and truncation; lessons never end at equal majority',()=>{
  const items:PromptLesson[]=[
    {type:'找',content:'r'.repeat(160),outcome:'right',current:true,at:'3'},
    {type:'找',content:'r'.repeat(160),outcome:'right',current:false,at:'2'},
    {type:'找',content:'w'.repeat(160),outcome:'wrong',current:false,at:'1'},
  ]
  const text=renderSystemPrompt([{name:'long',content:'t'.repeat(3000)}],items,500)
  assert.ok(text.length<=500);assert.match(text,/已截断/)
  assert.doesNotMatch(text,/做错/)
  for(let n=100;n<900;n++){
    const result=renderSystemPrompt([],items,n)
    const right=(result.match(/做对/g)||[]).length,wrong=(result.match(/做错/g)||[]).length
    assert.ok(result.length<=n);assert.ok(right===0?wrong===0:right>wrong)
  }
})
