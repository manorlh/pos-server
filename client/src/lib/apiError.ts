/**
 * FastAPI often returns `detail` as a string, or 422 as an array of `{ loc, msg, type, input }`.
 * Sonner/toasts must receive a string — never pass `detail` through directly.
 */
export function formatApiErrorDetail(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'msg' in item) {
        const m = (item as { msg?: unknown }).msg;
        if (typeof m === 'string') return m;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    });
    const joined = parts.filter(Boolean).join('; ');
    return joined || null;
  }
  if (typeof detail === 'object' && detail !== null && 'msg' in detail) {
    const m = (detail as { msg?: unknown }).msg;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function axiosErrorToToastMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string };
  const fromDetail = formatApiErrorDetail(e?.response?.data?.detail);
  if (fromDetail) return fromDetail;
  if (typeof e?.message === 'string' && e.message.trim()) return e.message;
  return fallback;
}
