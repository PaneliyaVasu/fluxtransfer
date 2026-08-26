import React from 'react';
import { FileText, Download } from 'lucide-react';

export default function ProgressCard({
  engineState,
  isCompleted,
  isSending,
  transferProgress,
  selectedFile,
  receivedFileName,
  transferredBytes,
  totalBytes,
  transferSpeed,
  receivedFileUrl,
  receivedFileBlob,
  handleDownloadFile,
  handleCancel,
  formatBytes
}) {
  return (
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
}
