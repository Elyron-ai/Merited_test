import { z } from 'zod';

/** Access-family mechanics (3 of 27) — FND D10. */

export const EarlyAccess = z.object({
  type: z.literal('early_access'),
  window_s: z.number().int().positive(),
});

export const ExperienceUpgrade = z.object({
  type: z.literal('experience_upgrade'),
  from_sku: z.string(),
  to_sku: z.string(),
});

export const VipEventInvite = z.object({
  type: z.literal('vip_event_invite'),
  event_ref: z.string(),
});

export const ACCESS_MECHANICS = [EarlyAccess, ExperienceUpgrade, VipEventInvite] as const;
