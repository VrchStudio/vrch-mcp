// A simulated device, with real WebSocket and native client boundaries.
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await pause(10); }
  throw new Error('Expected relay state was not reached.');
}
export async function relay() {
  const server = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise(resolve => server.once('listening', resolve));
  const frames = [], reports = [], peers = new Set();
  let peer, transfer, bytes = Buffer.alloc(0), running = null;
  const state = {type:'collaboration', apps:'vrch-apps-v1', assistantProtocol:'vrch-ai-assist-v1',
    assistantCapabilities:{apps:true, appLifecycle:true, interfaceInput:true, controls:true, hostMenus:['menu','device']},
    owner:'ai', epoch:1, private:false, passwordRequired:false, fileTransferV2:true,
    filePurposes:[{purpose:'app-workspace', directions:['upload','download'], maxBytes:1024*1024}]};
  const send = value => peer.send(JSON.stringify(value));
  const file = (type, extra = {}) => send({protocol:'vrch-file-v2', type, operationId:transfer.operationId, id:transfer.id, generation:1, ...extra});
  function download() {
    for (let offset = 0; offset < bytes.length; offset += 60 * 1024) {
      const block = bytes.subarray(offset, offset + 60 * 1024), frame = Buffer.alloc(40 + block.length);
      frame.write('VRCHFT2\0'); Buffer.from(transfer.id, 'hex').copy(frame, 8);
      frame.writeBigUInt64BE(1n, 24); frame.writeBigUInt64BE(BigInt(offset), 32); block.copy(frame, 40);
      peer.send(frame);
    }
  }
  server.on('connection', (socket, request) => {
    peer = socket; peers.add(socket); frames.push({path:request.url});
    socket.on('close', () => peers.delete(socket));
    socket.on('message', (raw, binary) => {
      if (binary) {
        bytes = Buffer.concat([bytes, raw.subarray(40)]);
        file('file_ack', {nextOffset:bytes.length}); return;
      }
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'ai_join') send({type:'ai_pending', assistantProtocol:'vrch-ai-assist-v1'});
      if (frame.type === 'ai_resume') {
        if (frame.credential !== 'fixture-secret') {send({type:'error',code:'ai_revoked'}); return;}
        send({type:'ai_resumed',leaseExpiresAt:0}); send(state);
      }
      if (frame.type === 'private_cancel') {
        if (frame.epoch !== state.epoch || !state.assistantCapabilities.cancelPrivateInput)
          send({type:'private_cancel_result',operationId:frame.operationId,ok:false,code:'stale_input'});
        else {const canceled=state.private;state.private=false;state.passwordRequired=false;
          if(canceled&&frame.resumeAI)state.owner='ai';state.epoch++;send(state);
          send({type:'private_cancel_result',operationId:frame.operationId,ok:true,canceled,owner:state.owner});}
      }
      if (frame.type === 'ai_report') {reports.push(frame.message); send({type:'ai_report_result',operationId:frame.operationId,ok:true});}
      if (frame.type === 'apps_request') {
        let result = {}, error;
        if (state.owner !== 'ai' && !['list','state','input_targets'].includes(frame.action)) error={code:'control_required',message:'The person has control.'};
        else if (state.private) error={code:'private_input',message:'Private input is active.'};
        else if (frame.action === 'list') result={apps:[{id:'fixture-app',name:'Fixture'}]};
        else if (frame.action === 'state') result={running};
        else if (frame.action === 'launch') {running={instanceId:'fixture-instance',appId:frame.args.appId}; result={running};}
        else if (frame.action === 'stop') {running=null; result={running};}
        else if (frame.action === 'input_targets') result={device:{instanceId:'fixture-instance',generation:1}};
        else if (['control_input','interface_input','host_input'].includes(frame.action)) result={dispatched:true,event:frame.args.event};
        send({type:'apps_result',operationId:frame.operationId,action:frame.action,status:error?'failed':'succeeded',...(error?{error}:{result})});
      }
      if (frame.protocol === 'vrch-file-v2') {
        if (frame.type === 'file_begin') {
          transfer={...frame,id:'a'.repeat(32)};
          if (frame.direction === 'upload') bytes=Buffer.alloc(0);
          file('file_ready',{size:frame.direction==='upload'?frame.size:bytes.length,sha256:frame.direction==='upload'?frame.sha256:digest(bytes),offset:0,prefixSha256:digest(Buffer.alloc(0)),name:'fixture.bin'});
          if (frame.direction === 'download') download();
        } else if (frame.type === 'file_finish') file('file_done',{sha256:digest(bytes),reference:'fixture-reference'});
      }
    });
  });
  return {frames,reports,state,bytes:()=>bytes,
    url:`http://127.0.0.1:${server.address().port}/apps/ai?invite=fixture`,
    approve() {send({type:'ai_approved',credential:'fixture-secret',requestId:'fixture-request',leaseExpiresAt:0}); send(state);},
    update(values) {Object.assign(state, values); send(state);},
    remove() {send({type:'error',code:'ai_revoked'});},
    async close() {for (const socket of peers) socket.terminate(); await new Promise(resolve => server.close(resolve));}
  };
}
