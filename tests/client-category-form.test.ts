import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React from 'react'
import type { ReactElement } from 'react'
import type { CategoryView } from '../src/types.ts'
import type { TemplateLibraryFace } from '../src/client/slots.ts'
import { createLibrarySelection } from '../src/client/library-state.ts'
register('./dsh-contract-loader.mjs', import.meta.url)
const { TemplateLibrary } = await import('../src/client/Library.tsx')
type Element = ReactElement<Record<string, any>>
function elements(node: unknown): Element[] {
  if(Array.isArray(node)) return node.flatMap(elements)
  if(!React.isValidElement(node)) return []
  const e=node as Element;return [e,...elements(e.props.children)]
}
function renderer(t: {after: (fn:()=>void)=>void}) {
  const dispatcher=(React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const previous=dispatcher.current;let state:unknown[]=[],index=0
  dispatcher.current={
    useState(initial:unknown){const k=index++,target=state;if(!(k in target))target[k]=typeof initial==='function'?(initial as ()=>unknown)():initial;return[target[k],(v:unknown)=>{target[k]=typeof v==='function'?(v as (old:unknown)=>unknown)(target[k]):v}]},
    useRef(initial:unknown){const k=index++;if(!(k in state))state[k]={current:initial};return state[k]},
    useEffect(){},useCallback(cb:unknown){return cb},useSyncExternalStore(_s:unknown,get:()=>unknown){return get()},
  }
  t.after(()=>{dispatcher.current=previous})
  return (fn:()=>unknown,slots:unknown[])=>{state=slots;index=0;return fn()}
}
function libraryFace(createCategory: TemplateLibraryFace['createCategory']):TemplateLibraryFace {
  const noop=async()=>({ok:true as const,value:null})
  return{librarySelection:createLibrarySelection(),refresh:async()=>[],refreshCategories:async()=>[],createCategory,removeCategory:noop,create:noop,update:noop,remove:noop,makeGlobal:noop,insert(){},send(){},interject(){},injectStatus:async()=>null,injectionHistory:async()=>[],eventPolicies:async()=>({enabled:false,items:[]}),setEventMaster:noop,updateEventPolicy:noop,eventEpisodes:async()=>[]}
}

for(const scope of ['global','session'] as const)test(scope+' category success selects the created category and cancel never writes',async t=>{
  const render=renderer(t),slots:unknown[]=[],requests:CategoryView[]=[],face=libraryFace(async request=>{requests.push(request);return{ok:true,value:{category:request}}})
  face.refreshCategories=async()=>[...requests]
  const library=()=>TemplateLibrary({sessionId:'a',face,t:key=>key})
  let tree=render(library,slots)
  const add=elements(tree).find(e=>e.props['aria-label']==='panel.newCategory');assert.ok(add);add.props.onClick()
  tree=render(library,slots)
  const form=elements(tree).find(e=>typeof e.type==='function'&&e.type.name==='CategoryForm');assert.ok(form)
  const formSlots:unknown[]=[]
  const draw=()=>render(()=>(form.type as Function)(form.props),formSlots)
  let body=draw()
  const cancel=elements(body).find(e=>e.type==='button'&&e.props.children==='panel.addCancel');assert.ok(cancel,'category form must offer cancel')
  cancel.props.onClick();assert.equal(requests.length,0)
  assert.equal(elements(render(library,slots)).some(e=>typeof e.type==='function'&&e.type.name==='CategoryForm'),false)
  const input=elements(body).find(e=>e.type==='input')!;input.props.onChange({target:{value:'  新分类  '}})
  const select=elements(body).find(e=>e.type==='select')!;select.props.onChange({target:{value:scope}})
  body=draw();const save=elements(body).find(e=>e.type==='button'&&e.props.children==='panel.addSave')!;assert.equal(save.props.disabled,false)
  save.props.onClick();await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(requests,[{name:'新分类',scope,session_id:scope==='session'?'a':null}])
  assert.equal(face.librarySelection.tab('a'),'cat:'+scope+':新分类')
  assert.equal(elements(render(library,slots)).some(e=>e.type==='button'&&e.props.children==='新分类'),true)
})

test('category tabs show globals and only the attached session categories after reload', t => {
  const render=renderer(t),slots:unknown[]=[],face=libraryFace(async()=>({ok:true,value:null}))
  const library=(sessionId:string)=>TemplateLibrary({sessionId,face,t:key=>key})
  render(()=>library('a'),slots)
  slots[1]=[{name:'global category',scope:'global',session_id:null},{name:'private A',scope:'session',session_id:'a'},{name:'private B',scope:'session',session_id:'b'}]
  const labels=(sessionId:string)=>elements(render(()=>library(sessionId),slots)).filter(e=>e.type==='button').map(e=>e.props.children)
  assert.ok(labels('a').includes('private A'));assert.ok(!labels('a').includes('private B'))
  assert.ok(labels('b').includes('private B'));assert.ok(!labels('b').includes('private A'))
  assert.ok(labels('a').includes('global category'))
})

test('category form shows server errors, releases busy on rejection, and can cancel afterwards',async t=>{
  let reject=false
  const render=renderer(t),slots:unknown[]=[],face=libraryFace(async()=>{if(reject)throw Error('transport rejected');return{ok:false,error:{code:'conflict',message:'category exists'}}})
  const library=()=>TemplateLibrary({sessionId:'a',face,t:key=>key});let tree=render(library,slots)
  elements(tree).find(e=>e.props['aria-label']==='panel.newCategory')!.props.onClick();tree=render(library,slots)
  const form=elements(tree).find(e=>typeof e.type==='function'&&e.type.name==='CategoryForm')!,formSlots:unknown[]=[]
  const draw=()=>render(()=>(form.type as Function)(form.props),formSlots)
  let body=draw();elements(body).find(e=>e.type==='input')!.props.onChange({target:{value:'duplicate'}})
  elements(draw()).find(e=>e.props.children==='panel.addSave')!.props.onClick();await new Promise(resolve=>setImmediate(resolve))
  body=draw();assert.ok(elements(body).some(e=>e.props.role==='alert'&&e.props.children==='category exists'))
  reject=true
  elements(body).find(e=>e.props.children==='panel.addSave')!.props.onClick();await new Promise(resolve=>setImmediate(resolve))
  body=draw();assert.ok(elements(body).some(e=>e.props.role==='alert'&&String(e.props.children).includes('transport rejected')))
  assert.equal(elements(body).find(e=>e.props.children==='panel.addCancel')!.props.disabled,false)
  assert.equal(face.librarySelection.tab('a'),'global')
})
