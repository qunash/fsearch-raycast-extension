# FSearch Changelog

## [Initial Version] - {PR_MERGE_DATE}

- First run without fsearch: the home screen offers **Install FSearch in Terminal**, which runs `cargo install --git …` (and rustup first when Rust is missing) in a Terminal window, then re-checks until the index is built. The executable is found in `~/.local/bin`, `~/.cargo/bin`, and Homebrew's bin folders without setting a preference.
- Persistent socket connection to the fsearch daemon; `fsearch stdio` is spawned only to start it.
- Show More raises the content-search read budget, and partial results report how many candidate files were read.
- Fonts in the type menu; the help lists regex, range, comma-list, and quoted-phrase syntax.
- Fuzzy, whole-disk file search powered by a local fsearch daemon.
- Home screen with saved searches, quick starters, and favourite places.
- File-type filters, folder scoping, sorting, and shell wildcards such as `*.docx`.
- Split-view previews for images, text and code, Word and RTF documents, archives, property lists, and Quick Look thumbnails of PDFs, Office files, HEIC, video, and fonts, with page counts, durations, and pixel sizes.
- Content search with line-numbered matches.
- Full Disk Access awareness with a one-click index rebuild, automatic retries while the index builds, and clear error states.
- Open, reveal in Finder, Quick Look, Open With, copy, and Move to Trash actions.
