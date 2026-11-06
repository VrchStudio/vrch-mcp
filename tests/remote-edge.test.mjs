import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Real installer, temporary files and logging fake executables only: no DNS,
// nginx, systemd or tunnel command can reach the host.
const installer = join(dirname(fileURLToPath(import.meta.url)), '..', 'remote', 'install-edge.py');
const python = spawnSync('python3', ['--version']).status === 0;
const tunnel = '0123abcd-4567-89ef-0123-456789abcdef';
const config = 'tunnel: ' + tunnel + '\ncredentials-file: /root/.cloudflared/' + tunnel + '.json\ningress:\n  - hostname: neighbor.example\n    service: http://127.0.0.1:9000\n  # __VRCH_CUSTOM_BINDINGS_END__\n  - service: http_status:404\n';
const bindings = 'neighbor.example\thttp://127.0.0.1:9000\n';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vrch-edge-')), bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['cloudflared', 'nginx', 'systemctl']) {
    const file = join(bin, name);
    writeFileSync(file, '#!/bin/sh\nline="$(basename "$0") $*"\necho "$line" >> "$EDGE_LOG"\nif [ -n "$EDGE_FAIL" ]; then case "$line" in *"$EDGE_FAIL"*) exit 1;; esac; fi\nexit 0\n');
    chmodSync(file, 0o755);
  }
  writeFileSync(join(root, 'config.yml'), config);
  writeFileSync(join(root, 'bindings.tsv'), bindings);
  const run = (args, fail = '') => {
    writeFileSync(join(root, 'log'), '');
    const result = spawnSync('python3', [installer, '--config', join(root, 'config.yml'), '--bindings', join(root, 'bindings.tsv'),
      '--origincert', join(root, 'cert.pem'), '--unit', 'vrch-tunnel.service', '--cloudflared', join(bin, 'cloudflared'),
      '--nginx-conf', join(root, 'vrch-mcp.conf'), '--backup-root', join(root, 'backups'), ...args],
      {encoding: 'utf8', env: {...process.env, PATH: bin + ':' + process.env.PATH, EDGE_LOG: join(root, 'log'), EDGE_FAIL: fail}});
    return {...result, calls: readFileSync(join(root, 'log'), 'utf8').split('\n').filter(Boolean).map(line => line.replace(/--config \S+/, '--config <temp>'))};
  };
  const files = () => [readFileSync(join(root, 'config.yml'), 'utf8'), readFileSync(join(root, 'bindings.tsv'), 'utf8'), existsSync(join(root, 'vrch-mcp.conf'))];
  return {root, run, files, backups: () => existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')) : [], cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('environment and host must match before any command runs', {skip: !python}, () => {
  const edge = fixture();
  try {
    for (const args of [['--host', 'mcp.vrch.ai'], ['--environment', 'sg', '--host', 'mcp.vrch.ai'],
      ['--environment', 'ea', '--host', 'mcp-sg.vrch.ai'], ['--environment', 'ea', '--host', 'mcp.vrch.ai.example'], ['--environment', 'eu', '--host', 'mcp.vrch.ai']]) {
      const result = edge.run(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.deepEqual(result.calls, []);
      assert.deepEqual(edge.files(), [config, bindings, false]);
    }
    assert.deepEqual(edge.backups(), []);
  } finally { edge.cleanup(); }
});

test('EA dry run only validates and prints the redacted change', {skip: !python}, () => {
  const edge = fixture();
  try {
    const result = edge.run(['--environment', 'ea', '--host', 'mcp.vrch.ai', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['cloudflared tunnel --config <temp> ingress validate']);
    assert.deepEqual(edge.files(), [config, bindings, false]);
    assert.deepEqual(edge.backups(), []);
    assert.match(result.stdout, /Environment: EA {2}Host: mcp\.vrch\.ai {2}Tunnel: 0123abcd\.\.\./);
    assert.match(result.stdout, /config\.yml: add - hostname: mcp\.vrch\.ai; service: http:\/\/127\.0\.0\.1:18917/);
    assert.match(result.stdout, /DNS route: add mcp\.vrch\.ai/);
    assert.ok(!result.stdout.includes(tunnel) && !result.stdout.includes('credentials-file'), result.stdout);
  } finally { edge.cleanup(); }
});

test('SG install preserves neighbors, then repeats without duplicate routes or reloads', {skip: !python}, () => {
  const edge = fixture();
  try {
    const first = edge.run(['--host', 'mcp-sg.vrch.ai']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.calls, ['cloudflared tunnel --config <temp> ingress validate',
      'cloudflared tunnel --origincert ' + join(edge.root, 'cert.pem') + ' route dns ' + tunnel + ' mcp-sg.vrch.ai',
      'nginx -t', 'systemctl reload nginx', 'systemctl restart vrch-tunnel.service']);
    const [installed, bound, nginx] = edge.files();
    assert.ok(installed.includes('  - hostname: neighbor.example\n    service: http://127.0.0.1:9000\n  - hostname: mcp-sg.vrch.ai\n    service: http://127.0.0.1:18917\n  # __VRCH_CUSTOM_BINDINGS_END__\n  - service: http_status:404\n'));
    assert.equal(bound, bindings + 'mcp-sg.vrch.ai\thttp://127.0.0.1:18917\n');
    assert.ok(nginx && readFileSync(join(edge.root, 'vrch-mcp.conf'), 'utf8').includes('server_name mcp-sg.vrch.ai;'));
    assert.equal(edge.backups().length, 1);
    const again = edge.run(['--host', 'mcp-sg.vrch.ai']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.calls, ['cloudflared tunnel --config <temp> ingress validate']);
    assert.match(again.stdout, /already installed; nothing changed/);
    assert.equal(edge.files()[0].split('hostname: mcp-sg.vrch.ai').length, 2);
    assert.equal(edge.files()[1], bound);
    assert.equal(edge.backups().length, 1);
    writeFileSync(join(edge.root, 'config.yml'), installed.replace('service: http://127.0.0.1:18917', 'service: http://127.0.0.1:18000'));
    const different = edge.run(['--host', 'mcp-sg.vrch.ai']);
    assert.equal(different.status, 2);
    assert.match(different.stderr, /Existing MCP route differs/);
    assert.deepEqual(different.calls, []);
  } finally { edge.cleanup(); }
});

test('a failed install restores only the files it changed', {skip: !python}, () => {
  for (const [fail, rollback] of [['restart', ['nginx -t', 'systemctl reload nginx', 'systemctl restart vrch-tunnel.service']],
    ['nginx -t', ['nginx -t', 'systemctl reload nginx']]]) {
    const edge = fixture();
    try {
      const result = edge.run(['--host', 'mcp-sg.vrch.ai'], fail);
      assert.notEqual(result.status, 0);
      assert.deepEqual(edge.files(), [config, bindings, false], fail);
      assert.match(result.stderr, /Installation failed; restored changed files/);
      const failedAt = result.calls.findIndex(call => call.includes(fail));
      assert.deepEqual(result.calls.slice(failedAt + 1), rollback, fail);
      if (fail === 'nginx -t') assert.match(result.stderr, /Rollback needs attention: nginx -t/);
      assert.equal(edge.backups().length, 1);
    } finally { edge.cleanup(); }
  }
});
