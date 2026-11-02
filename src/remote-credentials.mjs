// Storage for a trusted remote adapter, never a model-selectable filesystem API.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {constants, mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';

const failure = () => Object.assign(new Error('Remote credential storage is unavailable.'), {code: 'credential_storage_unavailable'});
const fields = ['issuer', 'principal', 'oauthClientId', 'deviceId', 'channel', 'connectionRef'];
const validRecord = record => record && typeof record === 'object' && !Array.isArray(record)
  && typeof record.credential === 'string' && record.credential.length > 0 && record.credential.length <= 4096
  && typeof record.requestId === 'string' && record.requestId.length > 0 && record.requestId.length <= 512
  && Number.isSafeInteger(record.expires) && record.expires >= 0
  && Number.isSafeInteger(record.offset) && record.offset >= 0
  && typeof record.stream === 'string' && record.stream.length <= 512;

export function createRemoteCredentialStore({directory, key, binding}) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof process.getuid !== 'function'
      || typeof directory !== 'string' || !directory
      || fields.some(field => typeof binding?.[field] !== 'string' || !binding[field] || binding[field].length > 2048)
      || binding.channel !== 'apps' || !/^[A-Za-z0-9_-]{22,128}$/.test(binding.connectionRef)) throw failure();
  // AAD binds ciphertext to all identity/routing dimensions, independently of its filename.
  const aad = Buffer.from(JSON.stringify(['vrch-mcp-credential-v1', ...fields.map(field => binding[field])]));
  const secret = Buffer.from(key);
  const filename = join(directory, createHash('sha256').update(aad).digest('hex') + '.bin');
  function privateDirectory() {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw failure();
  }
  function syncDirectory() {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {fsyncSync(fd);} finally {closeSync(fd);}
  }
  function read() {
    let fd;
    try {
      privateDirectory();
      try {fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
      catch (error) {if (error.code === 'ENOENT') return null; throw error;}
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size < 29 || info.size > 16384) throw failure();
      const bytes = readFileSync(fd);
      if (bytes[0] !== 1) throw failure();
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(1, 13));
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(13, 29));
      const record = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'));
      if (!validRecord(record)) throw failure();
      return record;
    } catch {throw failure();} finally {if (fd !== undefined) closeSync(fd);}
  }
  function write(record) {
    let fd, temporary;
    try {
      if (!validRecord(record)) throw failure();
      privateDirectory();
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(aad);
      const plain = Object.fromEntries(['credential', 'requestId', 'expires', 'offset', 'stream'].map(field => [field, record[field]]));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain)), cipher.final()]);
      temporary = filename + '.' + randomBytes(12).toString('hex') + '.tmp';
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, filename); temporary = undefined; syncDirectory();
    } catch {throw failure();} finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary) {try {unlinkSync(temporary);} catch {}}
    }
  }
  function remove(requestId) {
    try {
      const record = read();
      if (!record || record.requestId !== requestId) return;
      unlinkSync(filename); syncDirectory();
    } catch {throw failure();}
  }
  return {read, write, remove};
}
