import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { serializeAgentErrorRaw } from "./agentError.js";

export const PROVIDER_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;

/**
 * Newline-delimited JSON over a child process's stdio. This is a plain shared
 * transport: it carries whole JSON objects and never interprets them, so any
 * line-framed Provider protocol can sit on top of it.
 */
export class JsonLineChannel {
  readonly #listeners = new Set<(message: JsonObject) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  #buffer = "";
  #closedError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly mirror: (stream: "stdout" | "stderr", text: string) => void,
    private readonly onFailure?: (error: Error) => void
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    child.once("error", (error) => this.#close(error));
    child.once("close", (code, signal) => this.#close(new Error(
      `Provider process exited (code=${code ?? "none"}, signal=${signal ?? "none"}).`
    )));
  }

  /** The transport's terminal failure, once it has one. */
  get closedError(): Error | undefined {
    return this.#closedError;
  }

  onMessage(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Observe transport closure. A listener registered after the channel already
   * closed is called immediately, so a caller cannot lose the loss of the pipe
   * to a registration race and then wait forever for a reply that cannot come.
   */
  onClose(listener: (error: Error) => void): () => void {
    if (this.#closedError !== undefined) {
      listener(this.#closedError);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async send(message: JsonObject): Promise<void> {
    if (this.#closedError !== undefined) throw this.#closedError;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > PROVIDER_MESSAGE_MAX_BYTES) {
      throw new Error("Provider request exceeds its message bound.");
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error === null || error === undefined) resolvePromise();
        else reject(error);
      });
    });
  }

  #receive(chunk: string): void {
    if (this.#closedError !== undefined) return;
    this.mirror("stdout", chunk);
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > PROVIDER_MESSAGE_MAX_BYTES) {
      this.#fail(new Error("Provider response line exceeds its message bound."));
      terminateProcessGroup(this.child, "SIGTERM");
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        this.#fail(new Error("Provider response is not valid JSON.", { cause }));
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.#fail(new Error("Provider response must be a JSON object."));
        return;
      }
      // Unknown protocol objects belong to the protocol listener. A listener
      // throwing is not an unrelated notification or a parse error.
      try {
        for (const listener of this.#listeners) listener(parsed as JsonObject);
      } catch (cause) {
        this.#fail(new Error("Provider message listener failed.", { cause }));
        return;
      }
    }
  }

  #fail(error: Error): void {
    // Failing this pipe neither proves a native terminal nor permits replay.
    // Keep the original cause for pending callers and the Host's durable sink.
    try {
      this.mirror("stderr", `${serializeAgentErrorRaw(error)}\n`);
      this.onFailure?.(error);
    } finally {
      this.#close(error);
    }
  }

  #close(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    for (const listener of this.#closeListeners) listener(error);
  }
}

export function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (child.pid === undefined) return;
  // Managed Providers are spawned detached and therefore own a process group.
  // Kill that exact group so a CLI helper cannot outlive the Agent Host. The
  // direct-child fallback covers embedded runtimes that cannot create setsid.
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    child.kill(signal);
  }
}
