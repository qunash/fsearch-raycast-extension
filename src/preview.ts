import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ImageSize, imageDimensions } from "./format";

/** Images Raycast renders directly from a file URL. */
export const NATIVE_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
];

/** Word-processing formats that macOS can convert to plain text with textutil. */
export const RICH_TEXT_EXTENSIONS = [
  ".doc",
  ".docx",
  ".rtf",
  ".rtfd",
  ".odt",
  ".wordml",
  ".webarchive",
];

/**
 * Formats with a Quick Look thumbnail generator available on a stock Mac.
 * Anything else is skipped: qlmanage never exits for files it has no
 * generator for, and the extension would rather show nothing than wait.
 */
export const THUMBNAIL_EXTENSIONS = [
  // Documents and presentations
  ".pdf",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".key",
  ".pages",
  ".numbers",
  // Images Raycast cannot render itself
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".bmp",
  ".svg",
  ".psd",
  ".ai",
  ".eps",
  ".icns",
  ".ico",
  ".avif",
  ".jp2",
  ".raw",
  ".cr2",
  ".nef",
  ".dng",
  ".arw",
  // Video (first frame) and audio (artwork when embedded)
  ".mov",
  ".mp4",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".aiff",
  ".aif",
  ".flac",
  ".caf",
  // Fonts
  ".ttf",
  ".otf",
  ".ttc",
  ".woff",
  ".woff2",
];

export const ARCHIVE_EXTENSIONS = [
  ".zip",
  ".jar",
  ".ipa",
  ".apk",
  ".xpi",
  ".tar",
  ".tgz",
  ".tbz",
  ".txz",
  ".gz",
  ".bz2",
  ".xz",
];

/** Formats Quick Look plays back rather than just shows. */
export const PLAYABLE_EXTENSIONS = [
  ".mov",
  ".mp4",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".aiff",
  ".aif",
  ".flac",
  ".caf",
];

const MEDIA_EXTENSIONS = [
  ".mov",
  ".mp4",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".aiff",
  ".aif",
  ".flac",
  ".caf",
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".key",
  ".pages",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".bmp",
  ".psd",
  ".ai",
  ".eps",
];

const TOOL_TIMEOUT_MS = 4000;
const TEXT_LIMIT = 16 * 1024;
const ARCHIVE_LINES = 60;
const THUMBNAIL_PIXELS = 600;

function runTool(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = TOOL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { signal, timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export interface Thumbnail {
  path: string;
  size: ImageSize | undefined;
}

/**
 * Renders a Quick Look thumbnail into `cacheDir` and returns its path. The
 * cache key includes the file's size and mtime so edits invalidate it. Returns
 * undefined when macOS has no generator for the file or gives up within the
 * timeout.
 */
export async function quickLookThumbnail(
  path: string,
  size: number,
  mtimeMs: number,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<Thumbnail | undefined> {
  const key = createHash("sha1")
    .update(`${path}\0${size}\0${mtimeMs}`)
    .digest("hex");
  const cached = join(cacheDir, `${key}.png`);
  // An empty marker remembers files macOS could not render, so reselecting
  // them does not wait for the timeout again.
  const failed = join(cacheDir, `${key}.none`);
  try {
    const header = await readFile(cached);
    return { path: cached, size: imageDimensions(header) };
  } catch {
    // Not cached yet.
  }
  try {
    await access(failed);
    return undefined;
  } catch {
    // Not known to fail.
  }
  const workDir = join(cacheDir, `tmp-${key}-${process.pid}`);
  await mkdir(workDir, { recursive: true });
  try {
    await runTool(
      "/usr/bin/qlmanage",
      ["-t", "-s", String(THUMBNAIL_PIXELS), "-o", workDir, path],
      signal,
    );
    const produced = join(workDir, `${basename(path)}.png`);
    let header: Buffer;
    try {
      header = await readFile(produced);
    } catch {
      await writeFile(failed, "");
      return undefined;
    }
    await rename(produced, cached);
    return { path: cached, size: imageDimensions(header) };
  } catch {
    // A cancelled request says nothing about the file; a timeout does.
    if (!signal?.aborted) await writeFile(failed, "").catch(() => undefined);
    return undefined;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Plain text of a Word, RTF, or OpenDocument file, limited to `TEXT_LIMIT` characters. */
export async function richTextContent(
  path: string,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean } | undefined> {
  try {
    const output = await runTool(
      "/usr/bin/textutil",
      ["-stdout", "-convert", "txt", path],
      signal,
    );
    const text = output
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return undefined;
    return {
      text: text.slice(0, TEXT_LIMIT),
      truncated: text.length > TEXT_LIMIT,
    };
  } catch {
    return undefined;
  }
}

/** Entry listing of a zip or tar archive, limited to `ARCHIVE_LINES` entries. */
export async function archiveListing(
  path: string,
  signal?: AbortSignal,
): Promise<{ entries: string[]; truncated: boolean } | undefined> {
  const extension = extname(path).toLowerCase();
  const zipLike = [".zip", ".jar", ".ipa", ".apk", ".xpi"].includes(extension);
  try {
    const output = zipLike
      ? await runTool("/usr/bin/unzip", ["-Z1", path], signal)
      : await runTool("/usr/bin/tar", ["-tf", path], signal);
    const lines = output
      .split("\n")
      .filter(
        (line) =>
          line &&
          !line.includes("__MACOSX/") &&
          !basename(line).startsWith("._"),
      );
    if (lines.length === 0) return undefined;
    return {
      entries: lines.slice(0, ARCHIVE_LINES),
      truncated: lines.length > ARCHIVE_LINES,
    };
  } catch {
    return undefined;
  }
}

/** Pretty-printed contents of a binary or XML property list. */
export async function plistContent(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const output = await runTool("/usr/bin/plutil", ["-p", path], signal);
    return output.trim() ? output.slice(0, TEXT_LIMIT) : undefined;
  } catch {
    return undefined;
  }
}

export function hasMediaDetails(path: string): boolean {
  return MEDIA_EXTENSIONS.includes(extname(path).toLowerCase());
}

/** Short facts from Spotlight metadata: page count, duration, pixel size, title. */
export async function mediaDetails(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const output = await runTool(
      "/usr/bin/mdls",
      [
        "-name",
        "kMDItemNumberOfPages",
        "-name",
        "kMDItemDurationSeconds",
        "-name",
        "kMDItemPixelWidth",
        "-name",
        "kMDItemPixelHeight",
        "-name",
        "kMDItemTitle",
        path,
      ],
      signal,
    );
    const values = new Map<string, string>();
    for (const line of output.split("\n")) {
      const match = line.match(/^(\w+)\s+=\s+(.*)$/);
      if (match && match[2] !== "(null)") values.set(match[1], match[2]);
    }
    const parts: string[] = [];
    const pages = Number(values.get("kMDItemNumberOfPages"));
    if (pages > 0) parts.push(`${pages} ${pages === 1 ? "page" : "pages"}`);
    const seconds = Number(values.get("kMDItemDurationSeconds"));
    if (seconds > 0) parts.push(formatClock(seconds));
    const width = Number(values.get("kMDItemPixelWidth"));
    const height = Number(values.get("kMDItemPixelHeight"));
    if (width > 0 && height > 0) parts.push(`${width} × ${height}`);
    const title = values.get("kMDItemTitle")?.replace(/^"|"$/g, "").trim();
    if (title && title !== basename(path)) parts.push(title);
    return parts.length ? parts.join(" · ") : undefined;
  } catch {
    return undefined;
  }
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
