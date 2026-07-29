import type { CertInfo } from '../types/auth';

// ── Dev mode user session ─────────────────────────────

const DEV_USER_KEY = 'dev_user_key';
const DEV_USER_NAME = 'dev_user_name';

export interface DevUser {
  key: string;
  displayName: string;
}

export function getStoredDevUser(): DevUser | null {
  const key = sessionStorage.getItem(DEV_USER_KEY);
  const name = sessionStorage.getItem(DEV_USER_NAME);
  if (key && name) return { key, displayName: name };
  return null;
}

export function setStoredDevUser(key: string, displayName: string): void {
  sessionStorage.setItem(DEV_USER_KEY, key);
  sessionStorage.setItem(DEV_USER_NAME, displayName);
}

export function clearStoredDevUser(): void {
  sessionStorage.removeItem(DEV_USER_KEY);
  sessionStorage.removeItem(DEV_USER_NAME);
}

export function getDevUserHeader(): string | null {
  const stored = getStoredDevUser();
  return stored ? stored.key : null;
}

// ── Auth status check ─────────────────────────────────

export async function checkAuthStatus(): Promise<CertInfo | null> {
  try {
    const headers: Record<string, string> = {};
    const user = getDevUserHeader();
    if (user) headers['X-Dev-User'] = user;

    const res = await fetch('/api/auth/status', { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
