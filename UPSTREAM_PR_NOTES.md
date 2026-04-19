# Upstream PR Notes

Prepared for an upstream pull request from this maintenance fork back to Eli Finer's original PoeLog repository.

Prepared by Isaac Baum with GitHub Copilot assistance.

## Suggested PR Title

Restore Poe compatibility, current-chat media export, and reliable `/chats` bulk export

## Summary

- Reworked the extension for Manifest V3-safe downloads without relying on the old background service-worker path.
- Restored current-chat export against Poe's current CSS-module-based UI.
- Added a dedicated current-chat exporter tab so long-running exports survive popup focus loss.
- Added optional current-chat media and attachment downloads.
- Added stepped upward scrolling plus top-of-thread verification to handle Poe's virtualized long threads.
- Added Relay-backed `/chats` catalog capture and replay through `page_bridge.js` for more complete bulk discovery.
- Added a dedicated bulk exporter UI with bounded parallel worker tabs and per-run manifest output.
- Added stronger diagnostics for current-chat extraction and bulk catalog resolution.

## Validation Highlights

- Target long-thread current-chat validation succeeded with 448 exported messages.
- The same validation run exported 185 attachments and images.
- The exporter may briefly revisit the top boundary near completion because it performs a final hydration-verification sweep before declaring the thread complete.

## Files Of Interest

- `manifest.json`
- `popup.html`
- `popup.js`
- `current_export.html`
- `current_export.js`
- `bulk.html`
- `bulk.js`
- `content.js`
- `page_bridge.js`
- `README.md`

## Notes For Review

- The largest logic change is in `content.js`, where long-thread harvesting and media extraction now work against Poe's virtualized conversation UI.
- Bulk export correctness depends on Poe's Relay-backed `/chats` transport remaining structurally similar to the captured request templates.
- The fork preserves local-only processing; no transcript data is sent to external services.