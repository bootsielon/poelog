#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const SELECTORS = {
    messageNodes: ['[id^="message-"]', '[class*="ChatMessage_chatMessage"]'],
    messageGroups: ['[class*="ChatMessagesView_tupleGroupContainer"]'],
    humanBubble: ['[class*="Message_rightSideMessageBubble"]'],
    botBubble: ['[class*="Message_leftSideMessageBubble"]'],
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
    ]
};

const MESSAGE_CONTAINER_SELECTOR = '[class*="ChatMessage_chatMessage"]';
const MESSAGE_ID_SELECTOR = '[id^="message-"]';

const KNOWN_TRANSCRIPT_HEADERS = new Set([
    'Conversation',
    'Bot',
    'Source',
    'Exported',
    'Messages',
    'Attachments'
]);

function usage() {
    console.error(
        [
            'Usage:',
            '  node tools/poelog_verify.mjs html <saved-poe-chat.html>',
            '  node tools/poelog_verify.mjs export <poelog-export.txt> [attachments-dir]'
        ].join('\n')
    );
    process.exit(1);
}

function readUtf8(filePath) {
    return fs.readFileSync(filePath, 'utf8');
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

function sortElementsInDocumentOrder(elements, NodeCtor) {
    return elements.slice().sort((left, right) => {
        if (left === right) {
            return 0;
        }

        const relationship = left.compareDocumentPosition(right);
        if (relationship & NodeCtor.DOCUMENT_POSITION_FOLLOWING) {
            return -1;
        }
        if (relationship & NodeCtor.DOCUMENT_POSITION_PRECEDING) {
            return 1;
        }

        return 0;
    });
}

function getMessageElementId(messageNode, ElementCtor) {
    if (!(messageNode instanceof ElementCtor)) {
        return '';
    }

    if (typeof messageNode.id === 'string' && messageNode.id.startsWith('message-')) {
        return messageNode.id;
    }

    const nestedIdNode = messageNode.matches(MESSAGE_ID_SELECTOR)
        ? messageNode
        : queryFirst(messageNode, [MESSAGE_ID_SELECTOR]);
    return nestedIdNode?.id || '';
}

function getCanonicalMessageNode(node, ElementCtor) {
    if (!(node instanceof ElementCtor)) {
        return null;
    }

    const messageIdNode = node.matches(MESSAGE_ID_SELECTOR)
        ? node
        : queryFirst(node, [MESSAGE_ID_SELECTOR]) || node.closest(MESSAGE_ID_SELECTOR);
    if (messageIdNode) {
        return messageIdNode;
    }

    const messageContainer = node.matches(MESSAGE_CONTAINER_SELECTOR)
        ? node
        : node.closest(MESSAGE_CONTAINER_SELECTOR);
    if (messageContainer) {
        return messageContainer;
    }

    return null;
}

function normalizeMessageNodes(elements, ElementCtor, NodeCtor) {
    const canonicalNodes = [];
    const seenNodes = new Set();

    elements.forEach((element) => {
        const canonicalNode = getCanonicalMessageNode(element, ElementCtor);
        if (!canonicalNode || seenNodes.has(canonicalNode)) {
            return;
        }

        seenNodes.add(canonicalNode);
        canonicalNodes.push(canonicalNode);
    });

    return sortElementsInDocumentOrder(canonicalNodes, NodeCtor);
}

function getMessageNodes(root, ElementCtor, NodeCtor) {
    return normalizeMessageNodes(queryAllAcrossSelectors(root, SELECTORS.messageNodes), ElementCtor, NodeCtor);
}

function parseNextData(document) {
    const nextDataScript = document.getElementById('__NEXT_DATA__');
    if (!nextDataScript?.textContent) {
        return null;
    }

    try {
        return JSON.parse(nextDataScript.textContent);
    } catch {
        return null;
    }
}

function pickUrlFromSrcset(srcset) {
    if (typeof srcset !== 'string' || !srcset.trim()) {
        return '';
    }

    return srcset
        .split(',')[0]
        .trim()
        .split(/\s+/)[0]
        .trim();
}

function normalizeUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }

    return trimmed.replace(/&amp;/g, '&');
}

