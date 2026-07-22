# CapWarden — Product Requirements Document

| | |
|---|---|
| **Product** | CapWarden — per-dependency capability guard for Node.js / npm |
| **Status** | Draft v1.0 (for review) |
| **Document owner** | Sharma |
| **Last updated** | 2026-07-21 |

---

## 1. TL;DR

CapWarden gives every npm dependency in a project its own capability allowlist — which ambient authority it may touch (`env`, `net`, `fs`, `child_process`, install scripts) — enforced at the module boundary. It is adopted not by asking teams to author a policy, but by **watching what their dependencies already do**, freezing that as the baseline, and failing the build when a package deviates from it. The primary use case is a **CI gate** that catches a compromised or unexpectedly-behaving dependency update the moment it tries to do something it has never done before.

The core bet is about adoption economics, not maximal security: a leaky guard teams actually run in CI catches more real supply-chain attacks than a rigorous sandbox almost nobody enables.

---

## 2. Background & problem statement

When a Node project runs, **every dependency executes with the full privileges of the process**. A date-formatting utility can read `process.env` (API keys, database URLs), open network sockets, write files, spawn subprocesses, and run arbitrary code at install time via lifecycle scripts (`postinstall`). The runtime draws no distinction between first-party code and code authored by a maintainer three levels deep in the dependency tree.

This is the mechanism behind essentially every major JavaScript supply-chain incident (event-stream, ua-parser-js, node-ipc, and the recurring waves of typosquatted credential stealers). The attack surface is not a bug in application code — it is the **default trust model**: implicit, ambient, total authority granted to thousands of transitive packages nobody has read.

The primitives to constrain this exist but sit at two unhelpful extremes:

- **Process-wide permission systems** (Node `--permission`, Deno flags) can say "this app may use the network" but cannot say "the network, except the date library has no business there." The granularity that matters — *per package* — is missing.
- **Per-package hardening** (SES / Hardened JS, lavamoat) is genuinely rigorous but demands buy-in to a new runtime/mental model plus real compatibility and performance costs, so adoption is low.

The result: capable tools are too heavy to adopt; adoptable tools aren't granular enough. The overwhelming majority of projects run **nothing** — an empty allowlist and an unwatched supply chain.

CapWarden targets the gap: **per-package granularity at near-zero adoption cost**, purchased by giving up completeness.

---

## 3. Goals & non-goals

### 3.1 Goals

- **G1.** Provide per-package capability enforcement for `env`, `net`, `fs`, `child_process`, and install-time scripts.
- **G2.** Deliver value *before any configuration* via an observe mode that reports what the dependency tree actually does.
- **G3.** Generate the enforceable policy automatically from observed behavior; never require hand-authoring to start.
- **G4.** Fit the existing npm workflow — no new package manager, no lockfile replacement, integration via a single require/flag.
- **G5.** Function as a CI gate: deviation from frozen behavior fails the build with a reviewable diff.
- **G6.** Keep false positives low enough that a tripped policy remains a trustworthy signal.

### 3.2 Non-goals (explicitly out of scope)

- **NG1.** Not a sandbox or a hardened-JS runtime; CapWarden does not guarantee containment against a determined attacker.
- **NG2.** Not a replacement for SES/lavamoat where full isolation is required.
- **NG3.** Does not detect malice that looks identical to a package's legitimate function (a compromised networking library making a network request is within policy).
- **NG4.** Does not perform static analysis or vulnerability scanning of dependency source (that is the space of socket.dev / Snyk / npm audit; CapWarden is runtime-behavioral and complementary).
- **NG5.** Not a browser-side tool in the MVP (Node.js server/CLI/CI first).

---

## 4. Target users & personas

- **Platform/DevEx engineer.** Owns CI for many services. Wants a check she can roll out org-wide that catches supply-chain surprises without generating noise that teams learn to ignore. Primary buyer and integrator.
- **AppSec engineer.** Cares about the threat model and wants evidence of what dependencies do at runtime. Uses the observe report during dependency reviews.
- **App developer on a product team.** Doesn't want to think about this at all. The check is green until a PR bumps a dependency that suddenly wants new authority, at which point the failure explains itself in one screen.

