import React, { useState } from 'react';
import { Upload, Download, FileText, Check, X, CloudUpload, CloudDownload, Copy, Share2, Zap } from 'lucide-react';
import { buildPairingUrl, extractPairingCode, readPairingCodeFromLocation, clearPairingCodeFromLocation, resolveShareableOrigin } from '../utils/pairing-url.js';
import './TransferDashboard.css';

async function walkDirectoryEntry(entry, out, prefix = '') {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const relativeName = prefix ? `${prefix}${file.name}` : file.name;
    if (relativeName !== file.name && typeof File === 'function') {
      try {
        out.push(new File([file], relativeName, { type: file.type, lastModified: file.lastModified }));
        return;
      } catch (_) {}
    }
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const nextPrefix = `${prefix}${entry.name}/`;
    const readBatch = async () => {
      const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!entries.length) return;
      for (const child of entries) {
        await walkDirectoryEntry(child, out, nextPrefix);
      }
      await readBatch();
    };
    await readBatch();
  }
}

async function collectDroppedFiles(dataTransfer) {
  const items = dataTransfer?.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    const files = [];
    const jobs = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) jobs.push(walkDirectoryEntry(entry, files));
    }
    await Promise.all(jobs);
    if (files.length) return files;
  }
  return Array.from(dataTransfer?.files || []);
}

