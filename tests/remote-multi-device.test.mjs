import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {relay,until} from './helpers/relay.mjs';
import {createRegisteredTargetResolver} from '../remote/targets.mjs';
const [major,minor]=process.versions.node.split('.').map(Number),supported=major>22||major===22&&minor>=13;
const {createRemoteRouter}=supported?await import('../src/remote-router.mjs'):{};

test('one OAuth identity joins three independently approved registered devices without a server device list', {skip:!supported},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vrch-multi-device-')),devices=new Map(),references=[];
 let router;
 try{
  for(const suffix of ['a','b','c'])devices.set('appliance-'+suffix+'.example',{deviceId:'dvc_'+suffix.repeat(32),remote:await relay()});
  class LocalSocket extends WebSocket{
   constructor(url,options){const parsed=new URL(url),device=devices.get(parsed.hostname);assert(device);assert.equal(options.servername,parsed.hostname);assert.equal(options.rejectUnauthorized,true);super(new URL(device.remote.url).origin.replace('http:','ws:')+parsed.pathname);}
  }
  const resolveRegisteredTarget=createRegisteredTargetResolver({directoryURL:'http://127.0.0.1:18085/v1/public/server-directory',WebSocketImpl:LocalSocket,
   resolve:async()=>['104.21.10.20'],fetchImpl:async url=>{const host=url.searchParams.get('self_host'),device=devices.get(host);return Response.json(device?{data:{self:{device_uid:device.deviceId,hosts:[host]}}}:{},{status:device?200:404});}});
  router=await createRemoteRouter({filename:join(directory,'connections.sqlite'),credentialDirectory:join(directory,'credentials'),encryptionKey:randomBytes(32),resolveRegisteredTarget});
  const identity={issuer:'https://mcp.example',principal:'one-approved-client',oauthClientId:'https://claude.ai/oauth/mcp-oauth-client-metadata',pairedDeviceId:'dvc_'+'a'.repeat(32)};
  let sequence=0;
  const call=async(name,args)=> (await router.handle(identity,{jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}})).result;
  for(const [host,device] of devices){
   const result=await call('terminal_connect',{url:'https://'+host+'/apps/ai?invite=fixture',attemptId:randomUUID()}),ref=result.structuredContent.connectionRef;assert(ref);references.push(ref);
   await until(()=>device.remote.frames.some(frame=>frame.type==='ai_join'));
   assert.equal((await call('apps_state',{connectionRef:ref})).structuredContent.code,'approval_required');
   device.remote.approve();
   for(let i=0;i<100;i++){if((await call('terminal_events',{connectionRef:ref,waitSeconds:0})).structuredContent.phase==='ready')break;await new Promise(r=>setTimeout(r,10));}
   assert.equal((await call('apps_state',{connectionRef:ref})).structuredContent.phase,'succeeded');
  }
  assert.equal(new Set(references).size,3);
  await call('apps_publish',{connectionRef:references[2],workspaceId:'fixture-workspace',expectedRevision:'fixture-revision',operationId:randomUUID()});
  assert.deepEqual([...devices.values()].map(d=>d.remote.frames.filter(frame=>frame.action==='publish').length),[0,0,1]);
  await call('terminal_disconnect',{connectionRef:references[0]});
  assert.equal((await call('apps_state',{connectionRef:references[1]})).structuredContent.phase,'succeeded');
  assert.equal((await call('apps_state',{connectionRef:references[2]})).structuredContent.phase,'succeeded');
  const unknown=await call('terminal_connect',{url:'https://not-registered.example/apps/ai?invite=fixture',attemptId:randomUUID()});assert.equal(unknown.structuredContent.code,'target_unavailable');
 }finally{router?.close();for(const d of devices.values())await d.remote.close();rmSync(directory,{recursive:true,force:true});}
});
