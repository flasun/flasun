#!/usr/bin/env node
/* ============================================================
   The Public Record Auditor  (run under Node)
     node .agents/claim-audit.js [--dry-run] [--offline]
   ------------------------------------------------------------
   Ported from axiom-orion/cason-heritage, where this is the fourteenth agent
   in a governed roster. Same gate, same trace, different corpus: there it
   watches a résumé and a portfolio, here it watches this profile README.

   A GitHub profile README is the first thing anyone reads about you and the
   last thing anyone updates. Every claim in it that can go stale — an open
   PR that merges, a package that gets unpublished, a link that rots — is
   registered in `claims.json` with the source that backs it.

   It reads `claims.json`, verifies each claim against a live source, routes
   every result through the typed gate, and writes a report. It never edits
   the README: propose, never publish. Its only effect is a report and a PR.

   Verifiers (zero-dependency, Node's global fetch):
     github-issue-state  — is that issue/PR still open?
     npm-package         — is that package actually published?
     http-ok             — does that URL actually serve?
     record-count        — derived live from data.js, so a count on the
                           résumé can never silently drift from the record
     attested            — a real measurement from a source a workflow
                           cannot reach; sourced and dated, and it expires
     unverified          — honestly declared as uncheckable; must carry a
                           `basis`, and may not be a metric

   Exit code: non-zero if any claim BLOCKS (an honesty violation that must
   be fixed). Claims that merely need review do not fail the run — they are
   what the PR is for. A network outage degrades a run; it never fabricates
   a pass.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GOV = require(path.join(__dirname, 'governance.js'));
const CLAIM_POLICY = require(path.join(__dirname, 'claim-policy.js'));

const MANIFEST = path.join(ROOT, 'claims.json');
const REPORT_DIR = path.join(ROOT, '.agents', 'reports');
const TIMEOUT_MS = 15000;

function today() { return new Date().toISOString().slice(0, 10); }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

/* ---- the record, loaded the same way every other suite loads it ----
   Returns null when there is no data.js. `record-count` is the one verifier
   specific to THIS repo; a ported copy governing a profile README or an npm
   package has no family record, and must degrade rather than crash on import. */
const DATA_JS = path.join(ROOT, 'ui_kits', 'family-tree-app', 'data.js');
function recordCounts() {
  if (!fs.existsSync(DATA_JS)) return null;
  const ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(DATA_JS, 'utf8'), ctx, { filename: 'data.js' });
  const people = (ctx.CASON_DATA || {}).people || {};
  const ids = Object.keys(people);
  const direct = ids.filter(function (i) { return people[i].direct === true; })
    .map(function (i) { return people[i].generation; })
    .filter(function (n) { return typeof n === 'number'; })
    .sort(function (a, b) { return a - b; });
  const tiers = {};
  ids.forEach(function (i) { if (people[i].evidence) tiers[people[i].evidence] = 1; });
  return {
    people: ids.length,
    generations: direct.length ? (direct[direct.length - 1] - direct[0] + 1) : 0,
    evidenceTiers: Object.keys(tiers).length,
  };
}

/* ---- network, with a timeout and no fabrication on failure ---- */
async function get(url, headers) {
  const ctl = new AbortController();
  const t = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  try {
    // GET, never HEAD: cognigate.dev answers HEAD with 405 while serving fine.
    return await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: headers || {} });
  } finally { clearTimeout(t); }
}

