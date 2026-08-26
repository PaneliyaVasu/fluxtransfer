import React, { useRef } from 'react';
import { QrCode } from 'lucide-react';
import jsQR from 'jsqr';

export default function QrScannerModal({ setInputCode, addToast, joinReceiveSession, digitRefs }) {
  const qrInputRef = useRef(null);

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
        const urlMatch = raw.match(/[?&]code=([a-zA-Z0-9]{8}|\d{6})/);
        const code = urlMatch ? urlMatch[1] : (raw.match(/^([a-zA-Z0-9]{8}|\d{6})$/) ? raw : null);

        if (code) {
          setInputCode(code);
          if (Array.isArray(digitRefs)) {
            code.split('').forEach((char, idx) => {
              if (digitRefs[idx]?.current) digitRefs[idx].current.value = char;
            });
          }
          if (addToast) addToast('success', 'QR Code Scanned', `Connecting to code ${code}...`);
          if (joinReceiveSession) {
            joinReceiveSession(code);
          }
        } else {
          if (addToast) addToast('error', 'QR Scan Failed', 'No valid pairing code found in QR image.');
        }
      } else {
        if (addToast) addToast('error', 'QR Scan Failed', 'Could not detect a QR code in the image. Try a clearer photo.');
      }
    } catch (err) {
      console.error('[QR Scanner]', err);
      if (addToast) addToast('error', 'QR Scan Error', 'Failed to read image. Please try again.');
    }
  };

  return (
    <>
      <input
        type="file"
        ref={qrInputRef}
        onChange={handleQrFileSelect}
        accept="image/*"
        style={{ display: 'none' }}
      />
      <button
        onClick={handleQrScanClick}
        className="glass-btn"
        style={{
          width: '100%',
          padding: '12px 18px',
          borderRadius: '14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          fontSize: '0.88rem',
          fontWeight: 600,
          marginBottom: '16px',
          color: 'var(--text-title)',
          cursor: 'pointer'
        }}
      >
        <QrCode size={18} color="#7c3aed" /> Scan QR Image to Connect
      </button>
    </>
  );
}
