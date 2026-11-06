import assert from "node:assert/strict";
import test from "node:test";
import {
  beginProviderTurn, acceptProviderTurn, settleProviderTurn,
  createProviderRuntimeBinding, settleProviderTurnSubmission
} from "../../dist/runtime/providerRuntimeIdentity.js";
import {
  recordProviderFailure, admitProviderRetry, providerRetryProjection,
  cancelProviderRetry, deferProviderRetry, providerRetryAttemptId, providerRetryContext, providerRunRetry,
  providerRetryDecision
} from "../../dist/runtime/providerRetry.js";
import { mapCodexAgentError, mapClaudeAgentError, mapAcpAgentError } from "../../dist/runtime/builtinAgentErrorMappers.js";

const epoch = Date.parse("2026-09-13T00:00:00Z");
const iso = ms => new Date(ms).toISOString();
const failure = {
  source: "provider", phase: "turn-execute", category: "rate-limit",
  code: "provider.rate-limit", message: "Too many requests",
  raw: '{"codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":429}}}',
  inputDisposition: "accepted", sessionDisposition: "recoverable",
  retryable: true
};
function binding() {
  let value = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "test",
    conversationId: "same-session", startedAt: iso(epoch)
  });
  value = beginProviderTurn(value, {
    attemptId: "original", authorityEpoch: 1, submittedAt: iso(epoch),
    input: { kind: "text", text: "Finish the existing work." }, retrySupported: true
  });
  return acceptProviderTurn(value, {
    attemptId: "original", nativeTurnId: "turn-0", acceptedAt: iso(epoch)
  });
}
function fail(value, at, error = failure) {
  value = settleProviderTurn(value, {
    attemptId: value.run.attemptId, nativeTurnId: value.run.nativeTurnId,
    status: "failed", settledAt: iso(at)
  });
  return recordProviderFailure(value, { error, failureRef: value.run.attemptId, at, random: () => 0 });
}

const unknownFailure = { ...failure, category: "unknown", code: "unknown",
  message: "unrecognized failure", raw: "{}", retryable: undefined, sessionDisposition: "unknown" };
function nextFailure(value, error) {
  const due = Date.parse(value.retry.nextEligibleAt);
  const attemptId = providerRetryAttemptId(value.retry);
  value = admitProviderRetry(value, { attemptId, at: due });
  value = beginProviderTurn(value, { attemptId, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true });
  value = acceptProviderTurn(value, { attemptId, nativeTurnId: attemptId, acceptedAt: iso(due) });
  return fail(JSON.parse(JSON.stringify(value)), due + 1, error);
}

test("native stream failures qualify; permanent evidence dominates nested transient errors", () => {
  const message = "stream disconnected before completion: stream closed before response.completed";
  assert.equal(mapCodexAgentError({ message,
    raw: JSON.stringify({ message, codexErrorInfo: "other", additionalDetails: null })
  }).retryable, true);
  for (const codexErrorInfo of ["responseStreamDisconnected", "responseStreamConnectionFailed", "httpConnectionFailed"]) {
    assert.equal(mapCodexAgentError({ message: "failed",
      raw: JSON.stringify({ codexErrorInfo: { [codexErrorInfo]: { httpStatusCode: null } } })
    }).retryable, true);
  }
  for (const mapper of [mapCodexAgentError, mapClaudeAgentError, mapAcpAgentError]) {
    for (const fatal of [
      { message: "context window exceeded" }, { statusCode: 413 }, { code: "invalid_model" },
      { code: "insufficient_quota", statusCode: 429 }, { message: "permission denied" },
      { message: "request cancelled" }, { message: "session revoked" },
      { codexErrorInfo: "contextWindowExceeded" }, { message: "policy violation" }
    ]) {
      const result = mapper({ message: "stream disconnected",
        raw: JSON.stringify({ ...fatal, cause: { statusCode: 503 } }) });
      assert.equal(result.retryable, false, JSON.stringify(fatal));
    }
    assert.equal(mapper({ message: "failed", raw: '{"statusCode":429}' }).retryable, true);
    assert.equal(mapper({ message: "failed", raw: '{"statusCode":503}' }).retryable, true);
    assert.notEqual(mapper({ message: "failed",
      raw: '{"toolOutput":{"statusCode":503},"prompt":"stream disconnected before completion: stream closed before response.completed"}'
    }).retryable, true, "Display prose never establishes positive transient evidence.");
  }
  assert.equal(mapAcpAgentError({ message: "internal failure",
    raw: '{"code":-32603,"cause":{"statusCode":503}}' }).retryable, true);
});

