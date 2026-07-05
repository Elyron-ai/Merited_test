import { createServer, type Server } from 'node:http';
import type { Mailer } from '@merited/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResendMailer } from './resend.js';
import { SmtpMailer } from './smtp.js';

/**
 * PH1-7 accept: the SAME contract suite runs against BOTH impls; local dev
 * sends land in Mailpit; no email content carries credentials beyond the
 * single-use magic link.
 *
 * SmtpMailer → the compose Mailpit (real SMTP on 1025, read back over its
 * HTTP API on 8025). ResendMailer → a local capture server standing in for
 * Resend's API (the stub-creds posture: real HTTP shape, local endpoint).
 */
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';

interface CapturedSend {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** A Resend-API-shaped capture server for the contract run. */
class ResendCapture {
  private server!: Server;
  readonly captured: Array<{ auth: string; body: CapturedSend }> = [];
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        this.captured.push({ auth: String(req.headers.authorization ?? ''), body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'email_captured' }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const capture = new ResendCapture();

const clearMailpit = async () => {
  await fetch(`${MAILPIT_API}/api/v1/messages`, { method: 'DELETE' });
};

/** Read the latest Mailpit message body back for content assertions. */
const latestMailpit = async (): Promise<CapturedSend & { raw: string }> => {
  const list = (await (await fetch(`${MAILPIT_API}/api/v1/messages`)).json()) as {
    messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
  };
  const message = list.messages[0]!;
  const full = (await (
    await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`)
  ).json()) as { Text: string; HTML: string };
  return {
    to: message.To[0]!.Address,
    subject: message.Subject,
    text: full.Text,
    raw: `${message.Subject}\n${full.Text}\n${full.HTML}`,
  };
};

beforeAll(async () => {
  await capture.start();
});
afterAll(async () => {
  await capture.stop();
});

// The shared contract: one describe run per implementation.
const implementations: Array<{
  name: string;
  make: () => Mailer;
  lastSent: () => Promise<CapturedSend>;
  reset: () => Promise<void>;
}> = [
  {
    name: 'SmtpMailer (Mailpit)',
    make: () => new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    lastSent: async () => latestMailpit(),
    reset: clearMailpit,
  },
  {
    name: 'ResendMailer (capture)',
    make: () =>
      new ResendMailer({ apiKey: 'stub-resend-key', from: 'noreply@merited.test', baseUrl: capture.baseUrl }),
    lastSent: async () => capture.captured[capture.captured.length - 1]!.body,
    reset: async () => {
      capture.captured.length = 0;
    },
  },
];

for (const impl of implementations) {
  describe(`Mailer contract — ${impl.name} (PH1-7)`, () => {
    beforeEach(() => impl.reset());

    it('delivers a message: recipient, subject and body arrive intact', async () => {
      await impl.make().send({
        to: 'consumer@example.co.uk',
        subject: 'Verify your Aurora Club link',
        text: 'Tap the link to finish: https://wallet.merited.test/verify?token=single-use-abc123',
      });
      const sent = await impl.lastSent();
      expect(sent.to).toBe('consumer@example.co.uk');
      expect(sent.subject).toBe('Verify your Aurora Club link');
      expect(sent.text).toContain('https://wallet.merited.test/verify?token=single-use-abc123');
    });

    it('refuses a malformed message (bad email) — the same validation either side', async () => {
      await expect(
        impl.make().send({ to: 'not-an-email', subject: 'x', text: 'y' }),
      ).rejects.toThrow();
    });

    it('carries NO credentials beyond the single-use magic link', async () => {
      await impl.make().send({
        to: 'consumer@example.co.uk',
        subject: 'Your sign-in link',
        text: 'Sign in: https://wallet.merited.test/verify?token=magic-xyz789 — expires in 15 minutes.',
      });
      const sent = await impl.lastSent();
      const haystack = `${sent.subject}\n${sent.text}\n${sent.html ?? ''}`.toLowerCase();
      // the magic-link token is the ONLY secret permitted; nothing else leaks
      for (const forbidden of ['password', 'api_key', 'apikey', 'secret', 'refresh_token', 'access_token', 'bearer']) {
        expect(haystack, `email must not contain '${forbidden}'`).not.toContain(forbidden);
      }
    });
  });
}

describe('ResendMailer transport specifics (PH1-7)', () => {
  it('authorises with the configured key and never puts it in the body', async () => {
    capture.captured.length = 0;
    await new ResendMailer({
      apiKey: 'stub-resend-key',
      from: 'noreply@merited.test',
      baseUrl: capture.baseUrl,
    }).send({ to: 'c@example.co.uk', subject: 's', text: 'body text' });
    const call = capture.captured[0]!;
    expect(call.auth).toBe('Bearer stub-resend-key');
    expect(JSON.stringify(call.body)).not.toContain('stub-resend-key'); // key rides the header only
  });

  it('a non-2xx from Resend throws WITHOUT echoing the message body', async () => {
    const failing = new ResendMailer({
      apiKey: 'stub',
      from: 'noreply@merited.test',
      baseUrl: capture.baseUrl,
      fetchImpl: async () => new Response('nope', { status: 422 }),
    });
    await expect(
      failing.send({ to: 'c@example.co.uk', subject: 's', text: 'token=super-secret-magic' }),
    ).rejects.toThrow(/Resend send failed: 422/);
    await expect(
      failing.send({ to: 'c@example.co.uk', subject: 's', text: 'token=super-secret-magic' }),
    ).rejects.not.toThrow(/super-secret-magic/);
  });
});