function collectVisibleMediaUrls(messageNodes) {
    const urls = new Set();

    messageNodes.forEach((messageNode) => {
        const bubble = queryFirst(messageNode, SELECTORS.humanBubble)
            || queryFirst(messageNode, SELECTORS.botBubble);
        if (!bubble) {
            return;
        }

        queryAllAcrossSelectors(bubble, SELECTORS.attachmentMedia).forEach((node) => {
            const anchor = node.matches?.('a[href]') ? node : node.closest?.('a[href]');
            const href = normalizeUrl(anchor?.getAttribute?.('href'));
            const src = normalizeUrl(node.getAttribute?.('src'));
            const srcset = normalizeUrl(pickUrlFromSrcset(node.getAttribute?.('srcset')));

            [href, src, srcset].forEach((candidate) => {
                if (candidate) {
                    urls.add(candidate);
                }
            });
        });
    });

    return Array.from(urls).sort();
}

function collectPayloadAttachmentUrls(messagesConnection) {
    const urls = new Set();
    const edges = Array.isArray(messagesConnection?.edges) ? messagesConnection.edges : [];

    edges.forEach((edge) => {
        const attachments = Array.isArray(edge?.node?.attachments) ? edge.node.attachments : [];
        attachments.forEach((attachment) => {
            const candidate = attachment?.url || attachment?.file?.url || attachment?.file?.thumbnailUrl;
            const normalized = normalizeUrl(candidate);
            if (normalized) {
                urls.add(normalized);
            }
        });
    });

    return Array.from(urls).sort();
}

function analyzeHtmlFixture(filePath) {
    const html = readUtf8(filePath);
    const dom = new JSDOM(html);
    const { window } = dom;
    const { document, Node, Element } = window;
    const root = document.querySelector('main') || document;
    const payload = parseNextData(document);
    const messagesConnection = payload?.props?.pageProps?.data?.mainQuery?.chatOfCode?.messagesConnection || null;
    const chat = payload?.props?.pageProps?.data?.mainQuery?.chatOfCode || null;

    const messageNodes = getMessageNodes(root, Element, Node);
    const messageGroups = queryAll(root, SELECTORS.messageGroups);
    const humanMessages = messageNodes.filter((node) => Boolean(queryFirst(node, SELECTORS.humanBubble)));
    const botMessages = messageNodes.filter((node) => Boolean(queryFirst(node, SELECTORS.botBubble)));
    const visibleMediaUrls = collectVisibleMediaUrls(messageNodes);
    const payloadAttachmentUrls = collectPayloadAttachmentUrls(messagesConnection);
    const edgeCount = Array.isArray(messagesConnection?.edges) ? messagesConnection.edges.length : 0;
    const hasPreviousPage = Boolean(messagesConnection?.pageInfo?.hasPreviousPage);
    const immediateFastPathSafe = !hasPreviousPage && messageNodes.length >= edgeCount;
    const serializedWindowMatchesVisibleDom = edgeCount > 0 && messageNodes.length === edgeCount;
    const likelyPartialSnapshot = hasPreviousPage && serializedWindowMatchesVisibleDom;

    return {
        mode: 'html',
        file: path.resolve(filePath),
        title: chat?.title || document.title || null,
        bot: chat?.defaultBotObject?.displayName || null,
        chatCode: chat?.chatCode || null,
        visibleDom: {
            messageNodes: messageNodes.length,
            messageGroups: messageGroups.length,
            humanMessages: humanMessages.length,
            botMessages: botMessages.length,
            firstMessageId: getMessageElementId(messageNodes[0], Element) || null,
            lastMessageId: getMessageElementId(messageNodes[messageNodes.length - 1], Element) || null,
            visibleMediaUrls: visibleMediaUrls.length,
            groupMessageCounts: messageGroups.map((group) => getMessageNodes(group, Element, Node).length)
        },
        nextData: {
            edgeCount,
            hasPreviousPage,
            startCursor: typeof messagesConnection?.pageInfo?.startCursor === 'string'
                ? messagesConnection.pageInfo.startCursor
                : null,
            payloadAttachmentUrls: payloadAttachmentUrls.length
        },
        diagnostics: {
            immediateFastPathSafe,
            serializedWindowMatchesVisibleDom,
            likelyPartialSnapshot,
            notes: [
                hasPreviousPage
                    ? 'hasPreviousPage=true so the serialized snapshot is explicitly paginated.'
                    : 'hasPreviousPage=false so the serialized snapshot may be complete.',
                likelyPartialSnapshot
                    ? 'Visible DOM count matches the serialized edge window while older pages still exist; treat this fixture as a partial window, not a full chat.'
                    : 'Visible DOM and serialized edge counts do not by themselves prove a partial window.'
            ]
        }
    };
}

