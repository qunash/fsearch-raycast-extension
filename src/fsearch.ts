import { execFile } from "node:child_process";
import { access, constants, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface SearchFile {
  path: string;
  kind: string;
  size?: number;
  mtime?: number;
  matches?: { line: number; text: string }[];
}

export interface SearchResult {
  files: SearchFile[];
  tookUs: number;
  complete: boolean;
  indexing: boolean;
}

export interface IndexStatus {
  fullDiskAccess: boolean;
  entries: number;
  contentDocs: number;
  contentPending: number;
}

/**
 * Why a search failed, so the UI can pick copy and recovery actions.
 *
 * - `missing`: the executable is not installed or not executable.
 * - `daemon`: the client could not reach (or start) the index daemon.
 * - `indexing`: the daemon is still building its first index; retry shortly.
 * - `timeout`: the executable did not answer in time.
 * - `query`: fsearch rejected the query (for example `type:bogus`).
 * - `protocol`: the response did not match the expected JSON shape.
 */
export type SearchErrorKind =
  "missing" | "daemon" | "indexing" | "timeout" | "query" | "protocol";

export class SearchError extends Error {
  readonly kind: SearchErrorKind;
  constructor(kind: SearchErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SearchError";
    this.kind = kind;
  }
}

export const DEFAULT_BINARY = "~/.local/bin/fsearch";
/** Where the fsearch daemon keeps its index, socket, and content store. */
export const INDEX_DIR = join(homedir(), "Library/Application Support/FSearch");
/** Home folders macOS gates behind Full Disk Access that people search most. */
export const PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Expands a leading `~` and trims whitespace so preference typos do not break launching. */
export function resolveBinary(binaryPath: string | undefined): string {
  const trimmed = (binaryPath ?? "").trim() || DEFAULT_BINARY;
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
}

function classifyDaemonError(message: string): SearchErrorKind {
  const lower = message.toLowerCase();
  if (lower.startsWith("indexing")) return "indexing";
  if (lower.startsWith("cannot reach daemon")) return "daemon";
  return "query";
}

export function parseResponse(stdout: string): SearchResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (cause) {
    throw new SearchError(
      "protocol",
      "FSearch returned a response that is not JSON. Update fsearch and try again.",
      { cause },
    );
  }
  if (typeof data !== "object" || data === null || !("ok" in data)) {
    throw new SearchError(
      "protocol",
      "Unexpected fsearch response. Update fsearch and try again.",
    );
  }
  if (data.ok !== true) {
    const message =
      "error" in data && typeof data.error === "string" && data.error
        ? data.error
        : "FSearch could not complete the query.";
    throw new SearchError(classifyDaemonError(message), message);
  }
  if (!("took_us" in data) || typeof data.took_us !== "number") {
    throw new SearchError("protocol", "FSearch returned invalid timing data.");
  }
  const files: SearchFile[] = [];
  if ("hits" in data && Array.isArray(data.hits)) {
    for (const hit of data.hits as unknown[]) {
      if (
        typeof hit !== "object" ||
        hit === null ||
        !("path" in hit) ||
        typeof hit.path !== "string" ||
        !isAbsolute(hit.path) ||
        !("kind" in hit) ||
        typeof hit.kind !== "string" ||
        !("size" in hit) ||
        typeof hit.size !== "number"
      ) {
        throw new SearchError(
          "protocol",
          "FSearch returned an invalid file result.",
        );
      }
      const mtime = "mtime" in hit ? hit.mtime : undefined;
      if (
        mtime !== undefined &&
        (typeof mtime !== "number" || !Number.isFinite(mtime))
      ) {
        throw new SearchError(
          "protocol",
          "FSearch returned an invalid modification date.",
        );
      }
      files.push({
        path: hit.path,
        kind: hit.kind,
        size: hit.size,
        ...(mtime !== undefined ? { mtime } : {}),
      });
    }
  } else if ("files" in data && Array.isArray(data.files)) {
    for (const file of data.files as unknown[]) {
      if (
        typeof file !== "object" ||
        file === null ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !isAbsolute(file.path) ||
        !("matches" in file) ||
        !Array.isArray(file.matches)
      ) {
        throw new SearchError(
          "protocol",
          "FSearch returned an invalid content result.",
        );
      }
      const matches: { line: number; text: string }[] = [];
      for (const match of file.matches as unknown[]) {
        if (
          typeof match !== "object" ||
          match === null ||
          !("line" in match) ||
          typeof match.line !== "number" ||
          !("text" in match) ||
          typeof match.text !== "string"
        ) {
          throw new SearchError(
            "protocol",
            "FSearch returned an invalid content match.",
          );
        }
        matches.push({ line: match.line, text: match.text });
      }
      files.push({ path: file.path, kind: "file", matches });
    }
  } else {
    throw new SearchError("protocol", "FSearch returned no result collection.");
  }
  return {
    files,
    tookUs: data.took_us,
    complete: !("complete" in data) || data.complete === true,
    indexing: "indexing" in data && Boolean(data.indexing),
  };
}

