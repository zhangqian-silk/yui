// macOS assigns TMPDIR behind a system symlink (/var -> /private/var). Yui
// canonicalizes YUI_HOME and managed containers, so fixture paths derived
// from os.tmpdir() would compare unequal against the physical paths the
// product computes. Resolve TMPDIR once here, before any test module runs and
// therefore before the first os.tmpdir() call caches the platform default.
// On Linux /tmp is already physical, so the assignment is an identity no-op.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

try {
  process.env.TMPDIR = realpathSync(tmpdir());
} catch {
  // Keep the platform default when the temporary directory cannot be resolved.
}
