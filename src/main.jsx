import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/glassmorphism.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register Service Worker for offline PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[FluxTransfer] Service Worker registered:', reg.scope);
    }).catch((err) => {
      console.warn('[FluxTransfer] Service Worker registration failed:', err);
    });
  });
}
