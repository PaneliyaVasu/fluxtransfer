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
        />

        {/* Dark 3D Glass Cloud Background Image */}
        <img
          src="/assets/glass-cloud-hero-dark.png"
          alt="3D Iridescent Liquid Glass Cloud Dark"
          className="hero-cloud-dark"
        />

        {/* Overlay Content Centered Inside/Over the 3D Glass Cloud */}
        <div className="hero-content">

          {/* Floating Circular Arrow Badge */}
          <div className="hero-arrow-badge">
            <ArrowUpDown className="hero-arrow-icon" size={22} />
          </div>

          {/* Hero Headline */}
          <h2 className="hero-title">
            File Transfer
          </h2>

          {/* Hero Subtitle */}
          <p className="hero-subtitle">
            Fast. Secure. Simple.
          </p>
        </div>

      </div>
    </section>
  );
}

