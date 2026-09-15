// Central config
// WS_URL/CLERK_PUBLISHABLE_KEY are read from the environment (EXPO_PUBLIC_*
// vars are inlined at build time by Expo) so each EAS build profile
// (development/preview/production in eas.json) actually points at its own
// backend and Clerk instance, instead of every build silently shipping
// whatever was last hardcoded here for local testing.
const wsUrl = process.env.EXPO_PUBLIC_WS_URL;
if (!wsUrl) {
  throw new Error('Missing EXPO_PUBLIC_WS_URL in .env');
}
export const WS_URL = wsUrl;

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
