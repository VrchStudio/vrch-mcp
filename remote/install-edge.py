#!/usr/bin/env python3
"""Install one MCP ingress into the existing, locally managed SG tunnel.

Run as root from the committed checkout. Preserve all neighboring ingress and
store only affected configuration for rollback. Never read tunnel credentials.
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--config', required=True, type=Path)
parser.add_argument('--bindings', required=True, type=Path)
parser.add_argument('--origincert', required=True)
parser.add_argument('--unit', required=True)
parser.add_argument('--cloudflared', default='/usr/local/bin/cloudflared')
args = parser.parse_args()
if not re.fullmatch(r'mcp-sg\.[a-z0-9.-]+', args.host):
    parser.error('This installer is limited to the SG MCP hostname.')
original = args.config.read_text()
match = re.search(r'^tunnel:\s*([a-f0-9-]+)\s*$', original, re.M)
if not match or original.count('  # __VRCH_CUSTOM_BINDINGS_END__') != 1:
    parser.error('Expected an existing locally managed tunnel and custom-bindings marker.')
route = f'  - hostname: {args.host}\n    service: http://127.0.0.1:18917\n'
if re.search(r'^\s*- hostname:\s*'+re.escape(args.host)+r'\s*$',original,re.M):
    if route not in original: parser.error('Existing MCP route differs; refusing replacement.')
    candidate = original
else:
    candidate = original.replace('  # __VRCH_CUSTOM_BINDINGS_END__', route+'  # __VRCH_CUSTOM_BINDINGS_END__')
bindings = args.bindings.read_text()
line = args.host+'\thttp://127.0.0.1:18917\n'
if any(row.split('\t')[0] == args.host and row+'\n' != line for row in bindings.splitlines()):
    parser.error('Existing MCP binding differs; refusing replacement.')
if line not in bindings: bindings = bindings.rstrip('\n')+'\n'+line
nginx = Path('/etc/nginx/conf.d/vrch-mcp.conf')
rendered = Path(__file__).with_name('nginx.conf.template').read_text().replace('MCP_HOST',args.host)
backup = Path('/var/backups/vrch-mcp')/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True,mode=0o700)
for file in [args.config,args.bindings,nginx]:
    if file.exists(): shutil.copy2(file,backup/file.name)
with tempfile.NamedTemporaryFile(mode='w',suffix='.yml') as temp:
    temp.write(candidate);temp.flush()
    subprocess.run([args.cloudflared,'tunnel','--config',temp.name,'ingress','validate'],check=True)
route_changed = candidate != original
if route_changed:
    subprocess.run([args.cloudflared,'tunnel','--origincert',args.origincert,'route','dns',match[1],args.host],check=True)
try:
    nginx.write_text(rendered);nginx.chmod(0o644)
    subprocess.run(['nginx','-t'],check=True)
    args.config.write_text(candidate)
    args.bindings.write_text(bindings)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    if route_changed:
        subprocess.run(['systemctl','restart',args.unit],check=True)
except Exception:
    for file in [args.config,args.bindings,nginx]:
        prior=backup/file.name
        if prior.exists():shutil.copy2(prior,file)
        elif file==nginx:file.unlink(missing_ok=True)
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    if route_changed:
        subprocess.run(['systemctl','restart',args.unit],check=True)
    raise
print('Installed SG MCP ingress. Configuration rollback:',backup)
