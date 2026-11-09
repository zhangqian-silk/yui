import { fileURLToPath } from "node:url";
import { unsupportedPlatformMessage } from "./platform.js";

/** Native binaries are shipped together; never execute another platform's helper. */
export function nativeExecutable(
  name: "claude-process-owner" | "process-identity",
  platform: string = process.platform,
  architecture: string = process.arch
): string {
  const target = `${platform}-${architecture}`;
  const failure = unsupportedPlatformMessage(platform, architecture);
  if (failure !== undefined) throw new Error(failure);
  if (name === "process-identity" && platform !== "darwin") {
    throw new Error(`Unsupported native runtime: ${target}/${name}.`);
  }
  return fileURLToPath(new URL(`./native/${target}/${name}`, import.meta.url));
}
