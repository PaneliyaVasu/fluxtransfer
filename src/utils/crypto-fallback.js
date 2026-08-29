/**
 * Browser stand-in for Node's `crypto` module.
 * Vite aliases `crypto` here so LAN HTTP (no crypto.subtle) still encrypts.
 */
import { createSoftwareCrypto } from './software-crypto.js';

function hasSubtleApi(cryptoObj) {
  return Boolean(
    cryptoObj &&
    cryptoObj.subtle &&
    typeof cryptoObj.subtle.importKey === 'function'
  );
}

function getNativeCrypto() {
  if (typeof window !== 'undefined' && window.crypto) return window.crypto;
  if (typeof self !== 'undefined' && self.crypto) return self.crypto;
  if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto;
  return null;
}

const native = getNativeCrypto();
const software = createSoftwareCrypto();

if (typeof globalThis !== 'undefined' && !globalThis.FluxSoftwareCrypto) {
  globalThis.FluxSoftwareCrypto = software;
}

const cryptoApi = hasSubtleApi(native)
  ? native
  : {
      getRandomValues: (arr) => {
        if (native && typeof native.getRandomValues === 'function') {
          return native.getRandomValues(arr);
        }
        return software.getRandomValues(arr);
      },
      subtle: software.subtle
    };

export const subtle = cryptoApi.subtle;
export const getRandomValues = (arr) => cryptoApi.getRandomValues(arr);
export default cryptoApi;
