import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { nativeExecutable } from "../../dist/runtime/nativeExecutable.js";

test("native selection is exact and the built helper executes", () => {
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "x64"], ["darwin", "arm64"]]) {
    assert.ok(nativeExecutable("claude-process-owner", platform, arch)
      .endsWith(`/native/${platform}-${arch}/claude-process-owner`));
  }
  assert.throws(() => nativeExecutable("claude-process-owner", "linux", "arm64"), /Unsupported/);
  assert.throws(() => nativeExecutable("process-identity", "linux", "x64"), /Unsupported/);
  assert.equal(execFileSync(nativeExecutable("claude-process-owner"),
    ["/bin/echo", "native-ready"], { encoding: "utf8" }).trim(), "native-ready");
});