---

## 5. Competitive landscape

| Tool | Granularity | Adoption cost | What it does | Relationship to CapWarden |
|---|---|---|---|---|
| Node `--permission` | Process-wide | Low | Gates fs/net/child_process for the whole process | Complementary; CapWarden adds per-package attribution |
| Deno permissions | Process-wide | Low (new runtime) | Prompt/flag-based ambient authority | Different runtime; same granularity gap |
| SES / Hardened JS | Per-compartment | High | True isolation, frozen intrinsics | More rigorous, higher friction; CapWarden trades rigor for adoptability |
| lavamoat | Per-package | Medium–High | Policy-driven per-package access under SES | Closest peer; CapWarden is lighter/observe-first, less complete |
| socket.dev / Snyk / npm audit | N/A (static) | Low | Static/metadata risk scoring of packages | Complementary; different detection axis (static vs runtime-behavioral) |

**Positioning:** CapWarden is not competing with SES on rigor. Its competition is the empty allowlist. It wins by being turn-on-this-afternoon.

---

## 6. Product principles

1. **Observe before enforce.** The first run must be safe and informative, never blocking.
2. **Generate, don't author.** The policy is a machine-produced artifact the human reviews, not writes.
3. **Freeze normal; surface deviation.** Don't predict attacks; make change visible and reviewable.
4. **Fail loud, fail specific.** A block names the package, the exact capability, and how it differs from the baseline.
5. **Loose by default, strict on request.** Coarse capability kinds by default to protect the false-positive rate; opt-in tightening for high-value packages.
6. **Fit the workflow.** No new package manager, no new mental model as a precondition to value.

---

## 7. User journey — the lifecycle

1. **Install** — add CapWarden as a dev dependency and a single require/preload hook. `package.json`, `npm install`, and the lockfile are untouched.
2. **Observe** — run the test suite or app. CapWarden records every `env`/`net`/`fs`/`child_process`/install-script access, attributes it to the responsible package, and writes a **report** plus a **proposed policy**. Blocks nothing.
3. **Review & commit** — a human reads the report ("why does a string formatter want the network?"), and commits the generated policy file next to the lockfile. This review is the day-one catch for anything already wrong.
4. **Enforce (steady state)** — CI runs in enforce mode. Identical behavior passes with zero friction; the policy file is never touched.
5. **Deviation** — a dependency (often via an update) does something outside its frozen baseline. The build fails with a specific, reviewable message.
6. **Adjudicate** — the human decides: *legit* → regenerate the policy via `capwarden update`, review the diff, commit; *malicious* → do not regenerate; stop and investigate. A legitimate new capability and an attack surface the **same way** — CapWarden makes the change visible; the human judges it.

---

## 8. Functional requirements

### 8.1 Integration surface

- **FR-1.** CapWarden SHALL activate via a preload hook (`node --require capwarden/register app.js` or `NODE_OPTIONS`), requiring no changes to application source beyond that hook.
- **FR-2.** CapWarden SHALL provide a CLI: `capwarden observe`, `capwarden enforce`, `capwarden update`, `capwarden report`.
- **FR-3.** CapWarden SHALL NOT require replacing npm, the lockfile, or the resolution algorithm.

### 8.2 Modes

- **FR-4.** **Observe mode** SHALL record all intercepted accesses, block nothing, and on exit write (a) a detailed report and (b) a proposed policy.
- **FR-5.** **Enforce mode** SHALL load the committed policy and, for any access not permitted by it, (a) log a specific violation, (b) block the action (withhold env value / throw on net/fs/child_process), and (c) cause a non-zero process exit suitable for failing CI.
- **FR-6.** **Update mode** SHALL regenerate the policy from a fresh observe pass and print a diff against the committed policy; it SHALL NOT auto-commit.
- **FR-7.** Mode SHALL be selectable via CLI subcommand and via env var (`CAPWARDEN=observe|enforce`).

### 8.3 Capability model

