// Structured observation of one exact App instance, shared by the hosted bridge and the local server.
import {createHash as observeHash} from 'node:crypto';
import * as observeFiles from 'node:fs/promises';
import * as observePath from 'node:path';
const observeFail=code=>Object.assign(Error(code),{code});
const observeUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const observeContent=value=>[{type:'text',text:JSON.stringify(value)}];
const observeDigest=bytes=>observeHash('sha256').update(bytes).digest('hex');
// In-frame observation is distinct from a native page or device screenshot.
export const observationTool = {
  name: 'apps_observe',
  description: 'Observe one exact active App instance without screen sharing: the web Preview or browser Simulator (target preview, the default), or the App running on the device and its output picture on a second screen (target device; bindings from apps_input_targets, no workspaceId). Returns derived DOM/layout, readable Canvas pixel layers and App-reported logs (the App’s console output), so an App can report numbers it measures. Canvas images are separate layers, not a full screenshot; CSS/SVG rendering and missing/tainted layers are not inferred. Requires this connection’s current AI approval, control and the exact binding. Does not capture the device desktop or another tab; use take_screenshot for device pixels.',
  annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:true},
  inputSchema: {type:'object', properties:{target:{type:'string',enum:['preview','device']},workspaceId:{type:'string'},instanceId:{type:'string'},generation:{type:'integer',minimum:1},expectedRevision:{type:'string'},maxSide:{type:'integer',minimum:1,maximum:1024}}, required:['instanceId','generation','expectedRevision'], additionalProperties:false}
};
// Structured observation of one exact App instance: the maker Preview through the maker's existing connection, or the
// App running on the device (and its output picture) through the device's own My Apps window. Never a screenshot.
const observedMode=values=>values.target==='device'?'device':'preview';
export function decodePreviewObservation(bytes,metadata,values){
  if(bytes.length>6*1024*1024)throw observeFail('observe_too_large');
  let payload;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw observeFail('observe_invalid');}
  const {result,images}=payload||{},binding=result?.binding;
  if(result?.kind!=='in_frame_observation'||result.fullScreenshot!==false||!binding||binding.mode!==observedMode(values)||
      binding.instanceId!==values.instanceId||binding.generation!==values.generation||binding.revision!==values.expectedRevision||binding.appId!==metadata.appId||
      !Array.isArray(result.dom?.nodes)||result.dom.nodes.length>800||!Array.isArray(result.canvases)||result.canvases.length>4||!Array.isArray(images)||images.length>4)throw observeFail('observe_invalid');
  for(const image of images){
    if(image?.type!=='image'||image.mimeType!=='image/png'||typeof image.data!=='string'||image.data.length>1398104)throw observeFail('observe_invalid');
    const png=Buffer.from(image.data,'base64');
    if(png.toString('base64')!==image.data||png.length<24||png.length>1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.subarray(12,16).toString()!=='IHDR'||!png.readUInt32BE(16)||!png.readUInt32BE(20)||png.readUInt32BE(16)>1024||png.readUInt32BE(20)>1024)throw observeFail('observe_invalid');
  }
  for(const canvas of result.canvases)if(canvas.image!==null&&(canvas.image?.source!=='canvas-pixels'||!Number.isInteger(canvas.image.contentIndex)||canvas.image.contentIndex<1||canvas.image.contentIndex>images.length))throw observeFail('observe_invalid');
  return {result,images};
}
export async function observePreview(entry,values,directory){
  if(entry.snapshotPending)throw observeFail('capture_busy');
  entry.snapshotPending=true;entry.requests++;let ticket,dir;
  try{
    const {workspaceId,instanceId,generation,expectedRevision,maxSide=512,target='preview'}=values,device=target==='device';
    if(!['preview','device'].includes(target)||!observeUUID(instanceId)||!Number.isSafeInteger(generation)||generation<1||(!device&&!observeUUID(workspaceId))||!/^[a-f0-9]{64}$/.test(expectedRevision||'')||!Number.isInteger(maxSide)||maxSide<1||maxSide>1024)throw observeFail('invalid_preview_binding');
    ({ticket}=device?await entry.appRequest('device_observe_begin',{instanceId,generation,maxSide},{expectedRevision})
      :await entry.appRequest('preview_observe_begin',{instanceId,generation,maxSide},{workspaceId,expectedRevision}));
    const deadline=Date.now()+20000;let metadata;
    while(Date.now()<deadline){const status=await entry.appRequest('preview_observe_read',{ticket});
      if(status.phase==='failed')throw observeFail(status.code);
      if(status.phase==='ready'){metadata={...status.metadata,...status.metadata?.binding};break;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!metadata)throw observeFail('observe_timeout');
    if(metadata.source!==(device?'device-app-observation':'web-preview-observation')||metadata.instanceId!==instanceId||metadata.generation!==generation||metadata.revision!==expectedRevision||(!device&&metadata.workspaceId!==workspaceId)||!Number.isSafeInteger(metadata.size)||metadata.size<2||metadata.size>6*1024*1024)throw observeFail('observe_invalid');
    await observeFiles.mkdir(observePath.join(directory,'workspace-transfers'),{recursive:true,mode:0o700});
    dir=await observeFiles.mkdtemp(observePath.join(directory,'workspace-transfers','observation-'));const path=observePath.join(dir,'observation.json');
    try{await entry.downloadObservation(path,ticket);}catch(error){if(!['transfer_conflict','unsupported_purpose'].includes(error.code))await entry.call('tools/call',{name:'file_cancel',arguments:{}}).catch(()=>{});throw error;}
    const bytes=await observeFiles.readFile(path);if(bytes.length!==metadata.size||observeDigest(bytes)!==metadata.sha256)throw observeFail('hash_mismatch');
    const {result,images}=decodePreviewObservation(bytes,metadata,values),final=await entry.appRequest('preview_observe_read',{ticket});
    if(final.phase!=='ready'||final.metadata?.sha256!==metadata.sha256)throw observeFail('capture_changed');
    await entry.appRequest('preview_observe_release',{ticket});ticket=null;
    // On the device, role says which instance was read: the App ('control') or its output picture ('output').
    const observed=device?{...result,target:'device',role:metadata.role==='output'?'output':'control'}:result;
    return {content:[...observeContent(observed),...images],structuredContent:observed};
  }catch(error){return {isError:true,content:observeContent({code:error.code||'observe_failed',message:error.message})};}
  finally{if(ticket)await entry.appRequest('preview_observe_release',{ticket}).catch(()=>{});if(dir)await observeFiles.rm(dir,{recursive:true,force:true});entry.requests--;entry.snapshotPending=false;}
}
