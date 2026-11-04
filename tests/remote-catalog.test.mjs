import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';

test('in-place upgrade: an initialized HTTP client with a cached catalog and no GET subscription re-lists on its original tool call',async()=>{
  let upgraded=false, handler, calls=0, lists=0, oldGets=0, cached;
  const ref='same-test-ref';
  const tool=name=>({name,inputSchema:{type:'object',properties:{connectionRef:{type:'string'}}}});
  const server=createServer((req,res)=>{
    // Previous hosted transport did not accept a stand-alone listener.
    if(!upgraded&&req.method==='GET'){oldGets++;res.writeHead(405).end();return;}
    return handler(req,res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=new URL('/synth','http://127.0.0.1:'+server.address().port);
  const auth={metadata:()=>({issuer:url.origin}),authenticate:t=>{assert.equal(t,'same-grant');return {issuer:url.origin,principal:'same-owner',oauthClientId:'same-client'};}};
  handler=createRemoteHTTPHandler({auth,resource:url.href,handleMCP:async(identity,m)=>{
    assert.equal(identity.principal,'same-owner');
    let result;
    if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:upgraded}},serverInfo:{name:'test',version:upgraded?'2':'1'}};
    if(m.method==='tools/list'){lists++;result={tools:(upgraded?['ai_capabilities','apps_publish_preview','apps_preview_snapshot']:['ai_capabilities']).map(tool)};}
    if(m.method==='tools/call'){assert.equal(m.params.arguments.connectionRef,ref);calls++;result={structuredContent:{connectionRef:ref,phase:'ready'},content:[{type:'text',text:'Original call completed.'}]};}
    return {jsonrpc:'2.0',id:m.id,result};
  }});
  const sdk=new Client({name:'same-conversation',version:'1'});
  try{
    await sdk.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer same-grant'}}}));
    const names=async()=>(await sdk.listTools()).tools.map(t=>t.name);
    cached=await names();assert.deepEqual(cached,['ai_capabilities']);assert.equal(sdk.getServerCapabilities().tools.listChanged,false);
    while(!oldGets)await new Promise(r=>setTimeout(r,5));
    const refreshed=Promise.withResolvers();
    sdk.setNotificationHandler(ToolListChangedNotificationSchema,async()=>{try{cached=await names();refreshed.resolve();}catch(e){refreshed.reject(e);}});
    upgraded=true;
    const result=await sdk.callTool({name:'ai_capabilities',arguments:{connectionRef:ref}});
    await refreshed.promise;
    assert.equal(result.structuredContent.phase,'ready');assert.equal(calls,1);assert.equal(lists,2);
    assert.deepEqual(cached,['ai_capabilities','apps_publish_preview','apps_preview_snapshot']);
    // New listeners also catch up without sharing device data or other clients' results.
    const denied=await fetch(url,{headers:{Accept:'text/event-stream'}});assert.equal(denied.status,401);
    const controller=new AbortController();const stream=await fetch(url,{headers:{Accept:'text/event-stream',Authorization:'Bearer same-grant'},signal:controller.signal});
    assert.match(stream.headers.get('content-type'),/text\/event-stream/);const msg=new TextDecoder().decode((await stream.body.getReader().read()).value);
    assert.match(msg,/notifications\/tools\/list_changed/);assert(!msg.includes(ref));controller.abort();
  }finally{await sdk.close();handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
