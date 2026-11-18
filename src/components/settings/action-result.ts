// Result shape shared by every dashboard server action that reports back to the form (ActionForm).
// Kept in a plain module so client components can import it without pulling in server code.

export type ActionResult = { ok: boolean; message: string; at?: number } | null;

export type FormAction = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

export const ok = (message: string): ActionResult => ({ ok: true, message, at: Date.now() });
export const fail = (message: string): ActionResult => ({ ok: false, message, at: Date.now() });
