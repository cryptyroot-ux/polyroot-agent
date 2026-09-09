# Polyroot research findings and verification limits

Research date: 9 September 2026. Upstream commit: 715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8.

## What was inspected

All 827 Git blobs were extracted without installing or executing upstream code. Git blob hashes match the tree, and SHA256/bytes/lines/static imports/exports are inventoried. Forty-two files have targeted semantic findings; this is not a line-by-line audit of all source. Three official SDK candidate tarballs match registry SHA512 integrity. Current official Polymarket docs, package metadata and relevant primary security/statistical references informed the design. No credentials, relayer mutations, on-chain transactions, or live orders were used.

## Findings that change decisions

1. Clodds already wires SafetyManager and risk engine; these are not absent. Optional risk contexts, duplicated breakers, example bankroll and auto-resume still require hardening. Decision: reuse rules selectively, replace shared authority and reservation boundary. Sources R03–R05 and per-file matrix.
2. Manual signer knows signature type 3 but throws. Decision: implement full deposit-wallet path, not enum-only support. Source R06.
3. Kelly, links and structural modules exist upstream. Their presence does not prove valid probability, exhaustive outcomes or current fee economics. Decision: port useful ideas and rewrite proof/sizing money semantics. Sources R07–R09.
4. Copy success-to-filled and maker cancel-error/ID reset can misstate exposure. Decision: replace execution wiring and derive holdings from confirmed lifecycle. Sources R11–R12.
5. Current migration points toward unified client, superseding a blanket preference for clob-client-v2. Exact candidate versions are 0.9.0, 1.1.0 and 0.0.10; no production freeze has occurred. Sources R13–R14, R33–R35.
6. CLOB V2, PolyV2 settlement identifiers and ExchangeV3 signing are distinct dimensions. Decision: typed ProtocolProfile, unknown profile blocks. Sources R17–R18.
7. maxSpend changelog language is estimated spending; placing-orders prose still calls it a cap. Decision: unresolved contract gate, not a hard-cap claim. Sources R18–R19.
8. Venue downtime can return 425 and prevent cancel. POST_ONLY and CANCEL_ONLY do not define a universal restart sequence. Decision: orthogonal capabilities and observed mode, not timer inference. Sources R21–R22.
9. GTD expiration offset/minimum differs from short local intent TTL. Decision: profile tests and bounded stale exposure; timeout never proves server cancellation. Source R19.
10. Rate limiting includes IP queue/throttle and signer order/cancel buckets; rollout enforcement cannot be inferred from elapsed dates. Sources R29–R30.
11. Maker rebate, liquidity reward and taker incentive are separate; estimates cannot fund positions. Fee prose currency labels may differ from collateral documentation. Decision: receipt/profile asset identity, no symbol guessing. Sources R23–R28.
12. Same-process plugins and Node permission flags do not isolate malicious code. Retrieval requires DNS/redirect/egress protection in addition to prompt-injection defenses. Sources R10, R36–R38.
13. Hosted model lineage may remain non-immutable. Saved response replay is distinguishable from regenerating an alias. Experiments require prospective data, global trials, denominator logs and independent-event uncertainty. Sources R39–R42 plus explicit Polyroot design.

## Claims not established

Profitability, Cambridge affiliation, all advertised strategies functioning, exact production fee debit ceilings, complete semantic audit, SDK authenticated compatibility for all wallet/protocol profiles, on-chain bytecode equivalence, session-key revocation finality, and execution simulator calibration remain unproven. These are not marked PASS.

## Source precedence and conflicts

Protocol conflicts are recorded, not silently resolved by choosing a package name. Official deployment/changelog/contract evidence and exact package behavior guide a versioned adapter profile, then golden and authenticated tests decide admission. Blueprint design constraints are recommendations, not quotations from documentation. The public sources can change after the research date; Source_Snapshot_Manifest.json records fetched content hashes.
