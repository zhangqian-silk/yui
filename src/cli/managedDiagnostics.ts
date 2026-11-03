/** Explicit effect classification, not a verb-name heuristic. Ordinary reads
 * authenticate the caller but do not borrow the target Task's authority.
 * Mixed commands (retry, base status) stay mutating unless this exact form is
 * read-only. Domain parsers still reject unknown flags and malformed targets. */
export function isTaskReadCommand(args: readonly string[]): boolean {
  if (args[0] !== "task") return false;
  if (["list", "search", "show", "usage", "next-action", "remote-delivery", "archive-preflight"].includes(args[1] ?? "")) return true;
  if (args[1] === "context") return true;
  if (["brief", "decision", "milestone", "event", "message", "run", "wake", "input", "work", "publication"].includes(args[1] ?? "")
    && ["list", "show"].includes(args[2] ?? "")) return true;
  if (args[1] === "artifact" && ["list", "read"].includes(args[2] ?? "")) return true;
  if (args[1] === "run" && args[2] === "context") return true;
  if (args[1] === "role" && ["list", "status", "show"].includes(args[2] ?? "")) return true;
  if (args[1] === "role" && args[2] === "session") {
    return args[3] === "inspect"
      || args[3] === "retry" && (args.length === 6 || args.length === 7 && args[6] === "show");
  }
  return false;
}

export function operatorOfflineCommand(args: readonly string[]): boolean {
  return (args[0] === "controller"
      && ["status", "identity", "live-identity", "stop", "restart"].includes(args[1] ?? ""))
    || args[0] === "doctor"
    || (args[0] === "execution" && args[1] === "audit")
    || (args[0] === "operator" && ["status", "list"].includes(args[1] ?? ""))
    || (args[0] === "session" && ["context", "reconcile"].includes(args[1] ?? ""))
    || (args[0] === "role" && args[1] === "message" && ["list", "show"].includes(args[2] ?? ""))
    || (args[0] === "task" && args[1] === "list")
    || isTaskReadCommand(args);
}
