/**
 * FluxTransfer — Off-main-thread AES-256-GCM worker
 * Uses native WebCrypto on HTTPS (Render / localhost) and the software
 * fallback on HTTP LAN so encryption does not block the UI thread.
 */
import { createSoftwareCrypto } from '../utils/software-crypto.js';

const PBKDF2_ITERATIONS = 10000;
const software = createSoftwareCrypto();

function getCryptoApi() {
  if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle && typeof self.crypto.subtle.importKey === 'function') {
    return self.crypto;
  }
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.importKey === 'function') {
    return crypto;
  }
  return software;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

function frameToArrayBuffer(frame) {
  if (frame instanceof ArrayBuffer) return frame;
  if (frame instanceof Uint8Array || ArrayBuffer.isView(frame)) {
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
  }
  return frame;
}

let aesKey = null;

async function deriveKey(sessionCode, salt) {
  const cryptoObj = getCryptoApi();
  const keyMaterial = await cryptoObj.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(sessionCode || '').trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  aesKey = await cryptoObj.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toBytes(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptChunk(chunkBuffer, chunkIndex) {
  if (!aesKey) throw new Error('Crypto worker key is not initialized');
  const cryptoObj = getCryptoApi();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const additionalData = new Uint8Array(4);
  new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

  const ciphertextBuffer = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    aesKey,
    chunkBuffer
  );

  const ciphertextBytes = new Uint8Array(ciphertextBuffer);
  const frame = new Uint8Array(4 + 12 + ciphertextBytes.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, chunkIndex, false);
  frame.set(iv, 4);
  frame.set(ciphertextBytes, 16);
  return frameToArrayBuffer(frame);
}

async function decryptFrame(frameBuffer) {
  if (!aesKey) throw new Error('Crypto worker key is not initialized');
  const buffer = frameBuffer instanceof ArrayBuffer
    ? frameBuffer
    : frameBuffer.buffer.slice(frameBuffer.byteOffset, frameBuffer.byteOffset + frameBuffer.byteLength);
  if (buffer.byteLength < 32) throw new Error('Invalid transfer frame: undersized payload');

  const view = new DataView(buffer);
  const chunkIndex = view.getUint32(0, false);
  const iv = new Uint8Array(buffer, 4, 12);
  const ciphertext = new Uint8Array(buffer, 16);
  const additionalData = new Uint8Array(4);
  new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

  const cryptoObj = getCryptoApi();
  const chunkData = await cryptoObj.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData },
    aesKey,
    ciphertext
  );
  return { chunkIndex, chunkData };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const { type, id } = msg;
  try {
    if (type === 'init') {
      await deriveKey(msg.sessionCode, msg.salt);
      self.postMessage({ type: 'ready', id });
      return;
    }
    if (type === 'encrypt') {
      const frame = await encryptChunk(msg.buffer, msg.chunkIndex);
      self.postMessage({ type: 'encrypt-ok', id, buffer: frame }, [frame]);
      return;
    }
    if (type === 'decrypt') {
      const { chunkIndex, chunkData } = await decryptFrame(msg.buffer);
      self.postMessage({ type: 'decrypt-ok', id, chunkIndex, buffer: chunkData }, [chunkData]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || 'Crypto worker error' });
  }
};