export default function TransferDashboard({ transfer, addToast }) {
  const [inputCode, setInputCode] = useState('');
  const [activeTab, setActiveTab] = useState('send');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
  const [shareableOrigin, setShareableOrigin] = useState(
    typeof window !== 'undefined' ? window.location.origin : ''
  );
  const joinedFromUrlRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    resolveShareableOrigin().then((origin) => {
      if (!cancelled && origin) setShareableOrigin(origin);
    });
    return () => { cancelled = true; };
  }, []);

  const qrInputRef = React.useRef(null);

  const applyScannedCode = (code) => {
    setActiveTab('receive');
    setInputCode(code);
    code.split('').forEach((char, idx) => {
      if (digitRefs[idx]?.current) digitRefs[idx].current.value = char;
    });
    if (transfer.joinReceiveSession) {
      transfer.joinReceiveSession(code);
    }
    if (addToast) addToast('success', 'QR Code Scanned', `Connecting to code ${code}...`);
  };

  const handleQrScanClick = async () => {
    const canUseCamera = typeof navigator !== 'undefined'
      && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && (window.isSecureContext !== false);
    if (canUseCamera) {
      setIsQrScannerOpen(true);
      return;
    }
    if (qrInputRef.current) {
      qrInputRef.current.value = '';
      qrInputRef.current.click();
    }
  };

  const handleQrDetected = (code) => {
    setIsQrScannerOpen(false);
    applyScannedCode(code);
  };

  const handleQrScannerClose = (reason) => {
    setIsQrScannerOpen(false);
    if (reason === 'camera-unavailable' || reason === 'camera-denied') {
      if (addToast) addToast('info', 'Camera unavailable', 'Choose a photo of the QR code instead.');
      if (qrInputRef.current) {
        qrInputRef.current.value = '';
        qrInputRef.current.click();
      }
    }
  };

  const handleQrFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);

      if (result && result.data) {
        const code = extractPairingCode(result.data);

        if (code) {
          applyScannedCode(code);
        } else {
          if (addToast) addToast('error', 'QR Scan Failed', 'No valid 6-digit pairing code found in QR image.');
        }
      } else {
        if (addToast) addToast('error', 'QR Scan Failed', 'Could not detect a QR code in the image. Try a clearer photo.');
      }
    } catch (err) {
      console.error('[QR Scanner]', err);
      if (addToast) addToast('error', 'QR Scan Error', 'Failed to read image. Please try again.');
    }
  };

  const digitRefs = [
    React.useRef(null),
    React.useRef(null),
    React.useRef(null),
    React.useRef(null),
    React.useRef(null),
    React.useRef(null)
  ];

  React.useEffect(() => {
    const checkMobile = () => {
      const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
      const isSmallScreen = window.innerWidth <= 768;
      const isMobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      setIsMobile((isTouch && isSmallScreen) || isMobileUA);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Auto-join when a phone camera opens this site from the QR URL
  React.useEffect(() => {
    const cleanCode = readPairingCodeFromLocation();
    if (!cleanCode || joinedFromUrlRef.current) return;
    joinedFromUrlRef.current = true;
    setActiveTab('receive');
    setInputCode(cleanCode);

    const tryJoin = (attempts = 0) => {
      if (transfer.joinReceiveSession) {
        transfer.joinReceiveSession(cleanCode);
        if (addToast) addToast('info', 'QR Code Opened', `Connecting to code ${cleanCode}...`);
        clearPairingCodeFromLocation();
      } else if (attempts < 20) {
        setTimeout(() => tryJoin(attempts + 1), 100);
      }
    };

    setTimeout(tryJoin, 80);
  }, [addToast, transfer.joinReceiveSession]);

  const {
    engineState,
    role,
    pairingCode,
    selectedFile,
    selectedFiles = selectedFile ? [selectedFile] : [],
    transferProgress,
    transferSpeed,
    transferredBytes,
    totalBytes,
    currentFileName = '',
    packedFileCount = selectedFiles.length || 1,
    packedFiles = [],
    isPacking = false,
    packProgress = 0,
    receivedFiles = [],
    receivedFileBlob,
    receivedFileUrl,
    receivedFileName,
    createSendSession,
    joinReceiveSession,
    cancelTransfer
  } = transfer;

  const downloadReceivedItem = async (item) => {
    if (!item) return;
    if ('showSaveFilePicker' in window && item.blob) {
      try {
        const ext = item.name && item.name.includes('.') ? `.${item.name.split('.').pop()}` : undefined;
        const isZip = (item.type === 'application/zip') || (ext && ext.toLowerCase() === '.zip');
        const handle = await window.showSaveFilePicker({
          suggestedName: item.name || (isZip ? 'fluxtransfer.zip' : 'downloaded-file'),
          types: isZip
            ? [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }]
            : (item.type && ext ? [{ description: 'Received file', accept: { [item.type]: [ext] } }] : undefined)
        });
        const writable = await handle.createWritable();
        await writable.write(item.blob);
        await writable.close();
        if (addToast) addToast('success', 'File Saved', `Saved directly to disk: ${item.name || 'file'}`);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    if (!item.url) return;
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.name || 'downloaded-file';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  };

  const handleDownloadFile = async (e) => {
    if (e) e.preventDefault();
    const latest = receivedFiles[receivedFiles.length - 1];
    if (latest) {
      await downloadReceivedItem(latest);
      return;
    }
    if (!receivedFileBlob && !receivedFileUrl) return;

    if ('showSaveFilePicker' in window) {
      try {
        const ext = receivedFileName && receivedFileName.includes('.')
          ? `.${receivedFileName.split('.').pop()}`
          : undefined;
        const handle = await window.showSaveFilePicker({
          suggestedName: receivedFileName || 'downloaded-file',
          types: receivedFileBlob?.type && ext
            ? [{ description: 'Received file', accept: { [receivedFileBlob.type]: [ext] } }]
            : undefined
        });
        const writable = await handle.createWritable();
        if (receivedFileBlob) {
          await writable.write(receivedFileBlob);
        } else if (receivedFileUrl) {
          const res = await fetch(receivedFileUrl);
          const blob = await res.blob();
          await writable.write(blob);
        }
        await writable.close();
        if (addToast) addToast('success', 'File Saved', `Saved directly to disk: ${receivedFileName || 'file'}`);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    const a = document.createElement('a');
    a.href = receivedFileUrl;
    a.download = receivedFileName || 'downloaded-file';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  };

  const startSendWithFiles = (files) => {
    const list = (files || []).filter(Boolean).slice(0, 100);
    if (!list.length) return;
    createSendSession(list);
  };

  const handleFileSelect = (e) => {
    startSendWithFiles(Array.from(e.target.files || []));
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = await collectDroppedFiles(e.dataTransfer);
    startSendWithFiles(files);
  };

  const handleJoinSession = () => {
    const cleanCode = inputCode.trim();
    if (!cleanCode || cleanCode.length !== 6 || !/^[0-9]{6}$/.test(cleanCode)) {
      return;
    }
    joinReceiveSession(cleanCode);
  };

  const handleDigitChange = (index, value) => {
    const char = value.replace(/[^0-9]/g, '').slice(-1);
    const maxLen = 6;
    const digits = (inputCode.padEnd(maxLen, ' ')).split('');
    digits[index] = char || ' ';
    const newCode = digits.join('').replace(/\s+$/, '');
    setInputCode(newCode);

    if (char && index < maxLen - 1) {
      digitRefs[index + 1].current?.focus();
    }

    const cleanCode = newCode.replace(/\s/g, '');
    if (cleanCode.length === 6 && /^[0-9]{6}$/.test(cleanCode)) {
      joinReceiveSession(cleanCode);
    }
  };

  const handleDigitKeyDown = (index, e) => {
    if (e.key === 'Backspace' && (!inputCode[index] || inputCode[index] === ' ') && index > 0) {
      digitRefs[index - 1].current?.focus();
    }
  };

  const handleDigitPaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
    if (pasted) {
      setInputCode(pasted);
      const focusIndex = Math.min(pasted.length, 5);
      digitRefs[focusIndex]?.current?.focus();

      if (pasted.length === 6) {
        joinReceiveSession(pasted);
      }
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
  };

  const handleCancel = () => {
    setInputCode('');
    cancelTransfer();
  };

  const isCompleted = engineState === 'completed';
  const isSending = role === 'sender' || selectedFiles.length > 0;
  const isReceiving = role === 'receiver' || receivedFiles.length > 0 || Boolean(receivedFileUrl);
  const archiveCount = Math.max(packedFileCount || 0, packedFiles.length, selectedFiles.length, 1);
  const isZipArchive = archiveCount > 1 || /\.zip$/i.test(currentFileName || receivedFileName || '');
  const contentsList = packedFiles.length
    ? packedFiles
    : (isSending && selectedFiles.length > 1 ? selectedFiles : []);
  const activeName = currentFileName
    || selectedFile?.name
    || receivedFileName
    || (isZipArchive ? `${archiveCount} files.zip` : 'Incoming File');
  const progressPercent = isCompleted
    ? 100
    : engineState === 'transferring'
    ? transferProgress
    : isPacking
    ? packProgress
    : (packProgress >= 100 && selectedFiles.length > 1 ? 100 : transferProgress);

  const renderTransferProgressCard = () => (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: 'var(--glass-card-bg)',
        padding: '20px 18px',
        borderRadius: '18px',
        border: '1px solid var(--glass-card-border)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.04)'
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '2px' }}>
              Transfer Progress
            </h4>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {isCompleted
                ? (isSending
                  ? (isZipArchive ? `Zip archive sent (${archiveCount} files)` : 'File sent successfully to peer')
                  : (isZipArchive ? `Zip archive received (${archiveCount} files)` : 'File received successfully'))
                : isPacking && engineState !== 'transferring'
                ? `Creating zip archive${archiveCount > 1 ? ` · ${archiveCount} files` : ''}`
                : (isSending
                  ? (isZipArchive ? 'Sending zip archive to peer' : 'Sending file to peer')
                  : (isZipArchive ? 'Receiving zip archive from peer' : 'Receiving file from peer'))}
            </div>
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.75rem',
              fontWeight: 600,
              padding: '4px 12px',
              borderRadius: '999px',
              whiteSpace: 'nowrap',
              background: isCompleted
                ? 'rgba(16, 185, 129, 0.12)'
                : engineState === 'transferring'
                ? 'rgba(124, 58, 237, 0.12)'
                : engineState === 'connecting'
                ? 'rgba(245, 158, 11, 0.12)'
                : selectedFile
                ? 'rgba(59, 130, 246, 0.12)'
                : 'rgba(148, 163, 184, 0.12)',
              color: isCompleted
                ? '#10b981'
                : engineState === 'transferring'
                ? '#7c3aed'
                : engineState === 'connecting'
                ? '#d97706'
                : selectedFile
                ? '#3b82f6'
                : '#64748b',
              border: `1px solid ${
                isCompleted
                  ? 'rgba(16, 185, 129, 0.3)'
                  : engineState === 'transferring'
                  ? 'rgba(124, 58, 237, 0.3)'
                  : engineState === 'connecting'
                  ? 'rgba(245, 158, 11, 0.3)'
                  : selectedFile
                  ? 'rgba(59, 130, 246, 0.3)'
                  : 'rgba(148, 163, 184, 0.3)'
              }`
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: isCompleted
                  ? '#10b981'
                  : engineState === 'transferring'
                  ? '#7c3aed'
                  : engineState === 'connecting'
                  ? '#f59e0b'
                  : selectedFile
                  ? '#3b82f6'
                  : '#94a3b8'
              }}
            ></span>
            {isCompleted
              ? 'Completed'
              : engineState === 'transferring'
              ? `${transferProgress}% Transferring`
              : isPacking
              ? `${packProgress}% Zipping`
              : engineState === 'connecting'
              ? 'Connecting...'
              : selectedFiles.length
              ? (isZipArchive && packProgress >= 100 ? 'Zip ready' : 'Ready for Receiver')
              : 'Idle'}
          </span>
        </div>

        <div style={{ width: '100%', background: 'rgba(203, 213, 225, 0.35)', borderRadius: '999px', height: '10px', overflow: 'hidden', marginBottom: '18px' }}>
          <div
            style={{
              height: '100%',
              width: `${progressPercent}%`,
              background: isCompleted ? 'linear-gradient(90deg, #10b981, #059669)' : 'linear-gradient(90deg, #4f46e5, #7c3aed)',
              borderRadius: '999px',
              transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              boxShadow: '0 0 10px rgba(124, 58, 237, 0.4)'
            }}
          ></div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: 'var(--glass-card-bg)',
            padding: '12px 14px',
            borderRadius: '14px',
            border: '1px solid var(--glass-card-border)',
            marginBottom: '16px'
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              background: 'rgba(124, 58, 237, 0.1)',
              color: '#7c3aed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <FileText size={20} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-title)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '4px' }}>
              {isZipArchive && archiveCount > 1 ? `${activeName} · ${archiveCount} files` : activeName}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', gap: '8px' }}>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {formatBytes(transferredBytes)} / {formatBytes(totalBytes || selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0))}
              </span>
              {engineState === 'transferring' && (
                <span style={{ fontWeight: 700, color: '#7c3aed', flexShrink: 0 }}>⚡ {transferSpeed}</span>
              )}
            </div>
          </div>
        </div>

        {contentsList.length > 1 && (
          <div style={{ maxHeight: '112px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            {contentsList.map((item, idx) => (
              <div key={`${item.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '0.75rem', color: isCompleted ? '#059669' : 'var(--text-muted)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {isCompleted ? '✓' : '•'} {item.name}
                </span>
                {item.size ? (
                  <span style={{ flexShrink: 0 }}>{formatBytes(item.size)}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
        {(receivedFileUrl || receivedFiles.length > 0) && (
          <button
            onClick={handleDownloadFile}
            className="glass-btn glass-btn-dark"
            style={{
              flex: 1,
              height: '46px',
              padding: '0 16px',
              borderRadius: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontSize: '0.88rem',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              cursor: 'pointer'
            }}
          >
            {isZipArchive ? 'Download Zip' : 'Download File'} <Download size={15} />
          </button>
        )}

        {isCompleted && isSending ? (
          <button
            onClick={handleCancel}
            className="glass-btn glass-btn-dark"
            style={{
              flex: 1,
              height: '46px',
              padding: '0 16px',
              borderRadius: '14px',
              fontSize: '0.88rem',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              cursor: 'pointer'
            }}
          >
            Send More Files ✨
          </button>
        ) : (
          <button
            onClick={handleCancel}
            className="glass-btn"
            style={{
              flex: receivedFileUrl ? '0 0 80px' : 1,
              height: '46px',
              padding: '0 12px',
              borderRadius: '14px',
              fontSize: '0.88rem',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              opacity: 0.85,
              cursor: 'pointer'
            }}
          >
            {isCompleted ? 'Done' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  );

  const activeTransfer = engineState === 'TRANSFERRING' || (role === 'receiver' && (engineState === 'CONNECTING' || engineState === 'CONNECTED'));
  const hideToggle = activeTransfer || (selectedFiles.length > 0 && activeTab === 'send');

  return (
    <div style={{ position: 'relative', zIndex: 30, maxWidth: '680px', width: '100%', margin: '0 auto' }}>
      {/* Single Combined Glass Card */}
      <div className="glass-card unified-transfer-card">
        {/* Segmented Glass Pill Toggle Switch (Hidden during active file pairing or transfer) */}
        {!hideToggle && (
          <div className="card-segmented-toggle">
            <button
              type="button"
              className={`toggle-tab ${activeTab === 'send' ? 'active' : ''}`}
              onClick={() => setActiveTab('send')}
            >
              <CloudUpload size={18} /> Send
            </button>
            <button
              type="button"
              className={`toggle-tab ${activeTab === 'receive' ? 'active' : ''}`}
              onClick={() => setActiveTab('receive')}
            >
              <CloudDownload size={18} /> Receive
            </button>
          </div>
        )}

        <div className="card-content-area" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Send View */}
          {activeTab === 'send' && (
            <div className="card-send" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              {selectedFiles.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
                  <button
                    onClick={handleCancel}
                    className="glass-btn"
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      border: '1px solid var(--glass-card-border)',
                      background: 'var(--glass-card-bg)',
                      color: 'var(--text-title)',
                      transition: 'all 0.2s ease'
                    }}
                    title="Cancel / Change File"
                  >
                    <X size={18} />
                  </button>
                </div>
              )}

              {activeTransfer ? (
                renderTransferProgressCard()
              ) : !selectedFiles.length ? (
                <div
                  className="dropzone-box"
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  style={{
                    border: isDragOver ? '2px dashed #7c3aed' : '1.5px dashed rgba(124, 58, 237, 0.35)',
                    borderRadius: '24px',
                    padding: '36px 20px',
                    textAlign: 'center',
                    background: isDragOver ? 'rgba(124, 58, 237, 0.08)' : 'var(--dropzone-bg)',
                    boxShadow: 'inset 0 2px 6px rgba(255, 255, 255, 0.9), 0 8px 24px -4px rgba(120, 130, 160, 0.06)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                    cursor: 'pointer',
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <input
                    type="file"
                    id="file-upload-input"
                    multiple
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                  />
                  <label htmlFor="file-upload-input" style={{ cursor: 'pointer', display: 'block', width: '100%' }}>
                    <div
                      className="dropzone-badge"
                      style={{
                        width: '60px',
                        height: '60px',
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
                        border: '1.5px solid rgba(255, 255, 255, 0.95)',
                        boxShadow: 'inset 0 1.5px 0 #ffffff, 0 8px 22px rgba(124, 58, 237, 0.18)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        margin: '0 auto 14px auto'
                      }}
                    >
                      <Upload size={26} color="#7c3aed" />
                    </div>
                    <h4 className="dropzone-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '4px' }}>
                      Ready to share?
                    </h4>
                    <p className="dropzone-subtitle" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      Drag files or a folder, or tap to browse
                    </p>
                  </label>
                </div>
              ) : isCompleted ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-card-bg)', padding: '24px 16px', borderRadius: '16px', border: '1px solid var(--glass-card-border)', textAlign: 'center', gap: '10px' }}>
                  <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.12)', border: '1.5px solid rgba(16, 185, 129, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                    <Check size={26} />
                  </div>
                  <div>
                    <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '4px' }}>
                      {selectedFiles.length > 1 ? 'Zip Archive Delivered! 🎉' : 'File Delivered Successfully! 🎉'}
                    </h4>
                    <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {selectedFiles.length > 1
                        ? `${selectedFiles.length} files packed · ${formatBytes(selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0))}`
                        : `${selectedFile?.name || 'File'} (${formatBytes(selectedFile?.size)})`}
                    </p>
                  </div>
                </div>
              ) : (
                /* Selected File: 6-Digit Connection Code Display (Using Glass PIN Track UI) */
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '8px 0' }}>

                  {/* Header */}
                  <div style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.16em', marginBottom: '14px' }}>
                    YOUR CONNECTION CODE
                  </div>

                  {/* 6-Digit Glass PIN Track Display (Matching Receiver UI) */}
                  <div style={{ marginBottom: '16px', width: '100%', display: 'flex', justifyContent: 'center' }}>
                    <div className="obsidian-pin-track" style={{ cursor: 'default', userSelect: 'none' }}>
                      {/* Group 1: Digits 0, 1, 2 (White / Theme Title Group) */}
                      <div className="pin-group">
                        {(pairingCode || '---').slice(0, 3).split('').map((char, idx) => (
                          <div key={idx} className="pin-slot-wrapper">
                            <div className="pin-slot-card white-group has-value" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {char}
                            </div>
                            <span className="slot-indicator-dash white-dash active" />
                          </div>
                        ))}
                      </div>

                      {/* Central Electric Lightning Icon */}
                      <div className="pin-separator-icon" style={{ padding: '0 2px' }}>
                        <Zap size={20} color="#3b82f6" className="zap-glow" />
                      </div>

                      {/* Group 2: Digits 3, 4, 5 (Electric Blue Group) */}
                      <div className="pin-group">
                        {(pairingCode || '------').slice(3, 6).split('').map((char, idx) => (
                          <div key={idx} className="pin-slot-wrapper">
                            <div className="pin-slot-card blue-group has-value" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {char}
                            </div>
                            <span className="slot-indicator-dash blue-dash active" />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Description */}
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.86rem', lineHeight: '1.4', maxWidth: '340px', margin: '0 auto 16px auto' }}>
                    Share this code with the receiving device to start transfer.
                  </p>

                  {/* Live Status Badge at Bottom */}
                  <div className="live-status-badge">
                    <span className="pulsing-dot-blue" />
                    <span className="live-status-text">
                      {engineState === 'CONNECTED' ? 'RECEIVER CONNECTED' : 'WAITING FOR RECEIVER...'}
                    </span>
                  </div>

                </div>
              )}
            </div>
          )}

          {/* Receive View */}
          {activeTab === 'receive' && (
            <div className="card-receive" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

              {isSending ? (
                renderTransferProgressCard()
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'space-between' }}>
                  {/* Enter 6-Digit Code Header */}
                  <div style={{ textAlign: 'center', marginTop: '2px', marginBottom: '14px' }}>
                    <h3 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-title)', marginBottom: '4px', letterSpacing: '-0.02em' }}>
                      Enter 6-Digit Code
                    </h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: '1.4', maxWidth: '380px', margin: '0 auto' }}>
                      Enter the code displayed on the sending device to start direct download.
                    </p>
                  </div>

                  {/* Top Status Pill Badge */}
                  <div style={{ textAlign: 'center', marginBottom: '14px' }}>
                    {inputCode.replace(/\s/g, '').length === 6 ? (
                      <div className="code-verified-pill">
                        <Check size={14} /> CODE VERIFIED <span style={{ letterSpacing: '0.15em', marginLeft: '6px' }}>●●●●●●</span>
                      </div>
                    ) : (
                      <div className="code-pending-pill">
                        <span className="pulsing-dot-blue" /> READY TO VERIFY
                      </div>
                    )}
                  </div>

                  {/* Obsidian PIN Slot Track (Matching Reference Screenshots) */}
                  <div style={{ marginBottom: '18px', width: '100%', display: 'flex', justifyContent: 'center' }}>
                    <div className="obsidian-pin-track" onPaste={handleDigitPaste}>
                      {/* Group 1: Digits 0, 1, 2 (White Group) */}
                      <div className="pin-group">
                        {[0, 1, 2].map((idx) => {
                          const char = (inputCode[idx] && inputCode[idx] !== ' ') ? inputCode[idx] : '';
                          return (
                            <div key={idx} className="pin-slot-wrapper">
                              <input
                                ref={digitRefs[idx]}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                maxLength={1}
                                value={char}
                                onChange={(e) => handleDigitChange(idx, e.target.value)}
                                onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                                className={`pin-slot-card white-group ${char ? 'has-value' : ''}`}
                              />
                              <span className={`slot-indicator-dash white-dash ${char ? 'active' : ''}`} />
                            </div>
                          );
                        })}
                      </div>

                      {/* Central Electric Lightning Icon */}
                      <div className="pin-separator-icon" style={{ padding: '0 2px' }}>
                        <Zap size={20} color="#3b82f6" className="zap-glow" />
                      </div>

                      {/* Group 2: Digits 3, 4, 5 (Electric Blue Group) */}
                      <div className="pin-group">
                        {[3, 4, 5].map((idx) => {
                          const char = (inputCode[idx] && inputCode[idx] !== ' ') ? inputCode[idx] : '';
                          return (
                            <div key={idx} className="pin-slot-wrapper">
                              <input
                                ref={digitRefs[idx]}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                maxLength={1}
                                value={char}
                                onChange={(e) => handleDigitChange(idx, e.target.value)}
                                onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                                className={`pin-slot-card blue-group ${char ? 'has-value' : ''}`}
                              />
                              <span className={`slot-indicator-dash blue-dash ${char ? 'active' : ''}`} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {isQrScannerOpen && (
        <QrScanner onDetected={handleQrDetected} onClose={handleQrScannerClose} />
      )}
    </div>
  );
}
