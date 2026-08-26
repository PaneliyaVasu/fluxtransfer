import React from 'react';
import { ArrowUpDown, Sun, Moon } from 'lucide-react';
import { useCircularTheme } from '../hooks/useCircularTheme.js';

export default function Navbar({ onToggleZen }) {
  const { isDark, toggleTheme } = useCircularTheme('light');

  return (
    <header
      className="glass-header"
      style={{
        width: '100%',
        position: 'relative',
        zIndex: 5,
        padding: '12px 24px',
        marginBottom: '0px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}
    >
      {/* Brand Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div className="glass-logo-box">
          <ArrowUpDown size={18} />
        </div>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-title)', letterSpacing: '-0.02em', margin: 0 }}>
          FluxTransfer
        </h1>
      </div>

      {/* Right Action Icons: Apple Liquid Theme Toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Apple Liquid Theme Change Toggle Button */}
        <button
          onClick={(e) => toggleTheme(e)}
          title={`Switch to ${isDark ? 'Light' : 'Dark'} Mode (Press 'T')`}
          style={{
            position: 'relative',
            width: '92px',
            height: '38px',
            borderRadius: '9999px',
            background: isDark ? 'rgba(30, 41, 59, 0.75)' : 'rgba(255, 255, 255, 0.45)',
            border: isDark ? '1px solid rgba(255, 255, 255, 0.15)' : '1px solid rgba(255, 255, 255, 0.8)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            boxShadow: isDark ? 'inset 0 1px 2px rgba(0, 0, 0, 0.4)' : 'inset 0 1px 2px rgba(0, 0, 0, 0.05)',
            display: 'flex',
            alignItems: 'center',
            padding: '3px',
            cursor: 'pointer',
            outline: 'none',
            transition: 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          {/* Track Label Text ("Light" or "Dark") */}
          <span
            style={{
              position: 'absolute',
              right: isDark ? 'auto' : '14px',
              left: isDark ? '14px' : 'auto',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: isDark ? '#f8fafc' : '#334155',
              letterSpacing: '-0.01em',
              userSelect: 'none',
              transition: 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            {isDark ? 'Dark' : 'Light'}
          </span>

          {/* Sliding Liquid Glass Circular Lens Knob */}
          <div
            style={{
              position: 'absolute',
              top: '3px',
              left: isDark ? 'calc(100% - 35px)' : '3px',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: isDark
                ? 'rgba(15, 23, 42, 0.85)'
                : 'rgba(255, 255, 255, 0.85)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: isDark
                ? '1px solid rgba(255, 255, 255, 0.25)'
                : '1px solid rgba(255, 255, 255, 0.95)',
              boxShadow: isDark
                ? 'inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 4px 12px rgba(0, 0, 0, 0.35)'
                : 'inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 12px rgba(100, 110, 140, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            {isDark ? (
              <Moon size={15} color="#f8fafc" />
            ) : (
              <Sun size={15} color="#334155" />
            )}
          </div>
        </button>
      </div>
    </header>
  );
}
