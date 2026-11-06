import assert from 'node:assert/strict';
import test from 'node:test';
import {createRegisteredTargetResolver, publicIPv4} from '../remote/targets.mjs';
const deviceId = 'dvc_' + 'a'.repeat(32);

test('remote devices use current registered origins and a pinned public TLS address', async () => {
  let answers = ['104.21.10.20'], calls = [], options;
  class Socket {constructor(url, value) {options = value; this.url = url;}}
  const resolve = createRegisteredTargetResolver({directoryURL: 'http://127.0.0.1:18085/v1/public/server-directory', WebSocketImpl: Socket,
    fetchImpl: async (url, init) => {
      calls.push(url.href); assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({data: {self: {device_uid: deviceId, hosts: ['registered.example']}}}));
    }, resolve: async () => answers});
  const target = await resolve('https://registered.example/apps/ai?invite=not-sent-to-directory', {deviceId});
  assert.equal(target.deviceId, deviceId);
  assert.equal(calls[0], 'http://127.0.0.1:18085/v1/public/server-directory?self_host=registered.example');
  answers = ['127.0.0.1'];
  const socket = new target.WebSocketImpl('wss://registered.example/vrch-ws/apps-terminal-assist');
  assert.equal(options.servername, 'registered.example'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.followRedirects, false);
  await new Promise((resolve, reject) => options.lookup('registered.example', {all: true}, (error, records) => {if (error) reject(error); else {assert.deepEqual(records, [{address: '104.21.10.20', family: 4}]); resolve();}}));
  assert.throws(() => new target.WebSocketImpl('wss://other.example/vrch-ws/apps-terminal-assist'));
  await assert.rejects(resolve('https://registered.example/apps/ai?invite=x'), {code: 'target_unavailable'});
  answers = ['104.21.10.20', '10.0.0.1'];
  await assert.rejects(resolve('https://registered.example/apps/ai?invite=x'), {code: 'target_unavailable'});
  answers = ['104.21.10.20'];
  await assert.rejects(resolve('https://registered.example/apps/ai?invite=x', {deviceId: 'changed-device'}), {code: 'target_unavailable'});
  for (const url of ['http://registered.example', 'https://127.0.0.1', 'https://registered.example:8443', 'https://unregistered.example'])
    await assert.rejects(resolve(url), {code: 'target_unavailable'});
});

test('non-public and special IPv4 ranges cannot become hosted connection targets', () => {
  for (const ip of ['0.1.2.3','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.1','192.0.0.8','192.0.2.1','192.88.99.2','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','localhost']) assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['1.1.1.1','8.8.8.8','104.21.10.20','172.64.0.1','192.2.1.1']) assert.equal(publicIPv4(ip), true, ip);
});
