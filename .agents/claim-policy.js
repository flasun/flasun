/* ============================================================
   The Living Line — Public-Claim Policy  (window.CASON_CLAIM_POLICY)
   ------------------------------------------------------------
   The same typed gate as `governance.js`, pointed at a different corpus.

   The family record is a set of assertions, each with sources, each able
   to go stale — and it is governed. The PUBLIC record (the résumé, the
   portfolio, the profile READMEs) is structurally the same thing and was
   governed by nothing. This is the policy that closes that gap.

   It reuses `CASON_GOVERNANCE.evaluatePolicy` unchanged — same three-tier
   Decision, same named rules with thresholds, same NDJSON TraceEvent
   stream. Only the rules are new, because the failure modes are:

     • a public claim must be checkable or say why not (require-claim-basis, block)
     • a number needs a receipt                        (no-unsourced-metric, block)
     • proprietary content never appears in public     (no-internal-in-public, block)
     • a claim must actually appear where it says      (claim-must-appear, block)
     • a failed check routes to a human                (failed-check-needs-review, review)
     • a value that drifted routes to a human          (drifted-value-needs-review, review)
     • an attestation expires                          (stale-attestation-needs-review, review)
     • every correction parks for the human merge gate (correction-needs-human-merge, review)

   `no-internal-in-public` is the load-bearing one. "What is proprietary"
   stops being something a person remembers under deadline and becomes a
   rule the gate enforces before anything ships.

   Propose, never publish: nothing here edits a page. The auditor's only
   effect is a report and a PR.

   Runs no-build in the browser (window) and under Node (module.exports).
   ============================================================ */
