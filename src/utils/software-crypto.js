/**
 * Software WebCrypto subset for insecure contexts (HTTP LAN).
 *
 * Browsers hide crypto.subtle on http://<lan-ip>, but FluxTransfer is
 * commonly used that way for phone-to-laptop transfers. This module
 * implements the exact AES-256-GCM + PBKDF2-SHA-256 operations the
 * engine already uses, so HTTP and HTTPS peers stay interoperable.
 */

const KEY_RAW = typeof Symbol === 'function' ? Symbol('flux-software-key') : '__fluxSoftwareKey';

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
]);

const AES_RCON = new Uint8Array([0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('Expected binary data');
}

function copyBytes(data) {
  const bytes = toUint8(data);
  return bytes.slice();
}

function sha256(data) {
  const bytes = toUint8(data);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const W = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    const block = new DataView(padded.buffer, offset, 64);
    for (let t = 0; t < 16; t++) W[t] = block.getUint32(t * 4, false);
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const w2 = W[t - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false); outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false); outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false); outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false); outView.setUint32(28, h7, false);
  return out;
}

function hmacSha256(key, data) {
  const blockSize = 64;
  let keyBytes = toUint8(key);
  if (keyBytes.length > blockSize) keyBytes = sha256(keyBytes);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  ipad.set(keyBytes);
  opad.set(keyBytes);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] ^= 0x36;
    opad[i] ^= 0x5c;
  }
  const inner = new Uint8Array(blockSize + data.length);
  inner.set(ipad);
  inner.set(data, blockSize);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(blockSize + 32);
  outer.set(opad);
  outer.set(innerHash, blockSize);
  return sha256(outer);
}

function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const pass = toUint8(password);
  const saltBytes = toUint8(salt);
  const out = new Uint8Array(dkLen);
  const blockCount = Math.ceil(dkLen / 32);
  const saltBlock = new Uint8Array(saltBytes.length + 4);
  saltBlock.set(saltBytes);

  let offset = 0;
  for (let i = 1; i <= blockCount; i++) {
    saltBlock[saltBytes.length] = (i >>> 24) & 0xff;
    saltBlock[saltBytes.length + 1] = (i >>> 16) & 0xff;
    saltBlock[saltBytes.length + 2] = (i >>> 8) & 0xff;
    saltBlock[saltBytes.length + 3] = i & 0xff;

    let u = hmacSha256(pass, saltBlock);
    const t = u.slice();
    for (let j = 1; j < iterations; j++) {
      u = hmacSha256(pass, u);
      for (let k = 0; k < 32; k++) t[k] ^= u[k];
    }

    const take = Math.min(32, dkLen - offset);
    out.set(t.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

function xtime(a) {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function expandAes256Key(key) {
  const expanded = new Uint8Array(240);
  expanded.set(toUint8(key).subarray(0, 32));
  let generated = 32;
  let rconIndex = 1;
  const temp = new Uint8Array(4);

  while (generated < 240) {
    temp.set(expanded.subarray(generated - 4, generated));
    if (generated % 32 === 0) {
      const first = temp[0];
      temp[0] = AES_SBOX[temp[1]];
      temp[1] = AES_SBOX[temp[2]];
      temp[2] = AES_SBOX[temp[3]];
      temp[3] = AES_SBOX[first];
      temp[0] ^= AES_RCON[rconIndex++];
    } else if (generated % 32 === 16) {
      temp[0] = AES_SBOX[temp[0]];
      temp[1] = AES_SBOX[temp[1]];
      temp[2] = AES_SBOX[temp[2]];
      temp[3] = AES_SBOX[temp[3]];
    }
    for (let i = 0; i < 4; i++) {
      expanded[generated] = expanded[generated - 32] ^ temp[i];
      generated++;
    }
  }
  return expanded;
}

function mixColumn(s0, s1, s2, s3) {
  const t0 = xtime(s0) ^ xtime(s1) ^ s1 ^ s2 ^ s3;
  const t1 = s0 ^ xtime(s1) ^ xtime(s2) ^ s2 ^ s3;
  const t2 = s0 ^ s1 ^ xtime(s2) ^ xtime(s3) ^ s3;
  const t3 = xtime(s0) ^ s0 ^ s1 ^ s2 ^ xtime(s3);
  return [t0, t1, t2, t3];
}

function shiftRows(s) {
  let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; const u = s[6]; s[2] = s[10]; s[6] = s[14]; s[10] = t; s[14] = u;
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
}

function aesEncryptBlock(roundKeys, input, output, outOffset) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i] ^ roundKeys[i];

  for (let round = 1; round < 14; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    shiftRows(s);

    for (let col = 0; col < 4; col++) {
      const i = col * 4;
      const mixed = mixColumn(s[i], s[i + 1], s[i + 2], s[i + 3]);
      s[i] = mixed[0]; s[i + 1] = mixed[1]; s[i + 2] = mixed[2]; s[i + 3] = mixed[3];
    }

    const rk = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= roundKeys[rk + i];
  }

  for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
  shiftRows(s);

  const last = 14 * 16;
  for (let i = 0; i < 16; i++) output[outOffset + i] = s[i] ^ roundKeys[last + i];
}

function xorBlock(target, source, length) {
  for (let i = 0; i < length; i++) target[i] ^= source[i];
}

function inc32(block) {
  for (let i = 15; i >= 12; i--) {
    block[i] = (block[i] + 1) & 0xff;
    if (block[i] !== 0) break;
  }
}

function gfMul(x, y) {
  const z = new Uint8Array(16);
  const v = y.slice();
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3] >>> (7 - (i & 7))) & 1) xorBlock(z, v, 16);
    const lsb = v[15] & 1;
    for (let j = 15; j > 0; j--) {
      v[j] = (v[j] >>> 1) | ((v[j - 1] & 1) << 7);
    }
    v[0] >>>= 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function ghash(h, aad, ciphertext) {
  let y = new Uint8Array(16);
  const process = (data) => {
    const paddedLen = Math.ceil(data.length / 16) * 16;
    if (paddedLen === 0) return;
    const padded = new Uint8Array(paddedLen);
    padded.set(data);
    for (let i = 0; i < paddedLen; i += 16) {
      xorBlock(y, padded.subarray(i, i + 16), 16);
      y = gfMul(y, h);
    }
  };

  process(aad);
  process(ciphertext);

  const lengths = new Uint8Array(16);
  const lenView = new DataView(lengths.buffer);
  lenView.setUint32(4, aad.length * 8, false);
  lenView.setUint32(12, ciphertext.length * 8, false);
  xorBlock(y, lengths, 16);
  return gfMul(y, h);
}

