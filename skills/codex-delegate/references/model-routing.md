# Model routing policy

The public default uses one persistent lead thread, not one fresh session per capability. After Terra classification, low-risk/low-complexity tasks default to a Terra lead, others to Sol; a validated exact implementation route may override that choice. The lead retains its model between phases unless policy explicitly escalates to Astra. The capability defaults below apply to isolated execution and escalation decisions. Final Sol review remains separate in both modes.

`runtime/model-policy.json` is a readable policy input. It selects one model for one capability, rather than a fixed author-implementer-review chain. Available routes use medium reasoning only.

Initial defaults are hypotheses. Deterministic tool work needs no model. Classification and implementation use Terra; investigation, design, acceptance, and review use Sol. A bounded simple fix still needs a known failing deterministic check, explicit expected behavior, and a bounded implementation allowlist. Hard signals raise judgment capabilities (classify, investigate, design, acceptance, review) to at least Sol. They do not raise implementation above Terra: implementation consumes contract and scope already decided by judgment stages. Astra is escalation for design or acceptance when an unresolved contradiction or repeated contract failure remains.

Hard signals are `ambiguous-reproduction`, `cross-module`, `public-contract`, `auth-security`, `payment-medical-data`, `migration`, `external-side-effect`, `missing-executable-check`, and `contract-revision`. They establish Sol as a minimum.

An evaluated route is promoted only by a versioned result with a passing run, at least two holdout cases, at least two repetitions, zero false completions, zero scope violations, matching skill version, and a SHA-256-pinned JSON evidence artifact. The route key covers task class, workflow, risk, complexity, and normalized sorted signals. Selection re-hashes and validates artifact fields, metrics, and exact route key. A missing, stale, or changed artifact keeps the default route and independent review. Synthetic runner tests do not validate generic routing. Failed or incomplete results keep prior defaults.

Evaluated routes always retain `independentReview: true`. Relative evidence paths resolve from `runtime/`; absolute paths are supported. Every local-workspace workflow runs a fresh Sol review. Any skill-version change invalidates evaluated routes from older versions; retain evidence but do not select those routes until re-evaluated.
