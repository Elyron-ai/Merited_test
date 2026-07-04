import { z } from 'zod';

/**
 * Control-plane auth shapes (MER-1 → MER-7, §5.7): internal single-team
 * auth — password (argon2id at rest) + TOTP, httpOnly session cookie. Hash
 * and secret MATERIAL never appear in these shapes; storage is MER-7's.
 */
export const ControlPlaneUser = z.object({
  user_id: z.string().min(1),
  email: z.string().email(),
  totp_enabled: z.boolean(),
  created_at: z.string().datetime(),
});
export type ControlPlaneUser = z.infer<typeof ControlPlaneUser>;

export const ControlPlaneSession = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  expires_at: z.string().datetime(),
});
export type ControlPlaneSession = z.infer<typeof ControlPlaneSession>;
