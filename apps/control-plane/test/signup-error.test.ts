import { describe, expect, it } from 'vitest';
import { messageForError } from '../src/app/signup/signup-error';

/**
 * W13/#8: the in-page signup error message. A validation error surfaces its own
 * (already-redacted, W9) message; every other coded failure gets a safe,
 * human sentence — never a raw code and never an internal string.
 */
describe('signup error → accessible message (W13/#8)', () => {
  it('surfaces the INVALID_INPUT message verbatim (it is user-actionable + redacted)', () => {
    expect(messageForError({ error: { code: 'INVALID_INPUT', message: 'a launch bounty is required' } })).toBe(
      'a launch bounty is required',
    );
  });

  it('maps each coded failure to a safe non-technical sentence', () => {
    expect(messageForError({ error: { code: 'RATE_LIMITED' } })).toMatch(/too many attempts/i);
    expect(messageForError({ error: { code: 'SIGNUP_DISABLED' } })).toMatch(/turned off/i);
    expect(messageForError({ error: { code: 'ONBOARDING_FAILED' } })).toMatch(/went wrong/i);
  });

  it('never echoes an unknown code or a null body — falls back to a generic message', () => {
    const generic = 'We couldn’t complete signup. Please check the form and try again.';
    expect(messageForError({ error: { code: 'WEIRD_CODE' } })).toBe(generic);
    expect(messageForError(null)).toBe(generic);
    // an ONBOARDING_FAILED message is NOT surfaced (only INVALID_INPUT is)
    expect(messageForError({ error: { code: 'ONBOARDING_FAILED', message: 'pg: relation does not exist' } })).not.toContain(
      'relation',
    );
  });
});
