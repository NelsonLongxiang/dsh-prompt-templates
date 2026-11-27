import test from 'node:test'
import assert from 'node:assert/strict'
import {register} from 'node:module'
import React from 'react'
import {getWorkshopSyncStatus} from '../src/client/api.ts'
import {en,zh} from '../src/client/locales.ts'
register('./dsh-contract-loader.mjs',import.meta.url)
const {WorkshopSync}=await import('../src/client/WorkshopSync.tsx')
function elements(n:unknown):React.ReactElement<any>[]{if(Array.isArray(n))return n.flatMap(elements);if(!React.isValidElement(n))return[];const e=n as React.ReactElement<any>;return[e,...elements(e.props.children)]}
test('workshop observation API uses only read-only no-store GET and surfaces unavailable',async t=>{
 const calls:any[]=[];t.mock.method(globalThis,'fetch',async(url:unknown,options:unknown)=>{calls.push({url,options});return new Response(JSON.stringify({enabled:false,running:false,last:null}),{status:200})})
 assert.deepEqual(await getWorkshopSyncStatus(),{enabled:false,running:false,last:null})
 assert.deepEqual(calls,[{url:'/plugins/dsh-prompt-templates/workshop-sync',options:{cache:'no-store'}}])
})
test('workshop panel has observation only, cancels reads on close, localizes status in both languages',async t=>{
 const d=(React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,before=d.current,slots:any[]=[];let i=0,cleanup:(()=>void)|undefined,effect:(()=>void|(()=>void))|undefined
 d.current={useState(init:any){const k=i++;if(!(k in slots))slots[k]=init;return[slots[k],(v:any)=>slots[k]=typeof v==='function'?v(slots[k]):v]},useEffect(fn:any){effect??=fn}}
 const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;globalThis.setInterval=(()=>({})) as any;globalThis.clearInterval=(()=>{}) as any
 t.after(()=>{cleanup?.();d.current=before;globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear})
 let resolve!:(v:any)=>void;const load=()=>new Promise<any>(r=>resolve=r)
 const render=()=>{i=0;const tree=WorkshopSync({load,t:k=>zh[k]});if(effect&&!cleanup){cleanup=effect()||undefined}return tree}
 render();resolve({enabled:false,running:false,last:null});await Promise.resolve();const tree=render()
 assert.equal(elements(tree).some(e=>e.type==='input'||e.type==='select'||e.type==='textarea'),false)
 assert.equal(elements(tree).filter(e=>e.type==='button').length,1,'refresh is the only action; no run-now or enable control')
 assert.ok(JSON.stringify(tree).includes(zh['panel.syncDisabled']))
 cleanup?.();cleanup=undefined
 for(const k of Object.keys(zh).filter(k=>k.startsWith('panel.sync')) as Array<keyof typeof zh>)assert.ok(en[k]&&zh[k])
})
