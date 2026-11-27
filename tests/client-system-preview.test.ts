import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React from 'react'
import { getSystemPromptPreview } from '../src/client/api.ts'
import type { SystemPromptPreview } from '../src/types.ts'
import { en, zh } from '../src/client/locales.ts'
register('./dsh-contract-loader.mjs', import.meta.url)
const { SystemPreview } = await import('../src/client/SystemPreview.tsx')
const sample = (session_id: string): SystemPromptPreview => ({session_id,captured_at:'2026-11-27T00:00:00Z',status:'ready',enabled:true,lesson_depth:1,max_chars:4000,order:9000,text:'safe',chars:4,budget_applied:false,templates:1,lessons:[]})
function elements(node:unknown): React.ReactElement<any>[] {
  if(Array.isArray(node))return node.flatMap(elements)
  if(!React.isValidElement(node))return []
  const e=node as React.ReactElement<any>;return[e,...elements(e.props.children)]
}

test('preview client only uses GET/no-store and refuses another session response', async t => {
  const calls:any[]=[];let result:any={preview:sample('session /a')}
  t.mock.method(globalThis,'fetch',async(url:unknown,options:unknown)=>{calls.push({url,options});return new Response(JSON.stringify(result),{status:200})})
  assert.deepEqual(await getSystemPromptPreview('session /a'),result.preview)
  assert.deepEqual(calls,[{url:'/plugins/dsh-prompt-templates/system-preview?session_id=session%20%2Fa',options:{cache:'no-store'}}])
  result={preview:sample('b')};assert.equal(await getSystemPromptPreview('a'),null)
  result={preview:{...sample('a'),chars:3}};assert.equal(await getSystemPromptPreview('a'),null)
})

test('preview ignores stale replies after session switch and close; refresh clears old snapshot', async t=>{
  const dispatcher=(React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const before=dispatcher.current,slots:unknown[]=[];let index=0,previousDeps:unknown[]|undefined,cleanup:(()=>void)|undefined,effect:(()=>void|(()=>void))|undefined
  dispatcher.current={useState(initial:unknown){const key=index++;if(!(key in slots))slots[key]=initial;return[slots[key],(value:any)=>{slots[key]=typeof value==='function'?value(slots[key]):value}]},useEffect(fn:()=>void|(()=>void),deps:unknown[]){if(!previousDeps||deps.some((v,i)=>v!==previousDeps![i])){cleanup?.();previousDeps=deps;effect=fn}}}
  t.after(()=>{cleanup?.();dispatcher.current=before})
  const pending:Array<{id:string;resolve:(v:SystemPromptPreview|null)=>void}>=[]
  const load=(id:string)=>new Promise<SystemPromptPreview|null>(resolve=>pending.push({id,resolve}))
  const render=(sessionId:string)=>{index=0;const tree=SystemPreview({sessionId,load,t:k=>en[k]});if(effect){const fn=effect;effect=undefined;cleanup=fn()||undefined}return tree}
  render('a');render('b');assert.deepEqual(pending.map(p=>p.id),['a','b'])
  pending[0]!.resolve(sample('a'));await Promise.resolve();assert.equal(elements(render('b')).some(e=>e.type==='textarea'),false)
  pending[1]!.resolve(sample('b'));await Promise.resolve();let tree=render('b')
  const field=elements(tree).find(e=>e.type==='textarea')!;assert.equal(field.props.value,'safe');assert.equal(field.props.readOnly,true)
  elements(tree).find(e=>e.type==='button')!.props.onClick();render('b');tree=render('b')
  assert.equal(elements(tree).some(e=>e.type==='textarea'),false)
  cleanup?.();cleanup=undefined;pending[2]!.resolve(sample('b'));await Promise.resolve()
  assert.equal(elements(render('b')).some(e=>e.type==='textarea'),false)
})

test('preview locales have matching keys and no raw decision codes are displayed',()=>{
  assert.deepEqual(Object.keys(zh).sort(),Object.keys(en).sort())
  for(const key of Object.keys(zh).filter(k=>k.includes('preview')||k.includes('reason')) as Array<keyof typeof zh>)assert.ok(zh[key]&&en[key])
})
