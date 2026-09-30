// Central config
// WS_URL/CLERK_PUBLISHABLE_KEY are read from the environment (EXPO_PUBLIC_*
// vars are inlined at build time by Expo) so each EAS build profile
// (development/preview/production in eas.json) actually points at its own
// backend and Clerk instance, instead of every build silently shipping
// whatever was last hardcoded here for local testing.

// ── App branding ─────────────────────────────────────────────────────────────
// Re-exported from the root app-config.ts so all UI code has a single import
// path: `import { APP_NAME, APP_NAME_PREFIX, APP_NAME_SUFFIX } from '../config'`
export {
  APP_NAME,
  APP_NAME_PREFIX,
  APP_NAME_SUFFIX,
  APP_NAME_LOWER,
  APP_BUNDLE_ID,
} from '../app-config';
const wsUrl = process.env.EXPO_PUBLIC_WS_URL;
if (!wsUrl) {
  throw new Error('Missing EXPO_PUBLIC_WS_URL in .env');
}
export const WS_URL = wsUrl;

// HTTP equivalent of WS_URL, for plain REST calls (e.g. /clerk/update-profile).
// Derived from WS_URL so both always point at the same backend.
export const API_URL = WS_URL.replace(/^ws/, 'http');

export const LANGUAGES = [
  // China
  { code: 'zh-CN', name: 'Mandarin' },
  { code: 'zh-HK', name: 'Cantonese' },

  // GCC Countries (Gulf Cooperation Council)
  { code: 'ar-SA', name: 'Arabic (Saudi)' },
  { code: 'ar-AE', name: 'Arabic (UAE)' },
  { code: 'ar-QA', name: 'Arabic (Qatar)' },
  { code: 'ar-KW', name: 'Arabic (Kuwait)' },
  { code: 'ar-OM', name: 'Arabic (Oman)' },
  { code: 'ar-BH', name: 'Arabic (Bahrain)' },
  { code: 'ar', name: 'Arabic (Standard)' },

  // Global & Regional Languages
  { code: 'en-US', name: 'English' },
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'ur-PK', name: 'Urdu' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
] as const;

export type LanguageCode = typeof LANGUAGES[number]['code'];
export type LanguageName = typeof LANGUAGES[number]['name'];
