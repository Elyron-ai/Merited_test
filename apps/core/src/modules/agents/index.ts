// Agent registry, key auth plugin, per-agent limits (CORE-3).
export { AgentsService, type RegisterAgentInput, type RegisteredAgent } from './service.js';
export { registerAgentAuth, type AgentAuthOptions } from './auth.js';
export { registerAgentRoutes } from './routes.js';
export { generateApiKey, hashKey, hashesEqual } from './keys.js';
