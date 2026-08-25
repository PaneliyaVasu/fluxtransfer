import React, { useState } from 'react';
import { ChevronDown, ChevronUp, HelpCircle } from 'lucide-react';

const faqs = [
  {
    q: 'How fast is FluxTransfer compared to cloud storage?',
    a: 'FluxTransfer moves data directly over local Wi-Fi or WebRTC peer channels at maximum hardware speed (up to 900 Mbps on Wi-Fi 6). Because files do not get uploaded to a cloud server first and downloaded second, transfers complete in a fraction of the time.'
  },
  {
    q: 'Is there any file size limit?',
    a: 'No. FluxTransfer streams data directly from disk to network to disk using 64 KiB WebRTC DataChannel chunks and Web Crypto streaming. You can send 10 GB, 50 GB, or 100 GB files without browser crashes or memory caps.'
  },
  {
    q: 'How does connection work if devices are on different networks?',
    a: 'The protocol negotiates WebRTC ICE candidates through STUN/TURN servers to establish direct peer-to-peer data channels even across NATs and cellular networks.'
  },
  {
    q: 'Does FluxTransfer store my files or metadata?',
    a: 'Never. FluxTransfer is 100% serverless for data storage. Only signaling metadata (ephemeral connection tokens) passes through the signaling server to pair devices.'
  }
];

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState(null);

  const toggle = (index) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section style={{ maxWidth: '840px', margin: '0 auto 60px auto' }}>
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <div className="mono-badge" style={{ marginBottom: '12px' }}>
          <HelpCircle size={13} color="var(--cyber-cyan)" /> FREQUENTLY ASKED QUESTIONS
        </div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 700 }}>
          Everything you need to know
        </h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {faqs.map((faq, idx) => (
          <div 
            key={idx} 
            className="glass-card"
            style={{ padding: '20px 24px', cursor: 'pointer' }}
            onClick={() => toggle(idx)}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h4 style={{ fontFamily: 'var(--font-display)', fontSize: '1.08rem', fontWeight: 600, color: '#fff' }}>
                {faq.q}
              </h4>
              {openIndex === idx ? <ChevronUp size={20} color="var(--primary-emerald)" /> : <ChevronDown size={20} />}
            </div>
            {openIndex === idx && (
              <p style={{ color: 'var(--text-variant)', fontSize: '0.92rem', marginTop: '14px', lineHeight: 1.6 }}>
                {faq.a}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
