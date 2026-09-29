import { join, resolve } from "node:path";

/**
 * Exact same-user directory in which `tmux -L` publishes a named server.
 * TMUX_TMPDIR is tmux's only configurable root; TMPDIR/TMP/TEMP do not apply.
 */
export function tmuxSocketDirectory(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(resolve(nonEmptyTmuxTmpdir(environment) ?? "/tmp"), `tmux-${uid}`);
}

/** Pins an invoked tmux process to the same root selected above. */
export function tmuxSocketEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    TMUX_TMPDIR: nonEmptyTmuxTmpdir(environment),
    ...tmuxLocaleEnvironment(environment)
  };
}

/**
 * tmux 3.6+ substitutes `_` for non-printable bytes (such as the 0x1f field
 * separator in -F output) when it starts in the C/POSIX locale. Guarantee a
 * UTF-8 capable locale for tmux invocations while leaving an explicit UTF-8
 * user locale untouched. macOS always provides the portable "UTF-8" locale;
 * glibc systems provide C.UTF-8.
 */
export function tmuxLocaleEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const effectiveLocale = environment.LC_ALL ?? environment.LC_CTYPE ?? environment.LANG;
  if (typeof effectiveLocale === "string" && /utf-?8/iu.test(effectiveLocale)) {
    return {};
  }
  return {
    // LC_ALL wins over LANG/LC_CTYPE, so it also repairs an explicit C value.
    LC_ALL: process.platform === "darwin" ? "UTF-8" : "C.UTF-8"
  };
}

/** Environment for tmux lifecycle/inspection calls that do not pin a socket root. */
export function tmuxInvocationEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...environment, ...tmuxLocaleEnvironment(environment) };
}

function nonEmptyTmuxTmpdir(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.TMUX_TMPDIR;
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}
