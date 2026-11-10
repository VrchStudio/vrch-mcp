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

export {decodePreviewObservation,observePreview} from './observe.mjs';
