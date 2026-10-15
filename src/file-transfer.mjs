// Shared v2 client for browser and native adapters. No App or image file paths.
export const FILE_PROTOCOL = 'vrch-file-v2';
export const FILE_MAGIC = new Uint8Array([86, 82, 67, 72, 70, 84, 50, 0]);
const HEADER = 40, CHUNK = 60 * 1024;
const error = (code, message) => Object.assign(new Error(message), {code});
export function operationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function isFileFrame(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytes.length >= 8 && FILE_MAGIC.every((value, index) => bytes[index] === value);
}
function frame(job, offset, payload) {
  const bytes = new Uint8Array(HEADER + payload.byteLength), view = new DataView(bytes.buffer);
  bytes.set(FILE_MAGIC);
  bytes.set(job.id.match(/../g).map(value => parseInt(value, 16)), 8);
  view.setBigUint64(24, BigInt(job.generation), false); view.setBigUint64(32, BigInt(offset), false);
  bytes.set(new Uint8Array(payload), HEADER);
  return bytes;
}
export function browserHash(blob, end = blob.size, onProgress = () => {}, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./vrch_file_hash_worker.js?v=20261009-apps-a1', import.meta.url));
    const close = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { close(); reject(error('file_paused', 'File transfer paused.')); };
    worker.onmessage = ({data}) => {
      if (data.sha256) { close(); resolve(data.sha256); }
      else if (data.error) { close(); reject(error('hash_failed', data.error)); }
      else onProgress(data.progress, data.total);
    };
    worker.onerror = () => { close(); reject(error('hash_failed', 'File verification failed.')); };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) { abort(); return; }
    worker.postMessage({id: 1, blob, end});
  });
}
export function blobSource(blob, hash = browserHash) {
  return {size: blob.size, name: blob.name || 'file.bin',
    hash: (end, signal, progress) => hash(blob, end, progress, signal),
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())};
}
export function blobSink(hash = browserHash) {
  const parts = [];
  let size = 0;
  return {
    get size() { return size; },
    async write(bytes) { parts.push(bytes.slice()); size += bytes.length; },
    hash: (signal, progress) => hash(new Blob(parts), size, progress, signal),
    value: () => new Blob(parts),
    clear() { parts.length = 0; size = 0; }
  };
}

