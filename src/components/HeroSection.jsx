import React from 'react';
import { ArrowUpDown } from 'lucide-react';

export default function HeroSection() {
  return (
    <section
      style={{
        textAlign: 'center',
        position: 'relative',
        display: 'flex',
        justifyContent: 'center',
        marginTop: '-44px',
        marginBottom: '-55px',
        zIndex: 30,
        pointerEvents: 'none'
      }}
    >
      {/* Centered 3D Liquid Glass Cloud Artwork Container */}
      <div style={{ position: 'relative', width: '100%', maxWidth: '680px', height: '320px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {/* Light 3D Glass Cloud Background Image */}
        <img
          src="/assets/glass-cloud-hero.png"
          alt="3D Iridescent Liquid Glass Cloud"
          className="hero-cloud-light"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: 'drop-shadow(0 20px 40px rgba(160, 170, 200, 0.2))',
            zIndex: 30
          }}
        />

        {/* Dark 3D Glass Cloud Background Image */}
        <img
          src="/assets/glass-cloud-hero-dark.png"
          alt="3D Iridescent Liquid Glass Cloud Dark"
          className="hero-cloud-dark"
          style={{
            position: 'absolute',
            top: '55%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: 'drop-shadow(0 20px 40px rgba(0, 0, 0, 0.6))',
            zIndex: 30
          }}
        />

        {/* Overlay Content Centered Inside/Over the 3D Glass Cloud */}
        <div style={{ position: 'relative', zIndex: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', marginTop: '-10px' }}>

          {/* Floating Circular Arrow Badge */}
          <div
            className="hero-arrow-badge"
            style={{
              width: '54px',
              height: '54px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '10px'
            }}
          >
            <ArrowUpDown size={22} />
          </div>

          {/* Hero Headline */}
          <h2 style={{ fontSize: '2.4rem', fontWeight: 800, color: 'var(--text-title)', letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '4px' }}>
            File Transfer
          </h2>

          {/* Hero Subtitle */}
          <p style={{ color: 'var(--text-muted)', fontSize: '1.02rem', fontWeight: 500 }}>
            Fast. Secure. Simple.
          </p>
        </div>

      </div>
    </section>
  );
}
