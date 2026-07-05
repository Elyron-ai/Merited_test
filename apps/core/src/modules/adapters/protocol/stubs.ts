/**
 * Contract-stub protocol adapters (PH3-2, §2.2 "fakes are contract stubs
 * only"). Since PH3-3/PH3-4 the mappings ARE the real adapters — one source
 * of truth each; the conformance suite runs against them directly and the
 * stub names remain for the PH3-2 tests that pinned the behavioural
 * contract.
 */
export { UcpAdapter as UcpStubAdapter } from '../ucp/adapter.js';
export { AcpAdapter as AcpStubAdapter } from '../acp/adapter.js';