export class FileTransferClient {
  constructor({control, binary, epoch = () => undefined, onProgress = () => {}}) {
    Object.assign(this, {control, binary, epoch, onProgress});
    this.job = null; this.pending = null; this.serial = Promise.resolve();
  }
  emit(phase) {
    const job = this.job;
    if (job) this.onProgress({phase, id: job.id, operationId: job.operationId, direction: job.direction,
      confirmedBytes: job.offset || 0, size: job.size, name: job.name});
  }
  send(type, fields = {}) {
    const job = this.job;
    if (!this.control({type, protocol: FILE_PROTOCOL, operationId: job.operationId, id: job.id,
      generation: job.generation, inputEpoch: this.epoch(), ...fields})) throw error('file_paused', 'File transfer disconnected.');
  }
  begin(job) {
    if (this.pending) return Promise.reject(error('transfer_conflict', 'Another file is being transferred.'));
    this.job = job;
    return this.resume();
  }
  upload(source, {purpose, resource = {}, operationId: id = operationId(), maxBytes = Number.MAX_SAFE_INTEGER} = {}) {
    if (!source || !Number.isSafeInteger(source.size) || source.size < 0 || source.size > maxBytes) return Promise.reject(error('quota_exceeded', 'This file exceeds the allowed size.'));
    return this.begin({source, purpose, resource, operationId: id, direction: 'upload', size: source.size, name: source.name, offset: 0});
  }
  download({purpose, resource, operationId: id = operationId(), sink = blobSink(), maxBytes = 128 * 1024 * 1024}) {
    return this.begin({purpose, resource, operationId: id, direction: 'download', sink, maxBytes, offset: 0});
  }
  resume() {
    const job = this.job;
    if (!job || this.pending) return Promise.reject(error('transfer_conflict', 'The file is already active or unavailable.'));
    job.abort = new AbortController(); job.finishing = false; job.awaiting = null;
    const promise = new Promise((resolve, reject) => {this.pending = {resolve, reject};});
    this.emit('preparing');
    void (async () => {
      try {
        if (job.direction === 'upload') {
          // Reverify bytes on every resume; a native source may have changed.
          const sha256 = await job.source.hash(job.size, job.abort.signal, () => this.emit('preparing'));
          if (job.sha256 && job.sha256 !== sha256) throw error('source_changed', 'The source file changed. Start a new transfer.');
          job.sha256 = sha256;
        }
        if (job.abort.signal.aborted || this.job !== job) return;
        if (job.id) {
          const fields = {};
          if (job.direction === 'download') {
            fields.offset = job.sink.size;
            fields.prefixSha256 = await job.sink.hash(job.abort.signal);
          }
          this.send('file_resume', fields);
        } else this.send('file_begin', {purpose: job.purpose, resource: job.resource, direction: job.direction,
          ...(job.direction === 'upload' ? {name: job.name, size: job.size, sha256: job.sha256} : {})});
      } catch (failure) { this.fail(failure); }
    })();
    return promise;
  }
  async nextUpload(job) {
    if (job.offset === job.size) {
      if (!job.finishing) {job.finishing = true; this.emit('verifying'); this.send('file_finish');}
      return;
    }
    if (job.awaiting !== null) return;
    const bytes = await job.source.read(job.offset, Math.min(CHUNK, job.size - job.offset));
    if (job.abort.signal.aborted || this.job !== job) return;
    if (bytes.length !== Math.min(CHUNK, job.size - job.offset)) throw error('source_changed', 'The source file changed.');
    job.awaiting = job.offset + bytes.length;
    if (!this.binary(frame(job, job.offset, bytes))) throw error('file_paused', 'File transfer disconnected.');
  }
  async finishDownload(job) {
    if (job.finishing) return;
    job.finishing = true; this.emit('verifying');
    const sha256 = await job.sink.hash(job.abort.signal, () => this.emit('verifying'));
    if (job.abort.signal.aborted || this.job !== job) return;
    if (sha256 !== job.sha256) throw error('hash_mismatch', 'Downloaded file verification failed.');
    this.send('file_finish', {sha256});
  }
  handle(value) {
    const binary = value instanceof ArrayBuffer || ArrayBuffer.isView(value);
    if (binary ? !isFileFrame(value) : value?.protocol !== FILE_PROTOCOL) return false;
    this.serial = this.serial.then(() => this.receive(value, binary)).catch(failure => this.fail(failure));
    return true;
  }
  async receive(value, binary) {
    const job = this.job;
    if (!job || !this.pending) return;
    if (binary) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.length <= HEADER || bytes.length > HEADER + CHUNK) throw error('invalid_chunk', 'Invalid file block.');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const id = [...bytes.subarray(8, 24)].map(value => value.toString(16).padStart(2, '0')).join('');
      const generation = Number(view.getBigUint64(24, false)), offset = Number(view.getBigUint64(32, false));
      if (id !== job.id || generation !== job.generation) return;
      if (job.direction !== 'download' || offset !== job.sink.size || offset + bytes.length - HEADER > job.size) throw error('invalid_chunk', 'Unexpected file block.');
      await job.sink.write(bytes.subarray(HEADER));
      if (job.abort.signal.aborted) return;
      job.offset = job.sink.size; this.emit('transferring');
      this.send('file_ack', {nextOffset: job.offset});
      if (job.offset === job.size) await this.finishDownload(job);
      return;
    }
    if ((value.operationId && value.operationId !== job.operationId) || (value.id && job.id && value.id !== job.id)) return;
    if (value.type === 'file_error') throw error(value.code, value.message);
    if (value.type === 'file_paused' || value.type === 'file_canceled') throw error('file_paused', 'File transfer paused.');
    if (value.type === 'file_ready') {
      if (!/^[0-9a-f]{32}$/.test(value.id) || !Number.isSafeInteger(value.generation) || value.generation < 1
          || !Number.isSafeInteger(value.size) || value.size < 0 || !Number.isSafeInteger(value.offset)
          || value.offset < 0 || value.offset > value.size || !/^[0-9a-f]{64}$/.test(value.sha256)) throw error('invalid_file', 'Invalid file metadata.');
      if (job.direction === 'upload' && (job.sha256 !== value.sha256 || job.size !== value.size)) throw error('source_changed', 'Transfer metadata changed.');
      if (job.direction === 'download' && (value.size > job.maxBytes || value.offset !== job.sink.size
          || (job.sha256 && job.sha256 !== value.sha256))) throw error('invalid_file', 'Download metadata changed.');
      Object.assign(job, {id: value.id, generation: value.generation, size: value.size, sha256: value.sha256, name: value.name, offset: value.offset});
      if (job.direction === 'upload') {
        const prefix = await job.source.hash(job.offset, job.abort.signal);
        if (prefix !== value.prefixSha256) throw error('partial_mismatch', 'Retained bytes differ from this file. Cancel and restart.');
        if (!job.abort.signal.aborted) {this.emit('transferring'); await this.nextUpload(job);}
      } else if (job.offset === job.size) await this.finishDownload(job);
      else this.emit('transferring');
    } else if (value.type === 'file_ack') {
      if (value.generation !== job.generation || job.direction !== 'upload') return;
      if (value.nextOffset === job.offset) return;
      if (value.nextOffset !== job.awaiting) throw error('invalid_chunk', 'Unexpected file acknowledgement.');
      job.offset = value.nextOffset; job.awaiting = null; this.emit('transferring'); await this.nextUpload(job);
    } else if (value.type === 'file_done') {
      if (value.sha256 !== job.sha256 || (job.direction === 'download' && job.sink.size !== job.size)) throw error('download_bytes_missing', 'Start this download again to receive its bytes.');
      const pending = this.pending; this.pending = null; this.emit('complete');
      pending.resolve({...value, ...(job.sink ? {file: job.sink.value()} : {})});
    }
  }
  fail(failure) {
    if (!this.pending) return;
    this.job?.abort.abort();
    const pending = this.pending; this.pending = null; this.emit('paused'); pending.reject(failure);
  }
  interrupt() { this.fail(error('file_paused', 'File transfer disconnected. Resume when connected.')); }
  pause() {
    try { if (this.job?.id) this.send('file_pause'); } finally {this.fail(error('file_paused', 'File transfer paused.'));}
  }
  cancel() {
    try { if (this.job?.id) this.send('file_cancel'); } finally {
      this.fail(error('file_canceled', 'File transfer canceled.')); this.job?.sink?.clear(); this.job = null;
    }
  }
}
