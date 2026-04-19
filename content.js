const SELECTORS = {
    messageNodes: ['[id^="message-"]', '[class*="ChatMessage_chatMessage"]'],
    messageGroups: ['[class*="ChatMessagesView_tupleGroupContainer"]'],
    humanBubble: ['[class*="Message_rightSideMessageBubble"]'],
    botBubble: ['[class*="Message_leftSideMessageBubble"]'],
    markdownContainer: ['[class*="Markdown_markdownContainer"]'],
    messageText: [
        '[class*="Message_messageTextContainer"]',
        '[class*="Message_selectableText"]',
        '[class*="Message_plaintext"]'
    ],
    attachments: ['a[class*="Attachments_attachment"]', 'a[class*="FileInfo_fileInfo"]'],
    attachmentMedia: [
        'a[href][download]',
        'a[href] img[src]',
        'a[href] img[srcset]',
        'a[href] picture img[src]',
        'a[href] picture source[srcset]',
        'a[href] video',
        'a[href] audio',
        'img[src]',
        'img[srcset]',
        'picture img[src]',
        'picture source[srcset]',
        'video',
        'audio',
        'source[src]',
        'source[srcset]'
    ],
    attachmentTitle: ['[class*="FileInfo_title"]'],
    dateLabel: ['[class*="MessageDate_container"]'],
    conversationTitle: ['[class*="ChatHeader_titleText"]'],
    botName: [
        '[data-testid="chat-members-display-text"]',
        '[class*="ChatHeader_subText"]',
        '[class*="BotInfoCardHeader_botName"]'
    ],
    chatRows: [
        '[class*="ChatHistoryListItem_wrapper"]',
        '[class*="SidebarItem_sidebarItem"]',
        '[class*="SidebarItem_wrapper"]',
        '[data-testid*="sidebar-item"]',
        '[class*="ChatHistoryPage_chatRow"]',
        'a[href*="/chat/"]'
    ],
    chatRowTitle: [
        '[class*="ChatHistoryListItem_title"]',
        '[class*="SidebarItem_title"]',
        '[class*="SidebarItem_name"]',
        '[class*="ChatHistoryPage_chatTitle"]',
        '[data-testid*="chat-title"]'
    ],
    chatRowPreview: [
        '[class*="ChatHistoryListItem_previewText"]',
        '[class*="SidebarItem_subtitle"]',
        '[class*="SidebarItem_description"]',
        '[class*="ChatHistoryListItem_subtitle"]',
        '[class*="ChatHistoryPage_chatSubtitle"]'
    ],
    chatLinks: ['a[href*="/chat/"]']
};

const turndownService = typeof TurndownService === 'function'
    ? new TurndownService({
        codeBlockStyle: 'fenced',
        headingStyle: 'atx',
        bulletListMarker: '-',
        emDelimiter: '_',
        strongDelimiter: '**'
    })
    : null;

let nextDataPayload = null;
let nextDataChatRecords = null;

const CHAT_HISTORY_CAPTURE_EVENT = '__poelogChatHistoryCapture';
const CHAT_HISTORY_COMMAND_EVENT = '__poelogChatHistoryCommand';
const CHAT_HISTORY_COMMAND_RESPONSE_EVENT = '__poelogChatHistoryCommandResponse';
const CHAT_HISTORY_CAPTURE_BRIDGE_ID = 'poelog-chat-history-bridge';
const CHAT_HISTORY_CAPTURE_BRIDGE_PATH = 'page_bridge.js';

const chatHistoryCaptureState = {
    listenerInstalled: false,
    recordsByUrl: new Map(),
    orderedUrls: [],
    requestTemplates: [],
    pageInfo: null,
    lastActivityAt: 0
};

let messagePayloadCache = new WeakMap();
const messagePayloadById = new Map();

function resetPageScopedDataCaches() {
    nextDataPayload = null;
    nextDataChatRecords = null;
    messagePayloadCache = new WeakMap();
    messagePayloadById.clear();
}

function getNextDataPayload() {
    if (nextDataPayload) {
        return nextDataPayload;
    }

    const nextDataScript = document.getElementById('__NEXT_DATA__');
    if (!nextDataScript?.textContent) {
        return null;
    }

    try {
        nextDataPayload = JSON.parse(nextDataScript.textContent);
    } catch (error) {
        nextDataPayload = null;
    }

    return nextDataPayload;
}

function resetChatHistoryCaptureState() {
    chatHistoryCaptureState.recordsByUrl.clear();
    chatHistoryCaptureState.orderedUrls = [];
    chatHistoryCaptureState.requestTemplates = [];
    chatHistoryCaptureState.pageInfo = null;
    chatHistoryCaptureState.lastActivityAt = 0;
}

function normalizeCapturedChatHistoryRecord(record) {
    const url = normalizeCandidateChatUrl(record?.url || record?.chatCode);
    const title = collapseWhitespace(record?.title);
    if (!url || !title) {
        return null;
    }

    return {
        title,
        preview: collapseWhitespace(record?.preview),
        url,
        lastInteractionTime: Number(record?.lastInteractionTime || 0),
        cursor: typeof record?.cursor === 'string' ? record.cursor : null
    };
}

function mergeCapturedChatHistoryRecords(records = []) {
    records.forEach((record) => {
        const normalizedRecord = normalizeCapturedChatHistoryRecord(record);
        if (!normalizedRecord) {
            return;
        }

        const existingRecord = chatHistoryCaptureState.recordsByUrl.get(normalizedRecord.url);
        if (!existingRecord) {
            chatHistoryCaptureState.recordsByUrl.set(normalizedRecord.url, normalizedRecord);
            chatHistoryCaptureState.orderedUrls.push(normalizedRecord.url);
            return;
        }

        existingRecord.title = normalizedRecord.title || existingRecord.title;
        existingRecord.preview = normalizedRecord.preview || existingRecord.preview;
        existingRecord.lastInteractionTime = normalizedRecord.lastInteractionTime || existingRecord.lastInteractionTime;
        existingRecord.cursor = normalizedRecord.cursor || existingRecord.cursor;
    });
}

function getCapturedChatHistoryRecords() {
    return chatHistoryCaptureState.orderedUrls
        .map((url) => chatHistoryCaptureState.recordsByUrl.get(url))
        .filter(Boolean);
}

function getChatHistoryCaptureSummary() {
    return {
        recordCount: getCapturedChatHistoryRecords().length,
        requestTemplateCount: chatHistoryCaptureState.requestTemplates.length,
        pageInfo: chatHistoryCaptureState.pageInfo,
        lastActivityAt: chatHistoryCaptureState.lastActivityAt
    };
}

function updateChatHistoryCaptureTemplates(request) {
    if (!request?.url) {
        return;
    }

    const templateKey = request.queryName || request.queryId || request.url;
    const existingTemplates = chatHistoryCaptureState.requestTemplates.filter(
        (candidate) => (candidate.queryName || candidate.queryId || candidate.url) !== templateKey
    );

    chatHistoryCaptureState.requestTemplates = [request].concat(existingTemplates).slice(0, 8);
}

function handleChatHistoryCaptureEvent(event) {
    if (!event?.detail) {
        return;
    }

    let detail = event.detail;
    if (typeof detail === 'string') {
        try {
            detail = JSON.parse(detail);
        } catch (error) {
            return;
        }
    }

    if (!detail || typeof detail !== 'object') {
        return;
    }

    mergeCapturedChatHistoryRecords(detail.records || []);
    if (detail.pageInfo && typeof detail.pageInfo === 'object') {
        chatHistoryCaptureState.pageInfo = {
            endCursor: typeof detail.pageInfo.endCursor === 'string' ? detail.pageInfo.endCursor : null,
            hasNextPage: Boolean(detail.pageInfo.hasNextPage)
        };
    }
    if (detail.request) {
        updateChatHistoryCaptureTemplates(detail.request);
    }
    chatHistoryCaptureState.lastActivityAt = Date.now();
}

function ensureChatHistoryCaptureListener() {
    if (chatHistoryCaptureState.listenerInstalled) {
        return;
    }

    document.addEventListener(CHAT_HISTORY_CAPTURE_EVENT, handleChatHistoryCaptureEvent);
    chatHistoryCaptureState.listenerInstalled = true;
}

function ensureChatHistoryCaptureBridge() {
    ensureChatHistoryCaptureListener();

    if (document.getElementById(CHAT_HISTORY_CAPTURE_BRIDGE_ID)) {
        return;
    }

    const bridgeScript = document.createElement('script');
    bridgeScript.id = CHAT_HISTORY_CAPTURE_BRIDGE_ID;
    bridgeScript.src = chrome.runtime.getURL(CHAT_HISTORY_CAPTURE_BRIDGE_PATH);
    bridgeScript.async = false;
    (document.documentElement || document.head || document.body).appendChild(bridgeScript);
}

