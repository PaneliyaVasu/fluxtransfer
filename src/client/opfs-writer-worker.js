/**
 * FluxTransfer — Receiver OPFS Disk Storage Streaming Worker
 * 
 * Streams incoming decrypted file chunks directly to Origin Private File System (OPFS)
 * via FileSystemSyncAccessHandle, keeping RAM footprint near zero on large file receives.
 * Supports non-destructive partial file preservation for resumable transfers.
 */

let accessHandle = null;
let fileHandle = null;
let fileName = null;

self.onmessage = async function (e) {
  const { type, fileName: fName, transferId, isResume, chunkIndex, offset, buffer, id } = e.data || {};

  try {
    if (type === 'init') {
      fileName = fName || (transferId ? `flux_partial_${transferId}.bin` : `flux_received_${Date.now()}.bin`);
      const root = await navigator.storage.getDirectory();
      fileHandle = await root.getFileHandle(fileName, { create: true });
      
      if (typeof fileHandle.createSyncAccessHandle === 'function') {
        accessHandle = await fileHandle.createSyncAccessHandle();
        if (!isResume) {
          accessHandle.truncate(0);
        }
      } else {
        throw new Error('FileSystemSyncAccessHandle is not supported in this browser worker');
      }
      
      self.postMessage({ type: 'init-ack', id, success: true });

    } else if (type === 'write') {
      if (!accessHandle) {
        throw new Error('OPFS access handle not initialized');
      }
      const dataView = new Uint8Array(buffer);
      accessHandle.write(dataView, { at: offset });
      self.postMessage({ type: 'write-ack', id, chunkIndex });

    } else if (type === 'finalize') {
      if (accessHandle) {
        accessHandle.flush();
        accessHandle.close();
        accessHandle = null;
      }

      let fileObj = null;
      if (fileHandle) {
        fileObj = await fileHandle.getFile();
      }

      self.postMessage({ type: 'finalize-ack', id, file: fileObj });

    } else if (type === 'preserve' || type === 'close-handle') {
      if (accessHandle) {
        try { accessHandle.flush(); } catch (_) {}
        try { accessHandle.close(); } catch (_) {}
        accessHandle = null;
      }
      self.postMessage({ type: 'preserve-ack', id });

    } else if (type === 'abort') {
      if (accessHandle) {
        try { accessHandle.close(); } catch (_) {}
        accessHandle = null;
      }
      if (fileHandle && fileName) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(fileName);
        } catch (_) {}
      }
      self.postMessage({ type: 'abort-ack', id });
    }
  } catch (err) {
    if (accessHandle) {
      try { accessHandle.close(); } catch (_) {}
      accessHandle = null;
    }
    self.postMessage({ type: 'error', id, message: err.message || 'OPFS worker error' });
  }
};
