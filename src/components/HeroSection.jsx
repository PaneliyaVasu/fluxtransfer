import React from 'react';
import { ArrowUpDown } from 'lucide-react';

export default function HeroSection() {
  return (
    <section className="hero-section">
      {/* Centered 3D Liquid Glass Cloud Artwork Container */}
      <div className="hero-cloud-container">

        {/* Light 3D Glass Cloud Background Image */}
        <img
          src="/assets/glass-cloud-hero.png"
          alt="3D Iridescent Liquid Glass Cloud"
          className="hero-cloud-light"
          loading="eager"
          decoding="sync"
        />

        {/* Dark 3D Glass Cloud Background Image */}
        <img
          src="/assets/glass-cloud-hero-dark.png"
          alt="3D Iridescent Liquid Glass Cloud Dark"
          className="hero-cloud-dark"
          loading="eager"
          decoding="sync"
        />

        {/* Overlay Content Centered Inside/Over the 3D Glass Cloud */}
        <div className="hero-content">

          {/* Floating Circular Brand Logo Icon Badge */}
          <div className="hero-arrow-badge" style={{ padding: '0', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src="/assets/logo-icon-light.png"
              alt="FluxTransfer Brand Icon Light"
              className="nav-logo-icon-light"
              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
            />
            <img
              src="/assets/logo-icon-dark.png"
              alt="FluxTransfer Brand Icon Dark"
              className="nav-logo-icon-dark"
              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
            />
          </div>

          <h1 className="hero-title">
            Private file transfer
          </h1>
          <p className="hero-subtitle">
            Fast. Secure. Simple. Send files between phones and computers in your browser.
          </p>
        </div>

      </div>
    </section>
  );
}

