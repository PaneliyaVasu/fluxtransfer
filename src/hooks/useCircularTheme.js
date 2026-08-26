import { useState, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';

/**
 * useCircularTheme — Circular Ripple Theme Reveal via View Transitions API
 *
 * Expands a radial clip-path circle centered exactly on the user's click coordinates (x, y)
 * or defaults to top-right screen coordinates.
 * Includes fallback for non-supporting browsers and global 'T' keyboard shortcut.
 */
export function useCircularTheme(initialTheme = 'light') {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.body.classList.contains('dark-theme') ? 'dark' : initialTheme;
    }
    return initialTheme;
  });

  const toggleTheme = useCallback((event) => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';

    // Retrieve click coordinates or calculate intelligent fallback
    let x = window.innerWidth - 60;
    let y = 36;

    if (event && typeof event.clientX === 'number') {
      x = event.clientX;
      y = event.clientY;
    }

    // Maximum distance from click point to the furthest screen corner
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const applyThemeClasses = () => {
      setTheme(nextTheme);
      if (nextTheme === 'dark') {
        document.body.classList.add('dark-theme');
        document.documentElement.classList.add('dark');
      } else {
        document.body.classList.remove('dark-theme');
        document.documentElement.classList.remove('dark');
      }
    };

    const doc = document;
    if (typeof doc !== 'undefined' && typeof doc.startViewTransition === 'function') {
      doc.body.classList.add('view-transition-active');

      const transition = doc.startViewTransition(() => {
        flushSync(() => {
          applyThemeClasses();
        });
      });

      transition.ready.then(() => {
        const anim = doc.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${maxRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 500,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            pseudoElement: '::view-transition-new(root)',
          }
        );

        anim.onfinish = () => {
          doc.body.classList.remove('view-transition-active');
        };
      }).catch(() => {
        doc.body.classList.remove('view-transition-active');
        applyThemeClasses();
      });
    } else {
      // Fallback for browsers without View Transitions API
      applyThemeClasses();
    }
  }, [theme]);

  // Global 'T' keyboard shortcut listener to trigger theme reveal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (
        (e.key === 't' || e.key === 'T') &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        toggleTheme();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleTheme]);

  return { theme, isDark: theme === 'dark', toggleTheme };
}

export default useCircularTheme;
