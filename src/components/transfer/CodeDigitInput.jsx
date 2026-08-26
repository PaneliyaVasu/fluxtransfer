import React from 'react';

export default function CodeDigitInput({ inputCode, setInputCode, digitRefs }) {
  const maxLen = 8;

  const handleDigitChange = (index, value) => {
    const char = value.replace(/[^a-zA-Z0-9]/g, '').slice(-1);
    const digits = (inputCode.padEnd(maxLen, ' ')).split('');
    digits[index] = char || ' ';
    const newCode = digits.join('').replace(/\s+$/, '');
    setInputCode(newCode);

    if (char && index < maxLen - 1) {
      digitRefs[index + 1].current?.focus();
    }
  };

  const handleDigitKeyDown = (index, e) => {
    if (e.key === 'Backspace' && (!inputCode[index] || inputCode[index] === ' ') && index > 0) {
      digitRefs[index - 1].current?.focus();
    }
  };

  const handleDigitPaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    if (pasted) {
      setInputCode(pasted);
      const focusIndex = Math.min(pasted.length, 7);
      digitRefs[focusIndex]?.current?.focus();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: '6px',
        justifyContent: 'center',
        marginBottom: '18px',
        width: '100%'
      }}
      onPaste={handleDigitPaste}
    >
      {Array.from({ length: maxLen }).map((_, idx) => (
        <input
          key={idx}
          ref={digitRefs[idx]}
          type="text"
          maxLength={1}
          value={inputCode[idx] || ''}
          onChange={(e) => handleDigitChange(idx, e.target.value)}
          onKeyDown={(e) => handleDigitKeyDown(idx, e)}
          style={{
            width: '38px',
            height: '46px',
            borderRadius: '12px',
            border: inputCode[idx] ? '1px solid #7c3aed' : '1px solid var(--glass-card-border)',
            background: inputCode[idx] ? 'rgba(124, 58, 237, 0.08)' : 'var(--glass-card-bg)',
            textAlign: 'center',
            fontSize: '1.15rem',
            fontWeight: 700,
            fontFamily: 'monospace',
            color: 'var(--text-title)',
            outline: 'none',
            transition: 'all 0.2s ease',
            boxShadow: inputCode[idx] ? '0 0 10px rgba(124, 58, 237, 0.2)' : 'none'
          }}
        />
      ))}
    </div>
  );
}
