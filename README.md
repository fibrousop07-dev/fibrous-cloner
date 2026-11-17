# fibrous-cloner — local website cloner and downloader

**fibrous-cloner is a website cloner for downloading a public site's frontend and previewing the copy on localhost.** It saves HTML, CSS, JavaScript, images, fonts and accessible public API responses. Manage copies in a local control panel or use the Node.js command-line tool. The desktop and CLI have zero npm runtime dependencies and require Node.js 18 or newer.

[Documentation](https://fibrousop07-dev.github.io/fibrous-cloner/) · [Getting started](#quick-start) · [FAQ](#frequently-asked-questions) · [Report a bug](https://github.com/fibrousop07-dev/fibrous-cloner/issues)

Formerly SiteCloner. Maintained by [fibrousop07-dev](https://github.com/fibrousop07-dev). MIT licensed.

## What can this site cloner do?

- Download publicly accessible pages and frontend assets to local files.
- Save public API answers and replay them in a local website preview.
- Organize website copies into folders, add tags, search, and sort by name, date or size.
- Start and stop localhost previews from the control panel.
- Preview desktop, tablet and phone widths inside the panel.
- Import a page saved from your browser when an automated download fails.
- Run through a CLI on Windows, macOS or Linux; Windows also has app shortcuts and an installer build.

Use it to archive your own website, inspect frontend assets, or keep a permitted reference copy. Only copy websites you own or have permission to copy.

## Quick start

Install [Node.js](https://nodejs.org/) 18 or newer, then run:

```bash
git clone https://github.com/fibrousop07-dev/fibrous-cloner.git
cd fibrous-cloner
npm start
```

The control panel opens at **http://localhost:4200**. Paste a website URL, choose **Add to queue**, then **Start localhost** on the saved copy. No `npm install` is needed to run the panel or CLI.

On Windows, you can also double-click `FibrousSites.cmd`; the launcher filename is retained for compatibility.

## Clone a website from the command line

```bash
# Download a website, preview it, then choose whether to keep the copy.
node sitecloner.mjs https://example.com

# Download without automatically opening the browser; keep the saved files.
node sitecloner.mjs https://example.com --no-open --answer y

# Choose an output folder and limit the number of files.
node sitecloner.mjs https://example.com --out ./clones/example --max 200

# Serve an existing downloaded copy.
node sitecloner.mjs serve ./clones/example.com --port 4300

# Show help.
node sitecloner.mjs --help
```

`example.com` is an illustrative URL; use a site you own or have permission to copy. The installed command is `fibrous-cloner` if you run `npm link` locally; this does not imply an npm registry release.

| Option | Purpose |
| --- | --- |
| `--out <dir>` | Output directory; default `clones/<host>` |
| `--port <n>` | Local preview port |
| `--max <files>` | File limit; default 100000 |
| `--no-open` | Do not open the browser automatically |
| `--no-api` | Skip saving public API responses |
| `--answer y` | Keep the copy without an interactive confirmation |
| `--answer n` | Delete the copy after the preview confirmation |
| `--answer s` | Keep serving the copy |

## Automatic headless capture

JavaScript pages are rendered automatically using an installed Chrome, Edge or Chromium browser. Failed plain downloads also try this path. The app waits for rendering, scrolls to load common lazy assets, and imports the browser snapshot with its loaded images, styles and fonts. No Ctrl+S, file picker or visible browser window is needed.

Choose **Repair automatically** in Preview to refresh a broken copy. A refused browser capture now falls back to public source HTML and its assets, labelled as a partial copy rather than a completed render. Redirect-only source pages are followed, and parked-domain sale pages are reported instead of silently saved as the requested site. The job appears in the normal queue, supports cancellation and preserves existing files if capture fails. The browser uses a temporary profile, not your personal sessions. To select a nonstandard browser location, set `FIBROUS_CLONER_BROWSER` to its executable path.

Rendered captures preserve the page's static appearance; interactive features and uncaptured resources can remain incomplete. A CAPTCHA, login, HTTP denial or regional restriction can still prevent capture. If no supported browser is installed, a successful plain download is retained and the browser error is shown.

## How website copying works

The crawler fetches a page, discovers linked frontend resources, saves accessible files, and rewrites supported references for local serving. Where supported, public API responses are captured and replayed by the local server. These are downloaded responses, not a copy of the original database or backend application.

A localhost preview can still request resources from the original website when those resources could not be captured or rewritten. Saving a site is not a guarantee of a completely offline copy.

## Frequently asked questions

### What is a site cloner?

A site cloner downloads the browser-accessible parts of a website so they can be inspected or served elsewhere. fibrous-cloner focuses on local frontend copies with a control panel, command-line access, and public API response snapshots.

### Can I download a website and run it on localhost?

Yes, when its public frontend is accessible to the crawler. Run `node sitecloner.mjs <url>`, or add the URL in the panel and start the saved copy. See the limitations below for dynamic pages and blocked downloads.

### Does it copy a website's backend or database?

No. It cannot download private server code, databases, passwords or authenticated content. A public API snapshot only saves responses available to a logged-out visitor.

### Does it clone React, Vue or other JavaScript websites?

It can save accessible JavaScript bundles and assets, and the local server supports detected client-side routes. Results vary: private APIs, missing data and content that requires browser rendering can leave a copy incomplete. The downloader automatically renders JavaScript pages with an installed Chrome, Edge or Chromium browser. Rendering cannot bypass an interactive verification, login or access block.

### Can it bypass Cloudflare, logins or CAPTCHA?

No. Sites can refuse automated requests. The app automatically tries a headless browser when a plain download is refused. If verification still requires interaction, it reports the block instead of saving a challenge page. Import remains available for existing saved pages.

### Is fibrous-cloner free and open source?

Yes. The desktop control panel and CLI source in this repository are available under the [MIT license](LICENSE). There are no npm runtime dependencies for this tool.

### Does it work offline?

Captured files and saved API responses can be served locally. Uncaptured resources, live integrations and private APIs may still require the original site or fail. Verify the copy before relying on it as an offline archive.

### How does this differ from saving a page in a browser?

Browser Save Page is useful for one rendered page. fibrous-cloner adds a managed local library, a resource crawler, localhost serving, public API snapshots, folders, tags, and a CLI. Neither approach guarantees a working copy of a private or highly dynamic application.

## Limitations

- Server code, private databases and login-protected data are not copied.
- Bot protection, rate limits and access restrictions can prevent downloads.
- Payments, account systems, live search and third-party integrations may not work in a local copy.
- A local preview is not a replacement production deployment.
- Website content remains subject to its owner's rights and terms.

## Windows app and installer

Run `Install.cmd` for a Start-menu shortcut. `Uninstall.cmd` removes the shortcuts without deleting your clones.

To build the Windows installer with a bundled Node runtime:

```powershell
powershell -ExecutionPolicy Bypass -File installer/build.ps1
```

The output remains `dist/FibrousSites-Setup.exe`. Existing launcher filenames, saved-clone metadata and storage locations are retained so older copies still work. The displayed product name is fibrous-cloner.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `FIBROUS_SITES_CLONES` | Clone storage directory; default `./clones` |
| `FIBROUS_SITES_STATE` | Control-panel state directory |

Legacy `SITECLONER_*` variables still work and print a deprecation notice. Variable names have been kept for compatibility.

## Development

```bash
npm run check
npm test
```

The source is plain Node.js ES modules. `sitecloner.mjs` contains the crawler and local server, `ui.mjs` contains the control panel, `app.mjs` launches an app window, and `installer/` holds the Windows packaging scripts.

## Contributing and support

[Open an issue](https://github.com/fibrousop07-dev/fibrous-cloner/issues) with your Node version, operating system, command, expected result and actual result. Use a minimal public or local example; do not attach credentials, private website content, or large downloaded copies. Pull requests should explain the behavior changed and how it was checked.
