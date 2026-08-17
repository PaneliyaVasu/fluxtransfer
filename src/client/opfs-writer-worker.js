// FluxTransfer OPFS writer worker.
// Receives already-decrypted chunks and writes them directly to an OPFS file.
// FileSystemSyncAccessHandle is intentionally kept inside a dedicated worker
// because WebKit exposes synchronous OPFS read/write there.

let accessHandle = null;
let fileHandle = null;
let fileName = null;
let mimeType = 'application/octet-stream';
let fileSize = 0;

async function initFile({ name, size, mime }) {
  const root = await navigator.storage.getDirectory();
  const safe = String(name || 'download.bin').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 180) || 'download.bin';
  fileName = safe;
  mimeType = mime || mimeType;
  fileSize = Number(size) || 0;

  fileHandle = await root.getFileHandle(
    `fluxtransfer_${crypto.randomUUID()}_${safe}`,
    { create: true }
  );

  if (!fileHandle.createSyncAccessHandle) {
    throw new Error('OPFS synchronous writer is unavailable in this browser');
  }

  accessHandle = await fileHandle.createSyncAccessHandle();
  accessHandle.truncate(fileSize);
  accessHandle.flush();
  return { name: fileName, size: fileSize, mime: mimeType };
}

async function writeChunk({ position, data }) {
  if (!accessHandle) throw new Error('OPFS writer is not initialized');
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let written = 0;
  while (written < bytes.byteLength) {
    const n = accessHandle.write(bytes.subarray(written), { at: Number(position) + written });
    if (!n) throw new Error('Disk write returned zero bytes');
    written += n;
  }
  return written;
}

async function finalizeFile() {
  if (!accessHandle) throw new Error('OPFS writer is not initialized');
  accessHandle.flush();
  accessHandle.close();
  accessHandle = null;
  return true;
}

self.onmessage = async event => {
  const { id, type, payload } = event.data || {};
  try {
    let result;
    if (type === 'init') result = await initFile(payload);
    else if (type === 'write') result = await writeChunk(payload);
    else if (type === 'finalize') result = await finalizeFile();
    else if (type === 'abort') {
      if (accessHandle) {
        try { accessHandle.close(); } catch (_) {}
        accessHandle = null;
      }
      result = true;
    } else if (type === 'delete') {
      if (accessHandle) {
        try { accessHandle.close(); } catch (_) {}
        accessHandle = null;
      }
      if (fileHandle) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(fileHandle.name);
        } catch (_) {}
      }
      result = true;
    } else if (type === 'get-file') {
      const root = await navigator.storage.getDirectory();
      // fileHandle remains valid while the worker is alive. Flush and expose a
      // File clone back to the page for a memory-safe object URL download.
      if (accessHandle) accessHandle.flush();
      const file = await fileHandle.getFile();
      result = file;
    } else {
      throw new Error('Unknown OPFS worker command');
    }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
