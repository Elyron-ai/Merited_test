// PH2-9 (arch §4.1): consented 1pd is the DECISIONER'S edge, never an API
// surface. The `pd` object key is banned in every response-shape surface —
// route handlers, the OpenAPI document, and packages/contracts response
// schemas — mirroring the B23 refresh-token discipline. The two sanctioned
// homes are the internal pipeline ctx (contracts pipeline.ts DecisionCtx)
// and the wallet's own pd-store module (the consumer reading their own
// data is not a leak).

const PD_KEY = /^pd$/;

const isContracts = (filename) =>
  /packages[\\/]contracts[\\/]/.test(filename) &&
  !/contracts[\\/]src[\\/]pipeline\.[jt]s$/.test(filename) &&
  !/contracts[\\/]src[\\/]ports[\\/]/.test(filename);

const isPdStoreInternals = (filename) =>
  /apps[\\/]wallet[\\/]src[\\/]modules[\\/]pd-store[\\/]/.test(filename);

const isResponseSurface = (filename) =>
  /src[\\/]openapi[\\/]/.test(filename) ||
  /routes\.[jt]sx?$/.test(filename) ||
  /src[\\/]routes[\\/]/.test(filename) ||
  /src[\\/]app[\\/].*route\.[jt]sx?$/.test(filename);

const nameOf = (key) => {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
};

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        '1pd never appears in agent-facing response shapes (PH2-9) — pd keys are banned in contracts response schemas, route handlers and the OpenAPI document',
    },
    schema: [],
    messages: {
      pdLeak:
        "'pd' in a response-shape surface — consented 1pd is the decisioner's edge (DecisionCtx only) and never leaves in an API response (PH2-9, arch §4.1)",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const banned =
      (isContracts(filename) || isResponseSurface(filename)) && !isPdStoreInternals(filename);
    if (!banned) return {};
    return {
      Property(node) {
        const name = nameOf(node.key);
        if (name && PD_KEY.test(name)) {
          context.report({ node, messageId: 'pdLeak' });
        }
      },
    };
  },
};
