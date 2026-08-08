import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// expo-secure-store has NO web implementation at all (its web module is a
// literal empty object — see node_modules/expo-secure-store/src/ExpoSecureStore.web.ts).
// Every getItemAsync/setItemAsync call throws on web; call sites that catch
// and swallow the rejection (a reasonable thing to do for "best-effort"
// persistence) end up with persistence that silently never happens on web.
// This falls back to localStorage there, keeping the same async API native
// callers already use.

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try { window.localStorage.setItem(key, value); } catch (_) {}
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export const storage = { getItem, setItem };