async function sendChatHistoryBridgeCommand(action, payload = {}) {
    ensureChatHistoryCaptureBridge();
    await waitForCondition(
        () => document.documentElement?.dataset?.poelogChatHistoryBridgeReady === '1',
        {
            timeoutMs: 5_000,
            intervalMs: 50,
            errorMessage: 'The PoeLog page bridge did not finish loading.'
        }
    );

    const commandId = `poelog-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
        const timeoutHandle = window.setTimeout(() => {
            document.removeEventListener(CHAT_HISTORY_COMMAND_RESPONSE_EVENT, handleResponse);
            reject(new Error(`Timed out waiting for the PoeLog page bridge action: ${action}`));
        }, 20_000);

        function handleResponse(event) {
            if (!event?.detail) {
                return;
            }

            let detail = event.detail;
            if (typeof detail === 'string') {
                try {
                    detail = JSON.parse(detail);
                } catch (error) {
                    return;
                }
            }

            if (!detail || detail.commandId !== commandId) {
                return;
            }

            window.clearTimeout(timeoutHandle);
            document.removeEventListener(CHAT_HISTORY_COMMAND_RESPONSE_EVENT, handleResponse);
            resolve(detail);
        }

        document.addEventListener(CHAT_HISTORY_COMMAND_RESPONSE_EVENT, handleResponse);
        document.dispatchEvent(new CustomEvent(CHAT_HISTORY_COMMAND_EVENT, {
            detail: JSON.stringify({
                commandId,
                action,
                payload
            })
        }));
    });
}

ensureChatHistoryCaptureListener();

function getChatRoot() {
    return document.querySelector('main') || document;
}

function getScrollRoot() {
    return document.scrollingElement || document.documentElement || document.body;
}

function isDocumentScrollContainer(container) {
    const scrollRoot = getScrollRoot();
    return container === scrollRoot || container === document.documentElement || container === document.body;
}

function queryFirst(root, selectors) {
    for (const selector of selectors) {
        const element = root.querySelector(selector);
        if (element) {
            return element;
        }
    }
    return null;
}

function queryAll(root, selectors) {
    for (const selector of selectors) {
        const elements = Array.from(root.querySelectorAll(selector));
        if (elements.length > 0) {
            return elements;
        }
    }
    return [];
}

function queryAllAcrossSelectors(root, selectors) {
    const elements = [];
    const seenElements = new Set();

    selectors.forEach((selector) => {
        root.querySelectorAll(selector).forEach((element) => {
            if (seenElements.has(element)) {
                return;
            }

            seenElements.add(element);
            elements.push(element);
        });
    });

    return elements;
}

function cleanText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function collapseWhitespace(value) {
    return cleanText(value).replace(/\s+/g, ' ');
}

function comparableText(value) {
    return collapseWhitespace(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCondition(predicate, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const intervalMs = options.intervalMs ?? 250;
    const errorMessage = options.errorMessage ?? 'Timed out waiting for Poe content.';
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const result = predicate();
        if (result) {
            return result;
        }
        await wait(intervalMs);
    }

    throw new Error(errorMessage);
}

function getMessageNodes(root = getChatRoot()) {
    return queryAll(root, SELECTORS.messageNodes);
}

function getMessageGroups(root = getChatRoot()) {
    return queryAll(root, SELECTORS.messageGroups);
}

function isChatsIndexPage() {
    return /^\/chats\/?$/i.test(window.location.pathname || '');
}

function sanitizeFilenameSegment(value) {
    return collapseWhitespace(value)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
}

function buildFilename(title, messageCount) {
    const baseName = sanitizeFilenameSegment(title) || 'Poe conversation';
    return `${baseName} (${messageCount} messages).txt`;
}

function getConversationTitle(root) {
    const heading = cleanText(queryFirst(root, SELECTORS.conversationTitle)?.textContent);
    if (heading) {
        return heading;
    }

    return cleanText(document.title).replace(/\s+-\s+Poe$/, '') || 'Poe conversation';
}

function getBotName(root) {
    return cleanText(queryFirst(root, SELECTORS.botName)?.textContent) || 'Bot';
}

function removeElements(root, selectors) {
    for (const selector of selectors) {
        root.querySelectorAll(selector).forEach((element) => element.remove());
    }
}

function extractMessageText(bubble) {
    const markdownNode = queryFirst(bubble, SELECTORS.markdownContainer);
    if (markdownNode && turndownService) {
        const markdownClone = markdownNode.cloneNode(true);
        removeElements(markdownClone, ['button', '[class*="MessageOverflowActions"]']);

        const markdown = cleanText(turndownService.turndown(markdownClone));
        if (markdown) {
            return markdown;
        }
    }

    const textNode = queryFirst(bubble, SELECTORS.messageText) || bubble;
    const textClone = textNode.cloneNode(true);
    removeElements(textClone, ['button', '[class*="MessageOverflowActions"]']);
    return cleanText(textClone.innerText || textClone.textContent);
}

function normalizeAttachmentUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        return null;
    }

    try {
        return new URL(url, window.location.href).toString();
    } catch (error) {
        return null;
    }
}

function getFirstSrcSetUrl(srcSet) {
    if (typeof srcSet !== 'string' || !srcSet.trim()) {
        return '';
    }

    const firstCandidate = srcSet
        .split(',')
        .map((entry) => cleanText(entry).split(/\s+/)[0])
        .find(Boolean);

    return firstCandidate || '';
}

function getMediaSourceUrl(node) {
    if (!(node instanceof Element)) {
        return null;
    }

    const tagName = String(node.tagName || '').toUpperCase();
    if (tagName === 'IMG') {
        return normalizeAttachmentUrl(
            node.currentSrc
            || node.getAttribute('src')
            || getFirstSrcSetUrl(node.getAttribute('srcset'))
        );
    }

    if (tagName === 'VIDEO' || tagName === 'AUDIO') {
        const nestedSource = node.querySelector('source[src], source[srcset]');
        return normalizeAttachmentUrl(
            node.currentSrc
            || node.getAttribute('src')
            || nestedSource?.getAttribute('src')
            || getFirstSrcSetUrl(nestedSource?.getAttribute('srcset'))
            || node.getAttribute('poster')
        );
    }

    if (tagName === 'SOURCE') {
        return normalizeAttachmentUrl(node.getAttribute('src') || getFirstSrcSetUrl(node.getAttribute('srcset')));
    }

    if (tagName === 'PICTURE') {
        return getMediaSourceUrl(node.querySelector('img[src], img[srcset], source[src], source[srcset]'));
    }

    return null;
}

function getFilenameHintFromUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        return '';
    }

    try {
        const pathname = new URL(url).pathname || '';
        const segment = pathname.split('/').pop() || '';
        return cleanText(decodeURIComponent(segment));
    } catch (error) {
        return '';
    }
}

function getAttachmentMediaNode(candidateNode) {
    if (!(candidateNode instanceof Element)) {
        return null;
    }

    if (candidateNode.matches('img, picture, video, audio, source')) {
        return candidateNode;
    }

    return candidateNode.querySelector('img[src], img[srcset], picture, video, audio, source[src], source[srcset]');
}

function isLikelyDecorativeAttachmentCandidate(candidateNode) {
    if (!(candidateNode instanceof Element)) {
        return true;
    }

    const mediaNode = getAttachmentMediaNode(candidateNode);
    const descriptorText = collapseWhitespace([
        candidateNode.className,
        candidateNode.getAttribute('aria-label'),
        candidateNode.getAttribute('data-testid'),
        mediaNode?.className,
        mediaNode?.getAttribute?.('alt')
    ].filter(Boolean).join(' ')).toLowerCase();

    if (/(avatar|emoji|icon|reaction|spinner|badge|tooltip|logo)/i.test(descriptorText)) {
        return true;
    }

    if (mediaNode?.matches('img')) {
        const width = Math.max(
            Number(mediaNode.getAttribute('width')) || 0,
            mediaNode.naturalWidth || 0,
            mediaNode.clientWidth || 0
        );
        const height = Math.max(
            Number(mediaNode.getAttribute('height')) || 0,
            mediaNode.naturalHeight || 0,
            mediaNode.clientHeight || 0
        );

        if (width > 0 && height > 0 && width <= 48 && height <= 48 && !candidateNode.matches('a[href][download]')) {
            return true;
        }
    }

    return false;
}

function collectAttachmentCandidateNodes(bubble) {
    const candidates = [];
    const seenCandidates = new Set();

    function addCandidate(candidateNode) {
        if (!(candidateNode instanceof Element)) {
            return;
        }

        let normalizedCandidate = candidateNode;
        if (!normalizedCandidate.matches('a[href], img, picture, video, audio, source')) {
            normalizedCandidate = normalizedCandidate.closest('a[href], picture, video, audio') || normalizedCandidate;
        }

        const wrappingLink = normalizedCandidate.closest('a[href]');
        if (wrappingLink) {
            normalizedCandidate = wrappingLink;
        } else if (normalizedCandidate.matches('source')) {
            normalizedCandidate = normalizedCandidate.closest('picture, video, audio') || normalizedCandidate;
        }

        if (seenCandidates.has(normalizedCandidate) || isLikelyDecorativeAttachmentCandidate(normalizedCandidate)) {
            return;
        }

        seenCandidates.add(normalizedCandidate);
        candidates.push(normalizedCandidate);
    }

    queryAllAcrossSelectors(bubble, SELECTORS.attachments).forEach(addCandidate);
    queryAllAcrossSelectors(bubble, SELECTORS.attachmentMedia).forEach(addCandidate);

    bubble.querySelectorAll('a[href]').forEach((linkNode) => {
        if (linkNode.hasAttribute('download') || linkNode.querySelector('img, picture, video, audio, source')) {
            addCandidate(linkNode);
        }
    });

    return candidates;
}

function isLikelyAttachmentHref(linkNode, url) {
    if (!(linkNode instanceof Element) || !url) {
        return false;
    }

    try {
        const parsedUrl = new URL(url, window.location.href);
        if (/^(javascript|mailto|tel):/i.test(parsedUrl.protocol)) {
            return false;
        }

        if (linkNode.hasAttribute('download')) {
            return true;
        }

        if (parsedUrl.origin === window.location.origin && parsedUrl.pathname === window.location.pathname) {
            return false;
        }

        if (/^\/chat\//i.test(parsedUrl.pathname || '')) {
            return false;
        }

        if (linkNode.querySelector('img, picture, video, audio, source')) {
            return true;
        }

        return /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|flac|pdf|zip|docx?|xlsx?|pptx?|txt|csv|json)$/i.test(parsedUrl.pathname || '');
    } catch (error) {
        return false;
    }
}

function selectBestAttachmentUrl(linkNode, mediaNode) {
    const linkUrl = normalizeAttachmentUrl(linkNode?.getAttribute?.('href'));
    const mediaUrl = getMediaSourceUrl(mediaNode);

    if (isLikelyAttachmentHref(linkNode, linkUrl)) {
        return linkUrl;
    }

    return mediaUrl || linkUrl;
}

function getAttachmentTitle(candidateNode, linkNode, mediaNode, url) {
    return cleanText(queryFirst(candidateNode, SELECTORS.attachmentTitle)?.textContent)
        || cleanText(linkNode?.getAttribute?.('download'))
        || cleanText(mediaNode?.getAttribute?.('alt'))
        || cleanText(mediaNode?.getAttribute?.('aria-label'))
        || cleanText(linkNode?.getAttribute?.('aria-label'))
        || cleanText(candidateNode.getAttribute('aria-label'))
        || cleanText(linkNode?.textContent)
        || cleanText(candidateNode.textContent)
        || getFilenameHintFromUrl(url);
}

function getAttachmentKind(mediaNode, url) {
    const lowerUrl = String(url || '').toLowerCase();

    if (mediaNode?.matches('video') || /\.(mp4|webm|mov|m4v|mkv)(?:$|[?#])/i.test(lowerUrl)) {
        return 'video';
    }

    if (mediaNode?.matches('audio') || /\.(mp3|wav|ogg|flac|m4a)(?:$|[?#])/i.test(lowerUrl)) {
        return 'audio';
    }

    if (mediaNode?.matches('img, picture') || /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(lowerUrl)) {
        return 'image';
    }

    return 'file';
}

function getMessageNumericId(messageNode) {
    const rawId = String(messageNode?.id || '');
    const match = rawId.match(/^message-(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
}

function hasMessageAttachmentPayload(candidate) {
    return Array.isArray(candidate?.attachments)
        && candidate.attachments.some((attachment) => Boolean(
            typeof attachment?.url === 'string'
            || typeof attachment?.file?.url === 'string'
            || typeof attachment?.file?.thumbnailUrl === 'string'
        ));
}

function isMessagePayloadCandidate(candidate, messageNumericId) {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }

    const candidateMessageId = Number(candidate.messageId || 0) || null;
    const hasText = typeof candidate.text === 'string' || typeof candidate.content === 'string';
    const hasAttachments = hasMessageAttachmentPayload(candidate);
    if (!hasText && !hasAttachments) {
        return false;
    }

    if (messageNumericId && candidateMessageId === messageNumericId) {
        return true;
    }

    return candidate.__isMessageOrDeletedMessage === 'Message'
        || candidate.__typename === 'Message';
}

function findMessagePayloadInObject(source, messageNumericId, state = { visited: new WeakSet(), nodesVisited: 0 }, depth = 0) {
    if (!source || typeof source !== 'object' || depth > 16 || state.nodesVisited > 3_500) {
        return null;
    }

    if (state.visited.has(source)) {
        return null;
    }

    state.visited.add(source);
    state.nodesVisited += 1;

    if (isMessagePayloadCandidate(source, messageNumericId)) {
        const candidateMessageId = Number(source.messageId || 0) || null;
        if (messageNumericId && candidateMessageId === messageNumericId) {
            return source;
        }
    }

    const values = Array.isArray(source)
        ? source.slice(0, 200)
        : Object.values(source).slice(0, 250);

    let fallbackMatch = null;

    for (const value of values) {
        const match = findMessagePayloadInObject(value, messageNumericId, state, depth + 1);
        if (!match) {
            continue;
        }

        const candidateMessageId = Number(match.messageId || 0) || null;
        if (messageNumericId && candidateMessageId === messageNumericId) {
            return match;
        }

        fallbackMatch = fallbackMatch || match;
    }

    if (fallbackMatch) {
        return fallbackMatch;
    }

    return isMessagePayloadCandidate(source, messageNumericId) ? source : null;
}

function getMessagePayload(messageNode) {
    if (!(messageNode instanceof Element)) {
        return null;
    }

    const messageNumericId = getMessageNumericId(messageNode);
    if (messageNumericId && messagePayloadById.has(messageNumericId)) {
        const cachedPayloadById = messagePayloadById.get(messageNumericId) || null;
        messagePayloadCache.set(messageNode, {
            messageNumericId,
            payload: cachedPayloadById
        });
        return cachedPayloadById;
    }

    const cachedPayload = messagePayloadCache.get(messageNode);
    if (cachedPayload !== undefined) {
        if (!cachedPayload || cachedPayload.messageNumericId === messageNumericId) {
            return cachedPayload?.payload || null;
        }
    }
    const probeNodes = [
        messageNode,
        queryFirst(messageNode, SELECTORS.humanBubble),
        queryFirst(messageNode, SELECTORS.botBubble),
        ...Array.from(messageNode.querySelectorAll('*')).slice(0, 20)
    ].filter(Boolean);

    let payload = null;

    for (const probeNode of probeNodes) {
        const reactRoots = getReactProbeRoots(probeNode);
        for (const reactRoot of reactRoots) {
            const match = findMessagePayloadInObject(reactRoot, messageNumericId);
            if (!match) {
                continue;
            }

            const candidateMessageId = Number(match.messageId || 0) || null;
            if (messageNumericId && candidateMessageId !== messageNumericId) {
                continue;
            }

            payload = match;
            if (messageNumericId) {
                messagePayloadById.set(messageNumericId, payload);
            }
            messagePayloadCache.set(messageNode, {
                messageNumericId,
                payload
            });
            return payload;
        }
    }

    messagePayloadCache.set(messageNode, {
        messageNumericId,
        payload
    });
    return payload;
}

function shouldProbePayloadAttachments(bubble, domAttachmentData, options) {
    if (!options?.includeMediaDownloads) {
        return false;
    }

    if ((domAttachmentData?.files || []).length > 0 || (domAttachmentData?.lines || []).length > 0) {
        return true;
    }

    return Boolean(queryFirst(bubble, [
        '[class*="MarkdownImage_imageContainer"]',
        '[class*="MarkdownImage_image"]',
        'img[src]',
        'img[srcset]',
        'picture',
        'video',
        'audio',
        'a[href][download]',
        '[class*="Attachment"]',
        '[class*="FileInfo"]'
    ]));
}

function getAttachmentKindFromMimeType(mimeType, url) {
    const normalizedMimeType = String(mimeType || '').toLowerCase();
    if (normalizedMimeType.startsWith('image/')) {
        return 'image';
    }

    if (normalizedMimeType.startsWith('video/')) {
        return 'video';
    }

    if (normalizedMimeType.startsWith('audio/')) {
        return 'audio';
    }

    return getAttachmentKind(null, url);
}

function normalizePayloadAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return null;
    }

    const url = normalizeAttachmentUrl(
        attachment.url
        || attachment.file?.url
        || attachment.file?.thumbnailUrl
    );
    if (!url) {
        return null;
    }

    const title = cleanText(
        attachment.name
        || attachment.title
        || attachment.file?.name
        || attachment.fileName
    ) || getFilenameHintFromUrl(url);

    return {
        url,
        title,
        kind: getAttachmentKindFromMimeType(attachment.file?.mimeType || attachment.mimeType, url)
    };
}

function extractAttachmentDataFromPayload(messageNode) {
    const messagePayload = getMessagePayload(messageNode);
    if (!Array.isArray(messagePayload?.attachments) || messagePayload.attachments.length === 0) {
        return {
            lines: [],
            files: []
        };
    }

    const files = [];
    const lines = [];
    const seenUrls = new Set();

    messagePayload.attachments.forEach((attachment) => {
        const normalizedAttachment = normalizePayloadAttachment(attachment);
        if (!normalizedAttachment || seenUrls.has(normalizedAttachment.url)) {
            return;
        }

        seenUrls.add(normalizedAttachment.url);
        files.push(normalizedAttachment);
        lines.push(
            normalizedAttachment.title && normalizedAttachment.title !== normalizedAttachment.url
                ? `- ${normalizedAttachment.title}: ${normalizedAttachment.url}`
                : `- ${normalizedAttachment.url}`
        );
    });

    return {
        lines,
        files
    };
}

function mergeAttachmentDataSources(...attachmentSources) {
    const lines = [];
    const files = [];
    const seenUrls = new Set();

    attachmentSources.forEach((attachmentSource) => {
        (attachmentSource?.files || []).forEach((file, index) => {
            const url = typeof file?.url === 'string' ? file.url.trim() : '';
            if (!url || seenUrls.has(url)) {
                return;
            }

            seenUrls.add(url);
            const title = cleanText(file?.title);
            files.push({
                url,
                title,
                kind: file?.kind || 'file'
            });

            const explicitLine = attachmentSource?.lines?.[index];
            lines.push(explicitLine || (title && title !== url ? `- ${title}: ${url}` : `- ${url}`));
        });
    });

    return {
        lines,
        files
    };
}

function extractAttachmentData(bubble) {
    const attachmentLines = [];
    const attachmentFiles = [];
    const seenUrls = new Set();

    for (const attachmentNode of collectAttachmentCandidateNodes(bubble)) {
        const linkNode = attachmentNode.matches('a[href]')
            ? attachmentNode
            : attachmentNode.closest('a[href]') || attachmentNode.querySelector('a[href]');
        const mediaNode = getAttachmentMediaNode(attachmentNode);
        const url = selectBestAttachmentUrl(linkNode, mediaNode);

        if (!url || seenUrls.has(url)) {
            continue;
        }

        seenUrls.add(url);
        const title = getAttachmentTitle(attachmentNode, linkNode, mediaNode, url);

        attachmentLines.push(title && title !== url ? `- ${title}: ${url}` : `- ${url}`);
        attachmentFiles.push({
            url,
            title,
            kind: getAttachmentKind(mediaNode, url)
        });
    }

    return {
        lines: attachmentLines,
        files: attachmentFiles
    };
}

function isElementScrollable(element) {
    if (!element) {
        return false;
    }

    const style = window.getComputedStyle(element);
    return /(auto|scroll|overlay)/i.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20;
}

function getScrollableAncestors(seedNode) {
    const candidates = [];
    let currentNode = seedNode?.parentElement || null;

    while (currentNode && currentNode !== document.documentElement) {
        if (isElementScrollable(currentNode) && !candidates.includes(currentNode)) {
            candidates.push(currentNode);
        }
        currentNode = currentNode.parentElement;
    }

    const scrollRoot = getScrollRoot();
    if (scrollRoot && !candidates.includes(scrollRoot)) {
        candidates.push(scrollRoot);
    }

    return candidates;
}

function getViewportHeight(container) {
    return isDocumentScrollContainer(container) ? window.innerHeight : container.clientHeight;
}

function getScrollHeight(container) {
    return isDocumentScrollContainer(container) ? getScrollRoot().scrollHeight : container.scrollHeight;
}

function getScrollTop(container) {
    return isDocumentScrollContainer(container) ? window.scrollY : container.scrollTop;
}

function getScrollRange(container) {
    const metrics = getScrollMetrics(container);
    return Math.max(metrics.height - metrics.viewportHeight, 0);
}

function getScrollMetrics(container) {
    const height = getScrollHeight(container);
    const top = getScrollTop(container);
    const viewportHeight = getViewportHeight(container);

    return {
        height,
        top,
        viewportHeight,
        bottomGap: Math.max(height - (top + viewportHeight), 0)
    };
}

function scrollContainerTo(container, top) {
    const clampedTop = Math.max(0, top);

    if (isDocumentScrollContainer(container)) {
        window.scrollTo({ top: clampedTop, behavior: 'auto' });
        return;
    }

    container.scrollTop = clampedTop;
}

function scrollContainerBy(container, delta) {
    scrollContainerTo(container, getScrollTop(container) + delta);
}

function getNodeTextSignature(node) {
    return collapseWhitespace(node?.textContent || '').slice(0, 120);
}

function buildMessageWindowSignature() {
    const messageNodes = getMessageNodes();
    if (messageNodes.length === 0) {
        return '0';
    }

    const firstNode = messageNodes[0];
    const lastNode = messageNodes[messageNodes.length - 1];
    return [
        String(messageNodes.length),
        firstNode?.id || getNodeTextSignature(firstNode),
        lastNode?.id || getNodeTextSignature(lastNode)
    ].join('|');
}

function buildCatalogWindowSignature(rows = getChatCatalogRows()) {
    if (rows.length === 0) {
        return '0';
    }

    const sampleRows = rows.slice(0, 4).concat(rows.slice(-4));
    const markers = sampleRows.map((row) => {
        const title = collapseWhitespace(queryFirst(row, SELECTORS.chatRowTitle)?.textContent);
        const preview = collapseWhitespace(getChatPreview(row, title)).slice(0, 60);
        return `${title}\u0000${preview}`;
    });

    return `${rows.length}|${markers.join('|')}`;
}

function getCatalogCandidateRoots(candidate) {
    return [
        candidate.closest('[class*="ChatHistoryListItem_wrapper"]'),
        candidate.closest('[class*="SidebarItem_sidebarItem"]'),
        candidate.closest('[class*="SidebarItem_wrapper"]'),
        candidate.closest('[data-testid*="sidebar-item"]'),
        candidate.closest('a[href*="/chat/"]'),
        candidate
    ].filter(Boolean);
}

function isSidebarCatalogElement(element) {
    return Boolean(
        element?.closest('menu')
        || element?.closest('nav')
        || element?.closest('aside')
        || element?.closest('[class*="MainLeftSidebar"]')
        || element?.closest('[class*="LoggedInAppSidebar"]')
        || element?.closest('[class*="LeftSidebar"]')
    );
}

function getCatalogRowBuckets(root = document) {
    const seenRows = new Set();
    const allRows = [];

    SELECTORS.chatRows.forEach((selector) => {
        root.querySelectorAll(selector).forEach((candidate) => {
            getCatalogCandidateRoots(candidate).forEach((row) => {
                if (seenRows.has(row) || !isLikelyChatRow(row)) {
                    return;
                }

                seenRows.add(row);
                allRows.push(row);
            });
        });
    });

    const mainRows = allRows.filter((row) => !isSidebarCatalogElement(row));
    const sidebarRows = allRows.filter((row) => isSidebarCatalogElement(row));

    return {
        allRows,
        mainRows,
        sidebarRows,
        preferredRows: mainRows.length > 0 ? mainRows : allRows
    };
}

async function detectResponsiveScrollContainer(seedNode, signatureBuilder, direction) {
    const candidates = getScrollableAncestors(seedNode)
        .filter((candidate, index, allCandidates) => allCandidates.indexOf(candidate) === index)
        .sort((left, right) => getScrollRange(right) - getScrollRange(left));

    if (candidates.length === 0) {
        return getScrollRoot();
    }

    for (const candidate of candidates) {
        const range = getScrollRange(candidate);
        if (range < 32) {
            continue;
        }

        const before = getScrollMetrics(candidate);
        const beforeSignature = signatureBuilder();
        const probeStep = (direction < 0 ? -1 : 1) * Math.max(120, Math.min(320, Math.floor(before.viewportHeight * 0.35)));

        scrollContainerBy(candidate, probeStep);
        await wait(220);

        const after = getScrollMetrics(candidate);
        const afterSignature = signatureBuilder();

        scrollContainerTo(candidate, before.top);
        await wait(150);

        if (after.top !== before.top || afterSignature !== beforeSignature) {
            return candidate;
        }
    }

    return candidates[0];
}

function extractMessageEntry(messageNode, botName, options) {
    const humanBubble = queryFirst(messageNode, SELECTORS.humanBubble);
    const botBubble = queryFirst(messageNode, SELECTORS.botBubble);

    let bubble = null;
    let speaker = null;
    let shouldInclude = false;

    if (humanBubble) {
        bubble = humanBubble;
        speaker = 'Human';
        shouldInclude = options.includeHuman;
    } else if (botBubble) {
        bubble = botBubble;
        speaker = botName;
        shouldInclude = options.includeBot;
    } else {
        return null;
    }

    if (!shouldInclude) {
        return null;
    }

    const content = extractMessageText(bubble);
    const domAttachmentData = extractAttachmentData(bubble);
    const attachmentData = shouldProbePayloadAttachments(bubble, domAttachmentData, options)
        ? mergeAttachmentDataSources(domAttachmentData, extractAttachmentDataFromPayload(messageNode))
        : domAttachmentData;
    if (!content && attachmentData.lines.length === 0) {
        return null;
    }

    return {
        speaker,
        content: content || '[No text content]',
        attachments: attachmentData.lines,
        attachmentFiles: attachmentData.files
    };
}

function buildMessageRecordKey(messageNode, entry, dateLabel) {
    return messageNode.id || [
        entry.speaker,
        dateLabel || '',
        entry.content.slice(0, 200),
        entry.attachments.join('|').slice(0, 200)
    ].join('\u0000');
}

function extractMessageRecord(messageNode, botName, options, dateLabel) {
    const entry = extractMessageEntry(messageNode, botName, options);
    if (!entry) {
        return null;
    }

    return {
        key: buildMessageRecordKey(messageNode, entry, dateLabel),
        dateLabel,
        ...entry
    };
}

function captureVisibleMessageRecords(botName, options) {
    const root = getChatRoot();
    const groups = getMessageGroups(root);

    if (groups.length === 0) {
        return getMessageNodes(root)
            .map((messageNode) => extractMessageRecord(messageNode, botName, options, null))
            .filter(Boolean);
    }

    return groups.reduce((records, group) => {
        const dateLabel = cleanText(queryFirst(group, SELECTORS.dateLabel)?.textContent) || null;
        getMessageNodes(group).forEach((messageNode) => {
            const record = extractMessageRecord(messageNode, botName, options, dateLabel);
            if (record) {
                records.push(record);
            }
        });
        return records;
    }, []);
}

function arraysEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
}

function mergeSnapshotIntoHistory(orderedKeys, recordMap, snapshotRecords) {
    if (snapshotRecords.length === 0) {
        return orderedKeys;
    }

    const snapshotKeys = snapshotRecords.map((record) => {
        recordMap.set(record.key, record);
        return record.key;
    });

    if (orderedKeys.length === 0) {
        return snapshotKeys.slice();
    }

    const existingKeys = new Set(orderedKeys);
    let overlapSize = 0;
    const maxOverlap = Math.min(snapshotKeys.length, orderedKeys.length);

    for (let size = maxOverlap; size > 0; size -= 1) {
        if (arraysEqual(snapshotKeys.slice(snapshotKeys.length - size), orderedKeys.slice(0, size))) {
            overlapSize = size;
            break;
        }
    }

    if (overlapSize > 0) {
        const unseenPrefix = snapshotKeys
            .slice(0, snapshotKeys.length - overlapSize)
            .filter((key) => !existingKeys.has(key));
        return unseenPrefix.length > 0 ? unseenPrefix.concat(orderedKeys) : orderedKeys;
    }

    const unseenKeys = snapshotKeys.filter((key) => !existingKeys.has(key));
    return unseenKeys.length > 0 ? unseenKeys.concat(orderedKeys) : orderedKeys;
}

async function waitForConversationReady() {
    await waitForCondition(
        () => getMessageNodes().length > 0,
        {
            timeoutMs: 20_000,
            intervalMs: 300,
            errorMessage: 'Poe conversation messages did not load on this page.'
        }
    );
}

function describeScrollCandidate(candidate) {
    if (isDocumentScrollContainer(candidate)) {
        return 'DOCUMENT';
    }

    const tagName = String(candidate?.tagName || 'UNKNOWN').toUpperCase();
    const className = collapseWhitespace(candidate?.className || '').slice(0, 120);
    return className ? `${tagName}.${className}` : tagName;
}

function captureConversationProgressSnapshot(scrollContainer, harvestedCount, diagnostics = null) {
    const metrics = getScrollMetrics(scrollContainer);
    const snapshot = {
        harvestedCount,
        visibleCount: getMessageNodes().length,
        windowSignature: buildMessageWindowSignature(),
        top: Math.round(metrics.top),
        height: Math.round(metrics.height),
        viewportHeight: Math.round(metrics.viewportHeight)
    };

    if (diagnostics) {
        diagnostics.maxVisibleCount = Math.max(diagnostics.maxVisibleCount, snapshot.visibleCount);
        diagnostics.maxHarvestedCount = Math.max(diagnostics.maxHarvestedCount, harvestedCount);
    }

    return snapshot;
}

function hasConversationProgress(beforeSnapshot, afterSnapshot) {
    return beforeSnapshot.harvestedCount !== afterSnapshot.harvestedCount
        || beforeSnapshot.visibleCount !== afterSnapshot.visibleCount
        || beforeSnapshot.windowSignature !== afterSnapshot.windowSignature
        || beforeSnapshot.top !== afterSnapshot.top
        || beforeSnapshot.height !== afterSnapshot.height
        || beforeSnapshot.viewportHeight !== afterSnapshot.viewportHeight;
}

function isConversationScrollContainerAtTop(scrollContainer) {
    const metrics = getScrollMetrics(scrollContainer);
    return metrics.top <= 4 || getScrollRange(scrollContainer) <= 4;
}

async function probeConversationTopHydration(scrollContainer) {
    const before = getScrollMetrics(scrollContainer);
    const nudgeDistance = Math.max(96, Math.min(220, Math.floor(before.viewportHeight * 0.22)));

    scrollContainerBy(scrollContainer, nudgeDistance);
    await wait(180);
    scrollContainerTo(scrollContainer, 0);
    await wait(260);

    const after = getScrollMetrics(scrollContainer);
    return after.top !== before.top
        || after.height !== before.height
        || after.viewportHeight !== before.viewportHeight;
}

async function scrollConversationTowardTop(scrollContainer) {
    const firstVisibleNode = getMessageNodes()[0];
    if (firstVisibleNode) {
        firstVisibleNode.scrollIntoView({ behavior: 'auto', block: 'start' });
        await wait(120);
    }

    const before = getScrollMetrics(scrollContainer);
    if (before.top <= 4) {
        return probeConversationTopHydration(scrollContainer);
    }

    const stepSize = Math.max(180, Math.min(520, Math.floor(before.viewportHeight * 0.78)));
    const targetTop = Math.max(0, before.top - stepSize);
    scrollContainerTo(scrollContainer, targetTop);

    await wait(targetTop === 0 ? 260 : 180);
    const after = getScrollMetrics(scrollContainer);
    return after.top !== before.top
        || after.height !== before.height
        || after.viewportHeight !== before.viewportHeight;
}

async function waitForConversationChange(beforeSnapshot, harvestedCount, scrollContainer, timeoutMs) {
    try {
        await waitForCondition(
            () => {
                const currentSnapshot = captureConversationProgressSnapshot(scrollContainer, harvestedCount);
                return hasConversationProgress(beforeSnapshot, currentSnapshot);
            },
            {
                timeoutMs,
                intervalMs: 100,
                errorMessage: 'Conversation history did not move.'
            }
        );
    } catch (error) {
        // Ignore the probe timeout and rely on stability detection below.
    }
}

async function verifyTopOfConversation(scrollContainer, recordMap, orderedKeys, botName, options, diagnostics) {
    let mergedKeys = orderedKeys;

    for (let round = 0; round < 8; round += 1) {
        const beforeSnapshot = captureConversationProgressSnapshot(scrollContainer, mergedKeys.length, diagnostics);

        const moved = await scrollConversationTowardTop(scrollContainer);
        if (moved) {
            diagnostics.movedRounds += 1;
            await waitForConversationChange(beforeSnapshot, mergedKeys.length, scrollContainer, 1_800);
        }
        await wait(1_100);
        mergedKeys = mergeSnapshotIntoHistory(mergedKeys, recordMap, captureVisibleMessageRecords(botName, options));

        const afterSnapshot = captureConversationProgressSnapshot(scrollContainer, mergedKeys.length, diagnostics);
        const atTop = isConversationScrollContainerAtTop(scrollContainer);
        if (atTop && !hasConversationProgress(beforeSnapshot, afterSnapshot)) {
            break;
        }
    }

    return mergedKeys;
}

async function collectConversationMessages(botName, options) {
    await waitForConversationReady();

    const initialNodes = getMessageNodes();
    if (initialNodes.length === 0) {
        throw new Error('No Poe conversation messages were found on this page.');
    }

    const scrollContainer = await detectResponsiveScrollContainer(
        initialNodes[0],
        () => buildMessageWindowSignature(),
        -1
    );
    const diagnostics = {
        initialVisibleMessageCount: initialNodes.length,
        finalVisibleMessageCount: initialNodes.length,
        initialHarvestedCount: 0,
        finalHarvestedCount: 0,
        maxVisibleCount: initialNodes.length,
        maxHarvestedCount: 0,
        candidateCount: 1,
        candidateLabels: [describeScrollCandidate(scrollContainer)],
        candidateRanges: [Math.round(getScrollRange(scrollContainer))],
        movedRounds: 0,
        progressRounds: 0,
        stableRoundsReached: 0,
        finalAtTop: false
    };

    const recordMap = new Map();
    let orderedKeys = [];
    let stableRounds = 0;

    for (let attempt = 0; attempt < 420 && stableRounds < 10; attempt += 1) {
        orderedKeys = mergeSnapshotIntoHistory(orderedKeys, recordMap, captureVisibleMessageRecords(botName, options));

        const beforeSnapshot = captureConversationProgressSnapshot(scrollContainer, orderedKeys.length, diagnostics);
        const moved = await scrollConversationTowardTop(scrollContainer);
        const atTopAfterMove = isConversationScrollContainerAtTop(scrollContainer);

        if (moved) {
            diagnostics.movedRounds += 1;
        }

        if (moved) {
            await waitForConversationChange(beforeSnapshot, orderedKeys.length, scrollContainer, atTopAfterMove ? 2_000 : 3_200);
        } else if (!atTopAfterMove) {
            await waitForConversationChange(beforeSnapshot, orderedKeys.length, scrollContainer, 1_100);
        }

        await wait(atTopAfterMove ? 1_000 : 480);
        orderedKeys = mergeSnapshotIntoHistory(orderedKeys, recordMap, captureVisibleMessageRecords(botName, options));

        const afterSnapshot = captureConversationProgressSnapshot(scrollContainer, orderedKeys.length, diagnostics);
        const noProgress = !hasConversationProgress(beforeSnapshot, afterSnapshot);
        const topBoundaryStable = atTopAfterMove && noProgress;

        if (!noProgress) {
            diagnostics.progressRounds += 1;
        }

        stableRounds = topBoundaryStable ? stableRounds + 1 : 0;
    }

    orderedKeys = await verifyTopOfConversation(scrollContainer, recordMap, orderedKeys, botName, options, diagnostics);
    orderedKeys = mergeSnapshotIntoHistory(orderedKeys, recordMap, captureVisibleMessageRecords(botName, options));
    const messages = orderedKeys.map((key) => recordMap.get(key)).filter(Boolean);

    diagnostics.finalVisibleMessageCount = getMessageNodes().length;
    diagnostics.finalHarvestedCount = messages.length;
    diagnostics.stableRoundsReached = stableRounds;
    diagnostics.finalAtTop = isConversationScrollContainerAtTop(scrollContainer);

    if (messages.length === 0) {
        throw new Error('No matching messages were found in the current Poe conversation.');
    }

    return {
        messages,
        diagnostics
    };
}

function groupMessagesIntoSections(messages) {
    return messages.reduce((sections, message) => {
        const currentSection = sections[sections.length - 1];
        if (!currentSection || currentSection.dateLabel !== message.dateLabel) {
            sections.push({
                dateLabel: message.dateLabel,
                messages: [message]
            });
            return sections;
        }

        currentSection.messages.push(message);
        return sections;
    }, []);
}

function collectUniqueAttachmentFiles(messages) {
    const seenUrls = new Set();
    const attachmentFiles = [];

    messages.forEach((message, messageIndex) => {
        (message.attachmentFiles || []).forEach((attachment, attachmentIndex) => {
            const url = typeof attachment?.url === 'string' ? attachment.url.trim() : '';
            if (!url || seenUrls.has(url)) {
                return;
            }

            seenUrls.add(url);
            attachmentFiles.push({
                url,
                title: cleanText(attachment?.title),
                kind: attachment?.kind || 'file',
                messageIndex,
                attachmentIndex
            });
        });
    });

    return attachmentFiles;
}

async function buildTranscript(options) {
    resetPageScopedDataCaches();

    const root = getChatRoot();
    const botName = getBotName(root);
    const conversationTitle = getConversationTitle(root);
    const conversationResult = await collectConversationMessages(botName, options);
    const messages = conversationResult.messages;
    const sections = groupMessagesIntoSections(messages);
    const messageCount = messages.length;
    const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0);
    const attachmentFiles = options.includeMediaDownloads ? collectUniqueAttachmentFiles(messages) : [];

    const lines = [
        `Conversation: ${conversationTitle}`,
        `Bot: ${botName}`,
        `Source: ${window.location.href}`,
        `Exported: ${new Date().toISOString()}`,
        `Messages: ${messageCount}`,
        ''
    ];

    sections.forEach((section) => {
        if (section.dateLabel) {
            lines.push(`=== ${section.dateLabel} ===`, '');
        }

        section.messages.forEach((message) => {
            lines.push(`${message.speaker}:`, '', message.content);

            if (message.attachments.length > 0) {
                lines.push('', 'Attachments:', ...message.attachments);
            }

            lines.push('');
        });
    });

    return {
        filename: buildFilename(conversationTitle, messageCount),
        messageCount,
        attachmentCount,
        attachmentFiles,
        diagnostics: conversationResult.diagnostics,
        text: `${lines.join('\n').trim()}\n`
    };
}

function getChatCatalogRows(root = document) {
    return getCatalogRowBuckets(root).preferredRows;
}

function isLikelyChatCode(value) {
    return /^(?=.{12,32}$)[a-z0-9]+$/.test(value || '')
        && /[a-z]/.test(value || '')
        && /\d/.test(value || '')
        && !/^chats?$/.test(value || '');
}

function normalizeCandidateChatUrl(candidate) {
    if (typeof candidate !== 'string') {
        return null;
    }

    const value = candidate.trim();
    if (!value) {
        return null;
    }

    if (/^https?:\/\//i.test(value)) {
        const directMatch = value.match(/^https?:\/\/[^\s"']+\/chat\/[a-z0-9]{12,32}/);
        return directMatch ? directMatch[0] : null;
    }

    if (/^\/chat\/[a-z0-9]{12,32}$/.test(value)) {
        return new URL(value, window.location.origin).toString();
    }

    if (/^\/[a-z0-9]{12,32}$/.test(value)) {
        return new URL(`/chat${value}`, window.location.origin).toString();
    }

    if (isLikelyChatCode(value)) {
        return new URL(`/chat/${value}`, window.location.origin).toString();
    }

    return null;
}

function extractChatUrlFromCompositeString(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const directMatch = normalizeCandidateChatUrl(value);
    if (directMatch) {
        return directMatch;
    }

    const absoluteUrlMatch = value.match(/https?:\/\/[^\s"']+\/chat\/[a-z0-9]{12,32}/);
    if (absoluteUrlMatch) {
        return absoluteUrlMatch[0];
    }

    const relativeUrlMatch = value.match(/\/chat\/[a-z0-9]{12,32}/);
    if (relativeUrlMatch) {
        return new URL(relativeUrlMatch[0], window.location.origin).toString();
    }

    const embeddedCodeMatch = value.match(/(?:chat(?:_|\s)?code|conversation(?:_|\s)?code|chatId|chat_id|slug)["'=:\s]+([a-z0-9]{12,32})/i);
    if (embeddedCodeMatch) {
        return normalizeCandidateChatUrl(embeddedCodeMatch[1]);
    }

    return null;
}

function extractKnownChatUrlFromObject(source) {
    const fieldNames = [
        'chatCode',
        'chat_code',
        'conversationCode',
        'conversation_code',
        'href',
        'url',
        'to',
        'pathname',
        'slug'
    ];

    for (const fieldName of fieldNames) {
        if (typeof source[fieldName] === 'string') {
            const match = extractChatUrlFromCompositeString(source[fieldName]) || normalizeCandidateChatUrl(source[fieldName]);
            if (match) {
                return match;
            }
        }
    }

    for (const [fieldName, value] of Object.entries(source).slice(0, 160)) {
        if (typeof value !== 'string') {
            continue;
        }

        if (/chat.*code|conversation.*code|href|url|pathname|slug|link/i.test(fieldName)) {
            const match = extractChatUrlFromCompositeString(value) || normalizeCandidateChatUrl(value);
            if (match) {
                return match;
            }
        }
    }

    return null;
}

function searchObjectForChatUrl(source, state = { visited: new WeakSet(), nodesVisited: 0 }, depth = 0) {
    if (!source || depth > 18 || state.nodesVisited > 25_000) {
        return null;
    }

    if (typeof source === 'string') {
        return extractChatUrlFromCompositeString(source) || normalizeCandidateChatUrl(source);
    }

    if (typeof source !== 'object') {
        return null;
    }

    if (state.visited.has(source)) {
        return null;
    }

    state.visited.add(source);
    state.nodesVisited += 1;

    const directMatch = extractKnownChatUrlFromObject(source);
    if (directMatch) {
        return directMatch;
    }

    const values = Array.isArray(source)
        ? source.slice(0, 5_000)
        : Object.values(source).slice(0, 1_000);

    for (const value of values) {
        const match = searchObjectForChatUrl(value, state, depth + 1);
        if (match) {
            return match;
        }
    }

    return null;
}

function getReactProbeRoots(node) {
    const roots = [];
    for (const propertyName of Object.getOwnPropertyNames(node)) {
        if (!propertyName.startsWith('__reactProps$') && !propertyName.startsWith('__reactFiber$')) {
            continue;
        }

        const value = node[propertyName];
        if (!value) {
            continue;
        }

        roots.push(value);
        if (value.memoizedProps) {
            roots.push(value.memoizedProps);
        }
        if (value.pendingProps) {
            roots.push(value.pendingProps);
        }
        if (value.memoizedState) {
            roots.push(value.memoizedState);
        }
        if (value.return?.memoizedProps) {
            roots.push(value.return.memoizedProps);
        }
    }
    return roots;
}

function extractChatUrlFromAttributes(row) {
    const probeNodes = [row].concat(Array.from(row.querySelectorAll('*')).slice(0, 40));
    const allowedAttributeNames = new Set([
        'href',
        'data-href',
        'data-url',
        'data-to',
        'data-chat-code',
        'data-chatid',
        'data-chat-id',
        'data-conversation-code',
        'data-slug'
    ]);

    for (const probeNode of probeNodes) {
        const linkMatch = extractChatUrlFromCompositeString(probeNode.getAttribute?.('href'));
        if (linkMatch) {
            return linkMatch;
        }

        for (const attribute of Array.from(probeNode.attributes || [])) {
            if (!allowedAttributeNames.has(attribute.name.toLowerCase())) {
                continue;
            }

            const match = extractChatUrlFromCompositeString(attribute.value);
            if (match) {
                return match;
            }
        }

        for (const [datasetKey, datasetValue] of Object.entries(probeNode.dataset || {})) {
            if (!/(href|url|to|chat|conversation|slug|id)/i.test(datasetKey)) {
                continue;
            }

            const match = extractChatUrlFromCompositeString(datasetValue) || normalizeCandidateChatUrl(datasetValue);
            if (match) {
                return match;
            }
        }
    }

    return null;
}

function extractChatUrlFromReactData(row) {
    const probeNodes = [
        row,
        queryFirst(row, SELECTORS.chatRowTitle),
        queryFirst(row, SELECTORS.chatRowPreview),
        ...Array.from(row.querySelectorAll('*')).slice(0, 12)
    ].filter(Boolean);

    for (const probeNode of probeNodes) {
        const roots = getReactProbeRoots(probeNode);
        for (const root of roots) {
            const match = searchObjectForChatUrl(root);
            if (match) {
                return match;
            }
        }
    }

    return null;
}

function getFirstString(candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && collapseWhitespace(candidate)) {
            return collapseWhitespace(candidate);
        }
    }
    return '';
}

function extractTitleFromObject(source) {
    return getFirstString([
        source?.title,
        source?.chatTitle,
        source?.name,
        source?.displayTitle,
        source?.display_name
    ]);
}

function extractPreviewFromObject(source) {
    return getFirstString([
        source?.preview,
        source?.textPreview,
        source?.subtitle,
        source?.summary,
        source?.snippet,
        source?.messagePreview,
        source?.lastMessage?.textPreview,
        source?.lastMessage?.preview,
        source?.latestMessage?.textPreview,
        source?.description
    ]);
}

function dedupeChatRecords(records) {
    const seenKeys = new Set();
    return records.filter((record) => {
        const key = `${record.url || ''}\u0000${record.title}\u0000${record.preview}`;
        if (seenKeys.has(key)) {
            return false;
        }

        seenKeys.add(key);
        return true;
    });
}

function collectNextDataChatRecords() {
    if (nextDataChatRecords) {
        return nextDataChatRecords;
    }

    nextDataChatRecords = [];
    const parsed = getNextDataPayload();
    if (!parsed) {
        return nextDataChatRecords;
    }

    try {
        const queue = [parsed];
        const visited = new WeakSet();

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || typeof current !== 'object') {
                continue;
            }
            if (visited.has(current)) {
                continue;
            }

            visited.add(current);

            const title = extractTitleFromObject(current);
            const preview = extractPreviewFromObject(current);
            const url = searchObjectForChatUrl(current);
            if (title && url) {
                nextDataChatRecords.push({ title, preview, url });
            }

            const values = Array.isArray(current)
                ? current.slice(0, 5_000)
                : Object.values(current).slice(0, 1_000);
            values.forEach((value) => queue.push(value));
        }
    } catch (error) {
        nextDataChatRecords = [];
    }

    nextDataChatRecords = dedupeChatRecords(nextDataChatRecords);
    return nextDataChatRecords;
}

function getNextDataChatPageInfo() {
    const pageInfo = getNextDataPayload()?.props?.pageProps?.data?.mainQuery?.chats?.pageInfo;
    if (!pageInfo || typeof pageInfo !== 'object') {
        return null;
    }

    return {
        endCursor: typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null,
        hasNextPage: Boolean(pageInfo.hasNextPage)
    };
}

function previewsLikelyMatch(left, right) {
    const normalizedLeft = comparableText(left);
    const normalizedRight = comparableText(right);

    if (!normalizedLeft || !normalizedRight) {
        return normalizedLeft === normalizedRight;
    }

    return normalizedLeft === normalizedRight
        || normalizedLeft.startsWith(normalizedRight)
        || normalizedRight.startsWith(normalizedLeft);
}

function titlesLikelyMatch(left, right) {
    const normalizedLeft = comparableText(left);
    const normalizedRight = comparableText(right);
    return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function extractChatUrlFromNextData(title, preview) {
    const records = collectNextDataChatRecords();
    if (records.length === 0) {
        return null;
    }

    const exactMatch = records.find((record) => titlesLikelyMatch(record.title, title) && previewsLikelyMatch(record.preview, preview));
    if (exactMatch?.url) {
        return exactMatch.url;
    }

    const titleMatches = records.filter((record) => titlesLikelyMatch(record.title, title) && record.url);
    if (titleMatches.length === 1) {
        return titleMatches[0].url;
    }

    return null;
}

function backfillCatalogUrlsFromNextData(chats) {
    const availableRecords = collectNextDataChatRecords().map((record) => ({ ...record, used: false }));
    if (availableRecords.length === 0) {
        return chats;
    }

    chats.forEach((chat) => {
        if (!chat.url) {
            return;
        }

        const existingRecord = availableRecords.find((record) => !record.used && record.url === chat.url);
        if (existingRecord) {
            existingRecord.used = true;
        }
    });

    chats.forEach((chat) => {
        if (chat.url) {
            return;
        }

        const exactMatches = availableRecords.filter((record) => !record.used && titlesLikelyMatch(record.title, chat.title) && previewsLikelyMatch(record.preview, chat.preview));
        if (exactMatches.length === 1) {
            chat.url = exactMatches[0].url;
            exactMatches[0].used = true;
            return;
        }

        const titleMatches = availableRecords.filter((record) => !record.used && titlesLikelyMatch(record.title, chat.title));
        if (titleMatches.length === 1) {
            chat.url = titleMatches[0].url;
            titleMatches[0].used = true;
        }
    });

    return chats;
}

function backfillCatalogUrlsFromCapturedChatHistory(chats) {
    const availableRecords = getCapturedChatHistoryRecords().map((record) => ({ ...record, used: false }));
    if (availableRecords.length === 0) {
        return chats;
    }

    chats.forEach((chat) => {
        if (!chat.url) {
            return;
        }

        const existingRecord = availableRecords.find((record) => !record.used && record.url === chat.url);
        if (existingRecord) {
            existingRecord.used = true;
        }
    });

    chats.forEach((chat) => {
        if (chat.url) {
            return;
        }

        const exactMatches = availableRecords.filter((record) => !record.used && titlesLikelyMatch(record.title, chat.title) && previewsLikelyMatch(record.preview, chat.preview));
        if (exactMatches.length === 1) {
            chat.url = exactMatches[0].url;
            exactMatches[0].used = true;
            return;
        }

        const titleMatches = availableRecords.filter((record) => !record.used && titlesLikelyMatch(record.title, chat.title));
        if (titleMatches.length === 1) {
            chat.url = titleMatches[0].url;
            titleMatches[0].used = true;
        }
    });

    return chats;
}

function mergeCapturedChatHistoryIntoCatalog(chats) {
    const capturedRecords = getCapturedChatHistoryRecords();
    if (capturedRecords.length === 0) {
        return chats;
    }

    const pendingChats = chats.map((chat) => ({ ...chat, matched: false }));
    const mergedChats = [];

    capturedRecords.forEach((record, index) => {
        let matchedChat = pendingChats.find((chat) => !chat.matched && chat.url === record.url);

        if (!matchedChat) {
            const exactMatches = pendingChats.filter((chat) => !chat.matched && titlesLikelyMatch(chat.title, record.title) && previewsLikelyMatch(chat.preview, record.preview));
            if (exactMatches.length === 1) {
                matchedChat = exactMatches[0];
            }
        }

        if (!matchedChat) {
            const titleMatches = pendingChats.filter((chat) => !chat.matched && titlesLikelyMatch(chat.title, record.title));
            if (titleMatches.length === 1) {
                matchedChat = titleMatches[0];
            }
        }

        if (matchedChat) {
            matchedChat.matched = true;
            mergedChats.push({
                title: record.title || matchedChat.title,
                preview: record.preview || matchedChat.preview,
                url: record.url,
                firstSeenOrder: matchedChat.firstSeenOrder,
                sortOrder: matchedChat.firstSeenOrder
            });
            return;
        }

        mergedChats.push({
            title: record.title,
            preview: record.preview,
            url: record.url,
            sortOrder: chats.length + index
        });
    });

    pendingChats
        .filter((chat) => !chat.matched)
        .forEach((chat) => {
            mergedChats.push({
                ...chat,
                sortOrder: typeof chat.firstSeenOrder === 'number' ? chat.firstSeenOrder : mergedChats.length
            });
        });

    return mergedChats
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(({ matched, sortOrder, ...chat }) => chat);
}

async function primeChatHistoryCapture(scrollContainer) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const summary = getChatHistoryCaptureSummary();
        if (summary.requestTemplateCount > 0 || summary.recordCount > collectNextDataChatRecords().length) {
            return true;
        }

        const beforeRecords = summary.recordCount;
        const beforeSignature = buildCatalogWindowSignature();
        const beforeTop = getScrollMetrics(scrollContainer).top;
        const visibleRowsBefore = getChatCatalogRows();
        const lastVisibleRow = visibleRowsBefore[visibleRowsBefore.length - 1];

        if (lastVisibleRow) {
            lastVisibleRow.scrollIntoView({ behavior: 'auto', block: 'end' });
        }
        scrollContainerTo(scrollContainer, getScrollHeight(scrollContainer));

        try {
            await waitForCondition(
                () => {
                    const captureSummary = getChatHistoryCaptureSummary();
                    return captureSummary.requestTemplateCount > 0
                        || captureSummary.recordCount > beforeRecords
                        || buildCatalogWindowSignature() !== beforeSignature
                        || getScrollMetrics(scrollContainer).top > beforeTop;
                },
                {
                    timeoutMs: 4_000,
                    intervalMs: 150,
                    errorMessage: 'Chat history pagination did not react.'
                }
            );
        } catch (error) {
            // Ignore the timeout and keep trying until Poe exposes a pagination template.
        }

        await wait(500);
    }

    return false;
}

async function fetchRemainingChatHistoryPages(scrollContainer) {
    await primeChatHistoryCapture(scrollContainer);

    const captureSummary = getChatHistoryCaptureSummary();
    const startingPageInfo = getNextDataChatPageInfo() || captureSummary.pageInfo;
    if (captureSummary.requestTemplateCount === 0 || !startingPageInfo?.hasNextPage) {
        return false;
    }

    let cursor = startingPageInfo.endCursor || null;
    let hasNextPage = Boolean(startingPageInfo.hasNextPage);
    let stagnantRounds = 0;
    let fetchedAnyPage = false;

    for (let pageIndex = 0; pageIndex < 400 && hasNextPage && stagnantRounds < 4; pageIndex += 1) {
        const beforeCount = getCapturedChatHistoryRecords().length;
        const response = await sendChatHistoryBridgeCommand('fetchChatHistoryPage', {
            cursor,
            count: 50
        });

        if (!response?.ok) {
            break;
        }

        fetchedAnyPage = true;
        cursor = response.pageInfo?.endCursor || cursor;
        hasNextPage = Boolean(response.pageInfo?.hasNextPage);

        const afterCount = getCapturedChatHistoryRecords().length;
        stagnantRounds = afterCount > beforeCount ? 0 : stagnantRounds + 1;

        if (!cursor && !hasNextPage) {
            break;
        }

        await wait(120);
    }

    return fetchedAnyPage;
}

async function fetchPreferredChatHistoryCatalog(scrollContainer) {
    await primeChatHistoryCapture(scrollContainer);

    if (getChatHistoryCaptureSummary().requestTemplateCount === 0) {
        return false;
    }

    let fetchedAnyPage = false;
    let stagnantRounds = 0;
    let cursor = null;
    let hasNextPage = true;

    for (let pageIndex = 0; pageIndex < 200 && hasNextPage && stagnantRounds < 4; pageIndex += 1) {
        const beforeCount = getCapturedChatHistoryRecords().length;
        const response = await sendChatHistoryBridgeCommand('fetchPreferredCatalogPage', pageIndex === 0
            ? { mode: 'initial' }
            : {
                mode: 'pagination',
                cursor,
                count: 200
            });

        if (!response?.ok) {
            break;
        }

        fetchedAnyPage = true;
        cursor = response.pageInfo?.endCursor || cursor;
        hasNextPage = Boolean(response.pageInfo?.hasNextPage);

        const afterCount = getCapturedChatHistoryRecords().length;
        stagnantRounds = afterCount > beforeCount ? 0 : stagnantRounds + 1;

        if (!cursor && !hasNextPage) {
            break;
        }

        await wait(80);
    }

    return fetchedAnyPage;
}

function getChatTitle(row) {
    const explicitTitle = collapseWhitespace(queryFirst(row, SELECTORS.chatRowTitle)?.textContent);
    if (explicitTitle) {
        return explicitTitle;
    }

    const ariaLabel = collapseWhitespace(row.getAttribute('aria-label'));
    if (ariaLabel) {
        return ariaLabel.split('\n')[0].trim();
    }

    const rawText = collapseWhitespace(row.innerText || row.textContent);
    if (!rawText) {
        return '';
    }

    return rawText.split(/\n+/)[0].trim().slice(0, 180);
}

function isLikelyChatRow(row) {
    if (!(row instanceof Element)) {
        return false;
    }

    const title = getChatTitle(row);
    if (!title || title.length < 2) {
        return false;
    }

    const rect = row.getBoundingClientRect();
    if (rect.height < 24 || rect.height > window.innerHeight * 0.9) {
        return false;
    }

    const text = collapseWhitespace(row.innerText || row.textContent);
    if (!text || text.length > 1200) {
        return false;
    }

    return true;
}

function getChatPreview(row, title) {
    const previewNode = queryFirst(row, SELECTORS.chatRowPreview);
    if (previewNode) {
        return collapseWhitespace(previewNode.textContent);
    }

    const fallback = collapseWhitespace(row.textContent);
    return fallback.replace(title, '').trim().slice(0, 240);
}

function extractChatDescriptor(row) {
    const title = getChatTitle(row);
    if (!title) {
        return null;
    }

    const preview = getChatPreview(row, title);
    const directLinkNode = queryFirst(row, SELECTORS.chatLinks) || row.querySelector('a[href]');
    const anchorUrl = extractChatUrlFromCompositeString(directLinkNode?.getAttribute('href'));
    const attributeUrl = extractChatUrlFromAttributes(row);
    const reactUrl = extractChatUrlFromReactData(row);
    const nextDataUrl = extractChatUrlFromNextData(title, preview);
    const url = anchorUrl || attributeUrl || reactUrl || nextDataUrl || null;

    return {
        key: url || `${title}\u0000${preview}`,
        title,
        preview,
        url
    };
}

function collectCatalogSnapshot(chatMap, orderState) {
    const rows = getChatCatalogRows();

    rows.forEach((row) => {
        const descriptor = extractChatDescriptor(row);
        if (!descriptor) {
            return;
        }

        const existing = chatMap.get(descriptor.key);
        if (!existing) {
            chatMap.set(descriptor.key, {
                ...descriptor,
                firstSeenOrder: orderState.nextValue
            });
            orderState.nextValue += 1;
            return;
        }

        if (!existing.url && descriptor.url) {
            existing.url = descriptor.url;
        }
    });
}

async function collectChatCatalog() {
    if (!isChatsIndexPage()) {
        throw new Error('Open https://poe.com/chats in the source tab before starting bulk export.');
    }

    resetPageScopedDataCaches();
    ensureChatHistoryCaptureBridge();
    resetChatHistoryCaptureState();
    try {
        await sendChatHistoryBridgeCommand('resetChatHistoryCapture');
    } catch (error) {
        // Continue even if the bridge reset races the first run.
    }

    const initialRows = await waitForCondition(
        () => {
            const rows = getChatCatalogRows();
            return rows.length > 0 ? rows : null;
        },
        {
            timeoutMs: 20_000,
            intervalMs: 300,
            errorMessage: 'No Poe chat rows appeared on the /chats page.'
        }
    );

    const scrollContainer = await detectResponsiveScrollContainer(
        initialRows[0],
        () => buildCatalogWindowSignature(),
        1
    );

    scrollContainerTo(scrollContainer, 0);
    await wait(600);

    const chatMap = new Map();
    const orderState = { nextValue: 0 };
    collectCatalogSnapshot(chatMap, orderState);

    let fetchedPreferredCatalog = false;

    try {
        fetchedPreferredCatalog = await fetchPreferredChatHistoryCatalog(scrollContainer);
    } catch (error) {
        fetchedPreferredCatalog = false;
    }

    if (!fetchedPreferredCatalog) {
        await fetchRemainingChatHistoryPages(scrollContainer);
    }

    let stableRounds = 0;
    const maxIterations = fetchedPreferredCatalog ? 60 : 180;
    const requiredStableRounds = fetchedPreferredCatalog ? 4 : 8;

    for (let iteration = 0; iteration < maxIterations && stableRounds < requiredStableRounds; iteration += 1) {
        collectCatalogSnapshot(chatMap, orderState);

        const before = getScrollMetrics(scrollContainer);
        const beforeSignature = buildCatalogWindowSignature();
        const beforeCount = chatMap.size;
        const beforeCapturedCount = getCapturedChatHistoryRecords().length;
        const visibleRowsBefore = getChatCatalogRows();
        const lastVisibleRow = visibleRowsBefore[visibleRowsBefore.length - 1];

        if (lastVisibleRow) {
            lastVisibleRow.scrollIntoView({ behavior: 'auto', block: 'end' });
        }

        scrollContainerTo(scrollContainer, Math.max(getScrollHeight(scrollContainer) - before.viewportHeight, 0));

        try {
            await waitForCondition(
                () => {
                    const currentMetrics = getScrollMetrics(scrollContainer);
                    return currentMetrics.top > before.top
                        || currentMetrics.height > before.height
                        || buildCatalogWindowSignature() !== beforeSignature
                        || getCapturedChatHistoryRecords().length > beforeCapturedCount
                        || getChatCatalogRows().length !== visibleRowsBefore.length;
                },
                {
                    timeoutMs: 4_000,
                    intervalMs: 150,
                    errorMessage: 'Chat catalog did not move.'
                }
            );
        } catch (error) {
            // Ignore probe timeout and let stability checks decide whether the crawl is done.
        }

        await wait(500);
        collectCatalogSnapshot(chatMap, orderState);

        const after = getScrollMetrics(scrollContainer);
        const afterSignature = buildCatalogWindowSignature();
        const afterCapturedCount = getCapturedChatHistoryRecords().length;
        const noProgress = after.top === before.top
            && after.height === before.height
            && afterSignature === beforeSignature
            && chatMap.size === beforeCount
            && afterCapturedCount === beforeCapturedCount;

        stableRounds = noProgress ? stableRounds + 1 : 0;

        if ((iteration + 1) % 12 === 0 && getChatHistoryCaptureSummary().pageInfo?.hasNextPage) {
            if (fetchedPreferredCatalog) {
                await fetchPreferredChatHistoryCatalog(scrollContainer);
            } else {
                await fetchRemainingChatHistoryPages(scrollContainer);
            }
        }
    }

    if (fetchedPreferredCatalog) {
        await fetchPreferredChatHistoryCatalog(scrollContainer);
    } else {
        await fetchRemainingChatHistoryPages(scrollContainer);
    }

    let chats = Array.from(chatMap.values())
        .sort((left, right) => left.firstSeenOrder - right.firstSeenOrder)
        .map(({ key, ...chat }) => chat);

    chats = backfillCatalogUrlsFromNextData(chats);
    chats = backfillCatalogUrlsFromCapturedChatHistory(chats);
    chats = mergeCapturedChatHistoryIntoCatalog(chats);

    const captureSummary = getChatHistoryCaptureSummary();
    const rawUnresolvedChats = chats.filter((chat) => !chat.url);
    const resolvedCountBeforeFiltering = chats.length - rawUnresolvedChats.length;
    const shouldTrustCapturedCatalog = captureSummary.recordCount >= Math.max(100, resolvedCountBeforeFiltering)
        && captureSummary.pageInfo?.hasNextPage === false;

    if (shouldTrustCapturedCatalog) {
        chats = chats.filter((chat) => Boolean(chat.url));
    }

    const unresolvedChats = chats.filter((chat) => !chat.url);
    return {
        chats,
        totalCount: chats.length,
        resolvedCount: chats.length - unresolvedChats.length,
        unresolvedCount: unresolvedChats.length,
        unresolvedChats,
        diagnostics: {
            nextDataRecordCount: collectNextDataChatRecords().length,
            capturedChatHistoryRecordCount: captureSummary.recordCount,
            capturedRequestTemplateCount: captureSummary.requestTemplateCount,
            capturedHasNextPage: captureSummary.pageInfo?.hasNextPage ?? null,
            preferredCatalogReplayUsed: fetchedPreferredCatalog,
            capturedCatalogTrusted: shouldTrustCapturedCatalog,
            rawUnresolvedCount: rawUnresolvedChats.length,
            visibleRowsAtCompletion: getChatCatalogRows().length,
            mainRowsAtCompletion: getCatalogRowBuckets().mainRows.length,
            sidebarRowsAtCompletion: getCatalogRowBuckets().sidebarRows.length,
            scrollContainerTag: scrollContainer?.tagName || 'UNKNOWN',
            scrollContainerClassName: collapseWhitespace(scrollContainer?.className || '').slice(0, 240)
        }
    };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'exportTranscript') {
        (async () => {
            const transcript = await buildTranscript({
                includeHuman: Boolean(request.includeHuman),
                includeBot: Boolean(request.includeBot),
                includeMediaDownloads: Boolean(request.includeMediaDownloads)
            });
            sendResponse({ ok: true, ...transcript });
        })().catch((error) => {
            sendResponse({ ok: false, error: error.message || 'Transcript export failed.' });
        });

        return true;
    }

    if (request.action === 'collectChatCatalog') {
        (async () => {
            const catalog = await collectChatCatalog();
            sendResponse({ ok: true, ...catalog });
        })().catch((error) => {
            sendResponse({ ok: false, error: error.message || 'Could not collect the Poe chat catalog.' });
        });

        return true;
    }

    return undefined;
});
