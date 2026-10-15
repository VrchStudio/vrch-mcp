import { createInterface } from 'node:readline';
import { createAIClient, validateHTTPOrigin, checkNativeWebSocket } from './client.mjs';
import { createTerminalMCP } from './mcp.mjs';
import { VERSION } from './version.mjs';

export function runCLI({ defaultMode = 'mcp', defaultCatalog = 'stable' } = {}) {

  if (process.argv.length === 3 && process.argv[2] === '--version') { process.stdout.write(VERSION + '\n'); return; }
  if (process.argv.length === 3 && process.argv[2] === '--help') { process.stdout.write('VRCH MCP ' + VERSION + '\nUsage: vrch-mcp [--mcp | --connect URL | --resume URL | --interactive] [--tool-catalog stable|dynamic] [--allow-http-origin ORIGIN]\nDefault: MCP over STDIO; no invitation or credential is stored in configuration.\n'); return; }
  try { checkNativeWebSocket(globalThis.WebSocket); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
  let mode = '', resumeURL = '', allowHTTPOrigin, toolCatalog = defaultCatalog;
  try {
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift();
      if (flag === '--allow-http-origin' && allowHTTPOrigin === undefined && args.length) allowHTTPOrigin = validateHTTPOrigin(args.shift());
      else if (flag === '--tool-catalog' && ['stable', 'dynamic'].includes(args[0])) toolCatalog = args.shift();
      else if (flag === '--interactive' && !mode) mode = 'interactive';
      else if (flag === '--mcp' && !mode) mode = 'mcp';
      else if (['--resume', '--connect'].includes(flag) && !mode && args.length) { mode = flag.slice(2); resumeURL = args.shift(); }
      else throw new Error('Usage: client [--mcp | --connect URL | --resume URL] [--allow-http-origin ORIGIN]');
    }
  } catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
  mode ||= defaultMode;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  if (mode === 'mcp') {
    const bridge = createTerminalMCP({ send: value => process.stdout.write(JSON.stringify(value) + '\n'), allowHTTPOrigin, toolCatalog });
    lines.on('line', line => {
      try { void bridge.receive(JSON.parse(line)); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }) + '\n'); }
    });
    lines.on('close', () => bridge.close());
    process.on('SIGINT', () => { bridge.close(); lines.close(); });
  } else {
  let client;
  if (mode === 'resume' || mode === 'connect') {
    try { client = createAIClient(resumeURL, { resume: mode === 'resume', allowHTTPOrigin }); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
  } else process.stderr.write('Invitation URL: ');
  lines.on('line', async line => {
    if (!client) { try { client = createAIClient(line.trim(), { allowHTTPOrigin }); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; lines.close(); } return; }
    try {
      const message = JSON.parse(line);
      if (message.type === 'ai_report') console.log(JSON.stringify({type: 'ai_reported', result: await client.report(message.message)}));
      else if (message.type === 'ai_capabilities') console.log(JSON.stringify({type: 'ai_capabilities', result: client.capabilities()}));
      else if (message.type === 'apps_control') console.log(JSON.stringify({type:'apps_input_result',result:await client.appControl(message)}));
      else if (message.type === 'apps_interface_input') console.log(JSON.stringify({type:'apps_input_result',result:await client.appInterface(message)}));
      else if (message.type === 'input') client.input(message.data);
      else if (message.type === 'file_put') await client.putFile(message.path, { name: message.name, restart: message.restart ?? false });
      else if (message.type === 'file_pause') client.pauseFile();
      else if (message.type === 'apps_request') console.log(JSON.stringify({type: 'apps_response', action: message.action, result: await client.appsRequest(message.action, message.args, message)}));
      else if (message.type === 'file_upload') console.log(JSON.stringify({type: 'file_v2_complete', result: await client.uploadFile(message.path, message)}));
      else if (message.type === 'file_download') console.log(JSON.stringify({type: 'file_v2_complete', result: await client.downloadFile(message.path, message)}));
      else if (message.type === 'file_v2_pause') client.pauseTransfer();
      else if (message.type === 'file_v2_resume') console.log(JSON.stringify({type: 'file_v2_complete', result: await client.resumeTransfer()}));
      else if (message.type === 'file_v2_cancel') await client.cancelTransfer();
      else throw new Error();
    } catch (error) { console.log(JSON.stringify(error.code ? { type: error.code === 'file_paused' ? 'file_paused' : 'file_error', code: error.code, message: error.message } : { type: 'input_rejected', code: 'invalid_command' })); }
  });
  lines.on('close', () => client?.close());
  process.on('SIGINT', () => { client?.close(); lines.close(); });
  }
}
