import { createRequire } from "node:module";
import type NativeDatabase from "better-sqlite3";

export const SQLITE_CANDIDATES = Object.freeze([
  // N-API avoids node::ObjectWrap's GC cleanup abort on Node 24.19/24.20.
  Object.freeze({ name: "sqlite-modern", version: "13.0.3", minimumNapi: 10 }),
  Object.freeze({ name: "sqlite-compat", version: "10.1.0", minimumNapi: 0 })
]);
type Candidate = typeof SQLITE_CANDIDATES[number];
export type SqliteSelection = Readonly<Candidate & {
  Database: typeof NativeDatabase;
  sqliteVersion: string;
  fallbackReason?: string;
}>;

/** Only errors attributable to loading this native candidate, never database errors. */
function nativeUnavailable(error: unknown, candidate: Candidate): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  const firstLine = error.message.split("\n")[0];
  if (code === "MODULE_NOT_FOUND") {
    if (firstLine === `Cannot find module '${candidate.name}'`) return true;
    // v13 loads its bundled prebuild or these node-gyp paths directly.
    // Do not swallow an unrelated missing transitive JS dependency.
    const missing = /^Cannot find module '([^']+)'$/.exec(firstLine)?.[1];
    return missing !== undefined && ["Debug", "Release"].some((mode) =>
      missing.endsWith(`/node_modules/${candidate.name}/build/${mode}/better_sqlite3.node`));
  }
  const tries = (error as Error & { tries?: unknown }).tries;
  if (error.message.startsWith("Could not locate the bindings file.") && Array.isArray(tries)) {
    return tries.length > 0 && tries.every((path) =>
      typeof path === "string" && path.includes(`/node_modules/${candidate.name}/`)
      && path.endsWith("/better_sqlite3.node"));
  }
  if (code !== "ERR_DLOPEN_FAILED") return false;
  return /NODE_MODULE_VERSION \d+/.test(error.message)
    || /(?:GLIBC|GLIBCXX|CXXABI)_[\d.]+['’] not found/.test(error.message)
    || /(?:cannot open shared object file|Library not loaded:|wrong ELF class:|invalid ELF header|incompatible architecture)/.test(error.message);
}

const require = createRequire(import.meta.url);

function selectionFailure(failures: unknown[]): AggregateError {
  return new AggregateError(failures,
    "No usable SQLite driver. " + SQLITE_CANDIDATES.map((candidate, index) =>
      `${candidate.name}@${candidate.version}: ${
        failures[index] instanceof Error ? failures[index].message : String(failures[index])
      }`).join("; ")
    + ". Reinstall with npm optional dependencies enabled (do not use --omit=optional); "
    + "check Node ABI, system libraries and native build tools. Older systems may require an OS/toolchain upgrade.");
}

/**
 * Selection is isolated from every real database open. No real Home operation
 * is inside a fallback catch, and successful selection stays fixed per process.
 * Loader injection supports deterministic native-failure tests, not user config.
 */
export function createSqliteDriverSelector(
  load: (candidate: Candidate) => typeof NativeDatabase = (candidate) => require(candidate.name),
  napiVersion = Number(process.versions.napi ?? 0)
): () => SqliteSelection {
  let selected: SqliteSelection | undefined;
  return () => {
    if (selected) return selected;
    const failures: Error[] = [];
    for (const candidate of SQLITE_CANDIDATES) {
      // An unsupported Node-API constructor can crash outside JS exception
      // handling. Exclude it before loading native code, not after probing.
      if (napiVersion < candidate.minimumNapi) {
        failures.push(new Error(`${candidate.name} requires Node-API ${candidate.minimumNapi}; runtime provides ${napiVersion}`));
        continue;
      }
      let Driver: typeof NativeDatabase;
      let probe: NativeDatabase.Database;
      try {
        Driver = load(candidate);
        probe = new Driver(":memory:");
      } catch (error) {
        if (!nativeUnavailable(error, candidate)) {
          // Stop on unknown errors, but retain the modern failure when the
          // compatibility candidate also fails. This does not permit retry.
          if (failures.length) throw selectionFailure([...failures, error]);
          throw error;
        }
        failures.push(error as Error);
        continue;
      }
      // SQL and close failures are deliberately outside the native-load catch.
      let sqliteVersion: string;
      try {
        try {
          const result = probe.prepare("SELECT sqlite_version() AS version, 1 AS value").get() as
            { version: string; value: number };
          if (typeof result?.version !== "string" || result.value !== 1) {
            throw new Error(`SQLite probe returned an invalid result for ${candidate.name}.`);
          }
          sqliteVersion = result.version;
        } finally {
          probe.close();
        }
      } catch (error) {
        if (failures.length) throw selectionFailure([...failures, error]);
        throw error;
      }
      selected = Object.freeze({
        ...candidate, Database: Driver, sqliteVersion,
        ...(failures.length ? { fallbackReason: failures[0].message } : {})
      });
      return selected;
    }
    throw selectionFailure(failures);
  };
}

export const selectSqliteDriver = createSqliteDriverSelector();

// Preserve the existing constructor/type contract without loading native code
// during module import. All runtime consumers share the same selector.
const Database = function (
  filename?: string | Buffer,
  options?: NativeDatabase.Options
): NativeDatabase.Database {
  const Driver = selectSqliteDriver().Database;
  return new Driver(filename, options);
} as unknown as typeof NativeDatabase;

namespace Database {
  export type Database = NativeDatabase.Database;
}
export default Database;
