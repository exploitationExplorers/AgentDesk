/** Absolute session lifetime from creation (cookie Max-Age / better-auth expiresIn). */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
export const SESSION_ABSOLUTE_SECONDS = SESSION_ABSOLUTE_MS / 1000;

/**
 * Idle timeout from last authenticated API activity.
 * Matches absolute lifetime so overnight/phone-background use does not force re-login
 * within the cookie window.
 */
export const SESSION_IDLE_MS = SESSION_ABSOLUTE_MS;

export function sessionExpired(
  createdAt: Date | number | string,
  updatedAt: Date | number | string,
  now = Date.now(),
): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
  const updated = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(String(updatedAt));
  return (
    !Number.isFinite(created) ||
    !Number.isFinite(updated) ||
    now - updated >= SESSION_IDLE_MS ||
    now - created >= SESSION_ABSOLUTE_MS
  );
}