/* ---- the verifiers ---- */
async function verify(claim, opts) {
  const v = claim.verify || { method: 'unverified' };
  const m = v.method;

  if (m === 'unverified') return { method: m, checkable: false, ok: null };
  if (m === 'attested') return { method: m, checkable: true, ok: true, source: v.source, asOf: v.asOf };

  if (m === 'record-count') {
    const counts = opts.counts;
    if (!counts) return { method: m, checkable: true, ok: false, error: 'record-count needs ui_kits/family-tree-app/data.js, which this repo does not have' };
    const observed = counts[v.metric];
    if (observed === undefined) return { method: m, checkable: true, ok: false, error: 'unknown metric `' + v.metric + '`' };
    return { method: m, checkable: true, ok: true, observed: observed, expected: v.expect };
  }

  if (opts.offline) return { method: m, checkable: true, ok: null, skipped: true, error: 'offline: network verifier not run' };

  try {
    if (m === 'github-issue-state') {
      const h = { 'accept': 'application/vnd.github+json', 'user-agent': 'cason-claim-audit' };
      if (process.env.GITHUB_TOKEN) h.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
      const r = await get('https://api.github.com/repos/' + v.repo + '/issues/' + v.number, h);
      if (!r.ok) return { method: m, checkable: true, ok: false, error: 'GitHub API ' + r.status };
      const j = await r.json();
      return { method: m, checkable: true, ok: true, observed: j.state, expected: v.expect };
    }
    if (m === 'npm-package') {
      const r = await get('https://registry.npmjs.org/' + v.package.replace('/', '%2f'));
      return r.ok
        ? { method: m, checkable: true, ok: true, observed: 'published', expected: 'published' }
        : { method: m, checkable: true, ok: false, error: 'npm registry ' + r.status + ' for ' + v.package };
    }
    if (m === 'http-ok') {
      const r = await get(v.url);
      return r.ok
        ? { method: m, checkable: true, ok: true, observed: String(r.status), expected: String(r.status) }
        : { method: m, checkable: true, ok: false, error: 'HTTP ' + r.status };
    }
  } catch (e) {
    // Recovery & Resilience: an outage degrades the run, it never fabricates.
    return { method: m, checkable: true, ok: false, error: 'unreachable: ' + clip(e && e.message, 120) };
  }
  return { method: m, checkable: true, ok: false, error: 'unknown verifier method `' + m + '`' };
}

