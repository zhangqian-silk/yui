/** Check the Node runtime's exact OS/architecture before loading the control plane. */
export function unsupportedPlatformMessage(
  platform: string = process.platform,
  architecture: string = process.arch
): string | undefined {
  const target = `${platform}-${architecture}`;
  if (target === "linux-x64" || target === "darwin-arm64") return undefined;
  return `Unsupported Yui runtime: ${target}. `
    + "Yui supports Linux x64 (glibc) and macOS Apple Silicon with native arm64 Node.js."
    + (target === "darwin-x64"
      ? " macOS Intel is no longer supported; Intel Macs must remain on Yui 2.23.0."
      : "");
}
