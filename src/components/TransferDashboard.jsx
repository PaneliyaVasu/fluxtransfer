import React, { useState } from 'react';
import { Upload, Download, QrCode, FileText, Check, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';

export default function TransferDashboard({ transfer, addToast }) {
  const [inputCode, setInputCode] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const qrInputRef = React.useRef(null);

  const handleQrScanClick = () => {
    if (qrInputRef.current) {
      qrInputRef.current.value = '';
      qrInputRef.current.click();
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
        const raw = result.data;
        // Extract 6-digit numeric code from URL (?code=XXXXXX) or raw text
        const urlMatch = raw.match(/[?&]code=([0-9]{6})/);
        const code = urlMatch ? urlMatch[1] : (raw.match(/^([0-9]{6})$/) ? raw : null);

        if (code) {
          setInputCode(code);
          code.split('').forEach((char, idx) => {
            if (digitRefs[idx]?.current) digitRefs[idx].current.value = char;
          });
          if (addToast) addToast('success', 'QR Code Scanned', `Connecting to code ${code}...`);
          if (transfer.joinReceiveSession) {
            transfer.joinReceiveSession(code);
          }
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

  // Auto-connect when scanned via QR code link (?code=123456)
  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlCode = params.get('code');
      if (urlCode && /^[0-9]{6}$/.test(urlCode.trim())) {
        const cleanCode = urlCode.trim();
        setInputCode(cleanCode);

        const tryJoin = (attempts = 0) => {
          if (transfer.joinReceiveSession) {
            transfer.joinReceiveSession(cleanCode);
            if (addToast) addToast('info', 'QR Code Scanned', `Connecting to code ${cleanCode}...`);
            window.history.replaceState({}, document.title, window.location.pathname);
          } else if (attempts < 10) {
            setTimeout(() => tryJoin(attempts + 1), 100);
          }
        };

        setTimeout(tryJoin, 150);
      }
    }
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
    createSendSession,
    joinReceiveSession,
    cancelTransfer
  } = transfer;

  const handleDownloadFile = async (e) => {
    if (e) e.preventDefault();
    if (!receivedFileBlob && !receivedFileUrl) return;

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
    if (!cleanCode || cleanCode.length !== 6 || !/^[0-9]{6}$/.test(cleanCode)) {
      if (addToast) addToast('error', 'Invalid Code', 'Please enter a 6-digit numeric transfer code.');
      return;
    }
    joinReceiveSession(cleanCode);
    if (addToast) addToast('info', 'Connecting', `Connecting to transfer code ${cleanCode}...`);
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

  const isCompleted = engineState === 'completed' || transferProgress === 100;
  const isSending = role === 'sender' || Boolean(selectedFile);
  const isReceiving = role === 'receiver' || Boolean(receivedFileUrl) || (engineState !== 'idle' && !selectedFile);

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
                ? (isSending ? 'File sent successfully to peer' : 'File received successfully')
                : (isSending ? 'Sending file to peer' : 'Receiving file from peer')}
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
              : engineState === 'connecting'
              ? 'Connecting...'
              : selectedFile
              ? 'Ready for Receiver'
              : 'Idle'}
          </span>
        </div>

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
            Send Another File ✨
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

  return (
    <div style={{ position: 'relative', zIndex: 30, maxWidth: '750px', width: '100%', margin: '0 auto' }}>
      <div className="cards-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'clamp(12px, 1.8vw, 20px)', marginBottom: 'clamp(12px, 1.8vh, 20px)' }}>
        {/* Left Card — Send Files */}
        <div className="glass-card card-send" style={{ padding: 'clamp(18px, 2.4vh, 24px)', display: 'flex', flexDirection: 'column' }}>
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

          {isReceiving ? (
            renderTransferProgressCard()
          ) : !selectedFile ? (
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
                <h4 className="dropzone-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '4px' }}>
                  Ready to share?
                </h4>
                <p className="dropzone-subtitle" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Drag files or tap to browse
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
                  File Delivered Successfully! 🎉
                </h4>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  {selectedFile?.name || 'File'} ({formatBytes(selectedFile?.size)})
                </p>
              </div>
            </div>
          ) : (
            /* Selected File: 6-Digit Pairing Code + QR Code */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: 'var(--glass-card-bg)', padding: '20px 14px', borderRadius: '16px', border: '1px solid var(--glass-card-border)', textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
                6-DIGIT PAIRING CODE
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: '14px' }}>
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', margin: '0 auto', flexWrap: 'nowrap' }}>
                  {(pairingCode || '------').split('').map((char, idx) => (
                    <div
                      key={idx}
                      className="pin-slot-input"
                      style={{ width: '36px', height: '44px', fontSize: '1.15rem', fontWeight: 700 }}
                    >
                      {char}
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
                  value={
                    typeof window !== 'undefined' && pairingCode
                      ? `${window.location.origin}/?code=${pairingCode}`
                      : pairingCode || '------'
                  }
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
        <div className="glass-card card-receive" style={{ padding: 'clamp(18px, 2.4vh, 24px)', display: 'flex', flexDirection: 'column' }}>
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

          {isSending ? (
            renderTransferProgressCard()
          ) : (
            <>
              {/* 6-Digit Slot PIN Inputs */}
              <div style={{ marginTop: '12px', marginBottom: '16px', width: '100%', display: 'flex', justifyContent: 'center' }}>
                <div className="pin-slot-container" style={{ display: 'flex', justifyContent: 'center', gap: '6px', width: '100%', margin: '0 auto' }} onPaste={handleDigitPaste}>
                  {[0, 1, 2, 3, 4, 5].map((idx) => {
                    const char = (inputCode[idx] && inputCode[idx] !== ' ') ? inputCode[idx] : '';
                    return (
                      <input
                        key={idx}
                        ref={digitRefs[idx]}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        value={char}
                        onChange={(e) => handleDigitChange(idx, e.target.value)}
                        onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                        className="pin-slot-input"
                        style={{ width: '36px', height: '44px', fontSize: '1.15rem' }}
                      />
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 'auto' }}>
                <button
                  onClick={handleJoinSession}
                  className="glass-btn glass-btn-dark receive-action-btn"
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

                <button
                  onClick={handleQrScanClick}
                  className="glass-btn qr-scan-btn"
                  style={{
                    width: '52px',
                    height: '52px',
                    padding: 0,
                    borderRadius: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0
                  }}
                  title="Scan QR Code"
                >
                  <QrCode size={20} color="var(--text-muted)" />
                </button>
                <input
                  type="file"
                  ref={qrInputRef}
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={handleQrFileSelect}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
