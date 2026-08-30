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
  const [isPaused, setIsPaused] = useState(false);
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
  const isSending = role === 'sender';
  const isReceiving = role === 'receiver';
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

  const renderTransferProgressCard = () => {
    const percent = Math.round(progressPercent);
    const formattedTransferred = formatBytes(transferredBytes || totalBytes);
    const formattedTotal = formatBytes(totalBytes || selectedFiles.reduce((sum, file) => sum + (file.size || 0), 0));
    const itemCount = Math.max(packedFileCount || 0, packedFiles.length, selectedFiles.length, 1);

    if (isCompleted) {
      return (
        <div className="transfer-success-card-obsidian">
          {/* Green Check Icon Badge */}
          <div className="success-icon-badge">
            <Check size={22} color="#10b981" strokeWidth={2.5} />
          </div>

          {/* Subtitle & Title Header */}
          <div className="success-header-text">
            <div className="success-meta-tag">TRANSFER SUCCESS</div>
            <h3 className="success-title">Transfer Complete</h3>
            <p className="success-description">
              Your file was transferred directly with zero loss.
            </p>
          </div>



          {/* Transferred File Item Card */}
          <div className="success-file-card">
            <div className="file-item-left">
              <div className="file-type-icon-box">
                <FileText size={18} color="#a855f7" />
              </div>
              <span className="file-item-name">{activeName}</span>
            </div>
            <span className="file-item-size">{formattedTotal}</span>
          </div>

          {/* Action Buttons Below */}
          <div className="success-actions-row">
            {receivedFileUrl ? (
              <button
                type="button"
                onClick={handleDownloadFile}
                className="primary-glass-download-btn"
              >
                <Download size={18} /> Download File
              </button>
            ) : null}

            {isSending ? (
              <>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="primary-glass-download-btn"
                >
                  Send More Files
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="secondary-glass-done-btn"
                >
                  Done
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleCancel}
                className="secondary-glass-done-btn"
              >
                Done
              </button>
            )}
          </div>
        </div>
      );
    }

    // Live Transfer View
    const etaText = transfer.etaSeconds
      ? `About ${transfer.etaSeconds} second${transfer.etaSeconds === 1 ? '' : 's'} remaining`
      : 'Calculating remaining time...';

    return (
      <div className="transfer-progress-card-obsidian">
        {/* Top Header Row: Icon + File Name & Subtitle on Left, Big % & Speed on Right */}
        <div className="transfer-card-header">
          <div className="transfer-file-info">
            {/* Animated Spinner Icon Container */}
            <div className="spinner-icon-box">
              <span className="spinner-ring" />
            </div>

            <div className="file-details">
              <h4 className="file-title">
                {isSending ? `Sending ${activeName}` : `Receiving ${activeName}`}
              </h4>
              <div className="connection-subtitle">
                Connected to {role === 'sender' ? 'Receiver Device' : 'Sender Device'}
              </div>
            </div>
          </div>

          {/* Big % and Speed metrics */}
          <div className="transfer-metrics-right">
            <div className="big-percent">{percent}%</div>
            <div className="speed-text">{transferSpeed || '0 MB/S'}</div>
          </div>
        </div>

        {/* Progress Bar Track */}
        <div className="progress-bar-container">
          <div
            className="progress-bar-fill"
            style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
          />
        </div>

        {/* Metrics Row: Transferred MBs on Left, Remaining Time on Right */}
        <div className="transfer-submetrics-row">
          <div className="transferred-mbs">
            {formattedTransferred} of {formattedTotal} transferred
          </div>
          <div className="remaining-eta">
            {etaText}
          </div>
        </div>

        <div className="transfer-card-divider" />

        {/* Action Buttons Row */}
        <div className="transfer-actions-row">
          <button
            type="button"
            onClick={() => setIsPaused(!isPaused)}
            className="pause-btn-capsule"
          >
            <span className="pause-icon">{isPaused ? '▶' : '▌▌'}</span> {isPaused ? 'RESUME TRANSFER' : 'PAUSE TRANSFER'}
          </button>

          <button
            type="button"
            onClick={handleCancel}
            className="cancel-text-btn"
          >
            CANCEL TRANSFER
          </button>
        </div>
      </div>
    );
  };

  const activeTransfer = engineState === 'connected' || engineState === 'transferring' || engineState === 'completed';
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
                            <div
                              className="pin-slot-card white-group has-value"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 900,
                                fontSize: '1.7rem',
                                lineHeight: 1
                              }}
                            >
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
                            <div
                              className="pin-slot-card blue-group has-value"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 900,
                                fontSize: '1.7rem',
                                lineHeight: 1
                              }}
                            >
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
                      {engineState === 'connected' ? 'RECEIVER CONNECTED' : 'WAITING FOR RECEIVER...'}
                    </span>
                  </div>

                </div>
              )}
            </div>
          )}

          {/* Receive View */}
          {activeTab === 'receive' && (
            <div className="card-receive" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

              {activeTransfer ? (
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

                  {/* Top Status Pill Badge (Electric Blue for All States) */}
                  <div style={{ textAlign: 'center', marginBottom: '14px' }}>
                    <div className="code-pending-pill">
                      {engineState === 'failed' ? (
                        <>
                          <X size={14} /> INVALID CODE — TRY AGAIN
                        </>
                      ) : (engineState === 'connecting' || engineState === 'pairing') ? (
                        <>
                          <span className="pulsing-dot-blue" /> CONNECTING TO SENDER...
                        </>
                      ) : (engineState === 'connected' || engineState === 'transferring') ? (
                        <>
                          <Check size={14} /> CODE VERIFIED & CONNECTED <span style={{ letterSpacing: '0.15em', marginLeft: '6px' }}>●●●●●●</span>
                        </>
                      ) : inputCode.replace(/\s/g, '').length === 6 ? (
                        <>
                          <span className="pulsing-dot-blue" /> VERIFYING CODE...
                        </>
                      ) : (
                        <>
                          <span className="pulsing-dot-blue" /> ENTER 6-DIGIT CODE
                        </>
                      )}
                    </div>
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
