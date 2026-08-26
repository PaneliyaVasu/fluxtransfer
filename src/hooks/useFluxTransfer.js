import { useState, useEffect, useRef, useCallback } from 'react';
import FluxWebRTCEngine from '../engine/webrtc-engine.js';
import { generateSessionCode, isValidSessionCode } from '../config/app-config.js';

export function useFluxTransfer() {
  const [engineState, setEngineState] = useState('idle'); // idle, connecting, connected, transferring, completed, failed, cancelled
  const [role, setRole] = useState(null); // 'sender' | 'receiver'
  const [pairingCode, setPairingCode] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState('0 MB/s');
  const [transferredBytes, setTransferredBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState(0);
  const [receivedFileBlob, setReceivedFileBlob] = useState(null);
  const [receivedFileUrl, setReceivedFileUrl] = useState(null);
  const [receivedFileName, setReceivedFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const engineRef = useRef(null);
  const selectedFileRef = useRef(null);
  const wakeLockRef = useRef(null);

  // Best-effort Screen Wake Lock helpers for mobile transfers
  const requestWakeLock = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      return;
    }
    try {
      if (!wakeLockRef.current) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      }
    } catch (_) {
      // Best-effort optional feature; continue transfer if browser rejects wake lock
      wakeLockRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch (_) {}
      wakeLockRef.current = null;
    }
  }, []);

  // Re-acquire Wake Lock when page becomes visible during an active transfer
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && engineState === 'transferring') {
        requestWakeLock();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [engineState, requestWakeLock]);

  // Acquire Wake Lock on active transfer; release when idle, completed, failed, or cancelled
  useEffect(() => {
    if (engineState === 'transferring') {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }, [engineState, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    // Instantiate WebRTC engine
    const EngineClass = FluxWebRTCEngine || window.FluxWebRTCEngine;
    const engine = new EngineClass();
    engineRef.current = engine;

    // Single source of truth: engine state drives React engineState
    engine.on('stateChange', (state) => {
      setEngineState(state);
      if (state === 'connected' && selectedFileRef.current && !engine.isTransferring && engine.dataChannel && engine.dataChannel.readyState === 'open') {
        engine.sendFile(selectedFileRef.current);
      }
    });

    engine.on('dataChannelOpen', () => {
      if (selectedFileRef.current && !engine.isTransferring) {
        engine.sendFile(selectedFileRef.current);
      }
    });

    engine.on('progress', (info) => {
      if (typeof info === 'object') {
        const percent = info.percent ?? info.percentage ?? 0;
        setTransferProgress(Math.round(percent));
        setTransferredBytes(info.transferredBytes || 0);
        setTotalBytes(info.totalBytes || 0);
        if (info.speedBps) {
          const speedMB = (info.speedBps / (1024 * 1024)).toFixed(2);
          setTransferSpeed(`${speedMB} MB/s`);
        }
      }
    });

    engine.on('fileComplete', ({ blob, fileName }) => {
      if (blob) {
        setReceivedFileBlob(blob);
        const url = URL.createObjectURL(blob);
        setReceivedFileUrl(url);
        const finalName = fileName || 'received-file';
        setReceivedFileName(finalName);

        // Automatic Download Trigger on File Transfer Completion
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = finalName;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            if (document.body.contains(a)) {
              document.body.removeChild(a);
            }
          }, 1000);
        } catch (downloadErr) {
          console.warn('[FluxTransfer] Auto-download error:', downloadErr);
        }
      }
    });

    engine.on('error', (err) => {
      setErrorMessage(typeof err === 'string' ? err : err?.message || 'Transfer error occurred');
    });

    return () => {
      releaseWakeLock();
      try {
        engine.disconnect();
      } catch (e) {}
    };
  }, [releaseWakeLock]);

  const createSendSession = useCallback(async (file) => {
    if (!file || !engineRef.current) return;
    selectedFileRef.current = file;
    setSelectedFile(file);
    setRole('sender');
    setErrorMessage('');

    // Generate 8-character cryptographically secure session code
    const code = generateSessionCode(8);
    setPairingCode(code);

    try {
      engineRef.current.connect(code, code);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to create send session');
    }
  }, []);

  const joinReceiveSession = useCallback(async (code) => {
    const cleanCode = String(code || '').trim();
    if (!isValidSessionCode(cleanCode) || !engineRef.current) {
      setErrorMessage('Invalid session code format');
      return;
    }
    setRole('receiver');
    setErrorMessage('');
    try {
      engineRef.current.connect(cleanCode, cleanCode);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to connect to pairing code');
    }
  }, []);

  const cancelTransfer = useCallback(() => {
    selectedFileRef.current = null;
    setSelectedFile(null);
    setRole(null);
    setPairingCode('');
    setTransferProgress(0);
    setTransferSpeed('0 MB/s');
    setTransferredBytes(0);
    setTotalBytes(0);
    setReceivedFileBlob(null);
    setReceivedFileUrl(null);
    setReceivedFileName('');
    setErrorMessage('');
    releaseWakeLock();
    if (engineRef.current) {
      engineRef.current.disconnect();
    }
  }, [releaseWakeLock]);

  return {
    engineState,
    role,
    pairingCode,
    selectedFile,
    transferProgress,
    transferSpeed,
    transferredBytes,
    totalBytes,
    etaSeconds,
    receivedFileBlob,
    receivedFileUrl,
    receivedFileName,
    errorMessage,
    createSendSession,
    joinReceiveSession,
    cancelTransfer
  };
}

export default useFluxTransfer;
