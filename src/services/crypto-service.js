/**
 * FluxTransfer — Application-level AES-256-GCM E2EE Crypto Service
 */
let PBKDF2_ITERATIONS = 100000;
if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof require !== 'undefined') {
  try {
    const cfg = require('../config/app-config.js');
    if (cfg && cfg.PBKDF2_ITERATIONS) PBKDF2_ITERATIONS = cfg.PBKDF2_ITERATIONS;
  } catch (_) {}
}

function getCrypto() {
  if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.getRandomValues === 'function') {
    return window.crypto;
  }
  if (typeof self !== 'undefined' && self.crypto && typeof self.crypto.getRandomValues === 'function') {
    return self.crypto;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto;
  }
  if (typeof require !== 'undefined') {
    try {
      const nodeCrypto = require('crypto');
      if (nodeCrypto.webcrypto) {
        return nodeCrypto.webcrypto;
      }
    } catch (_) { }
  }
  return {
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    }
  };
}

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

async function deriveKey(sessionCode, salt, iterations = PBKDF2_ITERATIONS) {
  const cleanCode = String(sessionCode || '').trim();
  if (!cleanCode) throw new Error('Missing session code for key derivation');

  const cryptoObj = getCrypto();
  const encoder = new TextEncoder();
  const codeBytes = encoder.encode(cleanCode);
  const saltBytes = salt instanceof Uint8Array ? salt : (salt ? new Uint8Array(salt) : new Uint8Array(16));

  const keyMaterial = await cryptoObj.subtle.importKey(
    'raw',
    codeBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const derivedKey = await cryptoObj.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  return derivedKey;
}

async function encryptChunk(chunkBuffer, chunkIndex, key) {
  const cryptoObj = getCrypto();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));

  const additionalData = new Uint8Array(4);
  new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

  const ciphertextBuffer = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: additionalData },
    key,
    chunkBuffer
  );

  const ciphertextBytes = new Uint8Array(ciphertextBuffer);
  const frame = new Uint8Array(4 + 12 + ciphertextBytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, chunkIndex, false);
  frame.set(iv, 4);
  frame.set(ciphertextBytes, 16);
  return frame;
}

async function decryptFrame(frameBuffer, key) {
  const buffer = frameBuffer instanceof ArrayBuffer
    ? frameBuffer
    : frameBuffer.buffer.slice(frameBuffer.byteOffset, frameBuffer.byteOffset + frameBuffer.byteLength);

  if (buffer.byteLength < 32) {
    throw new Error('Invalid transfer frame: undersized payload');
  }

  const view = new DataView(buffer);
  const chunkIndex = view.getUint32(0, false);
  const iv = new Uint8Array(buffer, 4, 12);
  const ciphertext = new Uint8Array(buffer, 16);

  const additionalData = new Uint8Array(4);
  new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

  const cryptoObj = getCrypto();
  const decryptedBuffer = await cryptoObj.subtle.decrypt(
    { name: 'AES-GCM', iv: iv, additionalData: additionalData },
    key,
    ciphertext
  );

  return { chunkIndex, chunkData: decryptedBuffer };
}

const CryptoService = {
  getCrypto,
  bytesToBase64,
  base64ToBytes,
  deriveKey,
  encryptChunk,
  decryptFrame
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = CryptoService;
  module.exports.default = CryptoService;
  module.exports.CryptoService = CryptoService;
  module.exports.getCrypto = getCrypto;
  module.exports.bytesToBase64 = bytesToBase64;
  module.exports.base64ToBytes = base64ToBytes;
  module.exports.deriveKey = deriveKey;
  module.exports.encryptChunk = encryptChunk;
  module.exports.decryptFrame = decryptFrame;
}

export {
  getCrypto,
  bytesToBase64,
  base64ToBytes,
  deriveKey,
  encryptChunk,
  decryptFrame,
  CryptoService
};

export default CryptoService;
