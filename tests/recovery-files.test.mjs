// Real native client / WebSocket / source bytes; the device is simulated here.
import assert from 'node:assert/strict';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAIClient} from '../src/index.mjs';
import {until} from './helpers/relay.mjs';

for (const changed of [false,true]) test(`Recovery human file control retains source across reconnect (changed=${changed})`, async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>server.once('listening',resolve));
  const directory=await mkdtemp(join(tmpdir(),'vrch-recovery-file-'));
  const source=join(directory,'image.img.zst'),data=randomBytes(190003),events=[],frames=[];
  await writeFile(source,data);
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  let peer,spec,generation=1,bytes=Buffer.alloc(0),held=false,ackHeld=true,client;
  const peers=new Set(),id='a'.repeat(32),lease=Date.now()+60000;
  const send=value=>peer.send(JSON.stringify(value));
  const state=()=>send({type:'collaboration',owner:'ai',epoch:2,private:false,passwordRequired:false,
    fileTransferV2:'vrch-file-v2',filePurposes:[{purpose:'boot-image',directions:['upload'],maxBytes:2**30}],
    assistantTransfer:spec?{id,pausedByUser:held}:null});
  const frame=(type,extra={})=>send({type,protocol:'vrch-file-v2',id,operationId:spec.operationId,generation,...extra});
  const ready=()=>{frame('file_ready',{size:spec.size,name:spec.name,sha256:spec.sha256,offset:bytes.length,prefixSha256:digest(bytes)});state();};
  const control=action=>{held=action==='pause';send({type:'file_control_v2',id,action});state();};
  server.on('connection',socket=>{
    peer=socket;peers.add(socket);socket.on('close',()=>peers.delete(socket));
    socket.on('message',(raw,binary)=>{
      if(binary){
        assert.equal(Number(raw.readBigUInt64BE(24)),generation);
        assert.equal(Number(raw.readBigUInt64BE(32)),bytes.length);
        bytes=Buffer.concat([bytes,raw.subarray(40)]);
        if(!ackHeld)frame('file_ack',{nextOffset:bytes.length});
        return;
      }
      const value=JSON.parse(raw);frames.push(value);
      if(value.type==='ai_join'||value.type==='ai_resume'){
        assert.equal(value.fileControl,'vrch-file-v2');
        send({type:value.type==='ai_join'?'ai_approved':'ai_resumed',credential:'fixture-secret',requestId:'fixture-request',leaseExpiresAt:lease});state();
      }else if(value.type==='file_begin'){spec=value;ready();}
      else if(value.type==='file_pause')frame('file_paused',{phase:'paused',offset:bytes.length});
      else if(value.type==='file_resume'){assert(!held);generation++;ready();}
      else if(value.type==='file_finish')frame('file_done',{size:bytes.length,sha256:digest(bytes),transferComplete:true});
    });
  });
  try{
    client=createAIClient(`http://127.0.0.1:${server.address().port}/recovery/ai?invite=fixture`,{sessionFile:false,delay:10,emit:value=>events.push(value)});
    await until(()=>events.some(e=>e.type==='collaboration'));
    const upload=client.uploadFile(source,{purpose:'boot-image'});upload.catch(()=>{});
    await until(()=>bytes.length>0);
    await until(()=>frames.some(f=>f.type==='file_source_v2'&&f.available));
    control('pause');
    await assert.rejects(upload,{code:'file_paused'});
    await until(()=>frames.some(f=>f.type==='file_pause'));
    const retained=Buffer.from(bytes);assert.deepEqual(retained,data.subarray(0,retained.length));
    assert(client.input('pwd\n'),'File pause does not take terminal control');
    peer.terminate();await until(()=>frames.some(f=>f.type==='ai_resume'));
    await until(()=>frames.some(f=>f.type==='file_source_v2'&&f.available));
    assert.equal(frames.filter(f=>f.type==='file_resume').length,0,'Human hold survives AI reconnect');
    if(changed)await writeFile(source,Buffer.alloc(data.length,1));
    ackHeld=false;control('resume');
    if(changed){
      await until(()=>frames.some(f=>f.type==='file_source_v2'&&f.code==='source_changed'));
      assert.deepEqual(bytes,retained,'Changed source never replaces retained receiver bytes');
    }else{
      await until(()=>events.some(e=>e.type==='file_v2_complete'));
      assert.deepEqual(bytes,data);assert.deepEqual(await readFile(source),data);
      assert.equal(events.find(e=>e.type==='file_v2_complete').sha256,digest(data));
      assert.equal(frames.filter(f=>f.type==='file_begin').length,1);
    }
  }finally{client?.close();for(const socket of peers)socket.terminate();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
