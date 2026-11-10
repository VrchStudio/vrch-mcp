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
test('a device observation asks the device, needs no workspace and is never taken for a Preview one',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vrch-observe-'));
 const device=fixture();device.result.binding.mode='device';const payload=bytes(device),hash=createHash('sha256').update(payload).digest('hex');
 const asked=[],{workspaceId,...binding}=values;let source='device-app-observation',role='output';
 const entry={requests:0,appRequest:async(action,args,frame)=>{asked.push([action,frame]);if(action.endsWith('_begin'))return {ticket:'fixture-ticket'};if(action==='preview_observe_release')return {};
  return {phase:'ready',metadata:{role,source,size:payload.length,sha256:hash,binding:{...binding,revision:values.expectedRevision,appId,mode:'device'}}};},downloadObservation:async path=>writeFile(path,payload)};
 try{
  const result=await observePreview(entry,{...binding,target:'device'},root);
  assert.equal(result.isError,undefined,JSON.stringify(result.content[0]));assert.deepEqual(asked[0],['device_observe_begin',{expectedRevision:values.expectedRevision}]);
  assert.equal(result.structuredContent.target,'device');assert.equal(result.structuredContent.role,'output');assert.equal(result.structuredContent.binding.mode,'device');assert.equal(result.content[1].data,png);
  assert.deepEqual(await readdir(join(root,'workspace-transfers')),[],'the folder is made on demand and left empty');
  // The same document is refused as a Preview observation, and a Preview document as a device one.
  assert.equal(JSON.parse((await observePreview(entry,values,root)).content[0].text).code,'observe_invalid');
  source='web-preview-observation';assert.equal(JSON.parse((await observePreview(entry,{...binding,target:'device'},root)).content[0].text).code,'observe_invalid');
  assert.equal(JSON.parse((await observePreview(entry,{...binding,target:'screen'},root)).content[0].text).code,'invalid_preview_binding');
  // The output picture is asked for with the App's own binding; the device names the instance it reads.
  source='device-app-observation';
  const picture=fixture();picture.result.binding={...picture.result.binding,mode:'device',instanceId:'5b0c4f0e-6a3f-4d0e-9d55-0d3c1a0f7b21',generation:3};
  const body=bytes(picture),digest=createHash('sha256').update(body).digest('hex'),begun=[];let answer={ticket:'fixture-ticket',instanceId:picture.result.binding.instanceId,generation:3,role:'output'};
  const second={requests:0,appRequest:async(action,args)=>{if(action.endsWith('_begin')){begun.push(args);return answer;}if(action==='preview_observe_release')return {};
   return {phase:'ready',metadata:{role,source,size:body.length,sha256:digest,binding:{...picture.result.binding,revision:values.expectedRevision,appId}}};},downloadObservation:async path=>writeFile(path,body)};
  const seen=await observePreview(second,{...binding,target:'device',role:'output'},root);
  assert.equal(seen.isError,undefined,JSON.stringify(seen.content[0]));assert.equal(begun[0].role,'output');assert.equal(begun[0].instanceId,binding.instanceId);
  assert.equal(seen.structuredContent.role,'output');assert.equal(seen.structuredContent.binding.instanceId,picture.result.binding.instanceId);
  // A device that does not know the role would read the App itself: that is not passed off as its output.
  role='control';assert.equal(JSON.parse((await observePreview(second,{...binding,target:'device',role:'output'},root)).content[0].text).code,'observe_unavailable');
  assert.equal(JSON.parse((await observePreview(second,{...values,role:'output'},root)).content[0].text).code,'invalid_preview_binding','only the device has an output role');
  assert.equal(entry.snapshotPending,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
