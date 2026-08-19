// Flux Zen Calm Visuals Module
(function (window) {
  'use strict';

  class BreathingGuide {
    constructor(container, textEl) {
      this.container = container;
      this.textEl = textEl;
      this.timerId = null;
      this.seconds = 0;
    }

    start() {
      this.stop();

      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) {
        this.container.classList.add('reduced-motion');
        this.textEl.textContent = 'Focus on your breathing. Breathe calmly.';
        return;
      }

      this.container.classList.remove('reduced-motion');
      this.seconds = 0;
      this.updateState();

      this.timerId = setInterval(() => {
        this.seconds = (this.seconds + 1) % 8;
        this.updateState();
      }, 1000);
    }

    updateState() {
      // 0s-2s: Inhale (3s)
      // 3s: Hold (1s)
      // 4s-6s: Exhale (3s)
      // 7s: Hold (1s)
      
      const promptEl = this.textEl;
      if (!promptEl) return;

      if (this.seconds >= 0 && this.seconds <= 2) {
        promptEl.textContent = 'Inhale deeply... 💨';
        promptEl.className = 'zen-breathing-instruction inhale';
      } else if (this.seconds === 3) {
        promptEl.textContent = 'Hold... 🧘';
        promptEl.className = 'zen-breathing-instruction hold-full';
      } else if (this.seconds >= 4 && this.seconds <= 6) {
        promptEl.textContent = 'Exhale slowly... 🍃';
        promptEl.className = 'zen-breathing-instruction exhale';
      } else {
        promptEl.textContent = 'Hold... 🧘';
        promptEl.className = 'zen-breathing-instruction hold-empty';
      }
    }

    stop() {
      if (this.timerId) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      if (this.textEl) {
        this.textEl.textContent = '';
      }
    }
  }

  window.FluxZenVisuals = { BreathingGuide };
})(window);
