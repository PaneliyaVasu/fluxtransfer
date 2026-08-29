/**
 * Pairing QR / deep-link helpers.
 * Camera apps must receive a full http(s) URL so they open FluxTransfer,
 * not a raw 6-digit string.
 */
export function buildPairingUrl(code, origin) {
  const clean = String(code || '').trim();
  const base = String(origin || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');
  return `${base}/?code=${clean}`;
}

export async function resolveShareableOrigin() {
  if (typeof window === 'undefined' || !window.location) return '';
  const { protocol, hostname, port } = window.location;
  if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return window.location.origin;
  }
  try {
    const res = await fetch('/api/lan', { cache: 'no-store' });
    const data = await res.json();
    const ip = Array.isArray(data?.ips) ? data.ips[0] : '';
    if (ip) {
      const pagePort = port || (protocol === 'https:' ? '443' : '3000');
      return `${protocol}//${ip}:${pagePort}`;
    }
  } catch (_) { }
  return window.location.origin;
}

export function extractPairingCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  const patterns = [
    /[?&]code=([0-9]{6})\b/,
    /\/r\/([0-9]{6})(?:\/|$)/,
    /\/receive\/([0-9]{6})(?:\/|$)/,
    /^([0-9]{6})$/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function readPairingCodeFromLocation(loc = typeof window !== 'undefined' ? window.location : null) {
  if (!loc) return null;
  const queryCode = new URLSearchParams(loc.search || '').get('code');
  if (queryCode && /^[0-9]{6}$/.test(queryCode.trim())) return queryCode.trim();
  return extractPairingCode(`${loc.origin || ''}${loc.pathname || ''}${loc.search || ''}${loc.hash || ''}`);
}

export function clearPairingCodeFromLocation() {
  if (typeof window === 'undefined' || !window.history || !window.location) return;
  window.history.replaceState({}, document.title, window.location.pathname || '/');
}
