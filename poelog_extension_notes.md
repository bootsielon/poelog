- PoeLog now avoids MV3 background downloads; popup.js owns chrome.downloads.download because the old service-worker path depended on browser APIs that are not reliable there.
- Current Poe chat DOM can be scraped via stable CSS-module prefixes such as ChatMessage_chatMessage, Message_rightSideMessageBubble, Message_leftSideMessageBubble, ChatHeader_titleText, and MessageDate_container instead of exact hashed class names.
- content.js scrolls upward before export so older messages load into the DOM before transcript extraction.
- Bulk export is orchestrated from bulk.html/bulk.js, not the popup or a service worker; it crawls /chats once, reuses one inactive worker tab, and writes a manifest.json alongside transcript downloads.
- Unresolved /chats rows are deduped by title+preview fallback and recorded in manifest.json so bulk runs can continue even if Poe changes row wiring.
- Poe /chats and long conversation histories behave like virtualized lists; reliable export requires stepped scrolling plus incremental harvesting of visible rows/messages instead of assuming the whole DOM accumulates in place.
- Chat URL extraction must stay strict: only real `/chat/<lowercase-alnum-code>` paths are valid export targets; scanning arbitrary attribute/class strings creates false positives like CSS module names.


