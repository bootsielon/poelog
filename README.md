# PoeLog

PoeLog is a Chrome extension that exports Poe chats to local text files. It runs entirely in the browser, preserves Poe's rendered markdown where possible, and can export human messages, bot messages, or both.

This fork has been maintained by Isaac Baum, with implementation assistance from GitHub Copilot, to restore compatibility with Poe's current UI and prepare an upstream pull request back to Eli Finer's original project.

## What Changed

- The extension now uses a Manifest V3-safe download flow that does not depend on a background service worker.
- Transcript extraction now targets Poe's current chat structure by matching stable CSS-module prefixes such as `ChatMessage_` and `Message_` instead of scraping exact hashed class names.
- Before exporting, PoeLog scrolls upward through the conversation and accumulates messages while it moves so virtualized histories do not truncate the transcript.
- Attachment links are preserved when they are available in the page markup, and the current-chat flow can optionally download the linked media files themselves.
- PoeLog now has a bulk-export mode that crawls `https://poe.com/chats`, resolves the full catalog through Poe's Relay pagination, and exports chats through a configurable worker pool capped at 20 tabs.
- Long current-chat exports perform a final top-of-thread verification sweep before they finish. On Poe's virtualized threads, this can look like a brief extra bounce near the top boundary, and it is expected.

## Installation

1. Clone this repo to your computer.
2. Open the Chrome browser and navigate to `chrome://extensions/`.
3. Enable "Developer mode" by toggling the switch in the top right corner.
4. Click "Load unpacked" and select the directory containing the extension files.

## Usage

1. Open a conversation on `poe.com`.
2. Click the PoeLog extension icon in the Chrome toolbar.
3. Choose whether to include human messages, bot messages, or both.
4. Optionally enable media downloads for the current chat.
5. Click `Download Current Chat`.
6. PoeLog opens a dedicated exporter tab, loads the full thread, generates the transcript locally, and saves it through Chrome's download manager.
7. If media download is enabled, linked attachments are downloaded into a sibling attachments folder.
8. Chrome may prompt once to allow multiple downloads when media export is enabled.

## Bulk Usage

1. Open `https://poe.com/chats`.
2. Click the PoeLog extension icon.
3. Click `Bulk Export From /chats`.
4. Choose how many bulk worker tabs to use. PoeLog defaults to the machine's reported browser concurrency, capped at 20.
5. PoeLog opens a dedicated bulk-export tab, resolves the `/chats` catalog, then exports resolved conversations in parallel through the configured worker pool.
6. Transcripts are saved into a timestamped download folder together with a `manifest.json` file that records completed, skipped, failed, and unresolved rows.
7. Chrome may prompt once to allow multiple downloads during the run.

## Notes

- Poe rotates CSS-module suffixes frequently. PoeLog avoids exact class-name matches and instead looks for stable component name prefixes. If Poe substantially changes its chat DOM again, update the selector list in `content.js`.
- PoeLog does not send any data to external servers. All processing is done locally within the Chrome browser.
- The export only works on an active Poe conversation page.
- Bulk export depends on resolving direct chat URLs from the `/chats` index. If Poe changes how chat rows are wired, some rows may show up as unresolved and will be listed in the bulk `manifest.json` file.
- Validated current-chat behavior on a long Poe thread: 448 exported messages and 185 downloaded attachments/images.

## Contributing

If you'd like to contribute to PoeLog, suggest new features, or report any issues, please visit the [GitHub repository](https://github.com/finereli/poelog).

For the current maintenance fork and the upstream PR summary, see `UPSTREAM_PR_NOTES.md`.

## License

PoeLog is released under the [MIT License](https://opensource.org/licenses/MIT).
