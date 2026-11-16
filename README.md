# SiteCloner

A small Node tool that downloads a website's frontend and the public API responses it loads, then serves the copy on localhost. It comes with a local control panel for managing clones, and a CLI.

It only copies what a browser can already see. Server code and databases can't be downloaded, and sites behind bot protection may refuse the crawler (the panel has an "Import saved page" fallback for those).

Only clone sites you own or have permission to copy.

Requires Node.js 18 or newer. No npm dependencies.

## Quick start

```bash
git clone https://github.com/fibrousop07-dev/sitecloner.git
cd sitecloner
node ui.mjs            # opens the control panel at http://localhost:4200
```

On Windows you can also double-click `SiteCloner.cmd`.

### Command line

```bash
node sitecloner.mjs https://example.com        # clone, serve, then confirm keep/delete
node sitecloner.mjs serve ./clones/example.com # serve an existing clone
node sitecloner.mjs --help
```

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | output folder (default `clones/<host>`) |
| `--port <n>` | port to serve on |
| `--max <files>` | file limit (default 100000) |
| `--no-open` | don't open the browser |
| `--no-api` | skip saving public API answers |
| `--answer <y\|n\|s>` | answer the keep/delete prompt non-interactively |

### Windows installer

Build a double-click installer (bundles its own Node runtime, no admin rights, no Node needed on the target PC):

```powershell
powershell -ExecutionPolicy Bypass -File installeruild.ps1   # -> dist\SiteCloner-Setup.exe
```

It installs to `%LOCALAPPDATA%\Programs\SiteCloner`, adds Start-menu and desktop shortcuts, registers in Settings > Apps for uninstalling, and stores clones in `Documents\SiteCloner\clones` (never deleted on uninstall).

### Windows app install without the installer (optional)

Run `Install.cmd` to add a **SiteCloner** Start-menu entry and desktop shortcut that opens the panel in its own window. `Uninstall.cmd` removes them; your clones are never deleted.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `SITECLONER_CLONES` | where clones are stored (default `./clones`) |
| `SITECLONER_STATE` | where the panel keeps its small state/profile folder |

## Development

```bash
npm run check   # syntax-check all scripts
```

