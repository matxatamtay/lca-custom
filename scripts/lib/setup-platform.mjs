import { readFileSync } from "node:fs";
import os from "node:os";

const DEFAULT_TUNNEL_VERSION = process.env.TUNNEL_CLIENT_VERSION || "v0.0.10";
const TUNNEL_RELEASE_BASE = "https://github.com/openai/tunnel-client/releases/download";

export function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || text.endsWith("...") || text.includes("<") || text.includes("your-");
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function normalizeTunnelArch(arch = os.arch()) {
  const value = String(arch).toLowerCase();
  if (["x64", "amd64"].includes(value)) return "amd64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error(`Unsupported CPU architecture for tunnel-client: ${arch}`);
}

export function detectSetupPlatform() {
  const raw = process.platform;
  if (isWsl()) return { id: "wsl", label: "WSL", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "darwin") return { id: "darwin", label: "macOS", tunnelOs: "darwin", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "linux") return { id: "linux", label: "Linux", tunnelOs: "linux", arch: normalizeTunnelArch(), executable: "tunnel-client" };
  if (raw === "win32") return { id: "win32", label: "Windows", tunnelOs: "windows", arch: normalizeTunnelArch(), executable: "tunnel-client.exe" };
  return { id: raw, label: raw, tunnelOs: raw, arch: normalizeTunnelArch(), executable: raw === "win32" ? "tunnel-client.exe" : "tunnel-client" };
}

export function setupPlatformChoices() {
  const arch = normalizeTunnelArch();
  return [
    { id: "darwin", label: "macOS", tunnelOs: "darwin", arch, executable: "tunnel-client" },
    { id: "linux", label: "Linux", tunnelOs: "linux", arch, executable: "tunnel-client" },
    { id: "win32", label: "Windows", tunnelOs: "windows", arch, executable: "tunnel-client.exe" },
    { id: "wsl", label: "WSL", tunnelOs: "linux", arch, executable: "tunnel-client" }
  ];
}

export function platformMatchesHost(selected, host = detectSetupPlatform()) {
  return selected.id === host.id;
}

export function tunnelAssetName(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `tunnel-client-${version}-${tunnelOs}-${normalizeTunnelArch(arch)}.zip`;
}

export function tunnelAssetUrl(version = DEFAULT_TUNNEL_VERSION, tunnelOs = detectSetupPlatform().tunnelOs, arch = normalizeTunnelArch()) {
  return `${TUNNEL_RELEASE_BASE}/${version}/${tunnelAssetName(version, tunnelOs, arch)}`;
}

export function ripgrepInstallCommand(platform = detectSetupPlatform(), availableCommands = []) {
  const has = (name) => availableCommands.includes(name);
  if (platform.id === "darwin") {
    return has("brew") ? { label: "Homebrew", command: "brew", args: ["install", "ripgrep"] } : null;
  }
  if (platform.id === "win32") {
    return has("winget") ? { label: "winget", command: "winget", args: ["install", "--id", "BurntSushi.ripgrep.MSVC", "-e"] } : null;
  }
  if (platform.id === "linux" || platform.id === "wsl") {
    const sudo = typeof process.getuid === "function" && process.getuid() === 0 ? [] : has("sudo") ? ["sudo"] : [];
    if (has("apt-get")) return { label: "apt-get", command: sudo[0] || "apt-get", args: [...sudo.slice(1), ...(sudo[0] ? ["apt-get"] : []), "install", "-y", "ripgrep"] };
    if (has("dnf")) return { label: "dnf", command: sudo[0] || "dnf", args: [...sudo.slice(1), ...(sudo[0] ? ["dnf"] : []), "install", "-y", "ripgrep"] };
    if (has("yum")) return { label: "yum", command: sudo[0] || "yum", args: [...sudo.slice(1), ...(sudo[0] ? ["yum"] : []), "install", "-y", "ripgrep"] };
    if (has("pacman")) return { label: "pacman", command: sudo[0] || "pacman", args: [...sudo.slice(1), ...(sudo[0] ? ["pacman"] : []), "-S", "--noconfirm", "ripgrep"] };
    if (has("zypper")) return { label: "zypper", command: sudo[0] || "zypper", args: [...sudo.slice(1), ...(sudo[0] ? ["zypper"] : []), "--non-interactive", "install", "ripgrep"] };
  }
  return null;
}

