/** A transient authorization observation, never an execution credential.
 * Undefined at a discovery boundary means a template still needs target input. */
export type AccessAssessment =
  | Readonly<{ state: "hidden" }>
  | Readonly<{ state: "authorized" }>
  | Readonly<{
      state: "requestable";
      request: Readonly<{
        action: string;
        taskId: string;
        bounds: Readonly<Record<string, readonly string[]>>;
        via: "leader-message" | "leader-input" | "operator";
        explanation: string;
      }>;
    }>;
