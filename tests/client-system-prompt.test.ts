import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { TemplateView } from '../src/types.ts'
import { createLibrarySelection } from '../src/client/library-state.ts'
import type { TemplateLibraryFace } from '../src/client/slots.ts'
import { en, zh } from '../src/client/locales.ts'
import { planTemplateReorder } from '../src/client/reorder.ts'
register('./dsh-contract-loader.mjs', import.meta.url)
const { TemplateLibrary } = await import('../src/client/Library.tsx')
type Element = ReactElement<Record<string, any>>
function elements(node: unknown): Element[] {
  if(Array.isArray(node)) return node.flatMap(elements)
  if(!React.isValidElement(node))return []
  const e=node as Element;return [e,...elements(e.props.children)]
}

for (const scope of ['global','session'] as const) {
  test(scope+' system opt-in executes only after its required acknowledgement',async t=>{
    const template:TemplateView={id:'synthetic',name:'safe$&$1',content:'body',scope,session_id:scope==='session'?'a':null,description:null,position:0,category:null,inject_enabled:false,inject_every:null,mode:'inject',created_at:'2026',updated_at:'2026'}
    const dispatcher=(React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    const before=dispatcher.current,slots:unknown[]=[];let index=0
    dispatcher.current={
      useState(initial:unknown){const k=index++;if(!(k in slots))slots[k]=k===0?[template]:typeof initial==='function'?(initial as ()=>unknown)():initial;return [slots[k],(v:unknown)=>{slots[k]=typeof v==='function'?(v as (a:unknown)=>unknown)(slots[k]):v}]},
      useRef(initial:unknown){const k=index++;if(!(k in slots))slots[k]={current:initial};return slots[k]},
      useCallback(cb:unknown){return cb},useEffect(){},useSyncExternalStore(_s:unknown,read:()=>unknown){return read()},
    }
    t.after(()=>{dispatcher.current=before})
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({running:0,live:1}),{status:200}))
    const changes:unknown[]=[];const noop=async()=>({ok:true as const,value:null})
    const librarySelection=createLibrarySelection();librarySelection.select('a',scope)
    const face:TemplateLibraryFace={librarySelection,refresh:async()=>[template],refreshCategories:async()=>[],createCategory:noop,removeCategory:noop,create:noop,update:async(id,patch)=>{changes.push({id,patch});return noop()},remove:noop,makeGlobal:noop,insert(){},send(){},interject(){},injectStatus:async()=>null,injectionHistory:async()=>[],eventPolicies:async()=>({enabled:false,items:[]}),setEventMaster:noop,updateEventPolicy:noop,eventEpisodes:async()=>[]}
    const render=()=>{index=0;return TemplateLibrary({sessionId:'a',face,t:key=>en[key]})}
    let tree=render();const row=elements(tree).find(e=>typeof e.type==='function'&&e.type.name==='TemplateRow');assert.ok(row)
    row.props.onToggleSystem(template)
    await Promise.resolve()
    if(scope==='session'){
      assert.deepEqual(changes,[{id:'synthetic',patch:{system_prompt:true}}]);return
    }
    assert.deepEqual(changes,[])
    let risk=elements(render()).find(e=>typeof e.type==='function'&&e.type.name==='RiskConfirmation');assert.ok(risk)
    assert.ok(risk.props.title.includes('safe$&$1'));
    assert.equal(risk.props.acknowledged,false);risk.props.onConfirm();assert.deepEqual(changes,[])
    risk.props.onCancel();assert.equal(elements(render()).some(e=>typeof e.type==='function'&&e.type.name==='RiskConfirmation'),false)
    row.props.onToggleSystem(template);risk=elements(render()).find(e=>typeof e.type==='function'&&e.type.name==='RiskConfirmation');assert.ok(risk)
    risk.props.onAcknowledgedChange(true);risk=elements(render()).find(e=>typeof e.type==='function'&&e.type.name==='RiskConfirmation');risk!.props.onConfirm()
    await Promise.resolve();await Promise.resolve()
    assert.deepEqual(changes,[{id:'synthetic',patch:{system_prompt:true,confirm_global:true}}])
  })
}

test('reordering active globals is rejected before any write; ordinary plans remain complete', () => {
  const base = { content:'x',description:null,category:null,session_id:null,inject_enabled:false,inject_every:null,mode:'inject',created_at:'2026',updated_at:'2026',scope:'global' } as const
  const a = { ...base,id:'a',name:'A',position:0 }, b = { ...base,id:'b',name:'B',position:1,system_prompt:true }
  assert.deepEqual(planTemplateReorder([a,b],'a','b'),{blocked:true,changes:[]})
  assert.deepEqual(planTemplateReorder([a,{...b,system_prompt:false}],'a','b'),{blocked:false,changes:[{id:'b',position:0},{id:'a',position:1}]})
})

test('system risk copy is available in both dictionaries with matching placeholders',()=>{
  for(const key of Object.keys(zh).filter(key=>key.startsWith('panel.system')) as Array<keyof typeof zh>){
    assert.ok(en[key]);assert.deepEqual([...zh[key].matchAll(/{[a-z]+}/g)].map(m=>m[0]).sort(),[...en[key].matchAll(/{[a-z]+}/g)].map(m=>m[0]).sort())
  }
})