function gctr(roundKeys, icb, data) {
  if (data.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(data.length);
  const counter = icb.slice();
  const keystream = new Uint8Array(16);
  for (let offset = 0; offset < data.length; offset += 16) {
    aesEncryptBlock(roundKeys, counter, keystream, 0);
    const n = Math.min(16, data.length - offset);
    for (let i = 0; i < n; i++) out[offset + i] = data[offset + i] ^ keystream[i];
    inc32(counter);
  }
  return out;
}

function aesGcmEncrypt(key, iv, plaintext, aad) {
  const roundKeys = expandAes256Key(key);
  const h = new Uint8Array(16);
  aesEncryptBlock(roundKeys, new Uint8Array(16), h, 0);

  const j0 = new Uint8Array(16);
  if (iv.length === 12) {
    j0.set(iv);
    j0[15] = 1;
  } else {
    j0.set(ghash(h, new Uint8Array(0), iv));
  }

  const ctr = j0.slice();
  inc32(ctr);
  const ciphertext = gctr(roundKeys, ctr, plaintext);
  const s = ghash(h, aad, ciphertext);
  const tagMask = new Uint8Array(16);
  aesEncryptBlock(roundKeys, j0, tagMask, 0);
  xorBlock(s, tagMask, 16);

  const out = new Uint8Array(ciphertext.length + 16);
  out.set(ciphertext);
  out.set(s, ciphertext.length);
  return out.buffer;
}

function aesGcmDecrypt(key, iv, data, aad) {
  if (data.length < 16) throw new Error('AES-GCM: ciphertext too short');
  const ciphertext = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);

  const roundKeys = expandAes256Key(key);
  const h = new Uint8Array(16);
  aesEncryptBlock(roundKeys, new Uint8Array(16), h, 0);

  const j0 = new Uint8Array(16);
  if (iv.length === 12) {
    j0.set(iv);
    j0[15] = 1;
  } else {
    j0.set(ghash(h, new Uint8Array(0), iv));
  }

  const s = ghash(h, aad, ciphertext);
  const tagMask = new Uint8Array(16);
  aesEncryptBlock(roundKeys, j0, tagMask, 0);
  xorBlock(s, tagMask, 16);

  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= s[i] ^ tag[i];
  if (diff !== 0) {
    const err = new Error('The operation failed for an operation-specific reason');
    err.name = 'OperationError';
    throw err;
  }

  const ctr = j0.slice();
  inc32(ctr);
  return gctr(roundKeys, ctr, ciphertext).buffer;
}

function algorithmName(algorithm) {
  if (!algorithm) return '';
  if (typeof algorithm === 'string') return algorithm.toUpperCase();
  return String(algorithm.name || '').toUpperCase();
}

