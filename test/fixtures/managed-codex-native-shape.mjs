// Request shape observed from Codex CLI 0.159.2 against an isolated synthetic
// App Server. No account, real model, Controller or user workspace is involved.
export const nativeConfiguration = {
  model: "fixture-model", cwd: "/fixture", runtimeWorkspaceRoots: ["/fixture"],
  approvalPolicy: "never", approvalsReviewer: "user", reasoningEffort: "medium",
  collaborationMode: null, serviceTier: null
};

export const nativeTurnStart = {
  threadId: "thread", disabledPluginIds: null, clientUserMessageId: "fixture-message",
  input: [{ type: "text", text: "complete prompt", text_elements: [] }],
  turnTrigger: "user", toolOutput: null, responsesapiClientMetadata: null,
  additionalContext: null, environments: null, cwd: "/fixture",
  runtimeWorkspaceRoots: ["/fixture"], approvalPolicy: "never", approvalsReviewer: "user",
  sandboxPolicy: null, permissions: null, model: "fixture-model", serviceTier: "default",
  serviceTierForTurn: null, effort: "medium", summary: null, personality: null,
  outputSchema: null, collaborationMode: null, multiAgentMode: null, cyberAccessProgram: null
};
