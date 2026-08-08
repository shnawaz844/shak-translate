// Central config
// TEMP: pointed at local backend for latency diagnostics. Revert to
// 'wss://shaktranslate-backend-32126898120.us-central1.run.app' afterward.
export const WS_URL = 'wss://level-guacamole-spree.ngrok-free.dev';

// HTTP equivalent of WS_URL, for plain REST calls (e.g. /clerk/update-profile).
// Derived from WS_URL so both always point at the same backend.
export const API_URL = WS_URL.replace(/^ws/, 'http');

export const LANGUAGES = [
  { code: 'en-US', name: 'English' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'zh-CN', name: 'Mandarin' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
  { code: 'ar-SA', name: 'Arabic' },
] as const;

export type LanguageCode = typeof LANGUAGES[number]['code'];
export type LanguageName = typeof LANGUAGES[number]['name'];