function getKeyRaw(key) {
  if (!key || !key[KEY_RAW]) throw new Error('Invalid software crypto key');
  return key[KEY_RAW];
}

function createSoftwareKey(raw, algorithm, extractable, usages) {
  return {
    type: 'secret',
    algorithm: typeof algorithm === 'string' ? { name: algorithm } : { name: algorithm.name, length: algorithm.length },
    extractable: !!extractable,
    usages: Array.isArray(usages) ? usages.slice() : [],
    [KEY_RAW]: copyBytes(raw)
  };
}

function nativeGetRandomValues(arr) {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto.getRandomValues(arr);
  }
  if (typeof require === 'function') {
    try {
      const nodeCrypto = require('crypto');
      if (typeof nodeCrypto.randomFillSync === 'function') {
        nodeCrypto.randomFillSync(arr);
        return arr;
      }
    } catch (_) {}
  }
  throw new Error('No cryptographically secure random number generator is available.');
}

function createSoftwareCrypto() {
  const subtle = {
    async digest(algorithm, data) {
      if (algorithmName(algorithm) !== 'SHA-256') {
        throw new Error(`Unsupported digest algorithm: ${algorithmName(algorithm)}`);
      }
      return sha256(data).buffer;
    },

    async importKey(format, keyData, algorithm, extractable, usages) {
      if (format !== 'raw') throw new Error('Software crypto only supports raw key import');
      return createSoftwareKey(keyData, algorithm, extractable, usages);
    },

    async deriveKey(algorithm, baseKey, derivedKeyType, extractable, usages) {
      if (algorithmName(algorithm) !== 'PBKDF2') {
        throw new Error(`Unsupported derive algorithm: ${algorithmName(algorithm)}`);
      }
      if (algorithmName(algorithm.hash) !== 'SHA-256') {
        throw new Error('Software PBKDF2 only supports SHA-256');
      }
      if (algorithmName(derivedKeyType) !== 'AES-GCM' || Number(derivedKeyType.length) !== 256) {
        throw new Error('Software deriveKey only supports AES-GCM 256');
      }
      const iterations = Number(algorithm.iterations);
      if (!Number.isFinite(iterations) || iterations < 1) {
        throw new Error('Invalid PBKDF2 iteration count');
      }
      const raw = pbkdf2Sha256(getKeyRaw(baseKey), algorithm.salt, iterations, 32);
      return createSoftwareKey(raw, derivedKeyType, extractable, usages);
    },

    async encrypt(algorithm, key, data) {
      if (algorithmName(algorithm) !== 'AES-GCM') {
        throw new Error(`Unsupported encrypt algorithm: ${algorithmName(algorithm)}`);
      }
      const iv = toUint8(algorithm.iv);
      const aad = algorithm.additionalData ? toUint8(algorithm.additionalData) : new Uint8Array(0);
      return aesGcmEncrypt(getKeyRaw(key), iv, toUint8(data), aad);
    },

    async decrypt(algorithm, key, data) {
      if (algorithmName(algorithm) !== 'AES-GCM') {
        throw new Error(`Unsupported decrypt algorithm: ${algorithmName(algorithm)}`);
      }
      const iv = toUint8(algorithm.iv);
      const aad = algorithm.additionalData ? toUint8(algorithm.additionalData) : new Uint8Array(0);
      return aesGcmDecrypt(getKeyRaw(key), iv, toUint8(data), aad);
    }
  };

  return {
    getRandomValues: nativeGetRandomValues,
    subtle
  };
}

function installSoftwareCrypto(target) {
  const dest = target || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (dest && dest.FluxSoftwareCrypto && dest.FluxSoftwareCrypto.subtle) {
    return dest.FluxSoftwareCrypto;
  }
  const api = createSoftwareCrypto();
  if (dest) dest.FluxSoftwareCrypto = api;
  return api;
}

if (typeof globalThis !== 'undefined' && !globalThis.FluxSoftwareCrypto) {
  globalThis.FluxSoftwareCrypto = createSoftwareCrypto();
}

const SoftwareCrypto = {
  createSoftwareCrypto,
  installSoftwareCrypto,
  sha256,
  pbkdf2Sha256,
  aesGcmEncrypt,
  aesGcmDecrypt
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = SoftwareCrypto;
  module.exports.default = SoftwareCrypto;
  module.exports.createSoftwareCrypto = createSoftwareCrypto;
  module.exports.installSoftwareCrypto = installSoftwareCrypto;
}

export {
  createSoftwareCrypto,
  installSoftwareCrypto,
  sha256,
  pbkdf2Sha256,
  aesGcmEncrypt,
  aesGcmDecrypt,
  SoftwareCrypto
};

export default SoftwareCrypto;
