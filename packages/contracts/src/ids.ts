import { monotonicFactory } from 'ulidx';
import { z } from 'zod';

/**
 * Canonical ID scheme (BUILD-SPEC §3, BUILD-PLAN FND D3 / SYN-4):
 * `<prefix>_<26-char Crockford-uppercase ULID>`, thirteen prefixes.
 */
export const ID_PREFIXES = [
  'mer', // merchant
  'off', // offer
  'com', // commitment (COR)
  'agt', // agent
  'atk', // attribution token (jti)
  'clm', // conversion claim
  'mnd', // mandate
  'usr', // consumer (pseudonymous)
  'evt', // ledger event
  'qte', // offer quote
  'apr', // approval
  'lnk', // identity link
  'ern', // valet errand
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type MeritedId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

// ULID alphabet is Crockford base32: 0-9 and A-Z excluding I, L, O, U.
const idPattern = (prefix: IdPrefix): RegExp => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);

/** Zod schema for an ID with the given prefix. */
export const Id = <P extends IdPrefix>(prefix: P): z.ZodType<MeritedId<P>> =>
  z
    .string()
    .regex(idPattern(prefix), {
      message: `expected ${prefix}_<26-char Crockford-uppercase ULID>`,
    }) as unknown as z.ZodType<MeritedId<P>>;

const ulid = monotonicFactory();

/** Generate a fresh ID for the given prefix (monotonic within a process). */
export const newId = <P extends IdPrefix>(prefix: P): MeritedId<P> => `${prefix}_${ulid()}`;
