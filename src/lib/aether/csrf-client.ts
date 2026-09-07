/** Client-safe CSRF names. Do not import ops-auth here — it uses node:crypto. */
const CSRF_COOKIE = "aether_ops_csrf";
const CSRF_HEADER = "x-aether-csrf";

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Send the non-HttpOnly CSRF cookie as the mutation header. Session cookie stays HttpOnly. */
export function csrfHeaders(): HeadersInit {
  const token = readCookie(CSRF_COOKIE);
  return token ? { [CSRF_HEADER]: token } : {};
}
