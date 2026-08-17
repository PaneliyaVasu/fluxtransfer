// ─── FluxTransfer Web Worker: SHA-256 Off-Main-Thread File Integrity ───
// Canonical SHA-256 strategy: Windowed Merkle/Combined Hashing for all input types.
// Processes data in fixed 4 MB windows, then digests the combined window hashes.
// SENDER AND RECEIVER MUST USE THIS EXACT SAME ALGORITHM ON ALL CODE PATHS.

const HASH_WINDOW_SIZE = 4 * 1024 * 1024; // 4 MB canonical window size

// ─── Pure JavaScript SHA-256 Fallback ───
function sha256_pure(bin) {
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

  let H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  const len = bin.length;
  const padLen = 64 - ((len + 8) % 64);
  const totalLen = len + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(bin);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLen = len * 8;
  const highWord = Math.floor(bitLen / 4294967296);
  const lowWord = bitLen % 4294967296;
  view.setUint32(totalLen - 8, highWord, false);
  view.setUint32(totalLen - 4, lowWord, false);

  const W = new Uint32Array(64);

  function rightRotate(value, amount) {
    return ((value >>> amount) | (value << (32 - amount))) >>> 0;
  }

  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rightRotate(W[t - 15], 7) ^ rightRotate(W[t - 15], 18) ^ (W[t - 15] >>> 3)) >>> 0;
      const s1 = (rightRotate(W[t - 2], 17) ^ rightRotate(W[t - 2], 19) ^ (W[t - 2] >>> 10)) >>> 0;
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

    for (let t = 0; t < 64; t++) {
      const S1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

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

  const result = new Uint8Array(32);
  const resView = new DataView(result.buffer);
  for (let j = 0; j < 8; j++) {
    resView.setUint32(j * 4, H[j], false);
  }
  return result;
}

async function sha256Digest(arrayBuffer) {
  const cryptoObj = (typeof self !== 'undefined' && self.crypto);
  if (cryptoObj && cryptoObj.subtle) {
    try {
      return await cryptoObj.subtle.digest('SHA-256', arrayBuffer);
    } catch (e) {
      // Fall through to pure JS implementation
    }
  }
  const bytes = new Uint8Array(arrayBuffer);
  const hashBytes = sha256_pure(bytes);
  return hashBytes.buffer;
}

async function digestBufferOrBlob(input) {
  let blobOrFile = null;
  let chunksArray = null;

  if (input instanceof Blob || (typeof File !== 'undefined' && input instanceof File)) {
    blobOrFile = input;
  } else if (Array.isArray(input)) {
    chunksArray = input.filter(Boolean);
  } else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    chunksArray = [input];
  } else {
    throw new Error('Unsupported payload type for hashing');
  }

  // Calculate total byte length
  let totalSize = 0;
  if (blobOrFile) {
    totalSize = blobOrFile.size;
  } else if (chunksArray) {
    for (let i = 0; i < chunksArray.length; i++) {
      const c = chunksArray[i];
      totalSize += c.byteLength !== undefined ? c.byteLength : (c.length || 0);
    }
  }

  // If payload is <= 4MB, direct single-pass SHA-256
  if (totalSize <= HASH_WINDOW_SIZE) {
    let rawBuf;
    if (blobOrFile) {
      rawBuf = await blobOrFile.arrayBuffer();
    } else {
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (let i = 0; i < chunksArray.length; i++) {
        const c = chunksArray[i];
        const arr = ArrayBuffer.isView(c)
          ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
          : new Uint8Array(c);
        combined.set(arr, offset);
        offset += arr.byteLength;
      }
      rawBuf = combined.buffer;
    }
    const hashBuf = await sha256Digest(rawBuf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // If payload > 4MB, process in exact 4MB window boundaries
  const windowDigests = [];

  if (blobOrFile) {
    let offset = 0;
    while (offset < totalSize) {
      const slice = blobOrFile.slice(offset, offset + HASH_WINDOW_SIZE);
      const buf = await slice.arrayBuffer();
      const digest = await sha256Digest(buf);
      windowDigests.push(new Uint8Array(digest));
      offset += HASH_WINDOW_SIZE;
    }
  } else {
    // Array of chunks (fallback receiver path or chunk array > 4MB)
    // Stream through chunks filling 4MB window buffers
    let windowBuf = new Uint8Array(HASH_WINDOW_SIZE);
    let windowPos = 0;

    for (let i = 0; i < chunksArray.length; i++) {
      const c = chunksArray[i];
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
  }

  // Digest the combined 32-byte window SHA-256 hashes
  let combinedLen = 0;
  for (let d of windowDigests) combinedLen += d.byteLength;
  const combinedHashes = new Uint8Array(combinedLen);
  let p = 0;
  for (let d of windowDigests) {
    combinedHashes.set(d, p);
    p += d.byteLength;
  }
  const finalHashBuf = await sha256Digest(combinedHashes.buffer);
  return Array.from(new Uint8Array(finalHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (e) => {
  const { id, file, chunks } = e.data;
  try {
    const payload = file || chunks;
    const hashHex = await digestBufferOrBlob(payload);
    self.postMessage({ id, status: 'success', hash: hashHex });
  } catch (err) {
    self.postMessage({ id, status: 'error', error: err.message || 'Hashing failed' });
  }
};

