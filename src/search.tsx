import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Detail,
  environment,
  getPreferenceValues,
  Icon,
  List,
  LaunchProps,
  LocalStorage,
  open,
  openExtensionPreferences,
  showToast,
  Toast,
  trash,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, open as openFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  codeBlock,
  decodeTextSample,
  describeKind,
  displayPath,
  fitPreviewSize,
  ImageSize,
  formatSize,
  imageDimensions,
  isProtectedPath,
  languageFor,
  normalizeQuery,
} from "./format";
import {
  ARCHIVE_EXTENSIONS,
  archiveListing,
  hasMediaDetails,
  mediaDetails,
  NATIVE_IMAGE_EXTENSIONS,
  plistContent,
  quickLookThumbnail,
  RICH_TEXT_EXTENSIONS,
  richTextContent,
  THUMBNAIL_EXTENSIONS,
} from "./preview";
import {
  DEFAULT_BINARY,
  findUnindexedProtectedFolders,
  getStatus,
  IndexStatus,
  rebuildIndex,
  SearchError,
  searchFiles,
  SearchFile,
  SearchResult,
} from "./fsearch";

const MAX_LIMIT = 500;
const LOAD_MORE_STEP = 100;
const PREVIEW_BYTES = 32 * 1024;
const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;
// Enough header to reach the JPEG frame marker even behind a large EXIF block.
const IMAGE_HEADER_BYTES = 256 * 1024;
// The detail pane is roughly half of Raycast's window and ~365pt tall at the
// default size. Image plus two metadata rows (Where, and a tag row with kind,
// size, and date) fill the pane so the metadata sits at the bottom, without
// scrolling. Raycast scales wider images down.
const PREVIEW_MAX_WIDTH = 400;
const PREVIEW_MAX_HEIGHT = 300;
const SAVED_SEARCHES_KEY = "saved-searches";
const FULL_DISK_ACCESS_SETTINGS =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const INSTALL_COMMAND =
  "git clone https://github.com/noahdunnagan/fsearch.git && cd fsearch && cargo build --release && ./target/release/fsearch install";

const fileTypes = [
  { title: "Everything", value: "", icon: Icon.MagnifyingGlass },
  { title: "Documents", value: "type:doc", icon: Icon.Document },
  { title: "Images", value: "type:image", icon: Icon.Image },
  { title: "Folders", value: "kind:dir", icon: Icon.Folder },
  { title: "Code", value: "type:code", icon: Icon.Code },
  { title: "Applications", value: "type:app", icon: Icon.AppWindow },
  { title: "Audio", value: "type:audio", icon: Icon.Music },
  { title: "Video", value: "type:video", icon: Icon.Video },
  { title: "Archives", value: "type:archive", icon: Icon.Box },
];
const starters = [
  {
    title: "Recently Changed",
    query: "kind:file mtime:<7d",
    sort: "modified",
    icon: Icon.Clock,
  },
  {
    title: "PDF Documents",
    query: "ext:pdf",
    sort: "relevance",
    icon: Icon.Document,
  },
  {
    title: "Large Files",
    query: "kind:file size:>100mb",
    sort: "size",
    icon: Icon.HardDrive,
  },
  {
    title: "Screenshots",
    query: "screenshot type:image",
    sort: "modified",
    icon: Icon.Camera,
  },
];
const locations = [
  { title: "Entire Mac", path: "", icon: Icon.Desktop },
  { title: "Home", path: homedir(), icon: Icon.House },
  ...["Downloads", "Desktop", "Documents"].map((title) => ({
    title,
    path: join(homedir(), title),
    icon: Icon.Folder,
  })),
];
const sorts = [
  { title: "Best Match", value: "relevance" },
  { title: "Name A–Z", value: "name" },
  { title: "Recently Modified", value: "modified" },
  { title: "Largest First", value: "size" },
];
const THUMBNAIL_CACHE = join(environment.supportPath, "thumbnails");

interface SavedSearch {
  query: string;
  filter: string;
  scope: string;
}

interface Preferences {
  binaryPath: string;
  searchRoot?: string;
  resultLimit: string;
  showDetails: boolean;
}

interface FilePreview {
  path: string;
  markdown: string;
  /** Page count, duration, pixel size, or title from Spotlight metadata. */
  details?: string;
  size?: number;
  modified?: Date;
}

