import type { AgentEndpoint } from "./agentEndpoint.js";
import type { AgentEndpointDrain, AgentEndpointLease, createAgentEndpointOwner } from "./agentEndpointOwnership.js";
import { providerDeliveryFailureFrom, serializeAgentErrorRaw } from "./agentError.js";
import type { StructuredProviderDiagnostic } from "./structuredProviderHost.js";

/** Finish the Host's owned cleanup steps even when one fails. Neither a failed
 * inspection nor a timeout is proof that an implementation or client drained. */
export async function closeAgentHostEndpoints(input: Readonly<{
  owner: Pick<ReturnType<typeof createAgentEndpointOwner>, "stop" | "close">;
  session?: Pick<AgentEndpoint, "detach" | "nativeSessionId" | "processInstanceId">;
  lease?: AgentEndpointLease;
  adapterId?: string;
  attemptId?: string;
  nativeTurnId?: string;
  timeoutMs: number;
  report: (diagnostic: StructuredProviderDiagnostic) => Promise<void>;
  closeControl: () => Promise<void>;
}>): Promise<void> {
  const errors: unknown[] = [];
  let lastObservedDrain: AgentEndpointDrain | undefined;
  const report = async (operation: string, error: unknown, drains?: readonly AgentEndpointDrain[]) => {
    const failure = providerDeliveryFailureFrom(error, {
      phase: "host-stop", inputDisposition: "unknown",
      detail: `Endpoint ${operation}: ${error instanceof Error ? error.message : String(error)}. Owned client resources are unknown.`
    });
    const raw = serializeAgentErrorRaw({
      operation, error, adapterId: input.adapterId, implementation: input.lease?.implementation,
      nativeSessionId: input.session?.nativeSessionId, processInstanceId: input.session?.processInstanceId,
      attemptId: input.attemptId, timeoutMs: input.timeoutMs,
      ...(drains === undefined ? { lastObservedDrain } : { drains }),
      unknown: "Current resource quiescence and pending Provider effects; no input is replayed."
    });
    // The Host stream remains evidence even if its Inbox cannot be written.
    process.stderr.write(`${raw}\n`);
    if (input.session === undefined) return;
    try {
      await input.report({
        nativeSessionId: input.session.nativeSessionId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.nativeTurnId === undefined ? {} : { nativeTurnId: input.nativeTurnId }),
        failure: { ...failure, raw }
      });
    } catch (error) {
      errors.push(error);
      process.stderr.write(`Endpoint cleanup diagnostic delivery failed: ${serializeAgentErrorRaw(error)}\n`);
    }
  };
  try {
    try { input.session?.detach(); }
    catch (error) { errors.push(error); await report("detach failed", error); }
    try { await input.lease?.release(); }
    catch (error) { errors.push(error); await report("lease release failed", error); }
    if (input.adapterId !== undefined) {
      try {
        lastObservedDrain = await input.owner.stop(input.adapterId, input.timeoutMs);
        if (!lastObservedDrain.quiescent) {
          await report("stop incomplete", new Error("The bounded stop did not prove quiescence."), [lastObservedDrain]);
        }
      } catch (error) { errors.push(error); await report("stop failed", error); }
    }
    try {
      const remaining = await input.owner.close(input.timeoutMs);
      const held = remaining.filter(drain => !drain.quiescent);
      if (held.length > 0) await report("close incomplete", new Error("Endpoint references remain held."), held);
    } catch (error) { errors.push(error); await report("close failed", error); }
  } finally {
    try { await input.closeControl(); }
    catch (error) { errors.push(error); await report("control close failed", error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Agent Host cleanup failed; resource effects remain unknown.");
}
