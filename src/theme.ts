// Shared design tokens for the redesigned call/home experience — replaces the
// old flat-neon (#39FF14 on #0A0A0A) terminal look with a warmer, calmer
// palette: same brand green family, refined rather than raw, used to encode
// "this is live" rather than as decoration.
export const colors = {
  ink: '#0A0D0C',
  surface: '#141917',
  surface2: '#1B211E',
  surface3: '#222A26',
  signal: '#2FE0A8',
  signalDim: '#1C8F6C',
  warm: '#F3EEE6',
  muted: '#7C8985',
  hair: 'rgba(243,238,230,0.08)',
  danger: '#E85C5C',
  signalOnDark: '#04231A',
};

// Below this window width (web only), the app uses the single-column mobile
// layout; at or above it, screens that benefit from the extra room (the
// call screen's transcript, the home screen's two entry points) switch to
// a side-by-side desktop layout instead of stretching the phone layout.
export const DESKTOP_BREAKPOINT = 768;
