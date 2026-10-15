import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAIClient } from '../src/index.mjs';
import { relay, until } from './helpers/relay.mjs';

test('public native File V2 performs a verified round trip without overwriting a destination', async () => {
  const device=await relay(), directory=await mkdtemp(join(tmpdir(),'vrch-file-v2-')),events=[];
  const client=createAIClient(device.url,{sessionFile:false,emit:event=>events.push(event)});
  try {
    await until(()=>events.some(event=>event.type==='ai_pending'));
    device.approve(); await until(()=>client.capabilities()?.apps);
    const bytes=randomBytes(190003),source=join(directory,'source.bin'),destination=join(directory,'result.bin');
    await writeFile(source,bytes);
    const upload=await client.uploadFile(source,{purpose:'app-workspace',resource:{workspaceId:'fixture'}});
    const digest=createHash('sha256').update(bytes).digest('hex');
    assert.equal(upload.sha256,digest); assert.deepEqual(device.bytes(),bytes);
    const result=await client.downloadFile(destination,{purpose:'app-workspace',resource:{reference:upload.reference}});
    assert.equal(result.sha256,digest); assert.deepEqual(await readFile(destination),bytes);
    await assert.rejects(client.downloadFile(destination,{purpose:'app-workspace',resource:{reference:upload.reference}}),{code:'file_exists'});
    assert.deepEqual(await readFile(destination),bytes);
    assert(events.some(event=>event.type==='file_v2_progress'&&event.phase==='complete'));
  } finally {client.close();await device.close();await rm(directory,{recursive:true,force:true});}
});
