import assert from 'node:assert/strict';
import test from 'node:test';
import {createTerminalMCP} from '../src/index.mjs';

test('connect-first MCP defers Apps tools and guide until actual approval', async()=>{
 const replies=[];let emit;
 const bridge=createTerminalMCP({send:message=>replies.push(message),createClient:(_url,options)=>{
  emit=options.emit;return {close(){},capabilities:()=>({apps:true}),screenshotBatches:()=>[],sharedScreenshots:()=>[],report:async message=>({delivered:true,message})};
 }});
 let id=0;
 const call=async(method,params={})=>{const requestId=++id;await bridge.receive({jsonrpc:'2.0',id:requestId,method,params});return replies.find(value=>value.id===requestId).result;};
 const initial=await call('initialize',{protocolVersion:'2025-11-25'});
 assert.equal(initial.capabilities.tools.listChanged,true);assert.match(initial.instructions,/Connect first/);assert(!initial.instructions.includes('metronome instruments'));
 const waiting=await call('tools/list');assert.deepEqual(waiting.tools.map(tool=>tool.name),['ai_report','ai_capabilities','terminal_connect','terminal_events','terminal_disconnect']);
 await call('tools/call',{name:'terminal_connect',arguments:{url:'https://fixture.test/apps/ai?invite=fixture'}});
 emit({type:'ai_pending'});assert.deepEqual((await call('tools/list')).tools,waiting.tools);
 emit({type:'collaboration',apps:'vrch-apps-v1'});
 assert((await call('tools/list')).tools.some(tool=>tool.name==='apps_launch'));
 assert(replies.some(reply=>reply.method==='notifications/tools/list_changed'));
 const report=await call('tools/call',{name:'ai_report',arguments:{message:'正在检查 App。'}});assert(report.content[0].text.includes('delivered'));
 bridge.close();
});
