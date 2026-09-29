import { fileURLToPath } from "node:url";

/** Native binaries are shipped together; never execute another platform's helper. */
export function nativeExecutable(
  name: "claude-process-owner" | "process-identity",
  platform: string = process.platform,
  architecture: string = process.arch
): string {
  const target = `${platform}-${architecture}`;
  if (!["linux-x64", "darwin-x64", "darwin-arm64"].includes(target)
    || (name === "process-identity" && platform !== "darwin")) {
    throw new Error(`Unsupported native runtime: ${target}/${name}.`);
  }
  return fileURLToPath(new URL(`./native/${target}/${name}`, import.meta.url));
}
