# @merited/signing

Interfaces (`Signer`, `Crypter`) plus the Phase-0 fakes (`FakeSigner`, `FakeCrypter`).

**Boundary (SYN-32, BUILD-SPEC §7):** no real cryptography lives in this package in Phase 0. `FakeSigner` emits `fake-ed25519:`-tagged HMAC pseudo-signatures; `FakeCrypter` emits `fake-kms:`-tagged envelopes — visually unmistakable for production artefacts. The real Ed25519/KMS implementations replace the fakes via config in Phase 1 (**PH1-30**), behind these exact interfaces, under high-scrutiny controls and the LEAD-5 external audit.

Key refs are hierarchy-namespaced (SYN-1): `platform/<name>`, `merchant/<mer_id>`, `agent/<agt_id>`. A signature made under one hierarchy never verifies under another.
