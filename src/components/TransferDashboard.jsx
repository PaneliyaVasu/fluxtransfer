import React, { useState } from 'react';
import { Upload, Download, ArrowRight, QrCode, FileText, Check, Copy, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

export default function TransferDashboard({ transfer, addToast }) {
  const [inputCode, setInputCode] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

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

  const {
    engineState,
    role,
    pairingCode,
    selectedFile,
    transferProgress,
    transferSpeed,
    transferredBytes,
    totalBytes,
    receivedFileBlob,
    receivedFileUrl,
    receivedFileName,
    errorMessage,
    createSendSession,
    joinReceiveSession,
    cancelTransfer
  } = transfer;

  const handleDownloadFile = async (e) => {
    if (e) e.preventDefault();
    if (!receivedFileBlob && !receivedFileUrl) return;

    // 1. Native File System Access API (Bypasses Chrome Network Download Manager completely for multi-GB files!)
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: receivedFileName || 'downloaded-file'
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
        if (err.name === 'AbortError') return; // User cancelled save dialog
      }
    }

    // 2. Direct Programmatic Anchor Fallback
    const a = document.createElement('a');
    a.href = receivedFileUrl;
    a.download = receivedFileName || 'downloaded-file';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      createSendSession(file);
      if (addToast) addToast('info', 'File Selected', `Ready to send: ${file.name}`);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      createSendSession(file);
      if (addToast) addToast('info', 'File Selected', `Ready to send: ${file.name}`);
    }
  };

  const handleJoinSession = () => {
    const cleanCode = inputCode.trim();
    if (!cleanCode || cleanCode.length !== 6) {
      if (addToast) addToast('error', 'Invalid Code', 'Please enter a 6-digit transfer code.');
      return;
    }
    joinReceiveSession(cleanCode);
    if (addToast) addToast('info', 'Connecting', `Connecting to transfer code ${cleanCode}...`);
  };

  const handleDigitChange = (index, value) => {
    const char = value.replace(/\D/g, '').slice(-1);
    const digits = (inputCode.padEnd(6, ' ')).split('');
    digits[index] = char || ' ';
    const newCode = digits.join('').replace(/\s+$/, '');
    setInputCode(newCode);

    if (char && index < 5) {
      digitRefs[index + 1].current?.focus();
    }
  };

  const handleDigitKeyDown = (index, e) => {
    if (e.key === 'Backspace' && (!inputCode[index] || inputCode[index] === ' ') && index > 0) {
      digitRefs[index - 1].current?.focus();
    }
  };

  const handleDigitPaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted) {
      setInputCode(pasted);
      const focusIndex = Math.min(pasted.length, 5);
      digitRefs[focusIndex]?.current?.focus();
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
  };

  const handleCopyCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode);
    setIsCopied(true);
    if (addToast) addToast('success', 'Code Copied', '6-digit pairing code copied to clipboard!');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleCancel = () => {
    setInputCode('');
    cancelTransfer();
  };

  const isTransferActive = engineState === 'transferring' || engineState === 'completed' || selectedFile;
  const isCompleted = engineState === 'completed';
  const isSending = role === 'sender' || Boolean(selectedFile);
  const isReceiving = role === 'receiver' || Boolean(receivedFileUrl) || (engineState !== 'idle' && !selectedFile);

  const renderTransferProgressCard = () => (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justify: 'space-between',
        background: 'var(--glass-card-bg)',
        padding: '20px 18px',
        borderRadius: '18px',
        border: '1px solid var(--glass-card-border)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.04)'
      }}
    >
      <div>
        {/* Top Header Row: Status Title & Badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '2px' }}>
              Transfer Progress
            </h4>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {isSending ? 'Sending file to peer' : 'Receiving file from peer'}
            </div>
          </div>
          <span className="status-badge" style={{ fontSize: '0.75rem', padding: '5px 12px', borderRadius: '999px' }}>
            <span
              className="status-badge-dot"
              style={{
                backgroundColor: isCompleted
                  ? '#10b981'
                  : engineState === 'transferring'
                  ? '#7c3aed'
                  : engineState === 'connecting'
                  ? '#f59e0b'
                  : engineState === 'failed'
                  ? '#ef4444'
                  : selectedFile
                  ? '#3b82f6'
                  : '#94a3b8'
              }}
            ></span>
            {isCompleted
              ? 'Completed'
              : engineState === 'transferring'
              ? `${transferProgress}% Transferring`
              : engineState === 'connecting'
              ? 'Connecting...'
              : engineState === 'failed'
              ? 'Failed'
              : selectedFile
              ? 'Ready for Receiver'
              : 'Idle'}
          </span>
        </div>

        {/* Progress Bar with Glowing Gradient Fill */}
        <div style={{ width: '100%', background: 'rgba(203, 213, 225, 0.35)', borderRadius: '999px', height: '10px', overflow: 'hidden', marginBottom: '18px' }}>
          <div
            style={{
              height: '100%',
              width: `${transferProgress}%`,
              background: isCompleted ? 'linear-gradient(90deg, #10b981, #059669)' : 'linear-gradient(90deg, #4f46e5, #7c3aed)',
              borderRadius: '999px',
              transition: 'width 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              boxShadow: '0 0 10px rgba(124, 58, 237, 0.4)'
            }}
          ></div>
        </div>

        {/* Rich File Details Box */}
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
          {/* File Icon Badge */}
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

          {/* Name, Byte Counter, and Live Speed */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-title)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '4px' }}>
              {selectedFile?.name || receivedFileName || 'Incoming File'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', gap: '8px' }}>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {formatBytes(transferredBytes)} / {formatBytes(totalBytes || selectedFile?.size || 0)}
              </span>
              {engineState === 'transferring' && (
                <span style={{ fontWeight: 700, color: '#7c3aed', flexShrink: 0 }}>⚡ {transferSpeed}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons Row (Download / Cancel) */}
      <div style={{ display: 'flex', gap: '10px', marginTop: 'auto' }}>
        {receivedFileUrl && (
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
            Download File <Download size={15} />
          </button>
        )}
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
          {isCompleted ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );  return (
    <div style={{ position: 'relative', zIndex: 30, maxWidth: '750px', width: '100%', margin: '0 auto' }}>
      {/* Top 2-Column Grid: Send Files (Left) & Receive Files (Right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'clamp(12px, 1.8vw, 20px)', marginBottom: 'clamp(12px, 1.8vh, 20px)' }}>
        {/* Left Card — Send Files */}
        <div className="glass-card" style={{ padding: 'clamp(18px, 2.4vh, 24px)', display: 'flex', flexDirection: 'column' }}>
          {/* Card Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div className="icon-pill icon-pill-purple">
                <Upload size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '2px' }}>
                  Send Files
                </h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>
                  Choose files to send securely.
                </p>
              </div>
            </div>

            {/* Top Right X Button when File is Uploaded */}
            {selectedFile && (
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
            )}
          </div>

          {/* If RECEIVING file: Place Transfer Progress inside Sender block */}
          {isReceiving ? (
            renderTransferProgressCard()
          ) : !selectedFile ? (
            /* Send File Dropzone */
            <div
              className="dropzone-box"
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              style={{
                border: isDragOver ? '2px dashed #7c3aed' : '1px dashed rgba(168, 85, 247, 0.35)',
                borderRadius: '20px',
                padding: '30px 20px',
                textAlign: 'center',
                background: isDragOver ? 'rgba(124, 58, 237, 0.08)' : 'var(--dropzone-bg, rgba(255, 255, 255, 0.45))',
                transition: 'all 0.25s ease',
                cursor: 'pointer'
              }}
            >
              <input
                type="file"
                id="file-upload-input"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <label htmlFor="file-upload-input" style={{ cursor: 'pointer', display: 'block' }}>
                <div className="dropzone-badge" style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#ffffff', boxShadow: '0 4px 14px rgba(168, 85, 247, 0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px auto' }}>
                  <Upload size={24} color="#a855f7" />
                </div>
                <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '4px' }}>
                  Ready to share?
                </h4>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Drag files or tap to browse
                </p>
              </label>
            </div>
          ) : (
            /* Selected File: 6-Digit Code (Above) + QR Code (Below) */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: 'var(--glass-card-bg)', padding: '20px 14px', borderRadius: '16px', border: '1px solid var(--glass-card-border)', textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
                6-DIGIT PAIRING CODE
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: '14px' }}>
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', margin: '0 auto' }}>
                  {(pairingCode || '------').split('').map((digit, idx) => (
                    <div
                      key={idx}
                      className="pin-slot-input"
                    >
                      {digit}
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  width: '148px',
                  height: '148px',
                  margin: '0 auto 4px auto',
                  padding: '8px',
                  background: '#ffffff',
                  borderRadius: '16px',
                  boxShadow: '0 8px 24px rgba(124, 58, 237, 0.12)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <QRCodeSVG
                  value={pairingCode || '000000'}
                  size={132}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
                  level="M"
                />
              </div>
            </div>
          )}
        </div>

        {/* Right Card — Receive Files */}
        <div className="glass-card" style={{ padding: 'clamp(18px, 2.4vh, 24px)', display: 'flex', flexDirection: 'column' }}>
          {/* Card Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
            <div className="icon-pill icon-pill-emerald">
              <Download size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '2px' }}>
                Receive Files
              </h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>
                Enter code to receive files.
              </p>
            </div>
          </div>

          {/* If SENDING file: Place Transfer Progress inside Receiver block */}
          {isSending ? (
            renderTransferProgressCard()
          ) : (
            <>
              {/* 6-Digit Slot PIN Inputs */}
              <div style={{ marginTop: '16px', marginBottom: '24px', width: '100%', display: 'flex', justifyContent: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', width: '100%', margin: '0 auto' }} onPaste={handleDigitPaste}>
                  {[0, 1, 2, 3, 4, 5].map((idx) => {
                    const char = (inputCode[idx] && inputCode[idx] !== ' ') ? inputCode[idx] : '';
                    return (
                      <input
                        key={idx}
                        ref={digitRefs[idx]}
                        type="text"
                        maxLength={1}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={char}
                        onChange={(e) => handleDigitChange(idx, e.target.value)}
                        onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                        className="pin-slot-input"
                      />
                    );
                  })}
                </div>
              </div>

              {/* Bottom Action Row */}
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: 'auto' }}>
                <button
                  onClick={handleJoinSession}
                  className="glass-btn glass-btn-dark"
                  style={{
                    flex: 1,
                    height: '50px',
                    padding: '0 20px',
                    borderRadius: '14px',
                    fontSize: '0.98rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  Receive <Download size={18} />
                </button>

                {isMobile && (
                  <button
                    className="glass-btn qr-scan-btn"
                    style={{
                      width: '52px',
                      height: '52px',
                      padding: 0,
                      borderRadius: '14px',
                      display: 'flex',
                      alignItems: 'center',
                      justify: 'center'
                    }}
                    title="Scan QR Code"
                  >
                    <QrCode size={20} color="var(--text-muted)" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
