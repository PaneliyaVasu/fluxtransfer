---
name: FluxTransfer
colors:
  surface: '#0c1512'
  surface-dim: '#0c1512'
  surface-bright: '#323b37'
  surface-container-lowest: '#07100d'
  surface-container-low: '#141d1a'
  surface-container: '#18221e'
  surface-container-high: '#222c28'
  surface-container-highest: '#2d3733'
  on-surface: '#dae5df'
  on-surface-variant: '#bbcabf'
  inverse-surface: '#dae5df'
  inverse-on-surface: '#29322f'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#4edea3'
  on-primary: '#003824'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#006c49'
  secondary: '#97d2c9'
  on-secondary: '#003732'
  secondary-container: '#13524b'
  on-secondary-container: '#8ac3bb'
  tertiary: '#ffb3af'
  on-tertiary: '#650911'
  tertiary-container: '#fc7c78'
  on-tertiary-container: '#711419'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#b3eee5'
  secondary-fixed-dim: '#97d2c9'
  on-secondary-fixed: '#00201d'
  on-secondary-fixed-variant: '#0f4f49'
  tertiary-fixed: '#ffdad7'
  tertiary-fixed-dim: '#ffb3af'
  on-tertiary-fixed: '#410005'
  on-tertiary-fixed-variant: '#842225'
  background: '#0c1512'
  on-background: '#dae5df'
  surface-variant: '#2d3733'
  glass-border: rgba(255, 255, 255, 0.08)
  accent-gold: '#E8A33D'
  surface-card: '#16211C'
  text-warm: '#EDEAE2'
typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 36px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  label-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
FluxTransfer is a high-performance, security-focused peer-to-peer file transfer service. The brand personality is "Technical Zen"—combining the raw, precise energy of developer tools with a calm, focused, and frictionless user experience. 

The visual style is a sophisticated blend of **Glassmorphism** and **Technical Minimalism**. It utilizes deep obsidian surfaces, vibrant emerald accents, and frosted glass overlays to evoke a sense of digital "vault" security. The interface should feel cutting-edge and futuristic (via monospaced labels and glow effects) yet remains approachable through spacious layouts and smooth, eased transitions.

## Colors
The palette is rooted in a "Deep Forest" dark mode. 
- **Primary Emerald (#10b981):** Used for critical actions, progress indicators, and branding. It represents the "Flux" or energy of the data transfer.
- **Secondary Teal (#6fa8a0):** Used for supporting UI elements and secondary data points to maintain a monochromatic, tech-forward feel.
- **Accent Gold (#E8A33D):** Reserved exclusively for "Zen" or "AI" features, providing a warm contrast to the cool-toned primary palette.
- **Backgrounds:** Utilize a tiered dark scale from `#07100d` (lowest) to `#18221e` (container).
- **Transparency:** Glass panels use `rgba(22, 33, 28, 0.7)` with a `20px` backdrop blur for a layered, premium feel.

## Typography
The typographic system uses three distinct families to establish hierarchy:
1. **Space Grotesk (Headlines):** A geometric sans-serif with technical quirks, used for high-impact display text and primary titles.
2. **Inter (Body):** A highly legible workhorse font for all descriptive text, paragraphs, and standard UI labels.
3. **JetBrains Mono (Technical Labels):** Used for data points, pairing codes, and status indicators to reinforce the "direct/secure" technical nature of the product.

All headings should use tight letter spacing (`-0.02em`) to feel more compact and architectural.

## Layout & Spacing
The system follows a **Fixed Center-Column Grid** for its primary transfer interface while utilizing a fluid, expansive layout for the landing components.

- **Desktop:** 12-column grid with a maximum container width of `1280px`. Side margins are `40px`.
- **Mobile:** Single column with `16px` margins. 
- **Vertical Rhythm:** Elements are spaced using a base-4 system. Sections are separated by `stack-lg` (32px) or larger gaps (e.g., `64px` to `96px`) to allow the "Zen" aesthetic to breathe.
- **Transfer Card:** The central interaction area is limited to a max-width of `672px` (2xl) to maintain focus.

## Elevation & Depth
Depth is created through a "Stacking Glass" model rather than traditional shadows:
- **Level 0 (Base):** Deepest background (`#07100d`).
- **Level 1 (Cards):** `gradient-card` using a subtle linear gradient and a 1px `glass-border`.
- **Level 2 (Panels):** `glass-panel` with a `20px` backdrop blur and slightly higher border opacity for floating elements like the Zen Panel.
- **Glows:** Use radial gradients of `primary` at 12% opacity behind main containers to create a "digital aura" effect (Glow Effect). 
- **Shadows:** Only used sparingly as `shadow-lg` on floating buttons to provide a tactile lift.

## Shapes
The shape language is modern and approachable with significant rounding:
- **Standard Containers:** `rounded-xl` (0.75rem / 12px) for cards and main UI blocks.
- **Buttons/Toggles:** `rounded-lg` (0.5rem / 8px) to feel substantial and clickable.
- **Pills:** Full rounding (`rounded-full`) is reserved for trust badges and status tags.
- **Borders:** All interactive containers must have a `1px` border using `glass-border` or a themed low-opacity primary color (`primary/20`).

## Components
- **Buttons:** Primary buttons use the `primary-container` background with high-contrast text. They should have a subtle `brightness-110` hover state and a scale-down `active` state (90-95%) for tactile feedback.
- **Transfer Dropzone:** Large, dashed borders (`border-2 border-dashed`) with a transition to a solid background on hover.
- **Mode Toggle:** A "track-and-knob" style toggle where the active state is represented by a physical sliding card element within the track.
- **Zen Panel:** A slide-out side sheet with a heavy backdrop blur (`backdrop-blur-sm`) and distinct section headers using `label-caps`.
- **Progress Indicators:** Circular SVG charts with `stroke-linecap: round` and a soft background ring for a high-end dashboard feel.
- **Trust Badges:** Compact, pill-shaped outlines with small icons, used to communicate security features without overwhelming the hero section.