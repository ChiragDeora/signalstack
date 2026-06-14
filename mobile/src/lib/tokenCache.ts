/**
 * SecureStore-backed token cache for @clerk/clerk-expo.
 * Required so the JWT survives app restarts.
 */
import * as SecureStore from 'expo-secure-store';

export const tokenCache = {
  async getToken(key: string) {
    try { return await SecureStore.getItemAsync(key); } catch { return null; }
  },
  async saveToken(key: string, value: string) {
    try { return await SecureStore.setItemAsync(key, value); } catch { return; }
  },
};
