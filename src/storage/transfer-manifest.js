/**
 * FluxTransfer — Resumable Transfer Manifest Manager (IndexedDB Persistence)
 * 
 * Manages atomic local persistence of partial file transfer metadata,
 * serializable StreamingSHA256 hash states, and 24-hour expiration records.
 * Includes an in-memory fallback for environments without IndexedDB (e.g. Node tests).
 */

const DB_NAME = 'flux_transfers_db';
const DB_VERSION = 1;
const STORE_NAME = 'flux_transfers';
const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours

const memoryStore = new Map();

function getIndexedDB() {
  if (typeof window !== 'undefined' && window.indexedDB) {
    return window.indexedDB;
  }
  if (typeof self !== 'undefined' && self.indexedDB) {
    return self.indexedDB;
  }
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) {
    return globalThis.indexedDB;
  }
  return null;
}

function openDB() {
  return new Promise((resolve) => {
    const idb = getIndexedDB();
    if (!idb) {
      resolve(null);
      return;
    }

    try {
      const request = idb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'transferId' });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function createManifest(metadata) {
  if (!metadata || !metadata.transferId) {
    throw new Error('Invalid manifest: transferId is required');
  }

  const now = Date.now();
  const manifest = {
    transferId: metadata.transferId,
    fileName: metadata.fileName || metadata.name || 'unnamed',
    fileSize: metadata.fileSize || metadata.size || 0,
    chunkSize: metadata.chunkSize || 128 * 1024,
    totalChunks: metadata.totalChunks || 0,
    lastContiguousChunk: metadata.lastContiguousChunk ?? -1,
    receivedBytes: metadata.receivedBytes || 0,
    salt: metadata.salt || '',
    resumeToken: metadata.resumeToken || '',
    streamingHashState: metadata.streamingHashState || null,
    createdAt: metadata.createdAt || now,
    updatedAt: now,
    expiresAt: metadata.expiresAt || (now + DEFAULT_EXPIRATION_MS),
    status: metadata.status || 'active'
  };

  memoryStore.set(manifest.transferId, manifest);

  const db = await openDB();
  if (!db) return manifest;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(manifest);
      req.onsuccess = () => resolve(manifest);
      req.onerror = () => resolve(manifest);
    } catch (_) {
      resolve(manifest);
    }
  });
}

async function getManifest(transferId) {
  if (!transferId) return null;
  const db = await openDB();
  if (!db) {
    return memoryStore.get(transferId) || null;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(transferId);
      req.onsuccess = () => resolve(req.result || memoryStore.get(transferId) || null);
      req.onerror = () => resolve(memoryStore.get(transferId) || null);
    } catch (_) {
      resolve(memoryStore.get(transferId) || null);
    }
  });
}

async function updateManifest(transferId, updates) {
  if (!transferId || !updates) return null;
  const existing = await getManifest(transferId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now()
  };

  memoryStore.set(transferId, updated);

  const db = await openDB();
  if (!db) return updated;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(updated);
      req.onsuccess = () => resolve(updated);
      req.onerror = () => resolve(updated);
    } catch (_) {
      resolve(updated);
    }
  });
}

async function deleteManifest(transferId) {
  if (!transferId) return true;
  memoryStore.delete(transferId);

  const db = await openDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(transferId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

async function listActiveManifests() {
  const db = await openDB();
  const now = Date.now();

  if (!db) {
    return Array.from(memoryStore.values()).filter(m => m.status === 'active' && m.expiresAt > now);
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const active = (req.result || []).filter(m => m.status === 'active' && m.expiresAt > now);
        resolve(active);
      };
      req.onerror = () => resolve(Array.from(memoryStore.values()).filter(m => m.status === 'active' && m.expiresAt > now));
    } catch (_) {
      resolve(Array.from(memoryStore.values()).filter(m => m.status === 'active' && m.expiresAt > now));
    }
  });
}

async function cleanupExpiredManifests() {
  const db = await openDB();
  const now = Date.now();
  const expiredIds = [];

  for (const [id, m] of memoryStore.entries()) {
    if (m.expiresAt <= now || m.status === 'expired') {
      expiredIds.push(id);
      memoryStore.delete(id);
    }
  }

  if (!db) return expiredIds;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const manifests = req.result || [];
        for (const m of manifests) {
          if (m.expiresAt <= now || m.status === 'expired') {
            if (!expiredIds.includes(m.transferId)) expiredIds.push(m.transferId);
            store.delete(m.transferId);
          }
        }
        resolve(expiredIds);
      };
      req.onerror = () => resolve(expiredIds);
    } catch (_) {
      resolve(expiredIds);
    }
  });
}

const TransferManifestManager = {
  createManifest,
  getManifest,
  updateManifest,
  deleteManifest,
  listActiveManifests,
  cleanupExpiredManifests
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = TransferManifestManager;
  module.exports.default = TransferManifestManager;
  module.exports.createManifest = createManifest;
  module.exports.getManifest = getManifest;
  module.exports.updateManifest = updateManifest;
  module.exports.deleteManifest = deleteManifest;
  module.exports.listActiveManifests = listActiveManifests;
  module.exports.cleanupExpiredManifests = cleanupExpiredManifests;
}

export {
  createManifest,
  getManifest,
  updateManifest,
  deleteManifest,
  listActiveManifests,
  cleanupExpiredManifests,
  TransferManifestManager
};

export default TransferManifestManager;
