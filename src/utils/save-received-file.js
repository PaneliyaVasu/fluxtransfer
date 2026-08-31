function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
}

function asDownloadFile(blob, name, mime) {
  if (!blob) return blob;
  const fileName = name || blob.name || 'received-file';
  if (blob instanceof File && blob.name === fileName) return blob;
  try {
    Object.defineProperty(blob, 'name', { value: fileName, configurable: true });
  } catch (_) {
    try { blob.name = fileName; } catch (__) {}
  }
  if (mime && !blob.type) {
    try { Object.defineProperty(blob, 'type', { value: mime, configurable: true }); } catch (_) {}
  }
  return blob;
}

function triggerAnchorDownload(file, url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = (file && file.name) || 'received-file';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (document.body.contains(a)) document.body.removeChild(a);
  }, 1000);
}

function triggerBrowserDownload(file, url) {
  if (isIosDevice()) return;
  try {
    triggerAnchorDownload(file, url);
  } catch (downloadErr) {
    console.warn('[FluxTransfer] Auto-download error:', downloadErr);
  }
}

async function saveReceivedFile(file, url) {
  if (!file && !url) return 'empty';

  if (file && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    let shareFile = file;
    if (!(shareFile instanceof File) && typeof File === 'function') {
      try {
        shareFile = new File([file], file.name || 'received-file', {
          type: file.type || 'application/octet-stream',
          lastModified: Date.now()
        });
      } catch (_) {
        shareFile = file;
      }
    }
    try {
      const canShareFiles = typeof navigator.canShare !== 'function'
        || (shareFile instanceof File && navigator.canShare({ files: [shareFile] }));
      if (canShareFiles && shareFile instanceof File) {
        await navigator.share({
          files: [shareFile],
          title: shareFile.name
        });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'aborted';
    }
  }

  if (isIosDevice()) {
    throw new Error('IOS_SAVE_SHEET');
  }

  if (!url && file) {
    url = URL.createObjectURL(file);
  }
  triggerAnchorDownload(file, url);
  return 'downloaded';
}

export {
  isIosDevice,
  asDownloadFile,
  triggerBrowserDownload,
  saveReceivedFile
};
