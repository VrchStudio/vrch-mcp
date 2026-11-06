import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {decodePreviewObservation,observePreview} from '../src/remote-preview.mjs';
const values={workspaceId:'11111111-1111-4111-8111-111111111111',instanceId:'22222222-2222-4222-8222-222222222222',generation:1,expectedRevision:'a'.repeat(64)};
const appId='33333333-3333-4333-8333-333333333333';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYoQAAAAASUVORK5CYII=';
const fixture=()=>({result:{kind:'in_frame_observation',fullScreenshot:false,binding:{instanceId:values.instanceId,generation:1,revision:values.expectedRevision,appId,mode:'preview'},dom:{source:'live-dom',nodes:[{tag:'output',name:'4'}]},canvases:[{image:{source:'canvas-pixels',contentIndex:1}}]},images:[{type:'image',mimeType:'image/png',data:png}]});
const bytes=value=>Buffer.from(JSON.stringify(value));
test('observation returns distinct real Canvas layers and rejects stale or misleading results',()=>{
 const value=fixture();assert.equal(decodePreviewObservation(bytes(value),{appId},values).result.dom.nodes[0].name,'4');
 for(const change of [p=>p.result.fullScreenshot=true,p=>p.result.binding.mode='device',p=>p.result.binding.generation++,p=>p.images[0].mimeType='text/html',p=>p.images[0].data='invalid',p=>p.result.canvases[0].image.contentIndex=2,p=>p.result.dom.nodes=Array(801).fill({})]){const p=fixture();change(p);assert.throws(()=>decodePreviewObservation(bytes(p),{appId},values),e=>e.code==='observe_invalid');}
});
test('observation keeps exact file bytes, rechecks access after download and removes transient payloads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vrch-observe-'));await mkdir(join(root,'workspace-transfers'));const payload=bytes(fixture()),hash=createHash('sha256').update(payload).digest('hex');
 let deny=false,reads=0,releases=0;
 const entry={requests:0,appRequest:async(action)=>{if(action==='preview_observe_begin')return {ticket:'fixture-ticket'};if(action==='preview_observe_release'){releases++;return {};}
  if(action==='preview_observe_read'){reads++;if(deny&&reads%2===0)throw Object.assign(Error('Access revoked'),{code:'unauthorized'});return {phase:'ready',metadata:{...values,revision:values.expectedRevision,appId,source:'web-preview-observation',size:payload.length,sha256:hash}};}throw Error(action);},downloadObservation:async path=>writeFile(path,payload)};
 try{const result=await observePreview(entry,values,root);assert.equal(result.isError,undefined);assert.equal(result.content[1].data,png);assert.equal(entry.requests,0);assert.equal(releases,1);assert.deepEqual(await readdir(join(root,'workspace-transfers')),[]);
  deny=true;const refused=await observePreview(entry,values,root);assert.equal(refused.isError,true);assert.equal(refused.content.some(i=>i.type==='image'),false);assert.equal(JSON.parse(refused.content[0].text).code,'unauthorized');assert.equal(releases,2);assert.equal(entry.snapshotPending,false);assert.deepEqual(await readdir(join(root,'workspace-transfers')),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
