import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar.jsx';
import HeroSection from './components/HeroSection.jsx';
import TransferDashboard from './components/TransferDashboard.jsx';
import ZenDrawer from './components/ZenDrawer.jsx';
import ToastContainer from './components/ToastContainer.jsx';
import FAQSection from './components/FAQSection.jsx';
import { useFluxTransfer } from './hooks/useFluxTransfer.js';

export default function App() {
  const [isZenOpen, setIsZenOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  const transfer = useFluxTransfer();

  const addToast = (type, title, message) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, title, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Watch for transfer error messages and show toast notification
  useEffect(() => {
    if (transfer.errorMessage) {
      addToast('error', 'Transfer Error', transfer.errorMessage);
    }
  }, [transfer.errorMessage]);

  return (
    <div style={{ position: 'relative', zIndex: 1, padding: '16px 24px 0px 24px', maxWidth: '1240px', margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Background Shader Texture */}
      <div className="bg-liquid-overlay"></div>

      {/* Slide-In Right Toast Notification Manager */}
      <ToastContainer toasts={toasts} onCloseToast={removeToast} />

      {/* Top Header Navigation */}
      <Navbar
        onToggleZen={() => setIsZenOpen(true)}
      />

      {/* Main Content Area */}
      <main style={{ flex: 1 }}>
        {/* Centered 3D Liquid Glass Cloud Hero */}
        <HeroSection />

        {/* Transfer Dashboard */}
        <TransferDashboard transfer={transfer} addToast={addToast} />

        {/* FAQ Section */}
        <FAQSection />
      </main>

      {/* Bottom Glass Footer Attached to Bottom */}
      <footer
        className="glass-footer flex"
        style={{
          padding: '14px 28px',
          marginTop: '16px',
          marginBottom: '0px',
          display: 'flex',
          alignItems: 'center',
          justify: 'space-between',
          fontSize: '0.85rem',
          color: 'var(--text-muted)',
          borderRadius: '20px 20px 0 0'
        }}
      >
        <div>
          © 2026 FluxTransfer. All rights reserved.
        </div>
        <div style={{ fontWeight: 600, color: 'var(--text-title)' }}>
          Developed by Vasu Paneliya
        </div>
      </footer>

      {/* Modals & Drawers */}
      <ZenDrawer isOpen={isZenOpen} onClose={() => setIsZenOpen(false)} />
    </div>
  );
}
