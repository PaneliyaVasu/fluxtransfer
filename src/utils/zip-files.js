const ZIP_STORE = 0;
const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION_NEEDED = 20;
const MAX_ZIP32_SIZE = 0xffffffff;
const CRC_CHUNK = 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function encodeUtf8(text) {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text);
  }
  const escaped = unescape(encodeURIComponent(text));
  const out = new Uint8Array(escaped.length);
  for (let i = 0; i < escaped.length; i++) out[i] = escaped.charCodeAt(i);
  return out;
}

function dosDateTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

export function zipEntryName(file) {
  const raw = String(file?.webkitRelativePath || file?.name || 'file').replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/') || 'file';
}

export function suggestZipName(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return 'fluxtransfer.zip';
  const names = list.map(zipEntryName);
  const roots = names.map((name) => name.split('/')[0]);
  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length === 1 && names.some((name) => name.includes('/'))) {
    return `${uniqueRoots[0]}.zip`;
  }
  if (list.length === 1) {
    const base = names[0].split('/').pop() || 'file';
    const dot = base.lastIndexOf('.');
    return `${dot > 0 ? base.slice(0, dot) : base}.zip`;
  }
  return `fluxtransfer-${list.length}-files.zip`;
}

function uniquifyNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const slash = name.lastIndexOf('/');
    const dot = name.lastIndexOf('.');
    const insertAt = dot > slash ? dot : name.length;
    return `${name.slice(0, insertAt)} (${count})${name.slice(insertAt)}`;
  });
}

async function crc32OfBlob(blob) {
  let crc = 0xffffffff;
  const size = blob?.size || 0;
  for (let offset = 0; offset < size; offset += CRC_CHUNK) {
    const chunk = new Uint8Array(await blob.slice(offset, Math.min(size, offset + CRC_CHUNK)).arrayBuffer());
    for (let i = 0; i < chunk.length; i++) {
      crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toNamedFile(blob, name, type) {
  if (typeof File === 'function') {
    try {
      return new File([blob], name, { type, lastModified: Date.now() });
    } catch (_) {}
  }
  blob.name = name;
  blob.lastModified = Date.now();
  return blob;
}

/**
 * Build a STORE (uncompressed) zip from File/Blob parts so file bytes are not copied.
 * @param {Array<File|Blob>} files
 * @param {{ onProgress?: (info: { percent: number, currentName: string, index: number, total: number }) => void }} [options]
 * @returns {Promise<File|Blob>}
 */
export async function createZipArchive(files, options = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) {
    throw new Error('No files to zip.');
  }

  const names = uniquifyNames(list.map(zipEntryName));
  const records = [];
  let offset = 0;

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const name = names[i];
    const nameBytes = encodeUtf8(name);
    const size = Number(file.size) || 0;
    if (size > MAX_ZIP32_SIZE || offset + 30 + nameBytes.length + size > MAX_ZIP32_SIZE) {
      throw new Error('These files are too large for a standard zip archive.');
    }

    if (typeof options.onProgress === 'function') {
      options.onProgress({
        percent: Math.round((i / list.length) * 100),
        currentName: name,
        index: i,
        total: list.length
      });
    }

    const crc = await crc32OfBlob(file);
    const { dosTime, dosDate } = dosDateTime(file.lastModified);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, LOCAL_HEADER_SIG);
    writeUint16(localView, 4, VERSION_NEEDED);
    writeUint16(localView, 6, UTF8_FLAG);
    writeUint16(localView, 8, ZIP_STORE);
    writeUint16(localView, 10, dosTime);
    writeUint16(localView, 12, dosDate);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, size);
    writeUint32(localView, 22, size);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    local.set(nameBytes, 30);

    records.push({ name, nameBytes, size, crc, dosTime, dosDate, offset, local, file });
    offset += local.length + size;
  }

  const centralParts = records.map((record) => {
    const central = new Uint8Array(46 + record.nameBytes.length);
    const view = new DataView(central.buffer);
    writeUint32(view, 0, CENTRAL_HEADER_SIG);
    writeUint16(view, 4, VERSION_NEEDED);
    writeUint16(view, 6, VERSION_NEEDED);
    writeUint16(view, 8, UTF8_FLAG);
    writeUint16(view, 10, ZIP_STORE);
    writeUint16(view, 12, record.dosTime);
    writeUint16(view, 14, record.dosDate);
    writeUint32(view, 16, record.crc);
    writeUint32(view, 20, record.size);
    writeUint32(view, 24, record.size);
    writeUint16(view, 28, record.nameBytes.length);
    writeUint16(view, 30, 0);
    writeUint16(view, 32, 0);
    writeUint16(view, 34, 0);
    writeUint16(view, 36, 0);
    writeUint32(view, 38, 0);
    writeUint32(view, 42, record.offset);
    central.set(record.nameBytes, 46);
    return central;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, EOCD_SIG);
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, records.length);
  writeUint16(eocdView, 10, records.length);
  writeUint32(eocdView, 12, centralSize);
  writeUint32(eocdView, 16, offset);
  writeUint16(eocdView, 20, 0);

  const parts = [];
  for (const record of records) {
    parts.push(record.local, record.file);
  }
  parts.push(...centralParts, eocd);

  const zipName = suggestZipName(list);
  const blob = new Blob(parts, { type: 'application/zip' });
  const zipFile = toNamedFile(blob, zipName, 'application/zip');
  zipFile.fluxPacked = {
    count: list.length,
    files: records.map((record) => ({ name: record.name, size: record.size }))
  };

  if (typeof options.onProgress === 'function') {
    options.onProgress({
      percent: 100,
      currentName: zipName,
      index: list.length,
      total: list.length
    });
  }

  return zipFile;
}

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = { createZipArchive, suggestZipName, zipEntryName };
}
