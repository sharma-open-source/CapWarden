# CapWarden

**Per-dependency capability guard for Node.js / npm.**

Every dependency in a Node project runs with the full privileges of the
process. A date-formatting utility three levels deep in your tree can read
`process.env` (API keys, database URLs), open network sockets, write files, and
spawn subprocesses — the runtime draws no line between your code and code
authored by a stranger. CapWarden watches what each dependency actually does,
freezes that into a reviewed baseline, and fails your CI build if a dependency
later reaches for a capability it never used before.

> **What CapWarden is not.** It is not a sandbox and not a runtime security
> boundary — a determined native addon can still act below the JS layer. It is a
> **change detector**: it makes a dependency's newly-acquired capability
> *visible and reviewable* in a pull request, which is where supply-chain
> compromises are caught.

## How it works

1. **Observe** your app or test suite. CapWarden intercepts `env`, `net`, `fs`,
   and `proc` access, attributes each to the responsible package, and writes a
   proposed policy.
2. **Review and commit** `capwarden-policy.json` — a small, readable baseline of
   which package may use which capability kind.
3. **Enforce** in CI. Any access outside the committed policy blocks and exits
   non-zero, so the diff that introduced it fails review.

## Quickstart

```bash
npm install --save-dev capwarden

# 1. Record what your dependencies do (blocks nothing)
npx capwarden observe -- npm test

# 2. Review capwarden-policy.json, then commit it
git add capwarden-policy.json && git commit -m "Add CapWarden baseline"

# 3. Enforce it — in CI, or locally
npx capwarden enforce -- npm test
```

When a dependency later does something new:

```
⛔  CAPWARDEN BLOCKED
     package : leaky-util
     tried   : net:evil.example.com:443
     policy  : grants [env]
     → this capability was never part of leaky-util's frozen behavior.
```

To accept an intentional change, regenerate and review the diff:

```bash
npx capwarden update --write -- npm test   # rewrites the policy; you commit it
```

## Commands

| Command | Purpose |
|---|---|
| `capwarden observe -- <cmd>` | Run `<cmd>` under observation; write report + proposed policy. |
| `capwarden enforce -- <cmd>` | Run `<cmd>` under the committed policy; exit non-zero on any deviation. |
| `capwarden update --write -- <cmd>` | Re-observe, show the policy diff, and rewrite the policy. Never auto-commits. |
| `capwarden report` | Print the last observe report in human-readable form (`--json` for raw). |
| `capwarden inventory [--diff\|--write]` | List / diff packages that declare lifecycle install scripts. |
| `capwarden scripts [--enforce] [--run]` | Govern lifecycle (install) scripts against the policy; optionally run the permitted ones under observation. |
| `capwarden coverage [--json]` | List packages CapWarden cannot fully instrument (native addons, ESM-only). |
| `capwarden migrate [--out <file>]` | Convert a committed v1 policy to the v2 (strict-capable) schema. |

All modes can also be activated via a preload without the runner:
`CAPWARDEN=observe node --require capwarden/register app.js`.

## Configuration

Optional `capwarden.config.json` in your project root:

```json
{
  "onViolation": "block",
  "onInternalError": "fail-open",
  "ignored": ["some-trusted-internal-pkg"],
  "denied": { "*": ["proc"], "analytics-sdk": ["net"] }
}
```

- **`onViolation`** — `block` (default; CI gate) or `log` (warn only). Governs
  *policy violations*.
- **`onInternalError`** — `fail-open` (default) or `fail-closed`. Governs bugs
  in CapWarden itself: fail-open means a guard bug never takes down your app
  (NFR-4). Distinct from `onViolation`.
- **`ignored`** — packages allowed unconditionally (use sparingly).
- **`denied`** — manual pre-deny overrides: capability kinds a package may not
  use even if the baseline grants them. `"*"` applies to every package.

## Example GitHub Action

```yaml
# .github/workflows/capwarden.yml
name: CapWarden
on: [pull_request]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx capwarden enforce -- npm test
```

## Capability coverage

- **env** — `process.env` reads (via a Proxy covering `get`,
  `getOwnPropertyDescriptor`, and `ownKeys`). Node's own runtime env probes are
  suppressed to avoid baseline noise.
- **net** — `http(s)`, `net`, `tls`, `dgram`, `dns`, `http2`, and global `fetch`.
- **fs** — reads/writes plus destructive operations (`unlink`, `rm`, `rename`,
  `mkdir`, `chmod`, …), across sync, callback, and `promises` forms.
- **proc** — `child_process` `exec`/`spawn`/`fork` and their variants.

Sub-detail (host, path, env key) is recorded in the report. Two policy schemas
are supported and auto-detected on load:

- **v1** (default) — kind-level: a package may or may not use `net`.
- **v2** — strict sub-detail pinning: a package may reach
  `net:api.stripe.com:443` but nothing else. Generate with
  `capwarden observe --schema v2 --strict -- <cmd>`, or migrate an existing v1
  baseline with `capwarden migrate` (behavior-preserving: all grants become
  wildcards until you tighten them). v2 packages are keyed by `name@version` and
  can carry `resolvedVia` provenance.

## Monorepos

CapWarden reads your root `package.json` `workspaces` (npm/yarn/bun) or
`pnpm-workspace.yaml` and treats local workspace packages as first-party — they
are folded into `app` rather than flagged as third-party dependencies, even
though they're symlinked into `node_modules`. Anything discovery misses can be
added to `ignored` in the config.

## Privacy

CapWarden records capability **metadata only** — env keys, hostnames, and file
paths — never env values or file contents (NFR-5).

## License

MIT — see [LICENSE](LICENSE).
