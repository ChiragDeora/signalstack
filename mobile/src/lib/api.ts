/**
 * Axios client to the existing Next.js backend. Same routes the PWA hits.
 * Auth header is set from a Clerk session token (see AppProviders).
 */
import axios, { AxiosInstance } from 'axios';
import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;
export const API_BASE_URL = extra.apiBaseUrl || 'https://signalstack-105d.onrender.com';

let bearerToken: string | null = null;
export function setAuthToken(token: string | null) {
  bearerToken = token;
}

export const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  if (bearerToken) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${bearerToken}`;
  }
  return config;
});
