/**
 * FluxTransfer — Receiver Storage Abstraction (OPFS Storage & Safe Memory Fallback)
 */
let getWorkerPath = (name) => name.startsWith('/') ? name : `/${name}`;
let MAX_MEMORY_FALLBACK_SIZE = 300 * 1024 * 1024;

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require !== 'undefined') {
  try {
    const cfg = require('../config/app-config.js');
    if (cfg && typeof cfg.getWorkerPath === 'function') getWorkerPath = cfg.getWorkerPath;
    if (cfg && cfg.MAX_MEMORY_FALLBACK_SIZE) MAX_MEMORY_FALLBACK_SIZE = cfg.MAX_MEMORY_FALLBACK_SIZE;
  } catch (_) {}
}

class BaseReceiverStorage {
  constructor() {
    this.isOPFS = false;
  }
  async initialize(meta) { throw new Error('Not implemented'); }
  async writeChunk(chunkIndex, offset, chunkData) { throw new Error('Not implemented'); }
  async finalize() { throw new Error('Not implemented'); }
  async preserve() { }
  async abort() { throw new Error('Not implemented'); }
  async purge() { await this.abort(); }
  async cleanup() { }
}

class OPFSStorage extends BaseReceiverStorage {
  constructor() {
    super();
    this.isOPFS = true;
    this.worker = null;
    this.fileName = null;
  }

  async initialize(meta) {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function' || typeof Worker === 'undefined') {
      return false;
    }

    try {
      const workerPath = getWorkerPath('/opfs-writer-worker.js');
      const worker = new Worker(workerPath);
      const fileName = meta.transferId ? `flux_partial_${meta.transferId}.bin` : (meta.name || meta.fileName);
      this.fileName = fileName;

      const isInitialized = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500);
        worker.onmessage = (e) => {
          if (e.data?.type === 'init-ack') {
            clearTimeout(timer);
            resolve(true);
          } else if (e.data?.type === 'error') {
            clearTimeout(timer);
            resolve(false);
          }
        };
        worker.postMessage({ type: 'init', fileName, transferId: meta.transferId, isResume: Boolean(meta.isResume), totalSize: meta.size });
      });

      if (isInitialized) {
        this.worker = worker;
        return true;
      } else {
        try { worker.terminate(); } catch (_) { }
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  async writeChunk(chunkIndex, offset, chunkData) {
    if (!this.worker) throw new Error('OPFS worker not initialized');
    this.worker.postMessage({ type: 'write', chunkIndex, offset, buffer: chunkData }, [chunkData]);
  }

  async finalize() {
    if (!this.worker) throw new Error('OPFS worker not active');
    const fileObj = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OPFS worker finalize timed out')), 5000);
      this.worker.onmessage = (e) => {
        if (e.data?.type === 'finalize-ack') {
          clearTimeout(timer);
          resolve(e.data.file);
        } else if (e.data?.type === 'error') {
          clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      this.worker.postMessage({ type: 'finalize' });
    });
    this.cleanup();
    return fileObj;
  }

  async preserve() {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'preserve' }); } catch (_) { }
    }
    this.cleanup();
  }

  async abort() {
    await this.purge();
  }

  async purge() {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'abort' }); } catch (_) { }
    }
    if (this.fileName && typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.fileName);
      } catch (_) { }
    }
    this.cleanup();
  }

  async cleanup() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) { }
      this.worker = null;
    }
  }
}

class MemoryStorage extends BaseReceiverStorage {
  constructor() {
    super();
    this.isOPFS = false;
    this.chunks = null;
    this.meta = null;
  }

  async initialize(meta) {
    if (meta.size > MAX_MEMORY_FALLBACK_SIZE) {
      const maxMB = Math.round(MAX_MEMORY_FALLBACK_SIZE / (1024 * 1024));
      const sizeMB = (meta.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `OPFS storage is unavailable in this browser environment, and file size (${sizeMB} MB) exceeds safe in-memory limit (${maxMB} MB). Please use a browser supporting OPFS over HTTPS.`
      );
    }
    this.meta = meta;
    this.chunks = new Array(meta.totalChunks);
    return true;
  }

  async writeChunk(chunkIndex, offset, chunkData) {
    if (!this.chunks) throw new Error('Memory storage not initialized');
    this.chunks[chunkIndex] = chunkData;
  }

  async finalize() {
    if (!this.chunks) throw new Error('Memory storage not initialized');
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.chunks[i]) throw new Error(`Missing chunk at index ${i}`);
    }
    const blob = new Blob(this.chunks, { type: this.meta?.mimeType || 'application/octet-stream' });
    this.cleanup();
    return blob;
  }

  async preserve() {
    // MemoryStorage cannot survive tab close or process termination
    this.cleanup();
  }

  async abort() {
    this.cleanup();
  }

  async cleanup() {
    this.chunks = null;
    this.meta = null;
  }
}

async function createReceiverStorage(metadata) {
  const opfs = new OPFSStorage();
  const opfsOk = await opfs.initialize(metadata);
  if (opfsOk) {
    return opfs;
  }

  const memory = new MemoryStorage();
  await memory.initialize(metadata);
  return memory;
}

const ReceiverStorage = {
  BaseReceiverStorage,
  OPFSStorage,
  MemoryStorage,
  createReceiverStorage
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = ReceiverStorage;
  module.exports.default = ReceiverStorage;
  module.exports.ReceiverStorage = ReceiverStorage;
  module.exports.BaseReceiverStorage = BaseReceiverStorage;
  module.exports.OPFSStorage = OPFSStorage;
  module.exports.MemoryStorage = MemoryStorage;
  module.exports.createReceiverStorage = createReceiverStorage;
}

export {
  BaseReceiverStorage,
  OPFSStorage,
  MemoryStorage,
  createReceiverStorage,
  ReceiverStorage
};

export default ReceiverStorage;
