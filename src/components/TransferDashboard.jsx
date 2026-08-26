import React, { useState, useEffect, useRef } from 'react';
import { Upload, Download, QrCode, FileText, Check, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import QrScannerModal from './transfer/QrScannerModal.jsx';
import CodeDigitInput from './transfer/CodeDigitInput.jsx';
import ProgressCard from './transfer/ProgressCard.jsx';

export default function TransferDashboard({ transfer, addToast }) {
  const [inputCode, setInputCode] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const digitRefs = [
    useRef(null),
    useRef(null),
    useRef(null),
    useRef(null),
    useRef(null),
    useRef(null),
    useRef(null),
    useRef(null)
  ];

  useEffect(() => {
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

  // Auto-connect when scanned via QR code link (?code=aB3xK9pQ)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlCode = params.get('code');
      if (urlCode && /^[a-zA-Z0-9]{8}$|^\d{6}$/.test(urlCode.trim())) {
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
    if (!cleanCode || (cleanCode.length !== 8 && cleanCode.length !== 6)) {
      if (addToast) addToast('error', 'Invalid Code', 'Please enter an 8-character transfer code.');
      return;
    }
    joinReceiveSession(cleanCode);
    if (addToast) addToast('info', 'Connecting', `Connecting to transfer code ${cleanCode}...`);
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
    <ProgressCard
      engineState={engineState}
      isCompleted={isCompleted}
      isSending={isSending}
      transferProgress={transferProgress}
      selectedFile={selectedFile}
      receivedFileName={receivedFileName}
      transferredBytes={transferredBytes}
      totalBytes={totalBytes}
      transferSpeed={transferSpeed}
      receivedFileUrl={receivedFileUrl}
      receivedFileBlob={receivedFileBlob}
      handleDownloadFile={handleDownloadFile}
      handleCancel={handleCancel}
      formatBytes={formatBytes}
    />
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
            /* Selected File: 8-Character Pairing Code + QR Code */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: 'var(--glass-card-bg)', padding: '20px 14px', borderRadius: '16px', border: '1px solid var(--glass-card-border)', textAlign: 'center' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
                8-CHARACTER PAIRING CODE
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: '14px' }}>
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', margin: '0 auto', flexWrap: 'nowrap' }}>
                  {(pairingCode || '--------').split('').map((char, idx) => (
                    <div
                      key={idx}
                      className="pin-slot-input"
                      style={{ width: '32px', height: '42px', fontSize: '1rem', fontWeight: 700 }}
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
                      : pairingCode || '--------'
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
              <CodeDigitInput
                inputCode={inputCode}
                setInputCode={setInputCode}
                digitRefs={digitRefs}
              />

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

                <QrScannerModal
                  setInputCode={setInputCode}
                  addToast={addToast}
                  joinReceiveSession={joinReceiveSession}
                  digitRefs={digitRefs}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