(function (root) {
  'use strict';

  const GOV = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
    ? require('./governance.js')
    : (root && root.CASON_GOVERNANCE);

  const VISIBILITIES = ['public', 'internal'];
  const KINDS = ['metric', 'status', 'link', 'credential', 'narrative'];

  /* A claim action is the unit the gate sees:
       { kind: 'publish_claim', claim, payload: {...}, check: {...}, provenance: [...] }
     `check` is the verifier's verdict for this run:
       { ok, method, observed, expected, error, checkable } */

  function textOf(a) {
    const p = a.payload || {};
    return [p.text, p.basis, a.justification].filter(Boolean).join(' \n ');
  }

  /* ---- a public claim must be machine-checkable, or state its basis ----
     "unverifiable" is a legitimate answer (25 years of hospitality has no
     API), but it must be declared and grounded, not left blank. */
  const requireClaimBasis = {
    name: 'require-claim-basis',
    evaluate: function (a) {
      if (a.kind !== 'publish_claim') return null;
      const c = a.check || {};
      if (c.checkable !== false) return null;
      return (a.payload && String(a.payload.basis || '').trim())
        ? null
        : { rule: 'require-claim-basis', detail: 'claim has no machine check and no stated basis — it rests on nothing a reader can follow' };
    },
  };

  /* ---- a number needs a receipt ----
     The honesty bar that matters most in practice. A narrative claim can be
     argued about; a metric either has a source that produces it or it does
     not. An unsourced metric is the exact shape of an overclaim. */
  const noUnsourcedMetric = {
    name: 'no-unsourced-metric',
    evaluate: function (a) {
      if (a.kind !== 'publish_claim') return null;
      const p = a.payload || {}, c = a.check || {};
      if (p.claimKind !== 'metric') return null;
      return c.checkable === false
        ? { rule: 'no-unsourced-metric', detail: 'a metric is published with no machine-checkable source — produce the measurement or restate it as a target' }
        : null;
    },
  };

  /* ---- the proprietary boundary, mechanically ----
     A claim marked `internal` must not appear in a public artifact. This is
     the rule that makes "what is proprietary" enforceable rather than
     remembered. */
  function makeNoInternalInPublic(publicArtifacts) {
    const pub = publicArtifacts || [];
    return {
      name: 'no-internal-in-public',
      evaluate: function (a) {
        if (a.kind !== 'publish_claim') return null;
        const p = a.payload || {};
        if (p.visibility !== 'internal') return null;
        const leaked = (p.appearsIn || []).filter(function (f) { return pub.indexOf(f) !== -1; });
        return leaked.length
          ? { rule: 'no-internal-in-public', detail: 'claim is marked `internal` but appears in public artifact(s): ' + leaked.join(', ') }
          : null;
      },
    };
  }

  /* ---- a claim must actually appear where the manifest says it does ----
     Catches the silent edit: someone changes the page, the manifest still
     attests the old wording, and the audit passes on a claim that is no
     longer on the site. */
  const claimMustAppear = {
    name: 'claim-must-appear',
    evaluate: function (a) {
      if (a.kind !== 'publish_claim') return null;
      const missing = (a.payload && a.payload.missingFrom) || [];
      return missing.length
        ? { rule: 'claim-must-appear', detail: 'manifest says this claim appears in ' + missing.join(', ') + ', but the text is not there — the page or the manifest drifted' }
        : null;
    },
  };

  /* ---- a failed check routes to a human, it does not auto-edit ---- */
  const failedCheckNeedsReview = {
    name: 'failed-check-needs-review',
    evaluate: function (a) {
      if (a.kind !== 'publish_claim') return null;
      const c = a.check || {};
      if (c.checkable === false || c.ok !== false) return null;
      return {
        rule: 'failed-check-needs-review',
        detail: 'verification failed (' + (c.method || 'unknown') + ')' + (c.error ? ': ' + c.error : ''),
        severity: 'review',
      };
    },
  };

  /* ---- a value that moved routes to a human ----
     Separate from a hard failure: the check ran fine, the world simply
     changed. This is the livekit-PR-merges case, and the 66→101 case. */
  const driftedValueNeedsReview = {
    name: 'drifted-value-needs-review',
    evaluate: function (a) {
      if (a.kind !== 'publish_claim') return null;
      const c = a.check || {};
      if (c.ok !== true || c.observed == null || c.expected == null) return null;
      return String(c.observed) !== String(c.expected)
        ? { rule: 'drifted-value-needs-review', detail: 'published value is `' + c.expected + '` but the source now reads `' + c.observed + '`', severity: 'review' }
        : null;
    },
  };

  /* ---- an attestation is a receipt with a date, not a permanent pass ----
     Some real measurements live where a workflow cannot reach them (a private
     repo, an offline filing). `attested` lets those claims stand on a NAMED
     artifact — but without an expiry it would become the loophole that
     launders every unsourced number. An attestation older than the horizon
     routes to a human to re-check. */
  function makeStaleAttestation(maxAgeDays, nowMs) {
    const maxAge = maxAgeDays == null ? 180 : maxAgeDays;
    return {
      name: 'stale-attestation-needs-review',
      evaluate: function (a) {
        if (a.kind !== 'publish_claim') return null;
        const c = a.check || {};
        if (c.method !== 'attested' || !c.asOf) return null;
        const then = Date.parse(c.asOf);
        if (isNaN(then)) return { rule: 'stale-attestation-needs-review', detail: 'attestation date `' + c.asOf + '` is unparseable', severity: 'review' };
        const days = Math.floor(((nowMs == null ? Date.now() : nowMs) - then) / 86400000);
        return days > maxAge
          ? { rule: 'stale-attestation-needs-review', detail: 'attested ' + days + ' days ago (limit ' + maxAge + ') — re-check the source and refresh `asOf`', severity: 'review' }
          : null;
      },
    };
  }

  /* ---- propose, never publish ----
     The auditor may never rewrite a page. Any correction parks at the merge
     gate, exactly as a Keeper lead does. */
  const correctionNeedsHumanMerge = {
    name: 'correction-needs-human-merge',
    evaluate: function (a) {
      return a.kind === 'correct_claim'
        ? { rule: 'correction-needs-human-merge', detail: 'a correction is proposed for review; a human merges to accept', severity: 'review' }
        : null;
    },
  };

  /** Assemble the claim policy; rule order is stable, blocks before reviews. */
  function buildClaimPolicy(config) {
    config = config || {};
    return [
      requireClaimBasis,
      noUnsourcedMetric,
      makeNoInternalInPublic(config.publicArtifacts),
      claimMustAppear,
      failedCheckNeedsReview,
      driftedValueNeedsReview,
      makeStaleAttestation(config.attestationMaxAgeDays, config.nowMs),
      correctionNeedsHumanMerge,
    ];
  }

  /* Autonomy posture, same proof shape as the Keeper's: probe a clean
     correction and confirm it still cannot reach `allow`. The auditor
     cannot publish; supervised:false would mean that invariant was removed. */
  function autonomyPosture(policy) {
    const probe = {
      kind: 'correct_claim',
      payload: { text: 'a clean, fully-sourced correction with no other violation', visibility: 'public', claimKind: 'metric' },
      justification: 'autonomy probe',
      check: { ok: true, checkable: true, method: 'probe' },
    };
    const decision = GOV.evaluatePolicy(probe, policy || []);
    return {
      supervised: decision.decision !== 'allow',
      topTier: 'unoccupied',
      decision: decision.decision,
      detail: 'no correction is auto-applied — every published-record change routes to a human merge',
    };
  }

  const API = {
    VISIBILITIES: VISIBILITIES,
    KINDS: KINDS,
    buildClaimPolicy: buildClaimPolicy,
    autonomyPosture: autonomyPosture,
    // rules exposed for testing / reuse
    requireClaimBasis: requireClaimBasis,
    noUnsourcedMetric: noUnsourcedMetric,
    makeNoInternalInPublic: makeNoInternalInPublic,
    claimMustAppear: claimMustAppear,
    failedCheckNeedsReview: failedCheckNeedsReview,
    driftedValueNeedsReview: driftedValueNeedsReview,
    makeStaleAttestation: makeStaleAttestation,
    correctionNeedsHumanMerge: correctionNeedsHumanMerge,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.CASON_CLAIM_POLICY = API;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : null));
