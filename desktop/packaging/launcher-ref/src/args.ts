/** Exit codes are part of the contract. the desktop service contract (3). */
export const EXIT_OK = 0;
export const EXIT_CONFIG = 1;
export const EXIT_PORT_BUSY = 2;
export const EXIT_MISSING_DEPS = 3;

export interface Options {
  /** Requested port, or null for "pick a free ephemeral one". */
  port: number | null;
  /** True when the port came from --port rather than the environment. */
  portIsExplicit: boolean;
  workspace: string | null;
  open: boolean;
  verbose: boolean;
  /** Refuse to start unless python and tectonic are both present. */
  requireDeps: boolean;
}

export class UsageError extends Error {}

const USAGE = `omnisci-desktop - local research workbench service

  --port <n>          listen on this port; fail with exit 2 if it is taken
  --workspace <dir>   workspace root (default: ~/OmniScientist)
  --no-open           do not launch a browser
  --verbose           also write the log to stderr
  --require-deps      exit 3 when python or tectonic are missing
  --version           print the version and exit
  --help              print this and exit

Environment: OMNISCI_GATEWAY_PORT, OMNISCI_WORKSPACE_ROOT
`;

function parsePort(raw: string, source: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`${source} must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv, version: string): Options | string {
  const options: Options = {
    port: null,
    portIsExplicit: false,
    workspace: null,
    open: true,
    verbose: false,
    requireDeps: false,
  };

  const envPort = env.OMNISCI_GATEWAY_PORT?.trim();
  if (envPort) options.port = parsePort(envPort, "OMNISCI_GATEWAY_PORT");
  const envWorkspace = env.OMNISCI_WORKSPACE_ROOT?.trim();
  if (envWorkspace) options.workspace = envWorkspace;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const need = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--port":
        options.port = parsePort(need(), "--port");
        options.portIsExplicit = true;
        break;
      case "--workspace":
        options.workspace = need();
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--open":
        options.open = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--require-deps":
        options.requireDeps = true;
        break;
      case "--version":
        return version;
      case "--help":
      case "-h":
        return USAGE;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}