function countFilesRecursively(dirPath) {
    let total = 0;

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            total += countFilesRecursively(entryPath);
            continue;
        }

        if (entry.isFile()) {
            total += 1;
        }
    }

    return total;
}

function inferAttachmentsDir(exportPath, explicitDir) {
    if (explicitDir) {
        return fs.existsSync(explicitDir) ? explicitDir : null;
    }

    const baseName = path.basename(exportPath, path.extname(exportPath));
    const parentDir = path.dirname(exportPath);
    const candidates = [
        path.join(parentDir, `${baseName} attachments`),
        path.join(parentDir, `${baseName} attachments_previous`)
    ];

    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || null;
}

function analyzeExport(filePath, explicitAttachmentsDir) {
    const text = readUtf8(filePath);
    const lines = text.split(/\r?\n/);
    const speakerCounts = {};
    let declaredMessages = null;
    let actualMessages = 0;
    let attachmentSections = 0;
    let attachmentLines = 0;
    let markdownMediaLines = 0;
    let placeholderMessages = 0;
    let dateSections = 0;

    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }

        const declaredMatch = trimmed.match(/^Messages:\s+(\d+)$/);
        if (declaredMatch) {
            declaredMessages = Number(declaredMatch[1]);
            return;
        }

        if (/^===\s.*\s===$/.test(trimmed)) {
            dateSections += 1;
            return;
        }

        if (trimmed === 'Attachments:') {
            attachmentSections += 1;
            return;
        }

        if (trimmed.startsWith('- ')) {
            attachmentLines += 1;
            return;
        }

        if (trimmed.startsWith('![')) {
            markdownMediaLines += 1;
            return;
        }

        if (/^Generating\.\.\./.test(trimmed)) {
            placeholderMessages += 1;
            return;
        }

        if (/^[^:\n]+:\s*$/.test(trimmed)) {
            const label = trimmed.slice(0, -1);
            if (KNOWN_TRANSCRIPT_HEADERS.has(label)) {
                return;
            }

            actualMessages += 1;
            speakerCounts[label] = (speakerCounts[label] || 0) + 1;
        }
    });

    const attachmentsDir = inferAttachmentsDir(filePath, explicitAttachmentsDir);

    return {
        mode: 'export',
        file: path.resolve(filePath),
        declaredMessages,
        actualMessages,
        declaredMatchesParsed: declaredMessages === null ? null : declaredMessages === actualMessages,
        dateSections,
        speakerCounts,
        attachmentSections,
        attachmentLines,
        markdownMediaLines,
        placeholderMessages,
        attachmentsDirectory: attachmentsDir
            ? {
                path: attachmentsDir,
                fileCount: countFilesRecursively(attachmentsDir)
            }
            : null
    };
}

function main() {
    const [, , mode, targetPath, explicitAttachmentsDir] = process.argv;
    if (!mode || !targetPath) {
        usage();
    }

    const resolvedTargetPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedTargetPath)) {
        console.error(`File not found: ${resolvedTargetPath}`);
        process.exit(1);
    }

    let result;
    if (mode === 'html') {
        result = analyzeHtmlFixture(resolvedTargetPath);
    } else if (mode === 'export') {
        result = analyzeExport(
            resolvedTargetPath,
            explicitAttachmentsDir ? path.resolve(explicitAttachmentsDir) : null
        );
    } else {
        usage();
    }

    console.log(JSON.stringify(result, null, 2));
}

main();