import React from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

export default function ToastContainer({ toasts, onCloseToast }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => {
        const isError = toast.type === 'error';
        const isSuccess = toast.type === 'success';

        return (
          <div
            key={toast.id}
            className={`glass-toast ${isError ? 'toast-error' : isSuccess ? 'toast-success' : 'toast-info'}`}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {isError && <AlertCircle size={20} color="#ef4444" />}
              {isSuccess && <CheckCircle size={20} color="#10b981" />}
              {!isError && !isSuccess && <Info size={20} color="#7c3aed" />}

              <div>
                {toast.title && (
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-title)', marginBottom: '2px' }}>
                    {toast.title}
                  </div>
                )}
                <div style={{ fontSize: '0.82rem', fontWeight: 500, color: 'var(--text-body)' }}>
                  {toast.message}
                </div>
              </div>
            </div>

            <button
              onClick={() => onCloseToast(toast.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '6px'
              }}
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
