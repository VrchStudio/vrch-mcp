import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { relay, until } from './helpers/relay.mjs';

for (const entry of ['bin/vrch-mcp.mjs','dist/vrch-mcp.mjs']) test(`official MCP SDK crosses real STDIO and WebSocket: ${entry}`, async () => {
  const device = await relay(), directory = await mkdtemp(join(tmpdir(), 'vrch-stdio-'));
  const transport = new StdioClientTransport({command:process.execPath,
    args:[fileURLToPath(new URL('../'+entry, import.meta.url))],stderr:'pipe',env:{...process.env,XDG_STATE_HOME:directory}});
  const client = new Client({name:'vrch-test-host',version:'1.0.0'});
  try {
    await client.connect(transport);
    const initial = await client.listTools();
    assert(initial.tools.some(tool => tool.name === 'apps_launch'));
    assert.match(client.getInstructions(), /call ai_capabilities, then apps_list and apps_state/);
    for (const tool of initial.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    assert.equal(initial.tools.find(tool=>tool.name==='terminal_events').inputSchema.properties.waitSeconds.default,20);
    assert.equal(initial.tools.find(tool=>tool.name==='apps_control').annotations.readOnlyHint,false);
    assert.equal(initial.tools.find(tool=>tool.name==='file_download').annotations.readOnlyHint,false);
    const call = (name, args = {}) => client.callTool({name,arguments:args});
    const joinResult = await call('terminal_connect',{url:device.url});
    assert.equal(joinResult.isError,undefined);
    assert.match(joinResult.content[0].text,/terminal_events\(\{\}\)/);
    await until(()=>device.frames.some(frame=>frame.type==='ai_join'));
    assert.equal(device.frames[0].path, '/vrch-ws/apps-terminal-assist');
    const blocked = await call('apps_list');
    assert.equal(blocked.isError,true); assert.match(blocked.content[0].text,/approval_required/);
    assert(!device.frames.some(frame=>frame.type==='apps_request'));
    await call('ai_report',{message:'正在等待你在 My Apps 中批准。'});
    assert.equal(device.reports.length,1);
    const invalidWait = await call('terminal_events',{waitSeconds:55});
    assert.equal(invalidWait.isError,true);
    assert.match(invalidWait.content[0].text,/terminal_events\(\{\}\)/);
    device.approve();
    const events = await call('terminal_events');
    assert(events.content.some(item=>item.type==='text' && item.text.includes('ai_approved')));
    assert(events.content.some(item=>item.type==='text' && item.text.includes('apps_guide')));
    assert(!JSON.stringify(events).includes('fixture-secret'));
    assert.deepEqual(await client.listTools(),initial);
    assert.equal(JSON.parse((await call('ai_capabilities')).content[0].text).apps,true);
    assert.equal(JSON.parse((await call('apps_list')).content[0].text).apps[0].id,'fixture-app');
    await call('apps_launch',{appId:'fixture-app',expectedPackageDigest:'fixture-digest'});
    assert.equal(JSON.parse((await call('apps_state')).content[0].text).running.instanceId,'fixture-instance');
    await call('apps_interface_input',{target:'device',instanceId:'fixture-instance',generation:1,event:{type:'guide_start'}});
    await call('apps_interface_input',{instanceId:'fixture-instance',generation:1,event:{type:'text',text:'hello'}});
    await call('apps_control',{target:'device',instanceId:'fixture-instance',generation:1,control:'E1',type:'rotate',delta:1});
    await call('apps_control',{target:'device',instanceId:'fixture-instance',generation:1,control:'K2',type:'click',holdMs:0});
    const controls=device.frames.filter(frame=>frame.action==='control_input');
    assert.deepEqual(controls.map(frame=>frame.args.event.type),['rotate','down','up']);
    device.update({owner:'human'});
    await call('terminal_events',{waitSeconds:0});
    assert.equal((await call('apps_control',{target:'device',instanceId:'fixture-instance',generation:1,control:'K2',type:'down'})).isError,true);
    device.update({owner:'ai'});
    await call('terminal_events',{waitSeconds:0});
    await call('apps_exit',{instanceId:'fixture-instance'});
    assert.equal(JSON.parse((await call('apps_state')).content[0].text).running,null);
    device.remove();
    await call('terminal_events',{waitSeconds:1});
    assert.equal((await call('apps_list')).isError,true);
    assert(!JSON.stringify(await client.listTools()).includes('fixture-secret'));
  } finally {await client.close(); await device.close(); await rm(directory,{recursive:true,force:true});}
});
