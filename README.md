# FSearch for Raycast

Fast, local file search in Raycast, powered by [noahdunnagan/fsearch](https://github.com/noahdunnagan/fsearch).

- A home screen with saved searches, quick searches (recent, PDFs, large files, screenshots), and favourite places.
- Save any query with its file type and folder; run or remove it from the home screen.
- Nine file-type choices, folder scoping, and search-inside-folder actions.
- Fuzzy filename search with original ranking; sort loaded results by name, modification date, or size.
- A split view previews the selected file alongside its metadata: images, text and code with syntax highlighting, the text of Word, RTF, and OpenDocument files, archive listings, property lists, and Quick Look thumbnails of PDFs, spreadsheets, presentations, HEIC and other images, videos, and fonts. Spotlight metadata adds page counts, durations, and pixel sizes. Text previews open at the first line containing the query words (or, for content searches, fsearch’s first match), with every such line marked in the gutter.
- Preview text is limited to 32 KiB; inline PNG, JPEG, GIF, and WebP previews are limited to 20 MiB. Thumbnails are cached in the extension's support folder and generated with a 4-second limit. Only the selected file is read.
- Shell wildcards are translated: `*.docx` searches `ext:docx`, and `report*.pdf` searches `report ext:pdf`.
- Native file icons, readable sizes and dates, Quick Look, Open With, Finder reveal, copy actions, and Move to Trash with confirmation.
- Stable results while typing, cancellation of obsolete requests, and automatic retry while the daemon starts or builds its first index.
- Full Disk Access awareness: the home screen and empty states explain when protected folders are being skipped, link to System Settings, and offer an index rebuild once access is granted.
- A new query always starts at the top of the results instead of keeping the previous row selected.
- Expand searches up to 500 results. The results header shows the count, query latency, sort order, and notes on partial results, content indexing, and the 500-result limit.
- A custom F-in-a-magnifying-glass icon and an in-app search guide.

## Install

Requires macOS, Raycast, Bun 1.1.32+ and Node.js for Raycast’s CLI, and Rust/Cargo to build fsearch.

First install the search engine using its upstream instructions:

```sh
git clone https://github.com/noahdunnagan/fsearch.git
cd fsearch
cargo build --release
./target/release/fsearch install
```

Then, from this extension directory:

```sh
bun install
bun run dev
```

Open **Search Files** in Raycast. The default executable is `~/.local/bin/fsearch`; change it in extension preferences if necessary. The first query starts fsearch’s daemon. Initial indexing can take around 20 seconds; the command retries automatically while the first index is being built.

macOS hides Desktop, Documents, Downloads, and parts of Library until fsearch has Full Disk Access. Grant it to Raycast (the daemon Raycast starts inherits the permission) or, following [fsearch’s guidance](https://github.com/noahdunnagan/fsearch#full-disk-access), to a login daemon installed with `~/.local/bin/fsearch install --login`. Until then the extension marks those places as skipped and offers a shortcut to the Privacy & Security settings.

fsearch keeps the index it built before access was granted and only replays later file-system events, so those folders stay empty after the grant. The extension detects this (protected folders with files but no index entries) and offers **Rebuild Index** (⌘ ⇧ R) on the home screen, in empty states, and in the Help section. The rebuild stops the daemon, deletes `~/Library/Application Support/FSearch/index.bin` and its content store, and lets the next search start a fresh crawl, which takes about 20 seconds.

## Use from Raycast’s main search

Run **Manage Fallback Commands** in Raycast (or open Settings → Launcher → Fallback Commands), add **Search Files — FSearch**, and move it to your preferred position. When Raycast shows **Use with**, selecting this command searches the text you already typed.

Fallback registration is a Raycast user setting; there is no public extension API to enable it automatically on installation. The command accepts `fallbackText` and an optional `query` argument, so it also works when launched with text directly, including through deeplinks.

## Preferences

| Preference         | Effect                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| FSearch Executable | Path to the fsearch binary. `~` is expanded.                                                                  |
| Search Folder      | Default folder for every search. The home screen still appears; choose another folder with ⌘ ⇧ F at any time. |
| Maximum Results    | Results per request before Show More.                                                                         |
| Results            | Whether the preview pane is open by default. Toggle it with ⌘ D.                                              |

## Search

| Query                   | Finds                        |
| ----------------------- | ---------------------------- |
| `quarterly report`      | Fuzzy filename matches       |
| `ext:pdf invoice`       | PDF invoices                 |
| `readme in:~/Developer` | Files within a folder        |
| `type:image mtime:<7d`  | Recent images                |
| `size:>100mb`           | Large files                  |
| `ext:ts grep:useEffect` | Text inside TypeScript files |
| `sym:apply_dir`         | Symbol definitions           |

The type menu adds a filter to the query. Leave it on Everything when writing your own `type:` or `kind:` filters. The configured result limit overrides query `limit:`. The current search folder overrides query `in:`; choose Entire Mac to let the query supply its own folder. Sorting applies to the fetched results, not to the entire index. Select Show More in the list (or press ⌘ ⇧ M) to expand the set before sorting. Size and modification-date sorting are unavailable for content matches because fsearch does not return that metadata. Content search may return partial results while indexing or when its time budget is reached; the section header shows this status. Narrow the query and retry.

| Shortcut | Action                            |
| -------- | --------------------------------- |
| Return   | Open file, folder, or application |
| ⌘ Return | Reveal in Finder                  |
| ⌘ Y      | Quick Look                        |
| ⌘ ⇧ C    | Copy path                         |
| ⌃ X      | Move to Trash (asks first)        |
| ⌘ D      | Toggle details / content matches  |
| ⌘ R      | Refresh search                    |
| ⌘ ⇧ S    | Save / remove current search      |
| ⌘ ⇧ H    | Return to search home             |
| ⌘ ⇧ F    | Choose search folder              |
| ⌘ F      | Search selected result’s folder   |
| ⌘ ⇧ O    | Sort loaded results               |
| ⌘ ⇧ M    | Show more results                 |
| ⌘ ⇧ R    | Rebuild the index                 |

The preview keeps four metadata rows (Where, Kind, Size, Modified); Spotlight details such as page count, duration, or pixel size join the Kind row. Raycast splits the pane at a fixed point, so the image box is sized to the markdown area above those rows; text previews scroll. Anything without a richer preview, including applications, folders, and unknown formats, shows its Finder icon, as the built-in File Search does. Previews use only tools shipped with macOS: `qlmanage`, `textutil`, `unzip`, `tar`, `plutil`, `mdls`, and `osascript` for icons.

## Development

```sh
bun run typecheck
bun test
bun run build
bun run format:check
```

The extension uses Node’s `execFile` and fsearch’s JSON-lines `stdio` protocol, without a shell. Queries are passed as data (including words that are CLI subcommands). Each request closes its client after the response; fsearch’s index daemon remains running. `fsearch status` is read once per launch to report index size and Full Disk Access. Searches stay on your Mac. Only searches you explicitly save are stored in Raycast LocalStorage; typed queries are not recorded as history. Tests exercise the upstream response format, error classification, text-preview decoding, and process transport using a mock executable; a real fsearch installation is needed for end-to-end search validation.
