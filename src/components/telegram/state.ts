// Result of the Telegram card's server actions. Plain module: safe for client components.

export type TelegramActionState = {
  ok: boolean;
  message: string;
  at: number;
  /** Pairing code, shown once right after it's generated. */
  code?: string;
  createdAt?: string;
  expiresAt?: string;
  botUsername?: string;
} | null;