const guide = `# Find anything. Stay in flow.

FSearch brings fuzzy, whole-disk file search to Raycast. Type a filename, narrow it with a filter, or search inside text files.

## Install once

Requires macOS and Rust / Cargo. Run in Terminal:

\`\`\`sh
git clone https://github.com/noahdunnagan/fsearch.git
cd fsearch
cargo build --release
./target/release/fsearch install
\`\`\`

The extension uses \`~/.local/bin/fsearch\`. Set a different executable or a default search folder in extension preferences. The daemon starts automatically on your first search; the initial index can take around 20 seconds. The command retries automatically while the index is being built.

## Search from Raycast’s main search

Add **Search Files — FSearch** in Raycast’s **Manage Fallback Commands** (or Settings → Launcher → Fallback Commands). Then type in Raycast’s main search and choose FSearch under **Use with**. Your text carries into the file search automatically.

Raycast controls this list; extensions cannot add themselves on installation. You can also enter a query as the command’s optional argument.

## Make it yours

Save your current query, file type, and folder with **⌘ ⇧ S**. Saved searches appear on the home screen. Use **⌘ ⇧ H** to return there.

Use **⌘ ⇧ F** to change the search folder, or **⌘ F** on a result to search its folder. **⌘ ⇧ O** sorts the loaded results. The preview pane shows images, text and code, the text of Word and RTF documents, archive listings, and Quick Look thumbnails of PDFs, spreadsheets, presentations, videos, fonts, and other formats. Toggle it with **⌘ D**. Content matches show their line numbers automatically. **⌘ Y** opens the full Quick Look preview. Select **Show More**, or use **⌘ ⇧ M**, to expand the result limit, up to 500 files.

## A few useful searches

| Find | Query |
| --- | --- |
| A filename, even with typos | \`quarterly report\` |
| PDFs | \`ext:pdf invoice\` |
| Recent images | \`type:image mtime:<7d\` |
| Large files | \`size:>100mb\` |
| In a folder | \`readme in:~/Developer\` |
| Text inside files | \`ext:ts grep:useEffect\` |
| Symbol definitions | \`sym:apply_dir\` |

Use \`'exact\`, \`^prefix\`, \`suffix$\`, and \`!exclude\` for more control. Content search is smart-case. The filter menu adds a file-type filter to your query.

## Search protected folders

macOS hides Desktop, Documents, Downloads, and parts of Library from fsearch until it has Full Disk Access. Grant it to Raycast (the daemon it starts inherits the permission) or, for a login daemon installed with \`~/.local/bin/fsearch install --login\`, to that executable, in System Settings → Privacy & Security. Regrant after rebuilding it.

fsearch keeps the index it built before access was granted and only replays later file changes, so those folders stay empty until you **Rebuild Index** (**⌘ ⇧ R**). The home screen points this out and offers the rebuild; a fresh crawl takes about 20 seconds.

## At your fingertips

**Return** opens a file · **⌘ Return** reveals it in Finder · **⌘ Y** previews it · **⌘ ⇧ C** copies its path · **⌃ X** moves it to the Trash after confirmation.

Searches stay on your Mac. The extension talks only to your local fsearch process.
`;

function sameSearch(a: SavedSearch, b: SavedSearch) {
  return a.query === b.query && a.filter === b.filter && a.scope === b.scope;
}

function toSearchError(cause: unknown): SearchError {
  if (cause instanceof SearchError) return cause;
  return new SearchError(
    "protocol",
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
}

function parseSavedSearches(stored: string | undefined): SavedSearch[] {
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "query" in item &&
        typeof item.query === "string" &&
        "filter" in item &&
        typeof item.filter === "string" &&
        "scope" in item &&
        typeof item.scope === "string",
    )
  ) {
    throw new Error("Saved searches could not be read.");
  }
  return parsed as SavedSearch[];
}

