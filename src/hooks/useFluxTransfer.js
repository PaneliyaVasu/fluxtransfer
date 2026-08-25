import { useState, useEffect, useRef, useCallback } from 'react';
import FluxWebRTCEngine from '../client/webrtc-engine.js';

export function useFluxTransfer() {
  const [engineState, setEngineState] = useState('idle'); // idle, connecting, connected, transferring, completed, failed
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

  useEffect(() => {
    // Instantiate WebRTC engine
    const EngineClass = FluxWebRTCEngine || window.FluxWebRTCEngine;
    const engine = new EngineClass();
    engineRef.current = engine;

    // Register event listeners
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
      setEngineState('completed');
    });

    engine.on('error', (err) => {
      setErrorMessage(typeof err === 'string' ? err : err?.message || 'Transfer error occurred');
      setEngineState('failed');
    });

    return () => {
      try {
        engine.disconnect();
      } catch (e) {}
    };
  }, []);

  const createSendSession = useCallback(async (file) => {
    if (!file || !engineRef.current) return;
    selectedFileRef.current = file;
    setSelectedFile(file);
    setRole('sender');
    setErrorMessage('');

    // Generate 6-digit numeric pairing PIN
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    setPairingCode(code);

    try {
      // Auto-trigger sendFile when peer connects and DataChannel opens
      engineRef.current.onDataChannelOpen = () => {
        if (selectedFileRef.current && !engineRef.current.isTransferring) {
          engineRef.current.sendFile(selectedFileRef.current);
        }
      };
      engineRef.current.connect(code, code);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to create send session');
      setEngineState('failed');
    }
  }, []);

  const joinReceiveSession = useCallback(async (code) => {
    const cleanCode = String(code || '').trim();
    if (!cleanCode || !engineRef.current) return;
    setRole('receiver');
    setErrorMessage('');
    try {
      engineRef.current.connect(cleanCode, cleanCode);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to connect to pairing code');
      setEngineState('failed');
    }
  }, []);

  const cancelTransfer = useCallback(() => {
    selectedFileRef.current = null;
    if (engineRef.current) {
      try {
        engineRef.current.disconnect();
      } catch (e) {}
    }
    setEngineState('idle');
    setRole(null);
    setPairingCode('');
    setSelectedFile(null);
    setTransferProgress(0);
    setTransferredBytes(0);
    setTotalBytes(0);
    setReceivedFileBlob(null);
    setReceivedFileUrl(null);
    setReceivedFileName('');
    setErrorMessage('');
  }, []);

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
