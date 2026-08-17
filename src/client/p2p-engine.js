// FluxTransfer Internet-Only WebRTC Engine
// Transport: PeerJS signaling + one reliable WebRTC DataChannel.
// No local HTTP upload, UDP discovery, server relay, or insecure crypto fallback.
(function (window) {
  'use strict';

  const HASH_WINDOW_SIZE = 4 * 1024 * 1024;
  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_HIGH = 4 * 1024 * 1024;
  const BUFFER_LOW = 1 * 1024 * 1024;
  const ACK_TIMEOUT_MS = 60_000;

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function bytesToBase64(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const block = 0x8000;
    for (let i = 0; i < view.length; i += block) {
      binary += String.fromCharCode(...view.subarray(i, i + block));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function sha256Pure(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const padLen = 64 - ((bytes.length + 8) % 64);
    const totalLen = bytes.length + padLen + 8;
    const padded = new Uint8Array(totalLen);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    const view = new DataView(padded.buffer);
    const bitLen = bytes.length * 8;
    view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(totalLen - 4, bitLen >>> 0, false);

    const H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const W = new Uint32Array(64);
    const rotr = (value, amount) => ((value >>> amount) | (value << (32 - amount))) >>> 0;

    for (let offset = 0; offset < totalLen; offset += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = (rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)) >>> 0;
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const temp1 = (h + s1 + ch + K[i] + W[i]) >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temp2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    H.forEach((value, i) => outView.setUint32(i * 4, value, false));
    return out;
  }

  async function sha256Digest(buffer) {
    if (window.crypto?.subtle) {
      try {
        return new Uint8Array(await window.crypto.subtle.digest('SHA-256', buffer));
      } catch (_) {}
    }
    return sha256Pure(buffer);
  }

  function combineChunks(chunks, totalSize) {
    const BLOCK_SIZE = 16 * 1024 * 1024;
    const combined = [];
    let currentBlock = new Uint8Array(Math.min(BLOCK_SIZE, totalSize));
    let currentPos = 0;
    let bytesWritten = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      
      const arr = ArrayBuffer.isView(chunk)
        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : new Uint8Array(chunk);

      let chunkPos = 0;
      while (chunkPos < arr.byteLength) {
        const remainingInBlock = BLOCK_SIZE - currentPos;
        const bytesToCopy = Math.min(arr.byteLength - chunkPos, remainingInBlock);
        
        currentBlock.set(arr.subarray(chunkPos, chunkPos + bytesToCopy), currentPos);
        currentPos += bytesToCopy;
        chunkPos += bytesToCopy;
        bytesWritten += bytesToCopy;
        
        if (currentPos === BLOCK_SIZE) {
          combined.push(currentBlock);
          const remainingTotal = totalSize - bytesWritten;
          currentBlock = new Uint8Array(Math.min(BLOCK_SIZE, remainingTotal));
          currentPos = 0;
        }
      }
      chunks[i] = null;
    }

    if (currentPos > 0) {
      combined.push(currentBlock.subarray(0, currentPos));
    }

    return combined;
  }

  async function canonicalHash(fileOrChunks) {
    if (Array.isArray(fileOrChunks)) {
      const chunks = fileOrChunks.filter(Boolean);
      let totalSize = 0;
      for (let i = 0; i < chunks.length; i++) {
        totalSize += chunks[i].byteLength;
      }

      if (totalSize <= HASH_WINDOW_SIZE) {
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (let i = 0; i < chunks.length; i++) {
          const arr = ArrayBuffer.isView(chunks[i])
            ? new Uint8Array(chunks[i].buffer, chunks[i].byteOffset, chunks[i].byteLength)
            : new Uint8Array(chunks[i]);
          combined.set(arr, offset);
          offset += arr.byteLength;
        }
        const digest = await sha256Digest(combined.buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      }

      const windowDigests = [];
      let windowBuf = new Uint8Array(HASH_WINDOW_SIZE);
      let windowPos = 0;

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const arr = ArrayBuffer.isView(c)
          ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
          : new Uint8Array(c);

        let chunkPos = 0;
        while (chunkPos < arr.byteLength) {
          const bytesToCopy = Math.min(arr.byteLength - chunkPos, HASH_WINDOW_SIZE - windowPos);
          windowBuf.set(arr.subarray(chunkPos, chunkPos + bytesToCopy), windowPos);
          windowPos += bytesToCopy;
          chunkPos += bytesToCopy;

          if (windowPos === HASH_WINDOW_SIZE) {
            const digest = await sha256Digest(windowBuf.buffer);
            windowDigests.push(new Uint8Array(digest));
            windowBuf = new Uint8Array(HASH_WINDOW_SIZE);
            windowPos = 0;
          }
        }
      }

      if (windowPos > 0) {
        const digest = await sha256Digest(windowBuf.slice(0, windowPos).buffer);
        windowDigests.push(new Uint8Array(digest));
      }

      let combinedLen = windowDigests.length * 32;
      const combinedHashes = new Uint8Array(combinedLen);
      windowDigests.forEach((d, i) => combinedHashes.set(d, i * 32));

      const finalDigest = await sha256Digest(combinedHashes.buffer);
      return [...new Uint8Array(finalDigest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let blob = fileOrChunks instanceof Blob ? fileOrChunks : null;
    if (!blob) throw new Error('Unsupported hash input');

    if (blob.size <= HASH_WINDOW_SIZE) {
      const digest = await sha256Digest(await blob.arrayBuffer());
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const windowHashes = [];
    for (let offset = 0; offset < blob.size; offset += HASH_WINDOW_SIZE) {
      const slice = await blob.slice(offset, offset + HASH_WINDOW_SIZE).arrayBuffer();
      windowHashes.push(await sha256Digest(slice));
    }

    const combined = new Uint8Array(windowHashes.length * 32);
    windowHashes.forEach((digest, i) => combined.set(new Uint8Array(digest), i * 32));
    const finalDigest = await sha256Digest(combined.buffer);
    return [...new Uint8Array(finalDigest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function createHashWorker() {
    if (typeof Worker === 'undefined') return null;
    try {
      return new Worker('/hash-worker.js');
    } catch (_) {
      return null;
    }
  }

  async function computeHashWithWorker(payload) {
    const worker = createHashWorker();
    if (!worker) return canonicalHash(payload);

    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      let totalSize = 0;
      if (payload instanceof Blob) {
        totalSize = payload.size;
      } else if (Array.isArray(payload)) {
        for (let c of payload) {
          if (c) totalSize += c.byteLength || 0;
        }
      }
      // Allow 3 seconds per megabyte for hashing, with a minimum of 3 minutes (180s)
      const timeoutDuration = Math.max(180_000, (totalSize / (1024 * 1024)) * 3000);
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('SHA-256 calculation timed out'));
      }, timeoutDuration);

      worker.onmessage = event => {
        if (event.data.id !== id) return;
        clearTimeout(timeout);
        worker.terminate();
        if (event.data.status === 'success') resolve(event.data.hash);
        else reject(new Error(event.data.error || 'Hashing failed'));
      };
      worker.onerror = event => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(event.message || 'Hash worker failed'));
      };

      if (payload instanceof Blob) worker.postMessage({ id, file: payload });
      else worker.postMessage({ id, chunks: payload });
    });
  }

  function saveTransferRecord(record) {
    try {
      const history = JSON.parse(localStorage.getItem('flux_transfer_history') || '[]');
      history.unshift(record);
      localStorage.setItem('flux_transfer_history', JSON.stringify(history.slice(0, 50)));
    } catch (_) {}
  }

  function getTransferHistory() {
    try {
      return JSON.parse(localStorage.getItem('flux_transfer_history') || '[]');
    } catch (_) {
      return [];
    }
  }

  function clearTransferHistory() {
    try { localStorage.removeItem('flux_transfer_history'); } catch (_) {}
  }

  async function createZipBundle(fileList, archiveName = 'FluxTransfer_Bundle.zip', compress = false) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded');
    const zip = new JSZip();
    for (const file of fileList) zip.file(file.webkitRelativePath || file.name, file);
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: compress ? 'DEFLATE' : 'STORE',
      compressionOptions: compress ? { level: 6 } : undefined
    });
    return new File([blob], archiveName, { type: 'application/zip' });
  }

  function getDataChannel(connection) {
    const dc = connection?.dataChannel || connection?._dc || connection;
    if (!dc || typeof dc.send !== 'function' || typeof dc.readyState !== 'string') {
      throw new Error('WebRTC data channel is unavailable');
    }
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    return dc;
  }

  async function waitForBuffer(dc, isActive) {
    if (!isActive()) throw new Error('Transfer cancelled');
    while (dc.readyState === 'open' && dc.bufferedAmount > BUFFER_HIGH) {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (!isActive()) throw new Error('Transfer cancelled');
    }
    if (dc.readyState !== 'open') throw new Error('WebRTC connection closed');
  }

  class FluxEngine {
    constructor() {
      this.chunkSize = CHUNK_SIZE;
      this.bufferHigh = BUFFER_HIGH;
    }

    async deriveKey(sessionCode, salt) {
      if (!window.isSecureContext || !window.crypto?.subtle) {
        throw new Error('FluxTransfer requires HTTPS or localhost for secure encryption');
      }
      const cleanCode = String(sessionCode || '').trim().toUpperCase().replace(/^FT-/i, '');
      if (!cleanCode) throw new Error('Missing transfer code');

      const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(cleanCode),
        'PBKDF2',
        false,
        ['deriveKey']
      );
      return window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    async encryptChunk(file, chunkIndex, aesKey) {
      const raw = await file.slice(chunkIndex * this.chunkSize, (chunkIndex + 1) * this.chunkSize).arrayBuffer();
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, raw);
      const frame = new Uint8Array(4 + 12 + encrypted.byteLength);
      new DataView(frame.buffer).setUint32(0, chunkIndex, false);
      frame.set(iv, 4);
      frame.set(new Uint8Array(encrypted), 16);
      return { frame, size: raw.byteLength };
    }

    async decryptFrame(frameData, aesKey) {
      const buffer = frameData instanceof ArrayBuffer ? frameData : frameData.buffer.slice(frameData.byteOffset, frameData.byteOffset + frameData.byteLength);
      if (buffer.byteLength < 32) throw new Error('Invalid transfer frame');
      const view = new DataView(buffer);
      const chunkIndex = view.getUint32(0, false);
      const iv = new Uint8Array(buffer, 4, 12);
      const encrypted = buffer.slice(16);
      const chunkData = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encrypted);
      return { chunkIndex, chunkData };
    }

    async sendFile(connections, file, sessionCode, onProgress, isActive = () => true) {
      const list = Array.isArray(connections) ? connections : [connections];
      const channels = list.map(getDataChannel).filter(Boolean);
      if (!channels.length) throw new Error('No WebRTC data channels are available');
      if (!(file instanceof File)) throw new Error('Invalid file');
      channels.forEach(dc => {
        if (dc.readyState !== 'open') throw new Error('A WebRTC data channel is not open');
      });

      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const aesKey = await this.deriveKey(sessionCode, salt);
      const hashPromise = computeHashWithWorker(file);
      const totalChunks = Math.max(1, Math.ceil(file.size / this.chunkSize));
      const startedAt = Date.now();
      let sent = 0;

      const meta = {
        type: 'meta',
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        chunkSize: this.chunkSize,
        totalChunks,
        salt: bytesToBase64(salt),
        streamCount: channels.length
      };

      // Send metadata on every stream. This prevents a fast binary stream from
      // ever being processed before that stream has received the transfer key.
      const metaMessage = JSON.stringify(meta);
      channels.forEach(dc => dc.send(metaMessage));

      const sendChunk = async (dc, index) => {
        await waitForBuffer(dc, isActive);
        const { frame, size } = await this.encryptChunk(file, index, aesKey);
        dc.send(frame.buffer);
        sent += size;
        if (onProgress) {
          const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
          onProgress({
            loaded: sent,
            total: file.size,
            pct: file.size ? Math.min(100, (sent / file.size) * 100) : 100,
            speedBps: sent / seconds
          });
        }
      };

      // One worker per independent PeerJS data connection. Each worker handles
      // a disjoint subset of chunk indices, while the frame index preserves the
      // original file order at the receiver.
      let nextIndex = 0;
      const workers = channels.map(dc => (async () => {
        while (true) {
          if (!isActive()) throw new Error('Transfer cancelled');
          const index = nextIndex++;
          if (index >= totalChunks) return;
          await sendChunk(dc, index);
        }
      })());
      await Promise.all(workers);

      // Ensure every stream has flushed all queued data before EOF is sent.
      await Promise.all(channels.map(async dc => {
        while (dc.readyState === 'open' && dc.bufferedAmount > 0) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (dc.readyState !== 'open') throw new Error('WebRTC connection closed before EOF');
      }));

      const hash = await hashPromise;

      // Install the ACK listeners before EOF is sent. With a fast local/nearby
      // route the receiver can verify and ACK immediately; attaching listeners
      // after EOF creates a real completion race.
      await new Promise((resolve, reject) => {
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          channels.forEach(dc => dc.removeEventListener('message', onMessage));
        };
        // Allow 3 seconds per megabyte for receiver to hash and save, with a minimum of 3 minutes (180s)
        const ackTimeout = Math.max(180_000, (file.size / (1024 * 1024)) * 3000);
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Receiver did not confirm transfer completion'));
        }, ackTimeout);
        const onMessage = event => {
          if (typeof event.data !== 'string') return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'ack') {
              cleanup();
              resolve();
            }
          } catch (_) {}
        };
        channels.forEach(dc => dc.addEventListener('message', onMessage));
        const eof = JSON.stringify({ type: 'eof', hash });
        channels.forEach(dc => dc.send(eof));
      });

      return { name: file.name, size: file.size, hash, streams: channels.length };
    }

    async receiveFile(connections, sessionCode, callbacks = {}) {
      const list = Array.isArray(connections) ? connections : [connections];
      const channels = list.map(getDataChannel).filter(Boolean);
      if (!channels.length) throw new Error('No WebRTC data channels are available');
      channels.forEach(dc => {
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = BUFFER_LOW;
      });

      let meta = null;
      let aesKey = null;
      let chunks = [];
      let receivedCount = 0;
      let receivedBytes = 0;
      let eofHash = null;
      let finished = false;
      let pending = 0;
      let finishStarted = false;
      const startedAt = Date.now();

      const isOpfsSupported = typeof Worker !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function';
      let opfsWorker = null;
      let opfsActive = false;

      if (isOpfsSupported) {
        try {
          opfsWorker = new Worker('/opfs-writer-worker.js');
          this.lastOpfsWorker = opfsWorker;
          opfsActive = true;
        } catch (workerErr) {
          console.warn('Failed to start OPFS worker:', workerErr);
          opfsActive = false;
        }
      }

      const postWorkerCmd = (type, payload) => {
        return new Promise((resolve, reject) => {
          if (!opfsWorker) return reject(new Error('OPFS worker is not active'));
          const id = Math.random().toString(36).slice(2);
          const onMsg = e => {
            if (e.data?.id === id) {
              opfsWorker.removeEventListener('message', onMsg);
              if (e.data.ok) resolve(e.data.result);
              else reject(new Error(e.data.error));
            }
          };
          opfsWorker.addEventListener('message', onMsg);
          opfsWorker.postMessage({ id, type, payload });
        });
      };

      let resolveTransfer;
      let rejectTransfer;
      const resultPromise = new Promise((resolve, reject) => {
        resolveTransfer = resolve;
        rejectTransfer = reject;
      });

      let resolveMeta;
      let rejectMeta;
      const metaReady = new Promise((resolve, reject) => {
        resolveMeta = resolve;
        rejectMeta = reject;
      });

      const cleanup = () => {
        channels.forEach(dc => {
          dc.removeEventListener('message', onMessage);
          dc.removeEventListener('close', onClose);
        });
      };

      const fail = error => {
        if (finished) return;
        finished = true;
        cleanup();
        if (opfsWorker) {
          try { opfsWorker.postMessage({ type: 'abort' }); } catch (_) {}
          try { opfsWorker.terminate(); } catch (_) {}
          if (this.lastOpfsWorker === opfsWorker) this.lastOpfsWorker = null;
        }
        try { rejectMeta(error); } catch (_) {}
        rejectTransfer(error);
      };

      const finish = async () => {
        if (finished || finishStarted || !meta || !eofHash) return;
        if (receivedCount !== meta.totalChunks || pending !== 0) return;
        finishStarted = true;

        try {
          if (opfsActive) {
            try {
              await postWorkerCmd('finalize');
              const fileObj = await postWorkerCmd('get-file');

              // Read file back to verify integrity
              const hash = await computeHashWithWorker(fileObj);
              if (hash !== eofHash) throw new Error('SHA-256 integrity check failed');

              const ack = JSON.stringify({ type: 'ack', hash });
              channels[0].send(ack);

              finished = true;
              cleanup();
              resolveTransfer({ blob: fileObj, meta: { ...meta, hash }, hash, streams: channels.length });
              return;
            } catch (opfsFinishErr) {
              console.error('OPFS finalization failed, falling back to RAM:', opfsFinishErr);
              opfsActive = false;
            }
          }

          // Legacy fallback path:
          const ordered = new Array(meta.totalChunks);
          for (let i = 0; i < ordered.length; i++) {
            if (!chunks[i]) throw new Error(`Missing chunk ${i}`);
            ordered[i] = chunks[i];
          }
          const hash = await canonicalHash(ordered);
          if (hash !== eofHash) throw new Error('SHA-256 integrity check failed');

          const combined = combineChunks(ordered, meta.size);
          const blob = new Blob(combined, { type: meta.mime || 'application/octet-stream' });

          const ack = JSON.stringify({ type: 'ack', hash });
          channels[0].send(ack);

          finished = true;
          cleanup();
          resolveTransfer({ blob, meta: { ...meta, hash }, hash, streams: channels.length });
        } catch (error) {
          fail(error);
        }
      };

      const processMessage = async event => {
        if (finished) return;
        if (typeof event.data === 'string') {
          let msg;
          try { msg = JSON.parse(event.data); } catch (_) { return; }

          if (msg.type === 'meta') {
            if (!meta) {
              meta = msg;
              chunks = new Array(meta.totalChunks);
              try {
                aesKey = await this.deriveKey(sessionCode, base64ToBytes(meta.salt));

                if (opfsActive) {
                  try {
                    await postWorkerCmd('init', { name: meta.name, size: meta.size, mime: meta.mime });
                  } catch (opfsInitErr) {
                    console.error('OPFS init failed, falling back to RAM:', opfsInitErr);
                    opfsActive = false;
                  }
                }

                resolveMeta();
                callbacks.onMeta?.(meta);
              } catch (error) {
                rejectMeta(error);
                throw error;
              }
            }
            return;
          }

          if (msg.type === 'eof' && msg.hash) {
            eofHash = msg.hash;
            await finish();
          }
          return;
        }

        await metaReady;
        if (!aesKey || !meta) throw new Error('Transfer key was not initialized');

        const decoded = await this.decryptFrame(event.data, aesKey);
        if (decoded.chunkIndex < 0 || decoded.chunkIndex >= meta.totalChunks) {
          throw new Error('Received invalid chunk index');
        }

        if (!chunks[decoded.chunkIndex]) {
          let storedInOpfs = false;
          if (opfsActive) {
            try {
              await postWorkerCmd('write', { position: decoded.chunkIndex * meta.chunkSize, data: decoded.chunkData });
              chunks[decoded.chunkIndex] = true;
              storedInOpfs = true;
            } catch (writeErr) {
              console.error('OPFS write chunk error:', writeErr);
            }
          }

          if (!storedInOpfs) {
            chunks[decoded.chunkIndex] = decoded.chunkData;
          }

          receivedCount += 1;
          receivedBytes += decoded.chunkData.byteLength;

          if (callbacks.onProgress) {
            const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
            callbacks.onProgress({
              loaded: receivedBytes,
              total: meta.size,
              pct: meta.size ? Math.min(100, (receivedBytes / meta.size) * 100) : 100,
              speedBps: receivedBytes / seconds
            });
          }
        }
      };

      function onMessage(event) {
        pending += 1;
        processMessage(event)
          .catch(fail)
          .finally(() => {
            pending -= 1;
            finish();
          });
      }

      function onClose() {
        if (!finished) fail(new Error('A WebRTC stream closed before transfer completed'));
      }

      channels.forEach(dc => {
        dc.addEventListener('message', onMessage);
        dc.addEventListener('close', onClose, { once: true });
      });

      return resultPromise;
    }

    // Backward-compatible aliases for any remaining UI code.
    async sendViaWebRTC(connections, file, sessionCode, onProgress, isActive) {
      return this.sendFile(connections, file, sessionCode, onProgress, isActive);
    }
  }

  window.FluxEngine = FluxEngine;
  window.bytesToBase64 = bytesToBase64;
  window.base64ToBytes = base64ToBytes;
  window.saveTransferRecord = saveTransferRecord;
  window.getTransferHistory = getTransferHistory;
  window.clearTransferHistory = clearTransferHistory;
  window.createZipBundle = createZipBundle;
  window.canonicalHash = canonicalHash;
})(window);
