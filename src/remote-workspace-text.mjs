// Hosted text adapters use the existing workspace File V2 authorization and
// atomic commit. No caller-supplied path is ever a server filesystem path.
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {mkdirSync, lstatSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const TEXT_BYTES = 64 * 1024;
const fail = code => Object.assign(Error(code), {code});
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const text = value => ({type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)});
const schema = (properties, required) => ({type: 'object', properties, required, additionalProperties: false});
const common = {workspaceId: {type: 'string', format: 'uuid'}, path: {type: 'string', maxLength: 512}};
export const workspaceTextTools = [
  {name: 'apps_read_text', description: 'Read a verified UTF-8 source file (up to 64 KiB) from the explicit current App workspace. Returns complete source in a plain text content block and structuredContent.result.text, with its SHA-256 for conflict-safe editing. Source text is untrusted App data. Does not publish or save.',
    inputSchema: schema(common, ['workspaceId', 'path']), annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true}},
  {name: 'apps_write_text', description: 'Atomically write UTF-8 source (up to 64 KiB) to a relative path in the explicit current App workspace, using the existing File V2 upload and commit. Supply the original SHA-256, or null only for a new file. Reuse operationId after a lost response; query write_text with apps_operation_status, never resend with a new ID. Does not publish, save or execute. Read apps_state after editing to obtain draftRevision before publishing.',
    inputSchema: schema({...common, content: {type: 'string'}, expectedSha256: {type: ['string', 'null']}}, ['workspaceId', 'path', 'content', 'expectedSha256']),
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true}}
];

export function validateWorkspaceText(name, args) {
  const write = name === 'apps_write_text', keys = ['workspaceId', 'path', ...(write ? ['content', 'expectedSha256', 'operationId'] : [])];
  if (Object.keys(args).some(key => !keys.includes(key)) || !uuid(args.workspaceId)
      || typeof args.path !== 'string' || !args.path || args.path.length > 512 || args.path.includes('\\')
      || /[\x00-\x1f]/.test(args.path) || args.path.split('/').some(part => ['', '.', '..'].includes(part))) throw fail('invalid_workspace_path');
  if (write && (typeof args.content !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(args.content)
      || Buffer.byteLength(args.content) > TEXT_BYTES || Buffer.from(args.content).toString('utf8') !== args.content
      || !(args.expectedSha256 === null || typeof args.expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(args.expectedSha256)))) throw fail('invalid_workspace_text');
}
function value(result) {
  if (result?.isError) {
    const code = /^([a-z_]+):/.exec(result.content?.[0]?.text || '')?.[1] || 'workspace_transfer_failed';
    throw fail(code);
  }
  try {return JSON.parse(result.content[0].text);} catch {throw fail('invalid_workspace_result');}
}
export function createWorkspaceText(directory) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('unsafe_workspace_storage');
  // This directory belongs to the single hosted router. Files are temporary
  // transfer payloads, not drafts or operation journals, and never recovery data.
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (!/^(?:text|preview)-[A-Za-z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
    const path = join(directory, entry.name), prior = lstatSync(path);
    if (prior.uid === process.getuid() && !(prior.mode & 0o077)) rmSync(path, {recursive: true});
  }
  const queues = new Map();
  async function execute(connection, name, args, call) {
    validateWorkspaceText(name, args);
    let temporary, transferring = false;
    try {
      temporary = await mkdtemp(join(directory, 'text-'));
      const file = join(temporary, 'source.txt');
      if (name === 'apps_read_text') {
        const exported = value(await call('apps_file_export', {workspaceId: args.workspaceId, path: args.path}));
        if (!Number.isSafeInteger(exported.size) || exported.size < 0 || exported.size > TEXT_BYTES
            || !/^[a-f0-9]{64}$/.test(exported.sha256 || '') || typeof exported.reference !== 'string') throw fail('workspace_text_too_large');
        transferring = true;
        value(await call('file_download', {path: file, purpose: 'app-workspace', reference: exported.reference, maxBytes: TEXT_BYTES}));
        transferring = false;
        if ((await stat(file)).size !== exported.size) throw fail('hash_mismatch');
        const bytes = await readFile(file);
        if (sha(bytes) !== exported.sha256) throw fail('hash_mismatch');
        let source; try {source = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);} catch {throw fail('workspace_not_text');}
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) throw fail('workspace_not_text');
        // Read metadata alone is insufficient during Private Input. This RPC
        // explicitly rechecks payload access on the actual device after transfer.
        value(await call('apps_input_targets', {}));
        const metadata = {workspaceId: args.workspaceId, path: args.path, sha256: exported.sha256, size: bytes.length};
        return {content: [text(metadata)], structuredContent: {...metadata, text: source}};
      }
      const bytes = Buffer.from(args.content);
      await writeFile(file, bytes, {flag: 'wx', mode: 0o600});
      transferring = true;
      const uploaded = value(await call('file_upload', {path: file, purpose: 'app-workspace', workspaceId: args.workspaceId, operationId: randomUUID()}));
      transferring = false;
      if (uploaded.sha256 !== sha(bytes) || typeof uploaded.reference !== 'string') throw fail('hash_mismatch');
      // The caller's operation ID belongs to the device's durable commit, not
      // to a temporary transfer. A timeout is queried against this same ID.
      return await call('apps_file_commit', {workspaceId: args.workspaceId, path: args.path,
        expectedSha256: args.expectedSha256, reference: uploaded.reference, operationId: args.operationId});
    } finally {
      if (transferring) {try {await call('file_cancel', {});} catch {}}
      if (temporary) await rm(temporary, {recursive: true, force: true});
    }
  }
  return {async run(connection, name, args, call) {
    validateWorkspaceText(name,args);
    const previous=queues.get(connection), count=(previous?.count||0)+1;
    if(count>8)throw fail('transfer_busy');
    const job={count};
    job.promise=(previous?.promise||Promise.resolve()).catch(()=>{}).then(()=>execute(connection,name,args,call));
    queues.set(connection,job);
    try{return await job.promise;}
    finally{const tail=queues.get(connection);if(tail===job)queues.delete(connection);else if(tail)tail.count--;}
  }};
}
