/**
 * FluxTransfer — SHA-256 Integrity Verification Service
 */
function getWorkerPath(workerName) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require !== 'undefined') {
    try {
      const cfg = require('../config/app-config.js');
      if (cfg && typeof cfg.getWorkerPath === 'function') return cfg.getWorkerPath(workerName);
    } catch (_) {}
  }
  return workerName.startsWith('/') ? workerName : `/${workerName}`;
}

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

class StreamingSHA256 {
  constructor() {
    this.reset();
  }

  reset() {
    this.H0 = 0x6a09e667; this.H1 = 0xbb67ae85; this.H2 = 0x3c6ef372; this.H3 = 0xa54ff53a;
    this.H4 = 0x510e527f; this.H5 = 0x9b05688c; this.H6 = 0x1f83d9ab; this.H7 = 0x5be0cd19;
    this.buffer = new Uint8Array(64);
    this.bufferLen = 0;
    this.totalBytes = 0;
    this.W = new Uint32Array(64);
  }

  _processBlock(blockBytes) {
    const view = new DataView(blockBytes.buffer, blockBytes.byteOffset, 64);
    const W = this.W;
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^ ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^ (W[t - 15] >>> 3);
      const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^ ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }

    let a = this.H0, b = this.H1, c = this.H2, d = this.H3;
    let e = this.H4, f = this.H5, g = this.H6, h = this.H7;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    this.H0 = (this.H0 + a) | 0; this.H1 = (this.H1 + b) | 0;
    this.H2 = (this.H2 + c) | 0; this.H3 = (this.H3 + d) | 0;
    this.H4 = (this.H4 + e) | 0; this.H5 = (this.H5 + f) | 0;
    this.H6 = (this.H6 + g) | 0; this.H7 = (this.H7 + h) | 0;
  }

  update(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.totalBytes += bytes.length;

    let pos = 0;
    if (this.bufferLen > 0) {
      const needed = 64 - this.bufferLen;
      const copy = Math.min(needed, bytes.length);
      this.buffer.set(bytes.subarray(0, copy), this.bufferLen);
      this.bufferLen += copy;
      pos += copy;

      if (this.bufferLen === 64) {
        this._processBlock(this.buffer);
        this.bufferLen = 0;
      }
    }

    while (pos + 64 <= bytes.length) {
      this._processBlock(bytes.subarray(pos, pos + 64));
      pos += 64;
    }

    if (pos < bytes.length) {
      const remaining = bytes.subarray(pos);
      this.buffer.set(remaining, 0);
      this.bufferLen = remaining.length;
    }
  }

  digestHex() {
    const totalBits = this.totalBytes * 8;
    const padLen = (((this.bufferLen + 8) >> 6) + 1) << 6;
    const padded = new Uint8Array(padLen);
    padded.set(this.buffer.subarray(0, this.bufferLen));
    padded[this.bufferLen] = 0x80;

    const view = new DataView(padded.buffer);
    const highBits = Math.floor(totalBits / 0x100000000);
    const lowBits = totalBits % 0x100000000;
    view.setUint32(padLen - 8, highBits, false);
    view.setUint32(padLen - 4, lowBits, false);

    for (let i = 0; i < padLen; i += 64) {
      this._processBlock(padded.subarray(i, i + 64));
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, this.H0, false); outView.setUint32(4, this.H1, false);
    outView.setUint32(8, this.H2, false); outView.setUint32(12, this.H3, false);
    outView.setUint32(16, this.H4, false); outView.setUint32(20, this.H5, false);
    outView.setUint32(24, this.H6, false); outView.setUint32(28, this.H7, false);

    return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

async function computeHash(payload) {
  if (typeof Worker !== 'undefined' && (payload instanceof Blob || (typeof File !== 'undefined' && payload instanceof File))) {
    try {
      const workerPath = getWorkerPath('/hash-worker.js');
      const worker = new Worker(workerPath);
      const hashResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { worker.terminate(); } catch (_) { }
          reject(new Error('Hash worker timeout'));
        }, 30000);
        worker.onmessage = (e) => {
          if (e.data?.type === 'complete') {
            clearTimeout(timer);
            try { worker.terminate(); } catch (_) { }
            resolve(e.data.hash);
          } else if (e.data?.type === 'error') {
            clearTimeout(timer);
            try { worker.terminate(); } catch (_) { }
            reject(new Error(e.data.message));
          }
        };
        worker.postMessage({ type: 'hash-file', file: payload });
      });
      return hashResult;
    } catch (_) {
      // Fallback if worker creation fails (e.g. cross-origin/sandbox)
    }
  }

  return await canonicalHashFallback(payload);
}

async function canonicalHashFallback(fileOrChunks) {
  if (fileOrChunks instanceof Blob || (typeof File !== 'undefined' && fileOrChunks instanceof File)) {
    const chunkSize = 1024 * 1024; // 1 MB streaming slices
    let offset = 0;
    const total = fileOrChunks.size;

    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function' && total <= chunkSize) {
      const buf = await fileOrChunks.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const hasher = new StreamingSHA256();
    while (offset < total) {
      const slice = fileOrChunks.slice(offset, Math.min(offset + chunkSize, total));
      const buf = await slice.arrayBuffer();
      hasher.update(new Uint8Array(buf));
      offset += buf.byteLength;
    }
    return hasher.digestHex();
  }

  if (Array.isArray(fileOrChunks)) {
    const hasher = new StreamingSHA256();
    for (let c of fileOrChunks) {
      if (!c) continue;
      const arr = ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c);
      hasher.update(arr);
    }
    return hasher.digestHex();
  }

  return `hash_${Date.now()}`;
}

function sha256(data) {
  const hasher = new StreamingSHA256();
  const bytes = data instanceof Uint8Array ? data : (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  hasher.update(bytes);
  const hex = hasher.digestHex();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const HashService = {
  StreamingSHA256,
  computeHash,
  canonicalHashFallback,
  sha256
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = HashService;
  module.exports.default = HashService;
  module.exports.HashService = HashService;
  module.exports.StreamingSHA256 = StreamingSHA256;
  module.exports.computeHash = computeHash;
  module.exports.canonicalHashFallback = canonicalHashFallback;
  module.exports.sha256 = sha256;
}

export {
  StreamingSHA256,
  computeHash,
  canonicalHashFallback,
  sha256,
  HashService
};

export default HashService;
