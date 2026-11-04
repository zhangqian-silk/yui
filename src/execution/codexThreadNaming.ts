import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { codexClientInitialization } from "../runtime/codexAppServerRuntime.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 1_000;

export class CodexNamingClient {
  accountHome: string | undefined;
  readonly exited: Promise<void>;
  readonly #pending = new Map<number, Readonly<{
    resolve(value: JsonObject): void;
    reject(error: Error): void;
  }>>();
  readonly #stderr: string[] = [];
  #nextId = 1;
  #closed = false;
  readonly #deadline: NodeJS.Timeout;

  private constructor(readonly child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    this.#deadline = setTimeout(() => {
      this.#failAll(new Error("Native title metadata process deadline exceeded; effect may be unknown."));
      this.close("SIGKILL");
    }, timeoutMs);
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => {
      try {
        if (Buffer.byteLength(line) > 1_048_576) throw new Error("Native title reply exceeds its bound.");
        this.#receive(line);
      } catch (error) {
        this.#failAll(error instanceof Error ? error : new Error(String(error)));
        this.close();
      }
    });
    child.stdout.on("error", error => { this.#failAll(error); this.close(); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      if (this.#stderr.join("").length > 16_384) this.#stderr.shift();
    });
    child.on("error", (error) => { this.#failAll(error); this.close(); });
    child.stdin.on("error", (error) => { this.#failAll(error); this.close(); });
    child.on("exit", (code, signal) => {
      clearTimeout(this.#deadline);
      if (this.#closed) return;
      this.#closed = true;
      const detail = this.#stderr.join("").trim();
      this.#failAll(new Error(
        `Codex App Server exited (${code ?? signal ?? "unknown"})${
          detail.length === 0 ? "" : `: ${detail}`
        }`
      ));
    });
  }

  static async start(
    command: string,
    environment: NodeJS.ProcessEnv,
    baseArgs: readonly string[],
    timeoutMs: number
  ): Promise<CodexNamingClient> {
    const deadlineMs = threadNameTimeout(timeoutMs);
    const client = new CodexNamingClient(spawn(
      command,
      [...baseArgs, "app-server", "--listen", "stdio://"],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] }
    ), deadlineMs);
    try {
      const initialized = await withTimeout(
        client.request("initialize", codexClientInitialization()),
        timeoutMs,
        "Timed out initializing Codex App Server for thread naming."
      );
      client.accountHome = typeof initialized.codexHome === "string" ? initialized.codexHome : undefined;
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      await client.exited;
      throw error;
    }
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server is closed."));
    const id = this.#nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.#write({ method, params });
  }

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#deadline);
    this.child.kill(signal);
    // An owned metadata process must not survive a lost reply or ignored TERM.
    const reap = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 250);
    reap.unref();
    this.child.once("exit", () => clearTimeout(reap));
    this.#failAll(new Error("Codex App Server closed."));
  }

  #write(value: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #receive(line: string): void {
    let message: JsonObject;
    try {
      message = object(JSON.parse(line), "Codex App Server message");
    } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      if (typeof message.method === "string") {
        this.#write({
          id: message.id,
          error: { code: -32601, message: `Unsupported App Server request: ${message.method}` }
        });
      }
      return;
    }
    try {
      if (message.error !== undefined) {
        const error = object(message.error, "Codex App Server error");
        pending.reject(new Error(
          typeof error.message === "string" ? error.message : "Codex App Server request failed."
        ));
      } else {
        pending.resolve(object(message.result, "Codex App Server result"));
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#pending.delete(message.id);
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as JsonObject;
}

function threadNameTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000) {
    throw new Error("Codex thread name timeout is invalid.");
  }
  return Number(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
