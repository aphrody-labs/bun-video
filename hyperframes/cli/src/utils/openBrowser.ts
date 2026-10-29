import { spawn } from "node:child_process";
import { parsePort } from "./port.js";

export interface OpenBrowserOptions {
  browserPath?: string;
  userDataDir?: string;
  remoteDebuggingPort?: number;
  /**
   * Launch the browser with --disable-gpu. For hosts where hardware
   * acceleration crashes the graphics driver (wild report: auto-opened
   * preview triggered NVIDIA Xid 32 resets on NixOS). Only effective with
   * `browserPath` — the `open`-package fallback launches the system default
   * browser with no way to pass Chromium flags.
   */
  disableGpu?: boolean;
}

export function parseRemoteDebuggingPort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  return parsePort(value, "--remote-debugging-port");
}

export interface RemoteDebuggingPortDeps {
  browserPath?: string;
  userDataDir?: string;
  remoteDebuggingPort?: string;
}

/**
 * Returns an error message if --remote-debugging-port is set without its required
 * dependencies (--browser-path and --user-data-dir), or null if everything is OK.
 */
export function validateRemoteDebuggingPortDeps(deps: RemoteDebuggingPortDeps): string | null {
  if (!deps.remoteDebuggingPort) return null;
  if (!deps.browserPath) return "--remote-debugging-port requires --browser-path";
  if (!deps.userDataDir) return "--remote-debugging-port requires --user-data-dir";
  return null;
}

/**
 * Build the argument list for spawning a browser process.
 *
 * Pure function — easy to unit-test without mocking `spawn` or the default opener.
 */
export function buildBrowserArgs(url: string, options: OpenBrowserOptions): string[] {
  const args: string[] = [];
  if (options.userDataDir) {
    args.push(`--user-data-dir=${options.userDataDir}`);
  }
  // Defense-in-depth: only emit --remote-debugging-port when paired with an
  // isolated --user-data-dir. Without an isolated profile the CDP endpoint
  // would expose the user's main browser session, which is the whole reason
  // the CLI validation layer requires both flags together.
  if (options.remoteDebuggingPort !== undefined && options.userDataDir) {
    args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
  }
  if (options.disableGpu) {
    args.push("--disable-gpu");
  }
  args.push(url);
  return args;
}

/**
 * Open a URL in the browser with the given options.
 *
 * - browserPath: spawn the given binary directly (enables Chromium flags)
 * - userDataDir: passed as --user-data-dir (requires browserPath)
 * - remoteDebuggingPort: passed as --remote-debugging-port (requires browserPath + userDataDir)
 * - otherwise: open the system default browser
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  if (options.browserPath) {
    const args = buildBrowserArgs(url, options);
    const child = spawn(options.browserPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => {});
    child.unref();
    return;
  }

  openDefault(url).catch(() => {});
}

/** The platform command that opens a URL with the system default handler. */
export function defaultOpenCommand(url: string, platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

/** Open a URL with the system default handler; rejects when the handler is absent or fails. */
export async function openDefault(url: string): Promise<void> {
  const command = defaultOpenCommand(url);
  if (!Bun.which(command[0]!)) throw new Error(`${command[0]} is not available`);
  const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
}
