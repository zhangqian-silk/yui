import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const command = process.argv[2];

if (command === "fingerprint") {
  printFingerprint();
} else if (command === "verify") {
  await verifyNativeDependencies();
} else {
  throw new Error("ci-native-dependencies requires fingerprint or verify");
}

function printFingerprint() {
  const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
  const packagePaths = [
    "node_modules/sqlite-modern",
    "node_modules/sqlite-compat",
    "node_modules/node-pty",
    "node_modules/node-addon-api"
  ];
  const packages = packagePaths.map((path) => {
    const entry = lock.packages?.[path];
    if (typeof entry?.version !== "string" || typeof entry.integrity !== "string") {
      throw new Error(`package-lock.json is missing the locked native input ${path}`);
    }
    return {
      path,
      version: entry.version,
      integrity: entry.integrity
    };
  });
  const input = JSON.stringify({
    imageOs: process.env.ImageOS ?? process.platform,
    architecture: process.arch,
    nodeAbi: process.versions.modules,
    packages
  });
  const digest = createHash("sha256").update(input).digest("hex");

  console.log(`${process.platform}-${process.arch}-abi${process.versions.modules}-${digest}`);
}

async function verifyNativeDependencies() {
  // Resolve from the consumer when verifying a final tarball, never this script.
  const root = resolve(process.env.YUI_INSTALLED_ROOT ?? process.cwd());
  const require = createRequire(join(root, "package.json"));
  const { selectSqliteDriver } = await import(pathToFileURL(join(root, "dist/sqlite/driver.js")).href);
  const selected = selectSqliteDriver();
  const Database = selected.Database;
  const database = new Database(":memory:");

  try {
    const result = database.prepare("SELECT 1 AS value").get();
    if (result?.value !== 1) {
      throw new Error("SQLite native query returned an unexpected result");
    }
  } finally {
    database.close();
  }
  console.log(`SQLite ${selected.name}@${selected.version}; engine ${selected.sqliteVersion}; fallback: ${selected.fallbackReason ?? "none"}`);
  // Installed Doctor below exercises richer PTY diagnostics.
  const result = spawnSync(process.execPath, ["-e", `
    const pty = require(${JSON.stringify(require.resolve("node-pty"))});
    const marker = "yui-native-pty-ok";
    let output = "";
    const terminal = pty.spawn("/bin/echo", [marker], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C" }
    });
    const timer = setTimeout(() => {
      terminal.kill("SIGKILL");
      console.error("PTY output/exit timeout");
      process.exit(1);
    }, 1000);
    terminal.onData(data => { output = (output + data).slice(-4096); });
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || signal || output.replace(/\\r/g, "").trim() !== marker) {
        console.error({ exitCode, signal, output });
        process.exit(1);
      }
      console.log(marker);
      process.exit(0);
    });
  `], {
    cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C" },
    encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 64 * 1024
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== "yui-native-pty-ok") {
    throw new Error(`node-pty actual spawn failed at ${require.resolve("node-pty")}: ${result.error ?? ""} signal=${result.signal} ${result.stderr}`);
  }

  console.log(`Native dependencies verified with actual PTY output and exit: node-pty ${require("node-pty/package.json").version} at ${require.resolve("node-pty")}.`);
}