/* ---- does the claim actually appear where the manifest says? ---- */
function presence(claim, fileCache) {
  const missing = [];
  (claim.appearsIn || []).forEach(function (rel) {
    let body = fileCache[rel];
    if (body === undefined) {
      const p = path.join(ROOT, rel);
      body = fileCache[rel] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
    if (body === null || body.indexOf(claim.text) === -1) missing.push(rel);
  });
  return missing;
}

/* ---- the report ---- */
function report(date, rows, posture) {
  const blocked = rows.filter(function (r) { return r.decision.decision === 'block'; });
  const review = rows.filter(function (r) { return r.decision.decision === 'needs_approval'; });
  const clean = rows.length - blocked.length - review.length;

  let md = '# Public record audit — ' + date + '\n\n';
  md += '> The public record auditing itself. Every claim published about the person or the estate, checked against a live source and run through the same typed gate as the family record. **Propose, never publish** — nothing here edits a page.\n\n';
  md += '**' + rows.length + '** claim(s) · **' + clean + '** clean · **' + review.length + '** needs review · **' + blocked.length + '** BLOCKED\n\n';
  md += '**Autonomy posture:** ' + (posture.supervised ? 'supervised' : '⚠ UNSUPERVISED') + ' — ' + posture.detail + '\n\n';

  if (blocked.length) {
    md += '## Blocked — an honesty violation, fix before this ships\n\n';
    blocked.forEach(function (r) {
      md += '### `' + r.claim.id + '` — ' + clip(r.claim.text, 120) + '\n\n';
      r.decision.violations.filter(function (v) { return (v.severity || 'block') === 'block'; })
        .forEach(function (v) { md += '- **' + v.rule + '** — ' + v.detail + '\n'; });
      if (r.claim.note) md += '\n' + r.claim.note + '\n';
      md += '\n';
    });
  }

  if (review.length) {
    md += '## Needs review — the world moved\n\n';
    review.forEach(function (r) {
      md += '- **`' + r.claim.id + '`** (' + (r.claim.appearsIn || []).join(', ') + ') — ';
      md += r.decision.violations.map(function (v) { return v.rule + ': ' + v.detail; }).join('; ') + '\n';
    });
    md += '\n';
  }

  md += '## Every claim\n\n';
  md += '| claim | kind | visibility | check | result |\n|---|---|---|---|---|\n';
  rows.forEach(function (r) {
    const c = r.check;
    const mark = r.decision.decision === 'block' ? '⛔ block' : r.decision.decision === 'needs_approval' ? '⚠ review' : '✅ allow';
    const res = c.skipped ? 'skipped (offline)'
      : c.checkable === false ? 'declared uncheckable'
        : c.ok === false ? 'FAILED — ' + clip(c.error, 60)
          : c.observed != null ? String(c.observed) + (String(c.observed) === String(c.expected) ? '' : ' (published: ' + c.expected + ')')
            : 'ok';
    md += '| `' + r.claim.id + '` | ' + (r.claim.claimKind || '—') + ' | ' + (r.claim.visibility || '—') + ' | ' + c.method + ' | ' + mark + ' · ' + res + ' |\n';
  });
  md += '\n' + (blocked.length
    ? '**' + blocked.length + ' claim(s) BLOCKED — the run exits non-zero.**'
    : '_No blocked claims._') + '\n';
  return { md: md, blocked: blocked.length, review: review.length };
}

/* ---- main ---- */
async function main() {
  const args = process.argv.slice(2);
  const DRY = args.indexOf('--dry-run') !== -1;
  const OFFLINE = args.indexOf('--offline') !== -1 || DRY;

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const policy = CLAIM_POLICY.buildClaimPolicy({
    publicArtifacts: manifest.publicArtifacts,
    attestationMaxAgeDays: manifest.attestationMaxAgeDays,
  });
  const posture = CLAIM_POLICY.autonomyPosture(policy);

  const trace = GOV.Trace('public-record-audit ' + today());
  trace.runStarted();

  const counts = recordCounts();
  const fileCache = {};
  const rows = [];

  for (const claim of manifest.claims) {
    const stepId = 'claim:' + claim.id;
    trace.stepStarted(stepId, 'public-record-auditor');

    const check = await verify(claim, { counts: counts, offline: OFFLINE });
    const missingFrom = presence(claim, fileCache);

    const action = {
      kind: 'publish_claim',
      payload: {
        claimId: claim.id,
        text: claim.text,
        claimKind: claim.claimKind,
        visibility: claim.visibility,
        appearsIn: claim.appearsIn || [],
        missingFrom: missingFrom,
        basis: claim.basis,
      },
      justification: claim.note || '',
      check: check,
      provenance: check.source ? [{ sourceId: 'attested:' + claim.id, snippet: clip(check.source, 160), score: 0.9 }] : [],
    };

    trace.actionProposed(stepId, action);
    const decision = GOV.evaluatePolicy(action, policy);
    trace.gateDecision(stepId, decision);
    if (decision.decision === 'block') trace.halted(stepId, GOV.reasonOf(decision, 'block'));
    else if (decision.decision === 'needs_approval') trace.awaitingApproval(stepId, GOV.reasonOf(decision, 'review'));
    else trace.executed(stepId, { verified: true });
    trace.stepCompleted(stepId, 'public-record-auditor', check.method + ' → ' + decision.decision, action.provenance);

    rows.push({ claim: claim, check: check, decision: decision });
  }

  trace.runCompleted();
  const r = report(today(), rows, posture);

  console.log('Public record audit — ' + today());
  rows.forEach(function (row) {
    const mark = row.decision.decision === 'block' ? '⛔' : row.decision.decision === 'needs_approval' ? '⚠ ' : '✓ ';
    console.log('  ' + mark + ' ' + row.claim.id + ' — ' + row.check.method + (row.check.error ? ' — ' + clip(row.check.error, 80) : ''));
  });
  console.log('  · ' + r.blocked + ' blocked, ' + r.review + ' need review, ' + (rows.length - r.blocked - r.review) + ' clean');

  if (DRY) { console.log('\n--dry-run: nothing written.'); return r.blocked ? 1 : 0; }

  // Write only when there is something a human must act on.
  if (r.blocked || r.review) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'claim-audit-' + today() + '.md'), r.md);
    fs.writeFileSync(path.join(REPORT_DIR, 'latest.trace.ndjson'), trace.toNdjson());
    fs.writeFileSync(path.join(REPORT_DIR, 'claim-audit-' + today() + '.trace.ndjson'), trace.toNdjson());
  }
  return r.blocked ? 1 : 0;
}

module.exports = { recordCounts: recordCounts, verify: verify, presence: presence, report: report };

if (require.main === module) {
  main().then(function (code) { process.exit(code); }, function (e) {
    console.error('claim-audit failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
