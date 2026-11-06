import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer, request} from 'node:http';
import {createHash} from 'node:crypto';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';

test('connector metadata and favicon resolve to the official same-origin PNG without changing MCP authentication', async () => {
  const origin='https://mcp-sg.example', resource=origin+'/synth';
  const auth={metadata:()=>({issuer:origin}),authenticate:token=>{if(token!=='approved')throw Error('denied');return {};}};
  const server=createServer(createRemoteHTTPHandler({auth,resource,handleMCP:async(_identity,message)=>({jsonrpc:'2.0',id:message.id,result:{serverInfo:{name:'vrch-mcp-remote',version:'test'}}})}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const call=(path,method='GET',token)=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'mcp-sg.example',Accept:'application/json, text/event-stream','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end(method==='POST'?JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'}):undefined);
  });
  try {
    const metadata=JSON.parse((await call('/.well-known/oauth-protected-resource/synth')).bytes);
    assert.equal(metadata.resource,resource);assert.equal(new URL(metadata.resource_logo_uri).origin,origin);
    const iconPath=new URL(metadata.resource_logo_uri).pathname;
    const icon=await call(iconPath);assert.equal(icon.status,200);assert.equal(icon.headers['content-type'],'image/png');
    assert.equal(createHash('sha256').update(icon.bytes).digest('hex'),'f4e2d43e2ea10e3190e372ac0d1076a5e3524e19c6a0f81a24457d665b019087');
    assert.equal(icon.bytes.readUInt32BE(16),1024);assert.equal(icon.bytes.readUInt32BE(20),1024);
    const head=await call(iconPath,'HEAD');assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),icon.bytes.length);
    const favicon=await call('/favicon.ico');assert.equal(favicon.status,302);assert.equal(favicon.headers.location,iconPath);assert.equal(favicon.headers['cache-control'],'no-store');
    assert.equal((await call('/synth','POST')).status,401);
    const initialized=JSON.parse((await call('/synth','POST','approved')).bytes);
    assert.equal(initialized.result.serverInfo.icons[0].src,metadata.resource_logo_uri);
    assert.equal(initialized.result.serverInfo.version,'test');
    assert.equal((await call('/assets/unknown.png')).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
