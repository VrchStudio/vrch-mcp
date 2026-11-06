// Isolated one-frame readback. The approved device owns the binding and authorization.
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
const fail=code=>Object.assign(Error(code),{code});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const content=value=>[{type:'text',text:JSON.stringify(value)}];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const previewTools=[
  {name:'apps_publish_preview',description:'Publish the exact draft revision to the current web Preview only. Never saves or updates the device. Read apps_state for its actual appliedRevision or failure; do not fall back to apps_publish.',
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},
    inputSchema:{type:'object',properties:{workspaceId:{type:'string'},expectedRevision:{type:'string'},operationId:{type:'string'}},required:['workspaceId','expectedRevision','operationId'],additionalProperties:false}},
  {name:'apps_preview_snapshot',description:'Read one native PNG from the shared 2D web Preview. The person must choose 2D and Share Preview in the maker. Requires the current active instance and AI control. Does not capture a device desktop.',
    annotations:{readOnlyHint:true},
    inputSchema:{type:'object',properties:{workspaceId:{type:'string'},instanceId:{type:'string'},generation:{type:'integer'},expectedRevision:{type:'string'}},required:['workspaceId','instanceId','generation','expectedRevision'],additionalProperties:false}}
];
export async function capturePreview(entry,values,directory){
  if(entry.snapshotPending)throw fail('capture_busy');
  entry.snapshotPending=true;entry.requests++;let ticket,dir;
  try {
    const {workspaceId,instanceId,generation,expectedRevision}=values;
    if(!uuid(instanceId)||!Number.isSafeInteger(generation)||generation<1||!uuid(workspaceId)||!/^[a-f0-9]{64}$/.test(expectedRevision||''))throw fail('invalid_preview_binding');
    ({ticket}=await entry.appRequest('preview_capture_begin',{instanceId,generation},{workspaceId,expectedRevision}));
    const deadline=Date.now()+15000;
    let meta;
    while(Date.now()<deadline){const status=await entry.appRequest('preview_capture_read',{ticket});
      if(status.phase==='failed')throw fail(status.code);
      if(status.phase==='ready'){meta=status.metadata;break;}
      await new Promise(r=>setTimeout(r,150));
    }
    if(!meta)throw fail('capture_timeout');
    if(meta.source!=='web-preview'||meta.instanceId!==instanceId||meta.generation!==generation||meta.revision!==expectedRevision||meta.workspaceId!==workspaceId||!Number.isSafeInteger(meta.size)||meta.size<24||meta.size>1024*1024)throw fail('invalid_snapshot');
    dir=await mkdtemp(join(directory,'workspace-transfers','preview-'));const path=join(dir,'frame.png');
    try {await entry.downloadPreview(path,ticket);} catch(error){
      if(!['transfer_conflict','unsupported_purpose'].includes(error.code))await entry.call('tools/call',{name:'file_cancel',arguments:{}}).catch(()=>{});
      throw error;
    }
    const bytes=await readFile(path);if(bytes.length!==meta.size||digest(bytes)!==meta.sha256)throw fail('hash_mismatch');
    const final=await entry.appRequest('preview_capture_read',{ticket});
    if(final.phase!=='ready'||final.metadata?.sha256!==meta.sha256)throw fail('capture_changed');
    await entry.appRequest('preview_capture_release',{ticket});ticket=null;
    return {content:[...content(meta),{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]};
  } catch(error){return {isError:true,content:[{type:'text',text:(error.code||'capture_failed')+': '+(error.code==='capture_not_shared'?'Ask the person to enable Share Preview in the 2D maker.':error.message)}]};}
  finally {if(ticket)await entry.appRequest('preview_capture_release',{ticket}).catch(()=>{});if(dir)await rm(dir,{recursive:true,force:true});entry.requests--;entry.snapshotPending=false;}
}


// Structured observation from the existing maker connection, never device pixels.
export function decodePreviewObservation(bytes,metadata,values){
  if(bytes.length>6*1024*1024)throw fail('observe_too_large');
  let payload;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw fail('observe_invalid');}
  const {result,images}=payload||{},binding=result?.binding;
  if(result?.kind!=='in_frame_observation'||result.fullScreenshot!==false||!binding||binding.mode!=='preview'||
      binding.instanceId!==values.instanceId||binding.generation!==values.generation||binding.revision!==values.expectedRevision||binding.appId!==metadata.appId||
      !Array.isArray(result.dom?.nodes)||result.dom.nodes.length>800||!Array.isArray(result.canvases)||result.canvases.length>4||!Array.isArray(images)||images.length>4)throw fail('observe_invalid');
  for(const image of images){
    if(image?.type!=='image'||image.mimeType!=='image/png'||typeof image.data!=='string'||image.data.length>1398104)throw fail('observe_invalid');
    const png=Buffer.from(image.data,'base64');
    if(png.toString('base64')!==image.data||png.length<24||png.length>1024*1024||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.subarray(12,16).toString()!=='IHDR'||!png.readUInt32BE(16)||!png.readUInt32BE(20)||png.readUInt32BE(16)>1024||png.readUInt32BE(20)>1024)throw fail('observe_invalid');
  }
  for(const canvas of result.canvases)if(canvas.image!==null&&(canvas.image?.source!=='canvas-pixels'||!Number.isInteger(canvas.image.contentIndex)||canvas.image.contentIndex<1||canvas.image.contentIndex>images.length))throw fail('observe_invalid');
  return {result,images};
}
export async function observePreview(entry,values,directory){
  if(entry.snapshotPending)throw fail('capture_busy');
  entry.snapshotPending=true;entry.requests++;let ticket,dir;
  try{
    const {workspaceId,instanceId,generation,expectedRevision,maxSide=512}=values;
    if(!uuid(instanceId)||!Number.isSafeInteger(generation)||generation<1||!uuid(workspaceId)||!/^[a-f0-9]{64}$/.test(expectedRevision||'')||!Number.isInteger(maxSide)||maxSide<1||maxSide>1024)throw fail('invalid_preview_binding');
    ({ticket}=await entry.appRequest('preview_observe_begin',{instanceId,generation,maxSide},{workspaceId,expectedRevision}));
    const deadline=Date.now()+20000;let metadata;
    while(Date.now()<deadline){const status=await entry.appRequest('preview_observe_read',{ticket});
      if(status.phase==='failed')throw fail(status.code);
      if(status.phase==='ready'){metadata={...status.metadata,...status.metadata?.binding};break;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!metadata)throw fail('observe_timeout');
    if(metadata.source!=='web-preview-observation'||metadata.instanceId!==instanceId||metadata.generation!==generation||metadata.revision!==expectedRevision||metadata.workspaceId!==workspaceId||!Number.isSafeInteger(metadata.size)||metadata.size<2||metadata.size>6*1024*1024)throw fail('observe_invalid');
    dir=await mkdtemp(join(directory,'workspace-transfers','observation-'));const path=join(dir,'observation.json');
    try{await entry.downloadObservation(path,ticket);}catch(error){if(!['transfer_conflict','unsupported_purpose'].includes(error.code))await entry.call('tools/call',{name:'file_cancel',arguments:{}}).catch(()=>{});throw error;}
    const bytes=await readFile(path);if(bytes.length!==metadata.size||digest(bytes)!==metadata.sha256)throw fail('hash_mismatch');
    const {result,images}=decodePreviewObservation(bytes,metadata,values),final=await entry.appRequest('preview_observe_read',{ticket});
    if(final.phase!=='ready'||final.metadata?.sha256!==metadata.sha256)throw fail('capture_changed');
    await entry.appRequest('preview_observe_release',{ticket});ticket=null;
    return {content:[...content(result),...images],structuredContent:result};
  }catch(error){return {isError:true,content:content({code:error.code||'observe_failed',message:error.message})};}
  finally{if(ticket)await entry.appRequest('preview_observe_release',{ticket}).catch(()=>{});if(dir)await rm(dir,{recursive:true,force:true});entry.requests--;entry.snapshotPending=false;}
}