- **FR-8.** CapWarden SHALL support these capability kinds: `env`, `net`, `fs`, `proc` (child_process/exec/spawn), and `install` (lifecycle scripts run at install time).
- **FR-9.** The detailed report SHALL capture sub-detail per access: env var name; net host:port; fs path + read/write; proc command; install script name.
- **FR-10.** The enforced policy SHALL default to **coarse kinds** (e.g. `net`), with an opt-in **strict** qualifier to pin sub-detail (e.g. `net:api.example.com:443`).

### 8.4 Attribution

- **FR-11.** CapWarden SHALL attribute each access to the responsible package. The MVP MAY use call-stack inspection (nearest `node_modules/<pkg>` frame); GA SHALL use `AsyncLocalStorage`-based ownership tracking so attribution survives async boundaries and callback indirection.
- **FR-12.** Accesses with no `node_modules` frame SHALL be attributed to first-party application code and are always allowed (CapWarden governs dependencies, not your own code).
- **FR-13.** CapWarden SHALL correctly handle scoped packages (`@scope/name`).

### 8.5 Install-time protection

- **FR-14.** CapWarden SHALL be able to run dependency lifecycle scripts under observation/enforcement, since `postinstall` is a primary attack vector that executes before any application code.
- **FR-15.** Where full interception of install scripts is infeasible, CapWarden SHALL at minimum inventory which packages declare lifecycle scripts and flag additions across updates.

### 8.6 Reporting

- **FR-16.** The observe report SHALL be available as human-readable terminal output and as machine-readable JSON.
- **FR-17.** On an enforce violation, output SHALL name the package, the attempted capability with sub-detail, and the frozen grants it violated.
- **FR-18.** `capwarden update` diff output SHALL clearly separate *added* capabilities (the review-worthy signal) from removed ones.

### 8.7 Configuration & overrides

- **FR-19.** CapWarden SHALL read an optional config file for: strict-mode packages, globally denied capabilities, ignored packages, and CI behavior.
- **FR-20.** Users SHALL be able to manually pre-deny a capability a package currently uses, or pin strict sub-detail, as explicit overrides layered on top of the generated policy.

---

## 9. Non-functional requirements

