/**
 * W13/#8: map a coded `/api/signup` error into a human, accessible message for
 * the in-page `role="alert"`. Kept pure (no React) so it is unit-testable and
 * so the client component stays a thin shell. INVALID_INPUT already carries a
 * useful, redacted message (W9), so it is surfaced verbatim; every other code
 * gets a safe, non-technical sentence.
 */
export const messageForError = (
  body: { error?: { code?: string; message?: string } } | null,
): string => {
  const code = body?.error?.code;
  if (body?.error?.message && code === 'INVALID_INPUT') return body.error.message;
  switch (code) {
    case 'RATE_LIMITED':
      return 'Too many attempts from your network. Please wait a minute and try again.';
    case 'SIGNUP_DISABLED':
      return 'Self-serve signup is currently turned off. Please contact us to onboard.';
    case 'ONBOARDING_FAILED':
      return 'Something went wrong while setting up your account. Nothing was charged — please try again.';
    default:
      return 'We couldn’t complete signup. Please check the form and try again.';
  }
};