test("unknown fallback spends the same durable budget and can upgrade without resetting it", () => {
  const original = fail(binding(), epoch, unknownFailure);
  assert.equal(original.retry.status, "waiting");
  assert.equal(providerRetryProjection(original).limit, 1);
  const repeated = nextFailure(original, { ...unknownFailure, message: "different unknown wording" });
  assert.equal(repeated.retry.status, "exhausted");
  assert.equal(repeated.retry.attempts, 1);
  assert.throws(() => admitProviderRetry(repeated, { attemptId: "again", at: epoch + 10_000 }));
  let upgraded = nextFailure(original, failure);
  assert.equal(upgraded.retry.chainId, original.retry.chainId);
  assert.equal(upgraded.retry.deadline, original.retry.deadline);
  assert.equal(upgraded.retry.attempts, 1);
  assert.equal(providerRetryProjection(upgraded).limit, 5);
  assert.equal(providerRetryProjection(upgraded).remaining, 4);
  upgraded = nextFailure(upgraded, { ...failure, retryable: false, category: "access" });
  assert.equal(upgraded.retry.status, "cancelled");
  assert.equal(upgraded.retry.attempts, 2);
  assert.equal(nextFailure(fail(binding(), epoch), unknownFailure).retry.status, "exhausted");
});

test("unknown classification cannot replace terminal, delivery, identity or Host safety proof", () => {
  const failed = settleProviderTurn(binding(), {
    attemptId: "original", nativeTurnId: "turn-0", status: "failed", settledAt: iso(epoch)
  });
  for (const [change, error, reason] of [
    [{ retryDisabled: true }, unknownFailure, "retry-disabled"],
    [{}, { ...unknownFailure, inputDisposition: "unknown" }, "input-delivery-unknown"],
    [{ run: { ...failed.run, nativeTurnId: undefined } }, unknownFailure, "exact-failed-turn-unavailable"],
    [{ run: { ...failed.run, retrySupported: false } }, unknownFailure, "session-recovery-unproven"],
    [{ authority: { ...failed.authority, epoch: 2 } }, unknownFailure, "authority-changed"],
    [{ conversations: failed.conversations.map(c => ({ ...c, recoverability: "unrecoverable" })) },
      unknownFailure, "session-unrecoverable"],
    [{}, { ...failure, category: "cancelled" }, "known-non-retryable"],
    [{}, { ...failure, category: "context" }, "known-non-retryable"]
  ]) {
    const result = recordProviderFailure({ ...failed, ...change }, { error, failureRef: "f", at: epoch });
    assert.equal(result.retry, undefined, reason);
    assert.equal(providerRetryDecision(result).reason, reason);
  }
  const waiting = fail(binding(), epoch, unknownFailure);
  const deferred = admitProviderRetry(waiting, { attemptId: "busy", at: Date.parse(waiting.retry.nextEligibleAt) });
  const busy = beginProviderTurn(deferred, {
    attemptId: "busy", authorityEpoch: 1, submittedAt: iso(epoch + 5_000), retrySupported: true
  });
  const retriable = deferProviderRetry(settleProviderTurnSubmission(busy, {
    attemptId: "busy", status: "deferred", resolvedAt: iso(epoch + 5_000), reason: "native busy"
  }), epoch + 5_000);
  assert.equal(retriable.retry.attempts, 0);
  assert.equal(retriable.retry.deadline, waiting.retry.deadline);
  assert.equal(providerRetryProjection(retriable).limit, 1);
});

test("structured Codex capacity is retryable without granting replay from capacity prose", () => {
  const message = "Selected model is at capacity. Please try a different model.";
  const raw = JSON.stringify({ message, codexErrorInfo: "serverOverloaded", additionalDetails: null, misalignment: null });
  const classification = mapCodexAgentError({ message, raw });
  assert.equal(classification.retryable, true);
  assert.equal(classification.sessionDisposition, "recoverable");
  assert.equal(fail(binding(), epoch, { ...failure, ...classification, message, raw }).retry.status, "waiting");
  assert.equal(mapCodexAgentError({ message, raw: message }).retryable, undefined);
  for (const codexErrorInfo of ["usageLimitExceeded", "unauthorized", "badRequest"]) {
    assert.notEqual(mapCodexAgentError({
      message, raw: JSON.stringify({ codexErrorInfo })
    }).retryable, true);
  }
  assert.equal(mapClaudeAgentError({ message: "overloaded_error", raw: '{"type":"overloaded_error"}' }).retryable, true);
  assert.notEqual(mapClaudeAgentError({ message, raw }).retryable, true);
});

