// Central config
export const WS_URL = 'wss://shaktranslate-backend-32126898120.us-central1.run.app';

// Example for local testing: export const WS_URL = 'ws://192.168.1.100:8080';

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
