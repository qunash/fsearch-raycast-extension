/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** FSearch Executable - Path to the fsearch binary. Install fsearch before searching. */
  "binaryPath": string,
  /** Search Folder - Optional folder to search within. Leave empty to search the whole index. */
  "searchRoot"?: string,
  /** Maximum Results - Maximum files returned per search. */
  "resultLimit": "25" | "50" | "100",
  /** Results - Open results in a split view with a file preview and metadata. Toggle it any time with ⌘ D. */
  "showDetails": boolean
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search` command */
  export type Search = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search` command */
  export type Search = {}
}

