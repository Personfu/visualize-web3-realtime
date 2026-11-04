# Security validation

The root website and offline playground share the root npm workspace lock. Both now pin Next.js16.4.5, following the [November3 maintainer security release](https://github.com/vercel/next.js/releases/tag/v16.4.5). The earlier14.2 line falls in the critical image-optimization advisory range described by [GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw). This checkout does not enable dangerouslyAllowSVG; an alert is not proof of an exploitable or deployed instance. Do not test an exploit against public services.

Use Node22.23.4 and the declared npm10.8.2, then npm ci. Peer resolution is strict, with no legacy bypass. The root and playground production builds retain webpack while migrating from Next14. React18 remains supported by Next16 but is deprecated for Next17; changing the renderer's React major requires separate compatibility work.

Run npm run test:offline, npm run typecheck, npm run build and npm run build --workspace @web3viz/playground. The synthetic starter-graph contract opens no connection, wallet, model or executor. Provider adapters now supply the mint/volume aliases required by the existing renderer, including accumulated Ethereum and CEX values; the agent stats use the declared per-chain volume map. These checks do not attest a working native SQLite executor, paid SDK operations, live chains or deployment rollout.

The original next lint invocation is unavailable in Next16. npm run lint now runs the compatible Next16 core-web-vitals/TypeScript preset across the source tree, with warnings blocking. The current44errors/67warnings remain a real merge blocker; no rule was disabled or application tree ignored to obtain a green build. The new CI runs clean install, audit, offline tests, root/workspace typechecks, both builds and real lint. Repository Actions was already enabled; no disabled fork workflow was activated.

The complete dependency audit still contains moderate/low findings. Compatible lock refreshes removed the observed high/critical package findings; an attempted general audit fix selected incompatible ESLint peers and was rejected. Do not force its suggested downgrades or disable strict peers. A passed high-severity gate is not a clean full audit.

Compiler caches and task-runner logs are removed from the current source and ignored. This does not remove prior Git history, PR diffs, caches or old deployments, and no credential was rotated or dismissed. Review suspected credentials for validity and fixture context without publishing their values.
