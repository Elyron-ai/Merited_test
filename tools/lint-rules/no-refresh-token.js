// FND-15 (§6.3): refresh tokens never appear in any contract type or log
// line. Bans identifiers, object keys and string-literal keys matching
// /refresh_?token/i EVERYWHERE in packages/contracts (access tokens too —
// contracts must never carry credentials), and token keys in any
// logger-call argument repo-wide. apps/wallet's linking STORAGE internals
// are the one sanctioned home for access-token handling (Phase 1, B23).

const REFRESH = /refresh_?token/i;
const ACCESS = /access_?token/i;
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// Data contracts are strictly banned from naming tokens. contracts/src/ports
// is EXEMPT from the strict branch: ports are behavioural interfaces (the
// OAuth IdP port must speak OAuth's own field names), type-only, and never
// serialised into an API response or the ledger. Logger-argument checks
// still apply inside ports.
const isContracts = (filename) =>
  /packages[\\/]contracts[\\/]/.test(filename) && !/contracts[\\/]src[\\/]ports[\\/]/.test(filename);
const isWalletLinkingInternals = (filename) =>
  /apps[\\/]wallet[\\/]src[\\/]modules[\\/]linking[\\/]/.test(filename);
// PH1-1 extension (§6.3 accept): route handlers and the OpenAPI document
// are RESPONSE-SHAPE surfaces — token keys are banned there like contracts.
// apps/fake-aurora is exempt: it IS the external IdP fake (MER-11/P5) and
// must speak OAuth's real field names on its own wire.
const isResponseSurface = (filename) =>
  !/apps[\\/]fake-aurora[\\/]/.test(filename) &&
  (/src[\\/]openapi[\\/]/.test(filename) ||
    /routes\.[jt]sx?$/.test(filename) ||
    /src[\\/]routes[\\/]/.test(filename) ||
    /src[\\/]app[\\/].*route\.[jt]sx?$/.test(filename));

const nameOf = (key) => {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
};

const looksLikeLogger = (callee) => {
  if (callee.type !== 'MemberExpression') return false;
  const level = callee.property?.type === 'Identifier' ? callee.property.name : null;
  if (!level || !LOG_LEVELS.has(level)) return false;
  const receiver = callee.object;
  if (receiver.type === 'Identifier') return /log/i.test(receiver.name);
  if (receiver.type === 'MemberExpression' && receiver.property?.type === 'Identifier') {
    return /log/i.test(receiver.property.name);
  }
  return false;
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'refresh tokens never appear in any contract type or log line (FND-15, BUILD-SPEC §6.3)',
    },
    messages: {
      contractToken:
        "'{{name}}' must not appear here — credentials are never contract types or response-surface shapes (contracts, routes, OpenAPI — §6.3)",
      loggedToken:
        "'{{name}}' must not be passed to a logger — token fields are secrets (§6.3); rely on typed fields the redactor covers, or drop it",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const contracts = isContracts(filename) || isResponseSurface(filename);
    const accessExempt = isWalletLinkingInternals(filename);

    const banned = (name) => {
      if (!name) return false;
      if (REFRESH.test(name)) return true; // banned everywhere this rule looks
      if (!ACCESS.test(name)) return false;
      if (contracts) return true; // contracts never carry credentials
      return !accessExempt; // logger args: banned outside linking storage internals
    };

    const reportKeysDeep = (node, messageId) => {
      if (!node) return;
      if (node.type === 'ObjectExpression') {
        for (const property of node.properties) {
          if (property.type === 'Property') {
            const name = nameOf(property.key);
            if (name && banned(name)) {
              context.report({ node: property.key, messageId, data: { name } });
            }
            reportKeysDeep(property.value, messageId);
          }
        }
      } else if (node.type === 'ArrayExpression') {
        for (const element of node.elements) reportKeysDeep(element, messageId);
      }
    };

    const listeners = {
      CallExpression(node) {
        if (!looksLikeLogger(node.callee)) return;
        for (const argument of node.arguments) reportKeysDeep(argument, 'loggedToken');
      },
    };

    if (contracts) {
      listeners.Identifier = (node) => {
        if (banned(node.name)) {
          context.report({ node, messageId: 'contractToken', data: { name: node.name } });
        }
      };
      listeners.Literal = (node) => {
        if (typeof node.value === 'string' && banned(node.value) && node.parent?.type === 'Property') {
          context.report({ node, messageId: 'contractToken', data: { name: node.value } });
        }
      };
    }

    return listeners;
  },
};
