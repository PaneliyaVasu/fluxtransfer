import { useState, useEffect, useRef, useCallback } from 'react';
import { installSoftwareCrypto } from '../utils/software-crypto.js';
import FluxWebRTCEngine from '../engine/webrtc-engine.js';
import { generateSessionCode, isValidSessionCode } from '../config/app-config.js';
import { createZipArchive, suggestZipName } from '../utils/zip-files.js';
import { asDownloadFile, isIosDevice, triggerBrowserDownload } from '../utils/save-received-file.js';

if (typeof globalThis !== 'undefined' && !globalThis.FluxSoftwareCrypto) {
  installSoftwareCrypto(globalThis);
}

function normalizeFiles(fileOrFiles) {
  if (!fileOrFiles) return [];
  if (typeof FileList !== 'undefined' && fileOrFiles instanceof FileList) {
    return Array.from(fileOrFiles);
  }
  if (Array.isArray(fileOrFiles)) return fileOrFiles.filter(Boolean);
  return [fileOrFiles];
}

export function useFluxTransfer() {
  const [engineState, setEngineState] = useState('idle');
  const [role, setRole] = useState(null);
  const [pairingCode, setPairingCode] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState('0 MB/s');
  const [transferredBytes, setTransferredBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState(0);
  const [currentFileName, setCurrentFileName] = useState('');
  const [packedFileCount, setPackedFileCount] = useState(1);
  const [packedFiles, setPackedFiles] = useState([]);
  const [isPacking, setIsPacking] = useState(false);
  const [packProgress, setPackProgress] = useState(0);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [receivedFileBlob, setReceivedFileBlob] = useState(null);
  const [receivedFileUrl, setReceivedFileUrl] = useState(null);
  const [receivedFileName, setReceivedFileName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('');
  const [isPaused, setIsPaused] = useState(false);

  const engineRef = useRef(null);
  const selectedFilesRef = useRef([]);
  const packedFileRef = useRef(null);
  const packPromiseRef = useRef(null);
  const wakeLockRef = useRef(null);
  const receivedUrlsRef = useRef([]);

  const selectedFile = selectedFiles[0] || null;

  const revokeAllFileUrls = useCallback(() => {
    receivedUrlsRef.current.forEach((url) => {
      try { URL.revokeObjectURL(url); } catch (_) {}
    });
    receivedUrlsRef.current = [];
  }, []);

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
      wakeLockRef.current = null;
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try { await wakeLockRef.current.release(); } catch (_) {}
      wakeLockRef.current = null;
    }
  }, []);

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

  useEffect(() => {
    if (engineState === 'transferring') {
      requestWakeLock();
    } else if (engineState !== 'connected') {
      releaseWakeLock();
    }
  }, [engineState, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    const EngineClass = FluxWebRTCEngine || window.FluxWebRTCEngine;
    const engine = new EngineClass();
    engineRef.current = engine;

    engine.on('stateChange', (state) => {
      setEngineState(state);
      if (state === 'cancelled' || state === 'completed' || state === 'failed' || state === 'idle') {
        setIsPaused(false);
      }
    });

    engine.on('pauseChange', (paused) => {
      setIsPaused(Boolean(paused));
    });

    engine.on('statusChange', (status) => {
      if (typeof status === 'string' && status) setConnectionStatus(status);
    });

    engine.on('dataChannelOpen', () => {
      if (engine.isTransferring) return;
      const startSend = async () => {
        let files = selectedFilesRef.current;
        if (!files.length && !packPromiseRef.current && !packedFileRef.current) return;
        try {
          if (packPromiseRef.current) {
            const zip = await packPromiseRef.current;
            if (!engine.dataChannel || engine.dataChannel.readyState !== 'open' || engine.isTransferring) {
              return;
            }
            packedFileRef.current = zip;
            files = [zip];
          } else if (packedFileRef.current) {
            files = [packedFileRef.current];
          }
          if (files.length) engine.sendFiles(files);
        } catch (err) {
          setErrorMessage(err?.message || 'Failed to prepare zip archive');
        }
      };
      startSend();
    });

    engine.on('progress', (info) => {
      if (typeof info !== 'object') return;
      const percent = info.percent ?? info.percentage ?? 0;
      if (info.phase === 'zip') {
        setIsPacking(percent < 100);
        setPackProgress(Math.round(percent));
        if (info.fileName) setCurrentFileName(info.fileName);
        return;
      }
      setIsPacking(false);
      setTransferProgress(Math.round(percent));
      setTransferredBytes(info.transferredBytes || 0);
      setTotalBytes(info.totalBytes || 0);
      if (info.fileName) setCurrentFileName(info.fileName);
      if (typeof info.speedBps === 'number' && Number.isFinite(info.speedBps)) {
        const speedMB = info.speedBps / (1024 * 1024);
        setTransferSpeed(`${speedMB >= 10 ? speedMB.toFixed(1) : speedMB.toFixed(2)} MB/s`);
        const remaining = (info.totalBytes || 0) - (info.transferredBytes || 0);
        setEtaSeconds(info.speedBps > 0 ? Math.max(0, Math.round(remaining / info.speedBps)) : 0);
      }
    });

    engine.on('fileMetadata', (meta) => {
      if (meta?.name) setCurrentFileName(meta.name);
      if (typeof meta?.size === 'number') setTotalBytes(meta.size);
      if (typeof meta?.packedFileCount === 'number') setPackedFileCount(meta.packedFileCount);
      if (Array.isArray(meta?.packedFiles)) setPackedFiles(meta.packedFiles);
    });

    engine.on('fileComplete', ({ blob, fileName, fileType, packedFileCount: packedCount, packedFiles: packedList }) => {
      if (typeof packedCount === 'number') setPackedFileCount(packedCount);
      if (Array.isArray(packedList) && packedList.length) setPackedFiles(packedList);

      if (!blob) return;

      const finalName = fileName || blob.name || 'received-file';
      const mime = fileType || blob.type || 'application/octet-stream';
      const downloadFile = asDownloadFile(blob, finalName, mime);
      const skipBlobUrl = isIosDevice();
      const url = skipBlobUrl ? null : URL.createObjectURL(downloadFile);
      if (url) receivedUrlsRef.current.push(url);

      setReceivedFiles((prev) => [...prev, { name: finalName, url, blob: downloadFile, type: mime }]);
      setReceivedFileBlob(downloadFile);
      setReceivedFileUrl(url);
      setReceivedFileName(finalName);
      setCurrentFileName(finalName);
      if (!skipBlobUrl) triggerBrowserDownload(downloadFile, url);
    });

    engine.on('error', (err) => {
      setErrorMessage(typeof err === 'string' ? err : err?.message || 'Transfer error occurred');
      setEngineState((prev) => (prev === 'completed' || prev === 'cancelled' ? prev : 'failed'));
    });

    return () => {
      releaseWakeLock();
      revokeAllFileUrls();
      try { engine.disconnect(); } catch (_) {}
    };
  }, [releaseWakeLock, revokeAllFileUrls]);

  const createSendSession = useCallback(async (fileOrFiles) => {
    const files = normalizeFiles(fileOrFiles);
    if (!files.length || !engineRef.current) return;
    selectedFilesRef.current = files;
    packedFileRef.current = null;
    packPromiseRef.current = null;
    setSelectedFiles(files);
    setPackedFileCount(files.length);
    setPackedFiles(files.map((file) => ({ name: file.name, size: file.size || 0 })));
    setTotalBytes(files.reduce((sum, file) => sum + (file.size || 0), 0));
    setRole('sender');
    setErrorMessage('');
    setIsPaused(false);

    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    const zipNow = files.length > 1 && totalBytes > 0 && totalBytes <= 32 * 1024 * 1024;

    if (zipNow) {
      const zipName = suggestZipName(files);
      setCurrentFileName(zipName);
      setIsPacking(true);
      setPackProgress(0);
      packPromiseRef.current = createZipArchive(files, {
        onProgress: ({ percent, currentName }) => {
          setPackProgress(Math.round(percent));
          if (currentName) setCurrentFileName(percent >= 100 ? zipName : `Zipping ${currentName}`);
        }
      }).then((zip) => {
        packedFileRef.current = zip;
        selectedFilesRef.current = [zip];
        setCurrentFileName(zip.name);
        setTotalBytes(zip.size || 0);
        setIsPacking(false);
        setPackProgress(100);
        return zip;
      }).catch((err) => {
        setIsPacking(false);
        setErrorMessage(err.message || 'Failed to create zip archive');
        throw err;
      });
    } else {
      setCurrentFileName(files[0].name);
      setIsPacking(false);
      setPackProgress(0);
    }

    const code = generateSessionCode(6);
    setPairingCode(code);

    try {
      engineRef.current.connect(code, code);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to create send session');
      setEngineState('failed');
    }
  }, []);

  const joinReceiveSession = useCallback(async (code) => {
    const cleanCode = String(code || '').trim();
    if (!isValidSessionCode(cleanCode) || !engineRef.current) {
      setErrorMessage('Invalid session code format');
      setEngineState('failed');
      return;
    }
    const engine = engineRef.current;
    const busy = engine.transferState && engine.transferState !== 'idle' && engine.transferState !== 'failed' && engine.transferState !== 'cancelled';
    if (busy && engine.roomCode === cleanCode) {
      return;
    }
    setRole('receiver');
    setErrorMessage('');
    setIsPaused(false);
    setEngineState('connecting');
    try {
      engine.connect(cleanCode, cleanCode);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to connect to pairing code');
      setEngineState('failed');
    }
  }, []);

  const resetSession = useCallback(() => {
    selectedFilesRef.current = [];
    setSelectedFiles([]);
    setRole(null);
    setPairingCode('');
    setEngineState('idle');
    setTransferProgress(0);
    setTransferSpeed('0 MB/s');
    setTransferredBytes(0);
    setTotalBytes(0);
    setEtaSeconds(0);
    setCurrentFileName('');
    setPackedFileCount(1);
    setPackedFiles([]);
    setIsPacking(false);
    setPackProgress(0);
    packedFileRef.current = null;
    packPromiseRef.current = null;
    setReceivedFiles([]);
    setReceivedFileBlob(null);
    revokeAllFileUrls();
    setReceivedFileUrl(null);
    setReceivedFileName('');
    setErrorMessage('');
    setIsPaused(false);
    setConnectionStatus('');
    releaseWakeLock();
    if (engineRef.current) {
      try { engineRef.current.disconnect(); } catch (_) {}
    }
  }, [releaseWakeLock, revokeAllFileUrls]);

  const cancelTransfer = useCallback(() => {
    const engine = engineRef.current;
    const state = engine?.transferState;
    if (engine && (state === 'transferring' || state === 'connected')) {
      try { engine.cancelTransfer(); } catch (_) {}
      setIsPaused(false);
      return;
    }
    resetSession();
  }, [resetSession]);

  const pauseTransfer = useCallback(() => {
    if (engineRef.current) {
      try { engineRef.current.pauseTransfer(); } catch (_) {}
    }
  }, []);

  const resumeTransfer = useCallback(() => {
    if (engineRef.current) {
      try { engineRef.current.resumeTransfer(); } catch (_) {}
    }
  }, []);

  return {
    engineState,
    role,
    pairingCode,
    selectedFile,
    selectedFiles,
    transferProgress,
    transferSpeed,
    transferredBytes,
    totalBytes,
    etaSeconds,
    currentFileName,
    packedFileCount,
    packedFiles,
    isPacking,
    packProgress,
    receivedFiles,
    receivedFileBlob,
    receivedFileUrl,
    receivedFileName,
    errorMessage,
    connectionStatus,
    isPaused,
    createSendSession,
    joinReceiveSession,
    cancelTransfer,
    resetSession,
    pauseTransfer,
    resumeTransfer
  };
}

export default useFluxTransfer;
