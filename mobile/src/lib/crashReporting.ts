export function captureError(_error: unknown): void {}

export function log(_message: string): void {}

export function setUser(
  _user: { id: string; email?: string | null; username?: string | null } | null,
): void {}
