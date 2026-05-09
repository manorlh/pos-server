import axios from 'axios';
import { useAuth } from './auth';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Attach Clerk JWT on every request
api.interceptors.request.use(async (config) => {
  if (typeof window !== 'undefined') {
    const clerk = (window as any).Clerk;
    // Wait for Clerk to finish loading before reading the session
    if (clerk && !clerk.loaded) {
      await clerk.load?.();
    }
    const token = await clerk?.session?.getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const fromStore = useAuth.getState().activeTenantId;
    const fromStorage =
      typeof window !== 'undefined' ? window.localStorage.getItem('activeTenantId') : null;
    const activeTenantId = fromStore || fromStorage || undefined;
    if (activeTenantId) {
      config.headers['X-Tenant-Id'] = activeTenantId;
    }
  }
  return config;
});

// Redirect to sign-in on 401 only when Clerk is done loading and there is no session.
// Right after OAuth redirect, Clerk may still be loading — a 401 + no session would
// otherwise send users back to /sign-in in a loop.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      const clerk = (window as any).Clerk;
      if (clerk && !clerk.loaded) {
        return Promise.reject(err);
      }
      const hasSession = !!clerk?.session;
      if (!hasSession) {
        window.location.href = '/sign-in';
      }
    }
    if (err.response?.status === 403 && err.response?.data?.detail === 'tenant_forbidden') {
      const { tenants, setActiveTenant } = useAuth.getState();
      const fallback = tenants[0]?.id;
      if (fallback) {
        setActiveTenant(fallback);
        if (typeof window !== 'undefined') window.location.reload();
      }
    }
    return Promise.reject(err);
  },
);
