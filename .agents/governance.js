/* ============================================================
   The Living Line — Governance Gate + Trace  (window.CASON_GOVERNANCE)
   ------------------------------------------------------------
   The typed, pre-action policy gate the sibling repo `governed-agents`
   defines — ported here so the family site decides "propose / block /
   route-to-human" with the SAME three-tier model, named rules with
   thresholds, and the SAME NDJSON `TraceEvent` wire format the demo
   emits. One governance contract, two surfaces.

   Faithful to governed-agents `lib/governance.ts` and `lib/trace-events.ts`:
     • Decision      = "allow" | "block" | "needs_approval"   (block > review > allow)
     • evaluatePolicy(action, rules) -> { decision, violations, evaluatedAt }
     • PolicyRule    = { name, evaluate(action) -> violation | null }
     • TraceEvent    = run_started | step_started | step_completed |
                       action_proposed | gate_decision | executed |
                       halted | awaiting_approval | run_completed | error
   governed-agents stays the canonical, typed home of this gate (and its
   live "edit a threshold → the decision flips" demo); this is the
   no-build, dependency-free realization that runs in the Keeper.

   The rules here are the family record's policy, expressed as named
   thresholds rather than inline conditionals — the bloodhound's honesty
   bar made legible and tunable:
     • a record must cite a source                  (require-provenance, block)
     • never echo a quarantined myth                (no-quarantined-myth, block)
     • never re-assert a SUPERSEDED value, from the
       record's own correction ledger                (no-superseded-value, block)
     • never revive a ruled-out ancestor as kin     (no-eliminated-kin, block)
     • never write `confirmed`/`secondary` without a
       primary document scoring >= primaryThreshold  (no-overclaimed-record, block)
     • a split model vote routes to a human         (require-model-consensus, review)
     • every lead parks for the human merge gate    (lead-needs-human-merge, review)

   Runs no-build in the browser (window) and under Node (module.exports).
   ============================================================ */
