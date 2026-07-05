// @merited/verifier — the reference verifier (PH3-8), built strictly against
// docs/spec/verification.md. Standalone and open-sourceable: depends on
// @merited/contracts (shapes) + RFC 8785 + PASETO libraries only; no core,
// no trio, no events package, no Merited API calls — offline by construction.
export { verifyProofPack, type VerifierResult } from './verify.js';