test("explicit recovery requires current accepted failure proof, not an automatic classification", () => {
  const failed = fail(binding(), epoch, { ...failure, retryable: false });
  const original = { ...failed, run: { ...failed.run, runId: "run-1" } };
  const retry = providerRunRetry(original, "run-1", epoch + 1);
  assert.equal(retry.failedNativeTurnId, "turn-0");
  assert.equal(retry.error.retryable, false, "Manual intent must not manufacture automatic qualification.");
  assert.equal(retry.successorAutomatic, false);
  assert.equal(providerRunRetry(original, "another-run", epoch + 1), undefined);
  for (const change of [
    { status: "accepted" }, { status: "delivery-unknown" }, { nativeTurnId: undefined },
    { authorityEpoch: 2 }, { input: undefined }, { retrySupported: false },
    { failure: { ...original.run.failure, error: { ...failure, inputDisposition: "unknown" } } },
    { failure: { ...original.run.failure, error: { ...failure, sessionDisposition: "unrecoverable" } } }
  ]) assert.equal(providerRunRetry({ ...original, run: { ...original.run, ...change } }, "run-1", epoch + 1), undefined);
});

test("five consecutive automatic attempts survive new Turns; only exact success resets the chain", () => {
  let value = fail(binding(), epoch);
  for (let n = 1; n <= 5; n++) {
    const due = Date.parse(value.retry.nextEligibleAt);
    value = admitProviderRetry(value, { attemptId: `retry-${n}`, at: due });
    value = beginProviderTurn(value, {
      attemptId: `retry-${n}`, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
    });
    value = acceptProviderTurn(value, {
      attemptId: `retry-${n}`, nativeTurnId: `turn-${n}`, acceptedAt: iso(due)
    });
    assert.equal(value.retry.attempts, n, "acceptance must not reset the failure streak");
    value = fail(value, due + 1, n === 2
      ? { ...failure, category: "availability", code: "provider.temporary-unavailable", message: "Temporary unavailable" }
      : failure);
    assert.equal(value.retry.chainId, "original", "A changed but safely retryable error stays in the same budget.");
    value = JSON.parse(JSON.stringify(value)); // persisted/reloaded state is sufficient
  }
  assert.equal(value.retry.status, "exhausted");
  assert.throws(() => admitProviderRetry(value, { attemptId: "sixth-retry", at: epoch + 600_000 }));

  let recovered = fail(binding(), epoch);
  const due = Date.parse(recovered.retry.nextEligibleAt);
  recovered = admitProviderRetry(recovered, { attemptId: "recovered", at: due });
  recovered = beginProviderTurn(recovered, {
    attemptId: "recovered", authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
  });
  recovered = acceptProviderTurn(recovered, {
    attemptId: "recovered", nativeTurnId: "success", acceptedAt: iso(due)
  });
  recovered = settleProviderTurn(recovered, {
    attemptId: "recovered", nativeTurnId: "success", status: "completed", settledAt: iso(due + 1)
  });
  assert.equal(recovered.retry.status, "recovered");
  assert.equal(providerRetryProjection(recovered).attempts, 1, "Native success retains the audit count.");
  recovered = beginProviderTurn(recovered, {
    attemptId: "new-work", authorityEpoch: 1, submittedAt: iso(due + 2),
    input: { kind: "text", text: "Next work" }, retrySupported: true
  });
  recovered = acceptProviderTurn(recovered, {
    attemptId: "new-work", nativeTurnId: "new-turn", acceptedAt: iso(due + 2)
  });
  recovered = fail(recovered, due + 3);
  assert.equal(recovered.retry.attempts, 0);
  assert.equal(recovered.retryHistory.length, 1);
  for (let n = 1; n <= 5; n++) {
    const due = Date.parse(recovered.retry.nextEligibleAt);
    const attemptId = providerRetryAttemptId(recovered.retry);
    recovered = admitProviderRetry(recovered, { attemptId, at: due });
    recovered = beginProviderTurn(recovered, {
      attemptId, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
    });
    recovered = acceptProviderTurn(recovered, { attemptId, nativeTurnId: `fresh-${n}`, acceptedAt: iso(due) });
    recovered = fail(recovered, due + 1);
    assert.equal(recovered.retry.attempts, n);
  }
  assert.equal(recovered.retry.status, "exhausted");
});

