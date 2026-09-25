/**
 * CP26C-O2D — Owner authentication surface.
 * Path checks only. This module does not grant access.
 * A session still has to pass the platform Owner check on the server.
 */
export const OWNER_LOGIN_PATH = "/owner/login";
export const OWNER_HOME_PATH = "/owner";
export const OWNER_ACCESS_UNAVAILABLE = "Owner access unavailable.";

const OWNER_PATH = /^\/owner(?:\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;

export function isOwnerLoginPath(pathname: string): boolean {
  return stripTrailingSlash(pathname) === OWNER_LOGIN_PATH;
}

function isOwnerLoginFamily(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return path === OWNER_LOGIN_PATH || path.startsWith(`${OWNER_LOGIN_PATH}/`);
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** Internal Owner destination only. Anything else becomes the Owner home. */
export function safeOwnerReturnPath(input: unknown): string {
  if (typeof input !== "string") return OWNER_HOME_PATH;
  const trimmed = input.trim();
  if (!OWNER_PATH.test(trimmed)) return OWNER_HOME_PATH;
  if (trimmed.split("/").some((part) => part === "." || part === "..")) return OWNER_HOME_PATH;
  const path = stripTrailingSlash(trimmed);
  if (isOwnerLoginFamily(path)) return OWNER_HOME_PATH;
  return path;
}

/** Sign-out destinations stay on this origin. Anything else becomes home. */
export function safeSignOutPath(input: unknown): string {
  if (typeof input !== "string") return "/";
  const value = input.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || value.includes("://") || value.includes("?") || value.includes("#")) return "/";
  if (/[\u0000-\u001f]/.test(value)) return "/";
  return value;
}

export type OwnerGateLike =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "forbidden" };

export function ownerEntryDecision(
  access: OwnerGateLike,
  requested: unknown,
): { action: "enter"; path: string } | { action: "deny" } | { action: "signin" } {
  if (access.ok) return { action: "enter", path: safeOwnerReturnPath(requested) };
  if (access.reason === "forbidden") return { action: "deny" };
  return { action: "signin" };
}

export function unauthenticatedOwnerRedirect(
  pathname: string,
): { to: typeof OWNER_LOGIN_PATH; search: { redirect: string } } | null {
  if (isOwnerLoginPath(pathname)) return null;
  const path = stripTrailingSlash(pathname);
  if (!OWNER_PATH.test(path)) return null;
  return { to: OWNER_LOGIN_PATH, search: { redirect: safeOwnerReturnPath(path) } };
}