(function (root) {
  'use strict';

  function now() { return new Date().toISOString(); }
  function severityOf(v) { return v.severity || 'block'; }

  /* ---- the gate (identical semantics to governed-agents evaluatePolicy) ----
     A hard block beats a review request; a review request beats allow. */
  function evaluatePolicy(action, rules) {
    const violations = (rules || [])
      .map(function (r) { return r.evaluate(action); })
      .filter(function (v) { return v !== null && v !== undefined; });
    const hasBlock = violations.some(function (v) { return severityOf(v) === 'block'; });
    const hasReview = violations.some(function (v) { return severityOf(v) === 'review'; });
    const decision = hasBlock ? 'block' : hasReview ? 'needs_approval' : 'allow';
    return { decision: decision, violations: violations, evaluatedAt: now() };
  }

  /* ---- helpers ---- */
  function payloadText(payload) {
    return Object.keys(payload || {})
      .map(function (k) { return payload[k]; })
      .filter(function (v) { return typeof v === 'string'; })
      .join(' \n ');
  }
  function actionText(a) { return [payloadText(a.payload), a.justification].filter(Boolean).join(' \n '); }

  /* ---- the policy rules ---- */
  // a proposed record must rest on at least one source.
  const requireProvenance = {
    name: 'require-provenance',
    evaluate: function (a) {
      if (a.kind !== 'write_record') return null;
      return (a.provenance || []).length === 0
        ? { rule: 'require-provenance', detail: 'a proposed record cites no source' }
        : null;
    },
  };

  // never echo a quarantined myth (the disproven list) as a fact.
  function makeNoQuarantinedMyth(bannedPattern) {
    return {
      name: 'no-quarantined-myth',
      evaluate: function (a) {
        if (!bannedPattern) return null;
        return bannedPattern.test(actionText(a))
          ? { rule: 'no-quarantined-myth', detail: 'content repeats a quarantined (disproven) claim' }
          : null;
      },
    };
  }

  // never revive a person the family ruled out (evidence: 'eliminated') as kin.
  function makeNoEliminatedKin(eliminatedPatterns) {
    return {
      name: 'no-eliminated-kin',
      evaluate: function (a) {
        const text = actionText(a);
        const hit = (eliminatedPatterns || []).filter(function (e) { return e.pattern.test(text); });
        return hit.length
          ? { rule: 'no-eliminated-kin', detail: 'names a ruled-out ancestor as kin — ' + hit.map(function (e) { return e.name; }).join(', ') }
          : null;
      },
    };
  }

  // the honesty bar as a threshold: a record claimed at a PRIMARY-DOCUMENT tier
  // (`confirmed`/`secondary`) needs a source scoring >= primaryThreshold. Model
  // consensus never reaches it, so an AI-sourced confirmed/secondary is blocked.
  // `leading`/`possible` are the legitimate autonomous proposal tiers and pass.
  const OVERCLAIM_TIERS = { confirmed: 1, secondary: 1 };
  function makeNoOverclaimedRecord(primaryThreshold) {
    const thr = primaryThreshold == null ? 1.0 : primaryThreshold;
    return {
      name: 'no-overclaimed-record',
      evaluate: function (a) {
        if (a.kind !== 'write_record') return null;
        const tier = a.payload && a.payload.evidence;
        if (!OVERCLAIM_TIERS[tier]) return null;
        const hasPrimary = (a.provenance || []).some(function (p) { return p.score >= thr; });
        return hasPrimary ? null : {
          rule: 'no-overclaimed-record',
          detail: 'record claimed at `' + tier + '` but no source scores >= ' + thr.toFixed(2) + ' (an LLM is not a primary record)',
        };
      },
    };
  }

  // a split model vote routes to a human rather than acting on disagreement.
  function makeRequireModelConsensus(consensusThreshold) {
    const thr = consensusThreshold == null ? 0.5 : consensusThreshold;
    return {
      name: 'require-model-consensus',
      evaluate: function (a) {
        const c = a.consensus;
        if (!c) return null;
        const participating = (c.votes || []).filter(function (v) { return v.abstained !== true; }).length;
        if (participating < 2) return null;
        return c.agreementRatio < thr
          ? { rule: 'require-model-consensus', detail: Math.round(c.agreementRatio * 100) + '% model agreement is below the ' + Math.round(thr * 100) + '% required', severity: 'review' }
          : null;
      },
    };
  }

  // data-driven quarantine: refuse re-asserting any value the record has SUPERSEDED
  // (from the supersession ledger). Generalizes the hardcoded myth regex and extends
  // it to corrections not in that list (the 1608 baptism, the ~1629 crossing, …).
  function makeNoSupersededValue(values) {
    const list = (values || []).map(function (v) {
      const re = (v.match && typeof v.match.test === 'function') ? v.match : new RegExp(String(v.match || v.label || ''), 'i');
      return { label: v.label, current: v.current, re: re };
    });
    return {
      name: 'no-superseded-value',
      evaluate: function (a) {
        const text = actionText(a);
        const hit = list.filter(function (v) { return v.re.test(text); });
        return hit.length
          ? { rule: 'no-superseded-value', detail: 'asserts a value the record has superseded — ' + hit.map(function (h) { return '“' + h.label + '”' + (h.current ? ' (now: ' + h.current + ')' : ''); }).join('; ') }
          : null;
      },
    };
  }

  // propose, never publish: every lead parks for the human merge gate.
  const leadNeedsHumanMerge = {
    name: 'lead-needs-human-merge',
    evaluate: function (a) {
      return a.kind === 'write_record'
        ? { rule: 'lead-needs-human-merge', detail: 'a lead is proposed for the dossier; a human merges to accept', severity: 'review' }
        : null;
    },
  };

  /** Assemble the Keeper's policy from a config; rule order is stable. */
  function buildKeeperPolicy(config) {
    config = config || {};
    return [
      requireProvenance,
      makeNoQuarantinedMyth(config.bannedPattern),
      makeNoSupersededValue(config.supersededValues),
      makeNoEliminatedKin(config.eliminatedPatterns),
      makeNoOverclaimedRecord(config.primaryThreshold),
      makeRequireModelConsensus(config.consensusThreshold),
      leadNeedsHumanMerge,
    ];
  }

  /* ---- the NDJSON trace (same TraceEvent schema as governed-agents) ---- */
  function newRunId() { return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function Trace(task) {
    const runId = newRunId();
    const events = [];
    function push(e) { e.at = now(); events.push(e); return e; }
    return {
      runId: runId,
      runStarted: function () { return push({ type: 'run_started', runId: runId, task: task }); },
      stepStarted: function (stepId, role) { return push({ type: 'step_started', stepId: stepId, role: role }); },
      stepCompleted: function (stepId, role, summary, provenance) { return push({ type: 'step_completed', stepId: stepId, role: role, summary: summary, provenance: provenance || [] }); },
      actionProposed: function (stepId, action) { return push({ type: 'action_proposed', stepId: stepId, action: action }); },
      gateDecision: function (stepId, decision) { return push({ type: 'gate_decision', stepId: stepId, decision: decision }); },
      executed: function (stepId, result) { return push({ type: 'executed', stepId: stepId, result: result }); },
      awaitingApproval: function (stepId, reason) { return push({ type: 'awaiting_approval', stepId: stepId, reason: reason }); },
      halted: function (stepId, reason) { return push({ type: 'halted', stepId: stepId, reason: reason }); },
      runCompleted: function () { return push({ type: 'run_completed', runId: runId }); },
      error: function (message) { return push({ type: 'error', message: message }); },
      events: function () { return events.slice(); },
      toNdjson: function () { return events.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n'; },
    };
  }

  // Autonomy posture — the pitch made provable. The top tier (a model-originated
  // claim written to the record with no human) is UNOCCUPIED by design:
  // `lead-needs-human-merge` forces every write_record to at least needs_approval,
  // so no policy path auto-writes a new claim. This probes a clean, well-sourced
  // write and confirms it still cannot reach `allow`. supervised:false would mean
  // the invariant was removed.
  function autonomyPosture(policy) {
    const probe = { kind: 'write_record', payload: { personId: '∅probe', evidence: 'possible', text: 'a clean, well-sourced lead with no other violation' }, justification: 'autonomy probe', provenance: [{ sourceId: 'probe', snippet: 'x', score: 1.0 }] };
    const decision = evaluatePolicy(probe, policy || []);
    return { supervised: decision.decision !== 'allow', topTier: 'unoccupied', decision: decision.decision, detail: 'no write_record is auto-allowed — every new claim routes to a human merge' };
  }

  // map a gate decision to the trace's terminal event (mirrors loop.ts step 4).
  function reasonOf(decision, severity) {
    return decision.violations
      .filter(function (v) { return severity ? severityOf(v) === severity : true; })
      .map(function (v) { return v.rule + ': ' + v.detail; })
      .join('; ');
  }

  const API = {
    evaluatePolicy: evaluatePolicy,
    buildKeeperPolicy: buildKeeperPolicy,
    autonomyPosture: autonomyPosture,
    Trace: Trace,
    reasonOf: reasonOf,
    // rules exposed for testing / reuse
    requireProvenance: requireProvenance,
    makeNoQuarantinedMyth: makeNoQuarantinedMyth,
    makeNoSupersededValue: makeNoSupersededValue,
    makeNoEliminatedKin: makeNoEliminatedKin,
    makeNoOverclaimedRecord: makeNoOverclaimedRecord,
    makeRequireModelConsensus: makeRequireModelConsensus,
    leadNeedsHumanMerge: leadNeedsHumanMerge,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.CASON_GOVERNANCE = API;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : null));
