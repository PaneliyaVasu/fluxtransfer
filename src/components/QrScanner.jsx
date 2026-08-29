import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import jsQR from 'jsqr';
import { extractPairingCode } from '../utils/pairing-url.js';

export default function QrScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const stoppedRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  const onCloseRef = useRef(onClose);
  onDetectedRef.current = onDetected;
  onCloseRef.current = onClose;

  useEffect(() => {
    stoppedRef.current = false;

    const stop = () => {
      stoppedRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };

    const tick = () => {
      if (stoppedRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= 2) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height) {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);
          const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          const code = result?.data ? extractPairingCode(result.data) : null;
          if (code) {
            stop();
            onDetectedRef.current(code);
            return;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const start = async () => {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        onCloseRef.current('camera-unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (stoppedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch (_) {
        onCloseRef.current('camera-denied');
      }
    };

    start();
    return stop;
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan pairing QR code"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(2, 6, 23, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
    >
      <div
        className="glass-card"
        style={{
          width: 'min(420px, 100%)',
          padding: '16px',
          borderRadius: '20px',
          position: 'relative'
        }}
      >
        <button
          type="button"
          onClick={() => onClose('cancelled')}
          aria-label="Close scanner"
          className="glass-btn"
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 1
          }}
        >
          <X size={18} />
        </button>
        <div style={{ fontWeight: 700, marginBottom: '10px', color: 'var(--text-title)' }}>
          Point the camera at the QR code
        </div>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: '100%', borderRadius: '14px', background: '#000', aspectRatio: '3 / 4', objectFit: 'cover' }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <p style={{ marginTop: '10px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Scanning stays on this site. Allow camera access if asked.
        </p>
      </div>
    </div>
  );
}