export function parseStatus(stdout: string): IndexStatus {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (cause) {
    throw new SearchError(
      "protocol",
      "FSearch returned an unreadable status.",
      { cause },
    );
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !("ok" in data) ||
    data.ok !== true
  ) {
    throw new SearchError("protocol", "FSearch did not report its status.");
  }
  const number = (key: string) =>
    key in data && typeof (data as Record<string, unknown>)[key] === "number"
      ? ((data as Record<string, number>)[key] ?? 0)
      : 0;
  return {
    fullDiskAccess:
      "full_disk_access" in data && data.full_disk_access === true,
    entries: number("entries"),
    contentDocs: number("content_docs"),
    contentPending: number("content_pending"),
  };
}

async function ensureExecutable(binary: string): Promise<void> {
  if (!isAbsolute(binary)) {
    throw new SearchError(
      "missing",
      "Set an absolute FSearch executable path in extension preferences.",
    );
  }
  try {
    await access(binary, constants.X_OK);
  } catch (cause) {
    throw new SearchError(
      "missing",
      `Could not run FSearch at ${binary}. Check that it is installed and executable.`,
      { cause },
    );
  }
}

function run(
  binary: string,
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, output, stderr) => {
        if (!error) {
          resolve(output);
          return;
        }
        if (error.name === "AbortError" || signal.aborted) {
          reject(error);
          return;
        }
        const killedByTimeout =
          "killed" in error && error.killed === true && error.signal;
        if (killedByTimeout) {
          reject(
            new SearchError(
              "timeout",
              "FSearch did not answer in time. It may still be starting or busy indexing.",
              { cause: error },
            ),
          );
          return;
        }
        reject(
          new SearchError(
            "daemon",
            `Could not run FSearch at ${binary}. ${stderr.trim() || error.message}`,
            { cause: error },
          ),
        );
      },
    );
    if (input === undefined) return;
    // stdio sends structured queries, so filenames such as "install" never execute CLI commands.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // An early executable exit can close stdin before the request is written.
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(input);
  });
}

export async function searchFiles(
  binaryPath: string,
  query: string,
  root: string | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult> {
  const binary = resolveBinary(binaryPath);
  await ensureExecutable(binary);
  const request = JSON.stringify({
    q: query,
    limit,
    ...(root ? { in: root } : {}),
  });
  const stdout = await run(binary, ["stdio"], request + "\n", signal);
  return parseResponse(stdout);
}

/** Reads daemon statistics, including whether protected folders are indexed. */
export async function getStatus(
  binaryPath: string,
  signal: AbortSignal,
): Promise<IndexStatus> {
  const binary = resolveBinary(binaryPath);
  await ensureExecutable(binary);
  return parseStatus(await run(binary, ["status"], undefined, signal));
}

/**
 * Protected folders that exist and contain visible files but have nothing in
 * the index. After Full Disk Access is granted, fsearch keeps replaying events
 * on top of the index it built without access, so these folders stay empty
 * until the index is rebuilt.
 */
export async function findUnindexedProtectedFolders(
  binaryPath: string,
  signal: AbortSignal,
): Promise<string[]> {
  const binary = resolveBinary(binaryPath);
  await ensureExecutable(binary);
  const unindexed: string[] = [];
  for (const name of PROTECTED_FOLDERS) {
    const folder = join(homedir(), name);
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      continue; // Missing folder, or Raycast itself lacks access: nothing to report.
    }
    if (!entries.some((entry) => !entry.startsWith("."))) continue;
    const request = JSON.stringify({ q: "", limit: 1, in: folder });
    const result = parseResponse(
      await run(binary, ["stdio"], request + "\n", signal),
    );
    if (result.files.length === 0) unindexed.push(folder);
  }
  return unindexed;
}

function listProcesses(): Promise<{ pid: number; command: string }[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,command="],
      { maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const processes: { pid: number; command: string }[] = [];
        for (const line of stdout.split("\n")) {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (match)
            processes.push({ pid: Number(match[1]), command: match[2] });
        }
        resolve(processes);
      },
    );
  });
}

/**
 * Stops the fsearch daemon and deletes its index so the next search performs a
 * full crawl with the current permissions. The index is a cache that fsearch
 * rebuilds in about 20 seconds; the content index follows a few seconds later.
 */
export async function rebuildIndex(binaryPath: string): Promise<void> {
  const binary = resolveBinary(binaryPath);
  await ensureExecutable(binary);
  // Only the daemon we manage: an exact "<fsearch binary> serve" command line.
  const daemons = (await listProcesses()).filter(
    (process) =>
      process.command === `${binary} serve` ||
      /(^|\/)fsearch serve$/.test(process.command),
  );
  for (const daemon of daemons) {
    try {
      process.kill(daemon.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  // Let the daemon exit before deleting, so it cannot write the old index back.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const alive = daemons.some((daemon) => {
      try {
        process.kill(daemon.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) break;
    await sleep(100);
  }
  for (const daemon of daemons) {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await rm(join(INDEX_DIR, "index.bin"), { force: true });
  await rm(join(INDEX_DIR, "content"), { recursive: true, force: true });
}
