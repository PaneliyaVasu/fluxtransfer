/**
 * Fallback classic worker for environments that cannot load the Vite module worker.
 * Native WebCrypto only — the engine falls back to main-thread software crypto
 * when crypto.subtle is missing (HTTP LAN).
 */
const PBKDF2_ITERATIONS = 10000;
let aesKey = null;

function getCryptoApi() {
  if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) return self.crypto;
  throw new Error('NO_SUBTLE');
}

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
      salt: salt instanceof Uint8Array ? salt : new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
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
      const cryptoObj = getCryptoApi();
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));
      const additionalData = new Uint8Array(4);
      new DataView(additionalData.buffer).setUint32(0, msg.chunkIndex, false);
      const ciphertextBuffer = await cryptoObj.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData },
        aesKey,
        msg.buffer
      );
      const ciphertextBytes = new Uint8Array(ciphertextBuffer);
      const frame = new Uint8Array(4 + 12 + ciphertextBytes.byteLength);
      new DataView(frame.buffer).setUint32(0, msg.chunkIndex, false);
      frame.set(iv, 4);
      frame.set(ciphertextBytes, 16);
      const out = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
      self.postMessage({ type: 'encrypt-ok', id, buffer: out }, [out]);
      return;
    }
    if (type === 'decrypt') {
      const buffer = msg.buffer;
      const view = new DataView(buffer);
      const chunkIndex = view.getUint32(0, false);
      const iv = new Uint8Array(buffer, 4, 12);
      const ciphertext = new Uint8Array(buffer, 16);
      const additionalData = new Uint8Array(4);
      new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);
      const chunkData = await getCryptoApi().subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData },
        aesKey,
        ciphertext
      );
      self.postMessage({ type: 'decrypt-ok', id, chunkIndex, buffer: chunkData }, [chunkData]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || 'Crypto worker error' });
  }
};
