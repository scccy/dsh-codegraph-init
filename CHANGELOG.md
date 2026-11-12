# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-11-12

### Added

- Workspace "…" menu entries **安装 codegraph** and **卸载 codegraph**, ordered
  between "Show in Finder" and "Delete workspace".
- Modal dialog with live install/uninstall log, status readout (CLI version,
  DSH home, current wiring) and an optional "remove the global CLI" checkbox.
- Host service `codegraphInstall` (`status` / `start` / `poll` / `cancel` /
  `forget`) with a bounded in-memory log and a single concurrent run.
- Own DSH wiring writer for CLI releases that predate the `dsh` target: appends
  an `@deepseek-ai/dsh-mcp-client` entry to `$DSH_HOME/cordis.patch.yml` (with an
  absolute command path) and a marked block to `$DSH_HOME/AGENTS.md`, while
  delegating to `codegraph install -t dsh` whenever the CLI supports it.
- Resolution fallback so a `link:`-installed checkout can still load
  `@deepseek-ai/dsh-typert-protocol` from the running installation.

## 0.1.1 — 2026-11-12

### Added

- The bundle now wires itself: activating the plugin writes the
  `@deepseek-ai/dsh-mcp-client` row into `$DSH_HOME/cordis.patch.yml` and the
  `<!-- CODEGRAPH_START -->` block into `$DSH_HOME/AGENTS.md`, so installing the
  plugin also installs the MCP server and the agent instructions. Unloading it
  removes exactly the parts it wrote (the patch file returns to `[]`).
- Nothing is written when a `codegraph` server already exists in this home or in
  any profile, or when `codegraph` is not on `PATH` — the sidebar dialog stays
  the place that installs the CLI.
- `DSH_CODEGRAPH_AUTO_WIRE=0` disables the install-time wiring and leaves the
  dialog as the only writer.

### Fixed

- Removing the row from a patch file that only held `[]` and comments now
  restores an empty-list literal instead of leaving a `null` document.