test("terminal proof, Retry-After, deadline and cancellation bound automatic admission", () => {
  const active = binding();
  assert.equal(recordProviderFailure(active, {
    error: failure, failureRef: "internal-retry", at: epoch, random: () => 0
  }), active, "native internal retries must not create another Turn");
  const failed = settleProviderTurn(active, {
    attemptId: "original", nativeTurnId: "turn-0", status: "failed", settledAt: iso(epoch)
  });
  for (const error of [
    { ...failure, inputDisposition: "unknown" },
    { ...failure, sessionDisposition: "unrecoverable" },
    { ...failure, retryable: false, category: "access" }
  ]) assert.equal(recordProviderFailure(failed, { error, failureRef: "f", at: epoch, random: () => 0 }).retry, undefined);
  const waiting = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: 30_000 }, failureRef: "f", at: epoch, random: () => 0
  });
  assert.ok(Date.parse(waiting.retry.nextEligibleAt) > epoch + 30_000);
  assert.throws(() => admitProviderRetry(waiting, { attemptId: "early", at: epoch + 29_999 }));
  const exhausted = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: 600_000 }, failureRef: "f", at: epoch, random: () => 0
  });
  assert.equal(exhausted.retry.status, "exhausted");
  const distant = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: Number.MAX_SAFE_INTEGER }, failureRef: "distant", at: epoch, random: () => 1
  });
  assert.equal(distant.retry.status, "exhausted");
  assert.equal(distant.retry.error.retryAfterMs, Number.MAX_SAFE_INTEGER);
  assert.throws(() => admitProviderRetry(distant, { attemptId: "too-early", at: epoch + 600_000 }));
  const cancelled = cancelProviderRetry(waiting, "user-cancelled", epoch + 1);
  assert.equal(cancelled.retry.status, "cancelled");
  assert.throws(() => admitProviderRetry(cancelled, { attemptId: "late", at: epoch + 60_000 }));
  assert.equal(mapCodexAgentError({ message: "Some text mentions 429", raw: "429" }).retryable, undefined);
  assert.equal(mapCodexAgentError({
    message: "quota", raw: '{"code":"insufficient_quota","statusCode":429}'
  }).retryable, false);
  assert.equal(mapCodexAgentError({
    message: "limited", raw: '{"statusCode":429,"headers":{"Retry-After":"30"}}'
  }).retryAfterMs, 30_000);
  const unknownWait = mapCodexAgentError({
    message: "unknown failure", raw: '{"codexErrorInfo":"other","headers":{"Retry-After":"30"}}'
  });
  assert.equal(unknownWait.retryable, undefined);
  const unknown = recordProviderFailure(failed, {
    error: { ...unknownFailure, ...unknownWait }, failureRef: "unknown-wait", at: epoch, random: () => 0
  });
  assert.ok(Date.parse(unknown.retry.nextEligibleAt) > epoch + 30_000);
  assert.equal(providerRetryProjection(unknown).limit, 1);
});

test("busy admission has a fresh transport identity without spending a model attempt or changing recovery intent", () => {
  let value = fail(binding(), epoch);
  const before = providerRetryContext(value.retry);
  assert.equal(providerRetryContext({ ...value.retry, failedNativeTurnId: undefined }), undefined);
  const firstId = providerRetryAttemptId(value.retry);
  const due = Date.parse(value.retry.nextEligibleAt);
  value = admitProviderRetry(value, { attemptId: firstId, at: due });
  value = beginProviderTurn(value, {
    attemptId: firstId, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
  });
  value = settleProviderTurnSubmission(value, {
    attemptId: firstId, status: "deferred", resolvedAt: iso(due), reason: "native busy"
  });
  value = deferProviderRetry(value, due);
  assert.equal(value.retry.attempts, 0);
  assert.notEqual(providerRetryAttemptId(value.retry), firstId);
  assert.equal(providerRetryContext(value.retry), before);
  const nextId = providerRetryAttemptId(value.retry);
  const nextAt = Date.parse(value.retry.nextEligibleAt);
  value = admitProviderRetry(value, { attemptId: nextId, at: nextAt });
  value = beginProviderTurn(value, {
    attemptId: nextId, runId: "refused-run", authorityEpoch: 1, submittedAt: iso(nextAt), retrySupported: true
  });
  value = settleProviderTurnSubmission(value, {
    attemptId: nextId, status: "rejected", resolvedAt: iso(nextAt), reason: "metadata unavailable before native write"
  });
  value = deferProviderRetry(value, nextAt, "metadata unavailable before native write");
  assert.equal(value.retry.attempts, 0);
  assert.equal(value.retry.previousRunId, "refused-run", "Explicit recovery must retry the latest refused Run.");
  assert.equal(value.retry.successorRunId, undefined);
});
