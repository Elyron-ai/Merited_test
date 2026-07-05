// Identity resolution: pure resolve(), tiers, segments (CORE-4).
export {
  resolve,
  segmentFor,
  EMPTY_LOOKUPS,
  type AuroraMemberRecord,
  type Clock,
  type IdentityLookupResults,
  type ResolvedIdentity,
  type SoftIdentityRecord,
} from './resolve.js';
export { IdentityStore } from './store.js';
export {
  PgIdentityLinkReader,
  type IdentityLinkReader,
  type LinkedMember,
} from './link-reader.js';
