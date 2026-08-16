import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Everything user-scoped lives under here. the desktop service contract (3). */
export const OMNI_HOME = process.env.OMNISCI_HOME ?? join(homedir(), ".omnisci");
export const LOCK_FILE = join(OMNI_HOME, "desktop.lock");
export const ENV_FILE = join(OMNI_HOME, "env");
export const LOG_DIR = join(OMNI_HOME, "logs");

/**
 * Managed runtime (venv, downloaded tectonic) goes in the platform's app data
 * directory, not in OMNI_HOME: it is machine state, not user state, and on macOS
 * it is what Apple expects an app to use.
 */
export function appDataDir(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "OmniScientist");
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "OmniScientist",
      );
    default:
      return join(
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        "omniscientist",
      );
  }
}

export function venvDir(): string {
  return join(appDataDir(), "venv");
}

/** Where a managed python lands once bootstrap has run. */
export function venvPython(): string {
  return platform() === "win32"
    ? join(venvDir(), "Scripts", "python.exe")
    : join(venvDir(), "bin", "python3");
}

/** Where bootstrap drops downloaded tools such as tectonic. */
export function managedBinDir(): string {
  return join(appDataDir(), "bin");
}

export function defaultWorkspace(): string {
  return join(homedir(), "OmniScientist");
}
