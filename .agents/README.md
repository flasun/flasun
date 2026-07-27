# The Public Record Auditor

A profile README is the first thing anyone reads about you and the last thing
you remember to update. This agent watches this one.

Every claim in `README.md` that can go stale — an open PR that merges, a package
that gets unpublished, a link that rots, a count that changes — is registered in
[`claims.json`](../claims.json) with the source that backs it. Weekly, the agent
re-verifies each one against that source, runs the result through a typed policy
gate, and opens a PR if anything needs a human.

**It never edits the README.** Propose, never publish.

## Run it

```sh
node .agents/claim-audit.js              # verify every claim against its source
node .agents/claim-audit.js --dry-run    # no network, nothing written
```

Exit code is non-zero when a claim **blocks**. Claims needing review don't fail
the run — that's what the PR is for. A network outage degrades a check and says
so; it never fabricates a pass.

## Verifiers

| method | checks |
|---|---|
| `github-issue-state` | is that issue/PR still open? |
| `npm-package` | is that package actually published? |
| `http-ok` | does that URL actually serve? (GET, never HEAD — some hosts 405 on HEAD) |
| `attested` | a real fact whose source a workflow can't reach; needs a named `source` **and** an `asOf`, and expires |
| `unverified` | honestly declared uncheckable; must carry a `basis`, and may **not** be a metric |

## The gate

| rule | severity | refuses |
|---|---|---|
| `require-claim-basis` | block | an uncheckable claim resting on nothing |
| `no-unsourced-metric` | block | a number with no receipt — prose is not a measurement |
| `no-internal-in-public` | block | proprietary content appearing in a public artifact |
| `claim-must-appear` | block | the manifest attests text the README no longer carries |
| `failed-check-needs-review` | review | a check that ran and failed |
| `drifted-value-needs-review` | review | the source now reads something else |
| `stale-attestation-needs-review` | review | an attestation past its horizon |
| `correction-needs-human-merge` | review | every correction, always |

## Where it came from

Ported from [`axiom-orion/cason-heritage`](https://github.com/axiom-orion/cason-heritage),
where this is the fourteenth agent in a governed roster — the same gate that
governs an eleven-generation genealogical record, pointed at a different corpus.
The design notes live in that repo at `research/CLAIMS.md`.

The port is three modules plus a manifest: `governance.js` (the gate engine,
unchanged), `claim-policy.js` (the rules, unchanged), `claim-audit.js` (paths
adjusted for this flat layout, and the `record-count` verifier degrades to a
clear error here because this repo has no record to count).

That is the whole point of the split — **the agent is generic, the manifest is
what makes it about a given surface.**
