// Result shape every dashboard server action returns (never throws to the client). Pure.

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T; warnings?: string[] }
  | { ok: false; error: string };

export const ok = <T = undefined>(message?: string, data?: T, warnings?: string[]): ActionResult<T> => ({ ok: true, message, data, warnings });
export const fail = <T = undefined>(error: string): ActionResult<T> => ({ ok: false, error });