/** Orders results client-side; content matches lack size and date, so those sorts fall back. */
function sortFiles(files: SearchFile[], sort: string) {
  const list = [...files];
  const contentResults = list.some((file) => Boolean(file.matches));
  const effectiveSort =
    contentResults && ["modified", "size"].includes(sort) ? "relevance" : sort;
  if (effectiveSort === "name") {
    list.sort((a, b) =>
      basename(a.path).localeCompare(basename(b.path), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  } else if (effectiveSort === "modified") {
    list.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  } else if (effectiveSort === "size") {
    list.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  }
  return { list, contentResults, effectiveSort };
}

/** Reads at most `limit` bytes from the start of a file. */
async function readHead(path: string, limit: number): Promise<Uint8Array> {
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function fileUrl(path: string): string {
  return pathToFileURL(path).href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function imageMarkdown(url: string, size: ImageSize | undefined): string {
  // Size the image from its header so wide and tall pictures both fit the pane.
  const fit = fitPreviewSize(size, PREVIEW_MAX_WIDTH, PREVIEW_MAX_HEIGHT);
  return `![File preview](${url}?raycast-width=${fit.width}&raycast-height=${fit.height})`;
}

function quickLookHint(path: string, kind: string): string {
  return `*No inline preview for this ${describeKind(path, kind).toLowerCase()}.* Press **⌘ Y** for Quick Look.`;
}

/** A short, specific explanation of why a file could not be read. */
function previewErrorMarkdown(path: string, cause: unknown): string {
  const code =
    typeof cause === "object" && cause && "code" in cause
      ? String(cause.code)
      : "";
  const inCloud = path.includes("/Library/CloudStorage/");
  const reason = (() => {
    switch (code) {
      case "ETIMEDOUT":
      case "EAGAIN":
        return inCloud
          ? "This file lives in cloud storage and isn't downloaded. Open it to download a copy."
          : "Reading the file timed out.";
      case "ENOENT":
        return "The file has been moved or deleted since it was indexed.";
      case "EACCES":
      case "EPERM":
        return "macOS denied access. Grant Full Disk Access to Raycast to preview it.";
      case "EISDIR":
        return "This is a folder.";
      default:
        return inCloud
          ? "This file lives in cloud storage and may not be downloaded."
          : (cause instanceof Error ? cause.message : String(cause)).replace(
              /^Error: /,
              "",
            );
    }
  })();
  return `### Can't preview this file\n\n${reason}\n\nPress **Return** to open it or **⌘ Y** for Quick Look.`;
}

async function buildPreview(
  path: string,
  hasMatches: boolean,
  signal: AbortSignal,
): Promise<FilePreview> {
  const info = await stat(path);
  const base = {
    path,
    size: info.size,
    modified: info.mtime,
  };
  if (info.isDirectory()) {
    const extension = extname(path).toLowerCase();
    if (extension === ".app") {
      return {
        ...base,
        markdown:
          "## Application\n\nPress **Return** to launch, or **⌘ Return** to reveal in Finder.",
      };
    }
    // iWork documents and other bundles are folders with a thumbnail generator.
    if (THUMBNAIL_EXTENSIONS.includes(extension)) {
      const thumbnail = await quickLookThumbnail(
        path,
        info.size,
        info.mtimeMs,
        THUMBNAIL_CACHE,
        signal,
      );
      if (thumbnail) {
        return {
          ...base,
          markdown: imageMarkdown(fileUrl(thumbnail.path), thumbnail.size),
          details: await mediaDetails(path, signal),
        };
      }
    }
    return {
      ...base,
      markdown:
        "## Folder\n\nPress **⌘ F** to search inside, or **Return** to open in Finder.",
    };
  }
  if (!info.isFile() || hasMatches) {
    return { ...base, markdown: quickLookHint(path, "file") };
  }
  const extension = extname(path).toLowerCase();
  const details = hasMediaDetails(path)
    ? mediaDetails(path, signal)
    : Promise.resolve(undefined);
  if (NATIVE_IMAGE_EXTENSIONS.includes(extension)) {
    if (info.size > PREVIEW_IMAGE_BYTES) {
      return {
        ...base,
        markdown: `*This image is ${formatSize(info.size)}.* Press **⌘ Y** for Quick Look.`,
      };
    }
    const header = await readHead(path, IMAGE_HEADER_BYTES);
    return {
      ...base,
      markdown: imageMarkdown(fileUrl(path), imageDimensions(header)),
    };
  }
  if (RICH_TEXT_EXTENSIONS.includes(extension)) {
    const content = await richTextContent(path, signal);
    if (content) {
      let markdown = codeBlock(content.text);
      if (content.truncated) {
        markdown += "\n\n*Preview shows the beginning of the document.*";
      }
      return { ...base, markdown, details: await details };
    }
  }
  if (ARCHIVE_EXTENSIONS.includes(extension)) {
    const listing = await archiveListing(path, signal);
    if (listing) {
      let markdown = codeBlock(listing.entries.join("\n"));
      if (listing.truncated) {
        markdown += `\n\n*Showing the first ${listing.entries.length} entries.*`;
      }
      return { ...base, markdown };
    }
  }
  if (extension === ".plist") {
    const content = await plistContent(path, signal);
    if (content) return { ...base, markdown: codeBlock(content) };
  }
  if (
    THUMBNAIL_EXTENSIONS.includes(extension) ||
    RICH_TEXT_EXTENSIONS.includes(extension)
  ) {
    const thumbnail = await quickLookThumbnail(
      path,
      info.size,
      info.mtimeMs,
      THUMBNAIL_CACHE,
      signal,
    );
    if (thumbnail) {
      return {
        ...base,
        markdown: imageMarkdown(fileUrl(thumbnail.path), thumbnail.size),
        details: await details,
      };
    }
    return {
      ...base,
      markdown: quickLookHint(path, "file"),
      details: await details,
    };
  }
  // Bound reads to 32 KiB: large files must not block selection or flood the detail pane.
  const sample = await readHead(path, PREVIEW_BYTES);
  if (sample.length === 0) {
    return { ...base, markdown: "*This file is empty.*" };
  }
  const truncated = info.size > sample.length;
  const text = decodeTextSample(sample, truncated);
  if (text === undefined) {
    // Unknown binary formats and non-UTF-8 text use Quick Look instead.
    return { ...base, markdown: quickLookHint(path, "file") };
  }
  let markdown = codeBlock(text, languageFor(path));
  if (truncated) {
    markdown +=
      "\n\n*Preview shows the first 32 KiB. Open the file to read more.*";
  }
  return { ...base, markdown };
}

export default function Search(
  props: LaunchProps<{ arguments: { query?: string } }>,
) {
  const preferences = getPreferenceValues<Preferences>();
  const binaryPath = preferences.binaryPath?.trim() || DEFAULT_BINARY;
  const defaultLimit = Number(preferences.resultLimit) || 50;
  const defaultScope = preferences.searchRoot?.trim() || "";

  const [query, setQuery] = useState(
    props.fallbackText ?? props.arguments.query ?? "",
  );
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState(defaultScope);
  const [sort, setSort] = useState("relevance");
  const [limit, setLimit] = useState(defaultLimit);
  const [result, setResult] = useState<SearchResult>();
  const [error, setError] = useState<SearchError>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);
  const [showDetails, setShowDetails] = useState(
    preferences.showDetails ?? true,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [savedReady, setSavedReady] = useState(false);
  const [status, setStatus] = useState<IndexStatus>();
  const [unindexed, setUnindexed] = useState<string[]>([]);
  const [indexGeneration, setIndexGeneration] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  // Raycast keeps the old row index when items change and reports it back after
  // our selection update; while this is set, that stale report is bounced to the top.
  const pendingSelection = useRef<{ path: string; until: number } | null>(null);
  const sortRef = useRef("relevance");
  const lastSearchKey = useRef<string | undefined>(undefined);
  const lastErrorKind = useRef<SearchError["kind"] | undefined>(undefined);

  // The configured default folder alone keeps the home screen; an explicit choice starts a search.
  const active = Boolean(
    query.trim() || filter || (scope && scope !== defaultScope),
  );
  const currentSearch: SavedSearch = { query: query.trim(), filter, scope };
  const searchKey = `${currentSearch.query}\u0000${filter}\u0000${scope}`;
  const isSaved = saved.some((item) => sameSearch(item, currentSearch));
  const fullDiskAccessMissing = status?.fullDiskAccess === false;
  // Access was granted after the index was built: those folders stay empty until a rebuild.
  const needsRebuild = status?.fullDiskAccess === true && unindexed.length > 0;
  const unindexedNames = unindexed.map((folder) => basename(folder));

  const startSearch = useCallback(
    (next: Partial<SavedSearch> & { sort?: string }) => {
      if (next.query !== undefined) setQuery(next.query);
      if (next.filter !== undefined) setFilter(next.filter);
      if (next.scope !== undefined) setScope(next.scope);
      if (next.sort !== undefined) setSort(next.sort);
      setLimit(defaultLimit);
      setAutoRetries(0);
    },
    [defaultLimit],
  );

  const persistSaved = useCallback(
    async (next: SavedSearch[], successTitle: string, message?: string) => {
      try {
        await LocalStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(next));
        setSaved(next);
        await showToast({
          style: Toast.Style.Success,
          title: successTitle,
          message,
        });
      } catch (cause) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Could Not Save Changes",
          message: String(cause),
        });
      }
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    (async () => {
      let parsed: SavedSearch[] = [];
      try {
        parsed = parseSavedSearches(
          await LocalStorage.getItem<string>(SAVED_SEARCHES_KEY),
        );
      } catch (cause) {
        // Corrupt storage should not lock the user out of saving; start fresh instead.
        console.warn("Resetting saved searches:", cause);
        await LocalStorage.removeItem(SAVED_SEARCHES_KEY).catch(() => {});
        if (!disposed) {
          await showToast({
            style: Toast.Style.Failure,
            title: "Saved Searches Were Reset",
            message: "The stored list could not be read.",
          });
        }
      }
      if (!disposed) {
        setSaved(parsed);
        setSavedReady(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const value = await getStatus(binaryPath, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(value);
        const folders = value.fullDiskAccess
          ? await findUnindexedProtectedFolders(binaryPath, controller.signal)
          : [];
        if (!controller.signal.aborted) setUnindexed(folders);
      } catch {
        // Missing executables are reported by the search itself; status is optional context.
        if (!controller.signal.aborted) {
          setStatus(undefined);
          setUnindexed([]);
        }
      }
    })();
    return () => controller.abort();
  }, [binaryPath, retry, indexGeneration]);

  useEffect(() => {
    const controller = new AbortController();
    if (!active) {
      setResult(undefined);
      setError(undefined);
      setLoading(false);
      return () => controller.abort();
    }
    // Keep the previous error visible while retrying so the empty state does not flicker.
    setLoading(true);
    // Wait for a pause in typing; each obsolete request is aborted before it can update the list.
    const timer = setTimeout(async () => {
      try {
        const response = await searchFiles(
          binaryPath,
          [normalizeQuery(query), filter].filter(Boolean).join(" "),
          scope || undefined,
          limit,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResult(response);
          setError(undefined);
          setAutoRetries(0);
          if (lastSearchKey.current !== searchKey) {
            lastSearchKey.current = searchKey;
            // Select the first row in the same render as the new items, so Raycast
            // never has a chance to keep the previous row index.
            const first =
              sortFiles(response.files, sortRef.current).list[0]?.path ?? null;
            setSelectedPath(first);
            pendingSelection.current = first
              ? { path: first, until: Date.now() + 800 }
              : null;
          }
          // The index just finished building: re-check status and protected folders.
          if (lastErrorKind.current === "indexing") {
            setIndexGeneration((value) => value + 1);
          }
          lastErrorKind.current = undefined;
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          const searchError = toSearchError(cause);
          lastErrorKind.current = searchError.kind;
          setResult(undefined);
          setError(searchError);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, filter, scope, limit, retry, active, binaryPath, searchKey]);

  useEffect(() => {
    if (!error) return;
    // The first launch needs the daemon to finish its crawl; a cold daemon needs a moment to start.
    const retryable =
      error.kind === "indexing" ||
      ((error.kind === "daemon" || error.kind === "timeout") &&
        autoRetries < 3);
    if (!retryable) return;
    const timer = setTimeout(
      () => {
        setAutoRetries((value) => value + 1);
        setRetry((value) => value + 1);
      },
      error.kind === "indexing" ? 2500 : 1500,
    );
    return () => clearTimeout(timer);
  }, [error, autoRetries]);

  sortRef.current = sort;
  const files = useMemo(
    () => sortFiles(result?.files ?? [], sort),
    [result, sort],
  );
  const { list: sortedFiles, contentResults, effectiveSort } = files;

  const selectedFile =
    sortedFiles.find((file) => file.path === selectedPath) ?? sortedFiles[0];
  const previewPath = active && showDetails ? selectedFile?.path : undefined;
  const hasMatches = Boolean(selectedFile?.matches);
  const canLoadMore =
    active &&
    result !== undefined &&
    !loading &&
    sortedFiles.length >= limit &&
    limit < MAX_LIMIT;
  const nextLimit = Math.min(limit + LOAD_MORE_STEP, MAX_LIMIT);

  useEffect(() => {
    let disposed = false;
    setFilePreview(undefined);
    if (!previewPath) {
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    const controller = new AbortController();
    // Only inspect the selected result, after keyboard navigation settles.
    const timer = setTimeout(async () => {
      try {
        await mkdir(THUMBNAIL_CACHE, { recursive: true });
        const preview = await buildPreview(
          previewPath,
          hasMatches,
          controller.signal,
        );
        if (!disposed) setFilePreview(preview);
      } catch (cause) {
        if (!disposed) {
          setFilePreview({
            path: previewPath,
            markdown: previewErrorMarkdown(previewPath, cause),
          });
        }
      } finally {
        if (!disposed) setPreviewLoading(false);
      }
    }, 120);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewPath, hasMatches, retry]);

  const loadMore = () => {
    setLimit((value) => Math.min(value + LOAD_MORE_STEP, MAX_LIMIT));
  };

  const goHome = () => {
    startSearch({
      query: "",
      filter: "",
      scope: defaultScope,
      sort: "relevance",
    });
    setSelectedPath(null);
  };

  const toggleSaved = async () => {
    const next = isSaved
      ? saved.filter((item) => !sameSearch(item, currentSearch))
      : [currentSearch, ...saved];
    await persistSaved(
      next,
      isSaved ? "Search Removed" : "Search Saved",
      isSaved ? undefined : "Find your saved searches on the home screen.",
    );
  };

  const moveToTrash = async (file: SearchFile) => {
    const name = basename(file.path);
    const confirmed = await confirmAlert({
      title: `Move “${name}” to the Trash?`,
      message:
        file.kind === "dir"
          ? "The folder and everything inside it will be moved to the Trash."
          : "You can restore it from the Trash later.",
      icon: Icon.Trash,
      primaryAction: {
        title: "Move to Trash",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;
    try {
      await trash(file.path);
      await showToast({
        style: Toast.Style.Success,
        title: "Moved to Trash",
        message: name,
      });
      setRetry((value) => value + 1);
    } catch (cause) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could Not Move to Trash",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const fullDiskAccessAction = (
    <Action
      title="Open Full Disk Access Settings"
      icon={Icon.LockUnlocked}
      onAction={() => open(FULL_DISK_ACCESS_SETTINGS)}
    />
  );

  const rebuild = async () => {
    const confirmed = await confirmAlert({
      title: "Rebuild the FSearch index?",
      message:
        "The daemon restarts and scans your Mac again with its current permissions. Searching resumes automatically in about 20 seconds.",
      icon: Icon.ArrowClockwise,
      primaryAction: { title: "Rebuild Index" },
    });
    if (!confirmed) return;
    setRebuilding(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Rebuilding Index…",
    });
    try {
      await rebuildIndex(binaryPath);
      toast.style = Toast.Style.Success;
      toast.title = "Index Rebuild Started";
      toast.message = "Results return as soon as the new crawl finishes.";
      setUnindexed([]);
      setAutoRetries(0);
      setRetry((value) => value + 1);
      // Kick the daemon awake even from the home screen, so the crawl starts right away.
      if (!active) {
        searchFiles(binaryPath, "", undefined, 1, new AbortController().signal)
          .then(() => setIndexGeneration((value) => value + 1))
          .catch(() => setIndexGeneration((value) => value + 1));
      }
    } catch (cause) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could Not Rebuild Index";
      toast.message = cause instanceof Error ? cause.message : String(cause);
    } finally {
      setRebuilding(false);
    }
  };

  const rebuildAction = (
    <Action
      title="Rebuild Index"
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
      onAction={rebuild}
    />
  );

  const guideAction = (
    <Action.Push
      title="Search Tips & Setup"
      icon={Icon.Book}
      target={
        <Detail
          navigationTitle="FSearch Guide"
          markdown={guide}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="Copy Install Command"
                content={INSTALL_COMMAND}
              />
              <Action.OpenInBrowser
                title="Open FSearch on GitHub"
                url="https://github.com/noahdunnagan/fsearch"
              />
              {fullDiskAccessAction}
              {rebuildAction}
              <Action
                title="Open Extension Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      }
    />
  );

  const searchActions = (
    <ActionPanel.Section title="Search">
      {canLoadMore && (
        <Action
          title={`Load More Results (Up to ${nextLimit})`}
          icon={Icon.PlusCircle}
          shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
          onAction={loadMore}
        />
      )}
      {active && savedReady && (
        <Action
          title={isSaved ? "Remove Saved Search" : "Save This Search"}
          icon={isSaved ? Icon.StarDisabled : Icon.Star}
          shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
          onAction={toggleSaved}
        />
      )}
      <ActionPanel.Submenu
        title="Search In"
        icon={Icon.Folder}
        shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
      >
        {locations.map((location) => (
          <Action
            key={location.path || "everywhere"}
            title={location.title}
            icon={scope === location.path ? Icon.Checkmark : location.icon}
            onAction={() => startSearch({ scope: location.path })}
          />
        ))}
        {defaultScope && !locations.some((l) => l.path === defaultScope) && (
          <Action
            title={`Default Folder (${displayPath(defaultScope)})`}
            icon={scope === defaultScope ? Icon.Checkmark : Icon.Folder}
            onAction={() => startSearch({ scope: defaultScope })}
          />
        )}
      </ActionPanel.Submenu>
      {active && (
        <ActionPanel.Submenu
          title="Sort Results"
          icon={Icon.List}
          shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
        >
          {sorts
            .filter(
              (item) =>
                !contentResults || !["modified", "size"].includes(item.value),
            )
            .map((item) => (
              <Action
                key={item.value}
                title={item.title}
                icon={effectiveSort === item.value ? Icon.Checkmark : Icon.List}
                onAction={() => setSort(item.value)}
              />
            ))}
        </ActionPanel.Submenu>
      )}
      {active && (
        <Action
          title={showDetails ? "Hide Details" : "Show Details"}
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={() => setShowDetails((value) => !value)}
        />
      )}
      {active && (
        <Action
          title="Back to Search Home"
          icon={Icon.House}
          shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
          onAction={goHome}
        />
      )}
      <Action
        title="Refresh Results"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={() => {
          setAutoRetries(0);
          setRetry((value) => value + 1);
        }}
      />
    </ActionPanel.Section>
  );

  const helpActions = (
    <ActionPanel.Section title="Help">
      {guideAction}
      {fullDiskAccessMissing && fullDiskAccessAction}
      {!rebuilding && rebuildAction}
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </ActionPanel.Section>
  );

  const emptyState = (() => {
    if (error) {
      switch (error.kind) {
        case "missing":
          return {
            icon: Icon.Download,
            tint: Color.Orange,
            title: "FSearch Not Installed",
            description: `${error.message}\n\nOpen the guide for the one-time install steps, or point the extension at an existing executable in preferences.`,
          };
        case "indexing":
          return {
            icon: Icon.Hourglass,
            tint: Color.Blue,
            title: "Building Index",
            description:
              "First-time indexing takes about 20 seconds. Results appear automatically.",
          };
        case "daemon":
          return {
            icon: Icon.Hourglass,
            tint: Color.Orange,
            title:
              autoRetries < 3
                ? "Starting FSearch…"
                : "FSearch isn’t responding",
            description:
              autoRetries < 3
                ? "Starting the search daemon."
                : `${error.message}\n\nPress ⌘ R to try again, or run “fsearch status” in Terminal.`,
          };
        case "timeout":
          return {
            icon: Icon.Clock,
            tint: Color.Orange,
            title: "Search Timed Out",
            description:
              autoRetries < 3
                ? "Retrying automatically…"
                : "The search did not finish in time. Narrow the query or press ⌘ R to try again.",
          };
        case "query":
          return {
            icon: Icon.QuestionMarkCircle,
            tint: Color.Orange,
            title: "Invalid Query",
            description: `${error.message}\n\nCheck the filter syntax in the guide. Valid types are doc, image, code, app, audio, video, and archive.`,
          };
        default:
          return {
            icon: Icon.ExclamationMark,
            tint: Color.Orange,
            title: "Search Failed",
            description: error.message,
          };
      }
    }
    if (loading) {
      return {
        icon: Icon.MagnifyingGlass,
        tint: Color.Blue,
        title: "Searching…",
        description: "",
      };
    }
    const scopedToProtected = Boolean(scope) && isProtectedPath(scope);
    if (needsRebuild) {
      return {
        icon: Icon.ArrowClockwise,
        tint: Color.Orange,
        title: scopedToProtected
          ? `${basename(scope)} Not Indexed`
          : "No Results",
        description: `The index was built before Full Disk Access was granted, so ${unindexedNames.join(", ")} ${unindexedNames.length === 1 ? "is" : "are"} missing. Press ⌘ ⇧ R to rebuild.`,
      };
    }
    return {
      icon: Icon.MagnifyingGlass,
      tint: Color.Blue,
      title: "No Results",
      description: fullDiskAccessMissing
        ? scopedToProtected
          ? `${basename(scope)} needs Full Disk Access. Grant it in System Settings, then rebuild the index.`
          : "Desktop, Documents, and Downloads are skipped until FSearch has Full Disk Access."
        : "",
    };
  })();

  const resultsNote = (() => {
    if (!result || loading) return undefined;
    if (!result.complete)
      return "Partial results: fsearch ran out of time. Narrow the query.";
    if (result.indexing)
      return "Content is still being indexed; more matches may appear.";
    if (sortedFiles.length >= MAX_LIMIT)
      return "Showing the first 500 results. Narrow the query to see others.";
    return undefined;
  })();

  return (
    <List
      isLoading={loading}
      filtering={false}
      isShowingDetail={active && showDetails && sortedFiles.length > 0}
      navigationTitle={scope ? `Search in ${displayPath(scope)}` : "FSearch"}
      selectedItemId={active ? (selectedPath ?? undefined) : undefined}
      onSelectionChange={(id) => {
        const pending = pendingSelection.current;
        if (pending && id !== pending.path && Date.now() < pending.until) {
          // Raycast restored the previous row index; acknowledge it, then move to the top.
          setSelectedPath(id);
          setTimeout(() => setSelectedPath(pending.path), 0);
          return;
        }
        pendingSelection.current = null;
        setSelectedPath(id);
      }}
      searchText={query}
      onSearchTextChange={(text) => {
        setQuery(text);
        setLimit(defaultLimit);
        setAutoRetries(0);
      }}
      searchBarPlaceholder={
        scope
          ? `Search in ${basename(scope) || scope}…`
          : "Find a file… or try ext:pdf, mtime:<7d, grep:hello"
      }
      searchBarAccessory={
        <List.Dropdown
          tooltip="File Type"
          value={filter}
          onChange={(value) => startSearch({ filter: value })}
        >
          {fileTypes.map((type) => (
            <List.Dropdown.Item key={type.value || "all"} {...type} />
          ))}
        </List.Dropdown>
      }
    >
      {!active && (
        <>
          {saved.length > 0 && (
            <List.Section title="Saved Searches">
              {saved.map((item) => (
                <List.Item
                  key={JSON.stringify(item)}
                  title={
                    item.query ||
                    fileTypes.find((type) => type.value === item.filter)
                      ?.title ||
                    "All Files"
                  }
                  subtitle={[
                    item.query
                      ? fileTypes.find((type) => type.value === item.filter)
                          ?.title
                      : undefined,
                    item.scope ? displayPath(item.scope) : "Entire Mac",
                  ]
                    .filter((part) => part && part !== "Everything")
                    .join(" · ")}
                  icon={{ source: Icon.Star, tintColor: Color.Yellow }}
                  actions={
                    <ActionPanel>
                      <Action
                        title="Run Saved Search"
                        icon={Icon.MagnifyingGlass}
                        onAction={() => startSearch(item)}
                      />
                      <Action
                        title="Remove Saved Search"
                        icon={Icon.StarDisabled}
                        style={Action.Style.Destructive}
                        shortcut={{ modifiers: ["ctrl"], key: "x" }}
                        onAction={() =>
                          persistSaved(
                            saved.filter((entry) => entry !== item),
                            "Search Removed",
                          )
                        }
                      />
                      {searchActions}
                      {helpActions}
                    </ActionPanel>
                  }
                />
              ))}
            </List.Section>
          )}
          <List.Section title="Quick Searches">
            {starters.map((starter) => (
              <List.Item
                key={starter.query}
                title={starter.title}
                subtitle={starter.query}
                icon={{ source: starter.icon, tintColor: Color.Blue }}
                actions={
                  <ActionPanel>
                    <Action
                      title="Search Files"
                      icon={Icon.MagnifyingGlass}
                      onAction={() =>
                        startSearch({
                          query: starter.query,
                          sort: starter.sort,
                        })
                      }
                    />
                    {searchActions}
                    {helpActions}
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
          <List.Section
            title="Places"
            subtitle={
              status
                ? `${status.entries.toLocaleString()} items indexed`
                : undefined
            }
          >
            {locations
              .filter((location) => location.path)
              .map((location) => {
                const needsAccess =
                  fullDiskAccessMissing && isProtectedPath(location.path);
                const notIndexed = unindexed.includes(location.path);
                return (
                  <List.Item
                    key={location.path}
                    title={location.title}
                    subtitle={displayPath(location.path)}
                    icon={location.icon}
                    accessories={
                      needsAccess
                        ? [
                            {
                              tag: {
                                value: "Needs Full Disk Access",
                                color: Color.Orange,
                              },
                              tooltip:
                                "macOS hides this folder from FSearch until it has Full Disk Access.",
                            },
                          ]
                        : notIndexed
                          ? [
                              {
                                tag: {
                                  value: "Rebuild Index",
                                  color: Color.Orange,
                                },
                                tooltip:
                                  "Indexed before Full Disk Access was granted. Rebuild the index to include it.",
                              },
                            ]
                          : location.path === defaultScope
                            ? [
                                {
                                  tag: "Default",
                                  tooltip: "Configured in preferences",
                                },
                              ]
                            : []
                    }
                    actions={
                      <ActionPanel>
                        <Action
                          title="Search This Folder"
                          icon={Icon.MagnifyingGlass}
                          onAction={() => startSearch({ scope: location.path })}
                        />
                        {needsAccess && fullDiskAccessAction}
                        {notIndexed && rebuildAction}
                        {searchActions}
                        {helpActions}
                      </ActionPanel>
                    }
                  />
                );
              })}
          </List.Section>
          {(fullDiskAccessMissing || needsRebuild) && (
            <List.Section title="Setup">
              {fullDiskAccessMissing && (
                <List.Item
                  title="Grant Full Disk Access"
                  subtitle="Desktop, Documents, and Downloads are skipped"
                  icon={{ source: Icon.Lock, tintColor: Color.Orange }}
                  actions={
                    <ActionPanel>
                      {fullDiskAccessAction}
                      {guideAction}
                      <Action.CopyToClipboard
                        title="Copy Login Daemon Command"
                        content="~/.local/bin/fsearch install --login"
                      />
                      {searchActions}
                    </ActionPanel>
                  }
                />
              )}
              {needsRebuild && (
                <List.Item
                  title="Rebuild Index"
                  subtitle={`${unindexedNames.join(", ")} not indexed`}
                  icon={{
                    source: Icon.ArrowClockwise,
                    tintColor: Color.Orange,
                  }}
                  actions={
                    <ActionPanel>
                      {rebuildAction}
                      {guideAction}
                      {searchActions}
                    </ActionPanel>
                  }
                />
              )}
            </List.Section>
          )}
        </>
      )}
      <List.EmptyView
        icon={{ source: emptyState.icon, tintColor: emptyState.tint }}
        title={emptyState.title}
        description={emptyState.description || undefined}
        actions={
          <ActionPanel>
            {error?.kind === "missing" && guideAction}
            {error?.kind === "missing" && (
              <Action.CopyToClipboard
                title="Copy Install Command"
                content={INSTALL_COMMAND}
              />
            )}
            {!error && fullDiskAccessMissing && fullDiskAccessAction}
            {!error && needsRebuild && rebuildAction}
            {filter && (
              <Action
                title="Search All File Types"
                icon={Icon.MagnifyingGlass}
                onAction={() => startSearch({ filter: "" })}
              />
            )}
            {scope && (
              <Action
                title="Search Entire Mac"
                icon={Icon.Desktop}
                onAction={() => startSearch({ scope: "" })}
              />
            )}
            {searchActions}
            {helpActions}
          </ActionPanel>
        }
      />
      {active &&
        result &&
        sortedFiles.map((file) => (
          <List.Item
            key={file.path}
            id={file.path}
            title={basename(file.path) || file.path}
            subtitle={showDetails ? undefined : displayPath(dirname(file.path))}
            icon={{ fileIcon: file.path }}
            quickLook={{ path: file.path, name: basename(file.path) }}
            accessories={
              showDetails
                ? []
                : file.matches
                  ? [
                      {
                        tag: {
                          value: `${file.matches.length} ${file.matches.length === 1 ? "match" : "matches"}`,
                          color: Color.Blue,
                        },
                      },
                    ]
                  : [
                      {
                        text:
                          file.kind === "dir"
                            ? describeKind(file.path, file.kind)
                            : file.kind === "link"
                              ? "Link"
                              : file.size !== undefined
                                ? formatSize(file.size)
                                : "",
                      },
                      ...(file.mtime
                        ? [
                            {
                              date: new Date(file.mtime * 1000),
                              tooltip: `Modified ${new Date(file.mtime * 1000).toLocaleString()}`,
                            },
                          ]
                        : []),
                    ]
            }
            detail={
              <List.Item.Detail
                isLoading={previewLoading && file.path === previewPath}
                markdown={
                  file.matches
                    ? file.matches
                        .map(
                          (match) =>
                            `**Line ${match.line}**\n\n${codeBlock(match.text, languageFor(file.path))}`,
                        )
                        .join("\n\n")
                    : filePreview?.path === file.path
                      ? filePreview.markdown
                      : // Reserve the preview height without a visible loading label.
                        `![](preview-placeholder.png?raycast-height=${PREVIEW_MAX_HEIGHT})`
                }
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="Where"
                      text={displayPath(dirname(file.path))}
                    />
                    <List.Item.Detail.Metadata.TagList title="">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={describeKind(file.path, file.kind)}
                        color={Color.Blue}
                      />
                      {(() => {
                        if (file.kind === "dir") return null;
                        const size =
                          filePreview?.path === file.path
                            ? (filePreview.size ?? file.size)
                            : file.size;
                        return size === undefined ? null : (
                          <List.Item.Detail.Metadata.TagList.Item
                            text={formatSize(size)}
                            color={Color.SecondaryText}
                          />
                        );
                      })()}
                      {(() => {
                        const modified =
                          filePreview?.path === file.path &&
                          filePreview.modified
                            ? filePreview.modified
                            : file.mtime
                              ? new Date(file.mtime * 1000)
                              : undefined;
                        return modified ? (
                          <List.Item.Detail.Metadata.TagList.Item
                            text={modified.toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                            color={Color.SecondaryText}
                          />
                        ) : null;
                      })()}
                      {filePreview?.path === file.path &&
                        filePreview.details && (
                          <List.Item.Detail.Metadata.TagList.Item
                            text={filePreview.details}
                            color={Color.SecondaryText}
                          />
                        )}
                      {file.matches && (
                        <List.Item.Detail.Metadata.TagList.Item
                          text={`${file.matches.length} ${file.matches.length === 1 ? "match" : "matches"}`}
                          color={Color.Green}
                        />
                      )}
                    </List.Item.Detail.Metadata.TagList>
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section title={basename(file.path)}>
                  <Action.Open
                    title={
                      file.kind === "dir"
                        ? extname(file.path).toLowerCase() === ".app"
                          ? "Launch Application"
                          : "Open Folder"
                        : "Open File"
                    }
                    target={file.path}
                  />
                  <Action.ShowInFinder
                    path={file.path}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                  />
                  <Action.ToggleQuickLook
                    shortcut={{ modifiers: ["cmd"], key: "y" }}
                  />
                  <Action.OpenWith path={file.path} />
                  <Action.CopyToClipboard
                    title="Copy Path"
                    content={file.path}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                  />
                  <Action.CopyToClipboard
                    title="Copy File"
                    content={{ file: file.path }}
                  />
                  <Action.CopyToClipboard
                    title="Copy Filename"
                    content={basename(file.path)}
                  />
                  <Action
                    title={
                      file.kind === "dir"
                        ? "Search Inside Folder"
                        : "Search Containing Folder"
                    }
                    icon={Icon.Folder}
                    shortcut={{ modifiers: ["cmd"], key: "f" }}
                    onAction={() => {
                      startSearch({
                        scope:
                          file.kind === "dir" ? file.path : dirname(file.path),
                        query: "",
                        filter: "",
                      });
                      setSelectedPath(null);
                    }}
                  />
                  <Action
                    title="Move to Trash"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => moveToTrash(file)}
                  />
                </ActionPanel.Section>
                {searchActions}
                {helpActions}
              </ActionPanel>
            }
          />
        ))}
      {resultsNote && (
        <List.Item
          id="results-note"
          title={resultsNote}
          icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
          actions={<ActionPanel>{searchActions}</ActionPanel>}
        />
      )}
      {canLoadMore && (
        <List.Item
          id="show-more"
          title="Show More"
          subtitle={`Up to ${nextLimit} results`}
          icon={Icon.PlusCircle}
          detail={
            <List.Item.Detail
              markdown={`## Showing the first ${sortedFiles.length} results\n\nPress **Return** to load up to ${nextLimit}, or narrow the search with a filter or folder.`}
            />
          }
          actions={
            <ActionPanel>
              <Action
                title={`Load More Results (Up to ${nextLimit})`}
                icon={Icon.PlusCircle}
                onAction={loadMore}
              />
              {searchActions}
              {helpActions}
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