- **NFR-1. Performance.** Steady-state enforce overhead SHOULD be < 5% on typical server workloads; attribution must not add unbounded stack-walking cost on hot paths (AsyncLocalStorage context over per-call stack capture at GA).
- **NFR-2. Compatibility.** SHALL support Node LTS (currently 20/22) and both CommonJS and ESM. Dynamic `import()`/`require()` SHALL be attributed.
- **NFR-3. Determinism.** Given the same code and inputs, observe SHALL produce a stable policy (sorted, normalized) so diffs are meaningful.
- **NFR-4. Fail-safe posture.** A CapWarden internal error SHALL be configurable to fail-open (log, don't block) or fail-closed, defaulting to fail-open in enforce to avoid taking down production on a guard bug.
- **NFR-5. Zero secret leakage.** CapWarden SHALL never write env values or file contents into reports — only keys/paths/metadata.

---

## 10. Technical architecture

### 10.1 Interception points

- **`process.env`** — replaced with a `Proxy` whose `get` trap attributes and (in enforce) withholds unpermitted values.
- **Network** — wrap `http`/`https` `request`/`get`, `net.connect`/`createConnection`; attribute at call time and extract host:port.
- **Filesystem** — wrap `fs` read/write entry points (sync + async + promises).
- **Subprocess** — wrap `child_process` `exec`/`execFile`/`spawn`/`fork`.
- **Install scripts** — a wrapper around the install step that runs lifecycle scripts under the same hook.

### 10.2 Attribution (the hard part)

MVP walks the call stack for the nearest `node_modules/<pkg>` frame. This is honest but leaky: if a compromised package routes its call *through* a legitimate library's function, the innocent library can be blamed. GA replaces this with **`AsyncLocalStorage`**: when control enters a package's module code, CapWarden sets the "owning package" in async context, and every intercepted primitive reads the owner from context rather than sniffing the stack — surviving callbacks, promises, and timers. Native addons that bypass the JS boundary remain outside attribution and are a documented gap (see §12).

### 10.3 Transitive dependencies

Policy is keyed per resolved package and composes across the tree: a deep transitive package with no entry has zero capabilities. The generation step walks everything observed, so transitives are covered by construction rather than by manual enumeration.

### 10.4 CI integration

Shipped as a CI-friendly command with a non-zero exit on violation and machine-readable output for annotations. Recommended placement: a required status check on PRs, adjacent to tests and lint. The reviewable artifact is the policy diff when `capwarden update` is run for a legitimate change.

---

## 11. Policy schema

### 11.1 MVP (flat) schema

```json
{
  "version": 1,
  "packages": {
    "undici":         ["net"],
    "dotenv":         ["env", "fs"],
    "esbuild":        ["fs"],
    "@sentry/node":   ["env", "net"],
    "telemetry-lite": ["env", "net"]
  }
}
```

A package absent from `packages` has **zero** capabilities. Kinds are coarse by default.

### 11.2 GA (versioned + strict) schema

Addresses the open question that a flat schema can't distinguish `undici@6` from `undici@7`, can't express strict sub-detail, and doesn't record provenance.

```json
{
  "version": 2,
  "generatedAt": "2026-07-21T00:00:00Z",
  "defaults": { "strict": false, "onViolation": "block" },
  "packages": {
    "telemetry-lite@2.1.0": {
      "grants": {
        "env": ["TELEMETRY_KEY"],
        "net": ["api.telemetry.example.com:443"]
      },
      "strict": true,
      "resolvedVia": ["app > telemetry-lite"],
      "hasInstallScript": false
    },
    "undici@6.19.2": {
      "grants": { "net": ["*"] },
      "strict": false,
      "resolvedVia": ["app > @sentry/node > undici"]
    }
  }
}
```

- `grants` maps kind → allowed sub-details; `"*"` means "any, kind-level only" (loose mode).
- `strict: true` pins exact sub-detail; deviations within an allowed kind still trip.
- Version-qualified keys tie a capability change and a version bump together, so a compromised update stands out as *both* a new version *and* new grants.
- `resolvedVia` records provenance for reviewer context.
- `hasInstallScript` supports FR-15 flagging.

---

## 12. Security model & threat coverage

### 12.1 What CapWarden catches

| Scenario | Caught? | Why |
|---|---|---|
| Benign package's update adds env-read + exfil (classic stealer) | ✅ | New capability outside frozen baseline → block + fail |
| Typosquat that opens network / reads secrets | ✅ | No baseline grants → zero capabilities |
| `postinstall` script added in an update | ✅ (with §8.5) | Install inventory/enforcement flags the new script |
| Dependency starts spawning a subprocess it never did | ✅ | `proc` not in baseline |

### 12.2 What CapWarden does NOT catch (stated plainly)

| Scenario | Caught? | Why not |
|---|---|---|
| A networking library (already granted `net`) is compromised and exfiltrates over its legitimate channel | ❌ | The malicious action is within policy; behavior looks normal |
| Native addon performs I/O below the JS boundary | ❌ | Outside interception/attribution |
| Attacker routes a call through a legitimately-permitted package (MVP stack attribution) | ⚠️ | Mitigated at GA by AsyncLocalStorage, not eliminated |
| Data exfiltration via an allowed capability's side channel (e.g. DNS through an allowed resolver) | ❌ | Behavioral freeze is coarse by design |

**Honest summary:** CapWarden raises the cost of an attack and shrinks the exposed surface to packages that *already* hold the capability being abused. It does not reduce that surface to zero and is not a containment boundary.

---

## 13. Key risks & mitigations

- **R1 — Alert fatigue.** If legitimate updates trip the policy constantly, teams rubber-stamp warnings and the signal dies. *Mitigation:* loose-by-default kinds; strict only opt-in; clear add-only diffs; tuning the generation to minimize churn. This is the single most important thing to get right (NFR-driven).
- **R2 — Attribution errors blame the wrong package.** *Mitigation:* AsyncLocalStorage at GA; documented MVP limitation; provenance in reports for human sanity-checking.
- **R3 — Guard bug takes down production.** *Mitigation:* fail-open default in enforce (NFR-4); the CI gate, not production runtime, is the primary enforcement point.
- **R4 — False sense of security.** Teams believe they're sandboxed. *Mitigation:* documentation leads with §12.2; positioning explicitly states "not a sandbox."
- **R5 — Native/ESM/dynamic-import gaps** reduce coverage silently. *Mitigation:* coverage report that lists un-instrumentable packages so gaps are visible, not hidden.

---

## 14. Success metrics

- **Adoption:** # repos with a committed CapWarden policy; # running the CI gate.
- **Signal quality:** ratio of true-positive deviations (real review-worthy changes) to total enforce failures; target a low false-alarm rate (specific threshold set with design partners).
- **Time-to-value:** median time from install to first observe report (target: single test run).
- **Catch evidence:** documented instances where a CapWarden failure surfaced a real unexpected capability change in a dependency update.
- **Friction:** enforce-mode overhead within NFR-1; # of teams disabling the check (leading indicator of alert fatigue).

---

## 15. Phased rollout

**Phase 0 — Proof of concept (done).** Stack-attribution guard covering `env` + `net` + `fs`, observe/enforce, auto-generated flat policy, demonstrated catching a compromised update.

**Phase 1 — MVP (~1 quarter).**
- `env`/`net`/`fs`/`proc` interception; flat v1 policy; observe/enforce/update CLI; ESM + CJS; CI exit codes; terminal + JSON reports. Ship to 2–3 design-partner teams.

**Phase 2 — Hardening & GA (~2–3 quarters).**
- AsyncLocalStorage attribution; v2 versioned+strict schema; install-script coverage (§8.5); coverage/gap reporting; config + overrides; fail-open safety; performance to NFR-1.

**Phase 3 — Beyond.**
- Registry integration (compare a package's requested capabilities against community baselines); org-wide policy inheritance; editor/PR annotations; optional deeper isolation backend (SES/lavamoat) for teams that want to graduate from "observe" to "contain" without changing their policy files.

---

## 16. Open questions

1. **Strict vs loose default per kind** — should `net` ever default to strict (host-pinned) for packages that only ever hit one host? Trades safety for churn.
2. **Install-script enforcement depth** — full interception vs inventory-and-flag for MVP; how much can be done without owning the install step.
3. **Monorepo semantics** — one policy per workspace package vs one root policy; how provenance is expressed across workspaces.
4. **Version-key churn** — version-qualified keys make the policy noisier on every bump; need a normalization/roll-forward story so patch bumps with identical capabilities don't spam diffs.
5. **First-party boundary** — how to treat local packages / linked workspaces that live under `node_modules` but are effectively first-party.

---

## 17. Appendix

### 17.1 Glossary

- **Capability** — authority to perform a specific class of privileged action (open a socket, read a secret).
- **Ambient authority** — authority available implicitly to all code in a process without explicit granting; the thing CapWarden constrains per package.
- **Attribution** — determining which package is responsible for a given runtime access.
- **Freeze / baseline** — the set of capabilities a package was observed using, treated as its allowlist.
- **Deviation** — a runtime access outside a package's frozen baseline; the core signal.

### 17.2 Reference lifecycle (from the working prototype)

```
observe   → run app/tests → report + proposed policy   (blocks nothing)
review    → human reads report, commits policy         (day-one catch)
enforce   → identical behavior passes                  (zero friction)
deviation → dependency does something new → build fails (specific, reviewable)
adjudicate→ legit → `capwarden update` + commit diff
            malicious → do not regenerate; investigate
```

### 17.3 Example enforce failure (illustrative)

```
⛔  CAPWARDEN BLOCKED
     package : tiny-format@1.0.1
     tried   : env:AWS_SECRET_ACCESS_KEY
     policy  : (package unknown to policy — zero capabilities)
     → this capability was never part of tiny-format's frozen behavior.
```
