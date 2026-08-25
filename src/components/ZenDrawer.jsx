import React, { useState } from 'react';
import { X, Sparkles, Wind, Volume2, VolumeX, Play, Pause } from 'lucide-react';

export default function ZenDrawer({ isOpen, onClose }) {
  const [isBreathing, setIsBreathing] = useState(false);
  const [breathPhase, setBreathPhase] = useState('Breathe In');

  if (!isOpen) return null;

  const toggleBreathing = () => {
    setIsBreathing(!isBreathing);
  };

  return (
    <div className="glass-modal-backdrop" onClick={onClose}>
      <div 
        className="glass-card" 
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '520px', padding: '32px', border: '1px solid rgba(232, 163, 61, 0.4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sparkles size={22} color="var(--accent-gold)" />
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent-gold)' }}>
              Flux Zen Ambient Mode
            </h3>
          </div>
          <button onClick={onClose} className="glass-btn" style={{ padding: '8px' }}>
            <X size={18} />
          </button>
        </div>

        <p style={{ color: 'var(--text-variant)', fontSize: '0.92rem', marginBottom: '28px' }}>
          Relax while your peer-to-peer data transfer streams in the background. Mindful breathing exercise and ambient visual focus.
        </p>

        {/* Breathing Orb Visualization */}
        <div style={{ textAlign: 'center', padding: '30px 0' }}>
          <div 
            style={{
              width: '160px',
              height: '160px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(232, 163, 61, 0.4) 0%, rgba(217, 119, 6, 0.1) 70%)',
              border: '2px solid rgba(232, 163, 61, 0.6)',
              margin: '0 auto 24px auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 40px rgba(232, 163, 61, 0.3)',
              transform: isBreathing ? 'scale(1.2)' : 'scale(1)',
              transition: 'transform 4s ease-in-out'
            }}
          >
            <Wind size={40} color="var(--accent-gold)" />
          </div>

          <button 
            onClick={toggleBreathing}
            className="glass-btn glass-btn-zen"
            style={{ padding: '12px 24px', fontSize: '0.95rem' }}
          >
            {isBreathing ? <Pause size={16} /> : <Play size={16} />} 
            {isBreathing ? 'Pause Guided Breathing' : 'Start Zen Breathe'}
          </button>
        </div>
      </div>
    </div>
  );
}
