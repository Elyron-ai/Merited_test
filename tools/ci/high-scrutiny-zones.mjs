// XC-3: the high-scrutiny zones (BUILD-PLAN §8, table XC.7) as path
// prefixes — the SINGLE source the CODEOWNERS file, the labeler config and
// the security-review check are all tested against (a zone added here
// without updating those files fails the conventions tests).
export const HIGH_SCRUTINY_ZONES = [
  'packages/contracts/',
  'packages/signing/',
  'packages/events/',
  'apps/trio/',
  'apps/core/src/modules/token-client/',
  'apps/core/src/modules/adapters/',
  'apps/wallet/src/modules/linking/',
  'apps/wallet/src/modules/mandates/',
];

export const touchesHighScrutinyZone = (changedFiles) =>
  changedFiles.filter((file) => HIGH_SCRUTINY_ZONES.some((zone) => file.startsWith(zone)));
