import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalMCP} from '../src/mcp.mjs';
import {rgbPNG} from './helpers/png.mjs';

test('hosted engineering calls leave shared images for events; capture remains explicit and privacy can clear the queue', async()=>{
 const replies=[],image={metadata:{id:'fixture',batchId:'fixture',mimeType:'image/png'},data:rgbPNG(2,2)};
 let options,available=true;
 const mcp=createTerminalMCP({imageDelivery:'events',toolCatalog:'stable',send:value=>replies.push(value),createClient:(_url,opts)=>{
  options=opts;opts.emit({type:'collaboration',apps:'vrch-apps-v1'});opts.imageInput(image,{signal:{aborted:false}});
  return {appsRequest:async()=>({apps:[]}),screenshotBatches:()=>available?[[image]]:[],sharedScreenshots:()=>available?[image]:[],
   takeScreenshot:async()=>{opts.imageInput(image,{signal:{aborted:false}});return [image];},close(){}};
 }});
 let id=0;
 const send=async(method,params)=>{const n=++id;await mcp.receive({jsonrpc:'2.0',id:n,method,params});return replies.find(value=>value.id===n).result;};
 const call=(name,args={})=>send('tools/call',{name,arguments:args});
 try{
  await send('initialize');await call('terminal_connect',{url:'fixture'});
  assert(!(await call('apps_list')).content.some(value=>value.type==='image'));
  assert.equal((await call('terminal_events',{waitSeconds:0})).content.filter(value=>value.type==='image').length,1);
  assert(!(await call('terminal_events',{waitSeconds:0})).content.some(value=>value.type==='image'));
  assert.equal((await call('take_screenshot')).content.filter(value=>value.type==='image').length,1);
  options.imageInput(image,{signal:{aborted:false}});available=false;options.imagesChanged([]);
  assert(!(await call('terminal_events',{waitSeconds:0})).content.some(value=>value.type==='image'));
 }finally{mcp.close();}
});
