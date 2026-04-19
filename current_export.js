const statusElement = document.getElementById('status');
const countsElement = document.getElementById('counts');
const progressElement = document.getElementById('progress');
const closeButton = document.getElementById('closeBtn');
const logElement = document.getElementById('log');

const params = new URLSearchParams(window.location.search);
const sourceTabId = Number.parseInt(params.get('sourceTabId') || '', 10);
const includeHuman = params.get('includeHuman') !== '0';
const includeBot = params.get('includeBot') !== '0';
const includeMediaDownloads = params.get('includeMediaDownloads') === '1';

const runState = {
    messageCount: 0,
    attachmentCount: 0,
    attachmentDownloadCount: 0,
    attachmentFailureCount: 0,
    transcriptFilename: '',
    diagnostics: null
};

closeButton.addEventListener('click', async () => {
    try {
        const currentTab = await chromeCallback(chrome.tabs.getCurrent, chrome.tabs);
        if (currentTab?.id) {
            await chromeCallback(chrome.tabs.remove, chrome.tabs, currentTab.id);
            return;
        }
    } catch (error) {
        // Fall back to window.close if tab lookup fails.
    }

    window.close();
});

function appendLog(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const label = level.toUpperCase().padEnd(5, ' ');
    logElement.textContent += `[${timestamp}] ${label} ${message}\n`;
    logElement.scrollTop = logElement.scrollHeight;
}

function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.className = isError ? 'error' : '';
}

function updateCounts() {
    const segments = [
        `Messages: ${runState.messageCount || 0}`,
        `Attachment refs: ${runState.attachmentCount || 0}`,
        `Media requested: ${includeMediaDownloads ? 'yes' : 'no'}`
    ];

    if (includeMediaDownloads) {
        segments.push(`Media saved: ${runState.attachmentDownloadCount}`);
        segments.push(`Media failed: ${runState.attachmentFailureCount}`);
    }

    countsElement.textContent = segments.join(' • ');
}

function logConversationDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') {
        return;
    }

    appendLog(`Extraction diagnostics: candidates=${diagnostics.candidateCount || 0}, movedRounds=${diagnostics.movedRounds || 0}, progressRounds=${diagnostics.progressRounds || 0}, finalAtTop=${Boolean(diagnostics.finalAtTop)}, stableRounds=${diagnostics.stableRoundsReached || 0}`);
    appendLog(`Visible messages: initial=${diagnostics.initialVisibleMessageCount || 0}, max=${diagnostics.maxVisibleCount || 0}, final=${diagnostics.finalVisibleMessageCount || 0}`);
    appendLog(`Harvested messages: max=${diagnostics.maxHarvestedCount || 0}, final=${diagnostics.finalHarvestedCount || 0}`);

    if (Array.isArray(diagnostics.candidateLabels) && diagnostics.candidateLabels.length > 0) {
        const labels = diagnostics.candidateLabels.map((label, index) => `${index + 1}:${label} [range=${diagnostics.candidateRanges?.[index] ?? '?'}]`);
        appendLog(`Scroll candidates: ${labels.join(' | ')}`);
    } else {
        appendLog('Scroll candidates: none');
    }
}

function setProgress(value) {
    progressElement.max = includeMediaDownloads ? 3 : 2;
    progressElement.value = Math.max(0, Math.min(value, progressElement.max));
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function chromeCallback(method, context, ...args) {
    return new Promise((resolve, reject) => {
        method.call(context, ...args, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(result);
        });
    });
}

function getTab(tabId) {
    return chromeCallback(chrome.tabs.get, chrome.tabs, tabId);
}

function sendMessageToTab(tabId, message) {
    return chromeCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message);
}

function downloadFile(downloadOptions) {
    return chromeCallback(chrome.downloads.download, chrome.downloads, downloadOptions);
}

async function sendMessageWithRetry(tabId, message, options = {}) {
    const retries = options.retries ?? 20;
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            return await sendMessageToTab(tabId, message);
        } catch (error) {
            lastError = error;
            await delay(retryDelayMs);
        }
    }

    throw lastError || new Error('Could not reach the Poe tab.');
}

function sanitizePathSegment(value, fallback = 'download') {
    const cleaned = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();

    return cleaned || fallback;
}

function stripExtension(filename) {
    return String(filename || '').replace(/\.[^.]+$/i, '');
}

function getExtensionFromUrl(url) {
    try {
        const pathname = new URL(url).pathname || '';
        const segment = pathname.split('/').pop() || '';
        const match = segment.match(/\.([a-z0-9]{1,8})$/i);
        return match ? `.${match[1].toLowerCase()}` : '';
    } catch (error) {
        return '';
    }
}

function buildAttachmentDownloadPath(transcriptFilename, attachment, index) {
    const transcriptBaseName = sanitizePathSegment(stripExtension(transcriptFilename), 'Poe conversation');
    const folderName = `${transcriptBaseName} attachments`;
    const inferredExtension = getExtensionFromUrl(attachment.url);
    const fallbackName = attachment.kind === 'image' ? `image-${index + 1}` : `attachment-${index + 1}`;
    let baseName = sanitizePathSegment(attachment.title, fallbackName);

    if (inferredExtension && !baseName.toLowerCase().endsWith(inferredExtension)) {
        baseName += inferredExtension;
    }

    const numberedName = `${String(index + 1).padStart(3, '0')} ${baseName}`;
    return `${folderName}/${numberedName}`;
}

function describeAttachmentSample(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return 'unknown';
    }

    return sanitizePathSegment(attachment.title, '') || attachment.url || 'unknown';
}

async function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    try {
        await downloadFile({
            url,
            filename,
            saveAs: false,
            conflictAction: 'uniquify'
        });
    } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
}

async function downloadAttachmentFiles(transcriptFilename, attachmentFiles) {
    for (let index = 0; index < attachmentFiles.length; index += 1) {
        const attachment = attachmentFiles[index];
        const downloadPath = buildAttachmentDownloadPath(transcriptFilename, attachment, index);

        try {
            await downloadFile({
                url: attachment.url,
                filename: downloadPath,
                saveAs: false,
                conflictAction: 'uniquify'
            });
            runState.attachmentDownloadCount += 1;
            appendLog(`Saved attachment ${index + 1}/${attachmentFiles.length}: ${downloadPath}`);
        } catch (error) {
            runState.attachmentFailureCount += 1;
            appendLog(`Failed attachment ${index + 1}/${attachmentFiles.length}: ${downloadPath} (${error.message || 'download failed'})`, 'warn');
        }

        updateCounts();
        await delay(120);
    }
}

async function startCurrentExport() {
    if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
        throw new Error('The source chat tab id was missing. Start current-chat export from the popup while the Poe chat is active.');
    }

    const sourceTab = await getTab(sourceTabId);
    if (!sourceTab?.url || !/^https:\/\/(www\.)?poe\.com\/chat\//i.test(sourceTab.url)) {
        throw new Error('The source tab is no longer on a Poe chat page.');
    }

    appendLog(`Requesting transcript from source tab ${sourceTabId}.`);
    appendLog(`Filters: includeHuman=${includeHuman} includeBot=${includeBot} includeMediaDownloads=${includeMediaDownloads}`);
    setStatus('Loading the full Poe thread...');
    setProgress(0);
    updateCounts();

    const response = await sendMessageWithRetry(
        sourceTabId,
        {
            action: 'exportTranscript',
            includeHuman,
            includeBot,
            includeMediaDownloads
        },
        {
            retries: 25,
            retryDelayMs: 1_000
        }
    );

    if (!response?.ok) {
        throw new Error(response?.error || 'Transcript export failed.');
    }

    runState.messageCount = Number(response.messageCount || 0);
    runState.attachmentCount = Number(response.attachmentCount || 0);
    runState.transcriptFilename = response.filename || 'Poe conversation.txt';
    runState.diagnostics = response.diagnostics || null;
    updateCounts();
    setProgress(1);
    appendLog(`Transcript assembled: ${runState.messageCount} messages, ${runState.attachmentCount} attachment references.`);
    logConversationDiagnostics(runState.diagnostics);

    setStatus('Saving transcript...');
    await downloadTextFile(runState.transcriptFilename, response.text);
    setProgress(2);
    appendLog(`Saved transcript: ${runState.transcriptFilename}`);

    const attachmentFiles = includeMediaDownloads && Array.isArray(response.attachmentFiles)
        ? response.attachmentFiles
        : [];

    if (includeMediaDownloads) {
        const sampleAttachments = attachmentFiles
            .slice(0, 3)
            .map((attachment) => describeAttachmentSample(attachment));

        appendLog(`Downloadable media files returned: ${attachmentFiles.length}${sampleAttachments.length > 0 ? ` (sample: ${sampleAttachments.join(' | ')})` : ''}`);

        if (attachmentFiles.length > 0) {
            setStatus(`Downloading ${attachmentFiles.length} media files...`);
            appendLog('Chrome may ask once to allow multiple downloads from this extension.', 'warn');
            appendLog(`Starting media downloads for ${attachmentFiles.length} attachment files.`);
            await downloadAttachmentFiles(runState.transcriptFilename, attachmentFiles);
        } else {
            appendLog('No downloadable attachment files were returned for this chat.');
        }
        setProgress(3);
    }

    updateCounts();

    if (runState.attachmentFailureCount > 0) {
        setStatus(`Transcript saved, but ${runState.attachmentFailureCount} media downloads failed.`, true);
        appendLog(`Current-chat export finished with ${runState.attachmentFailureCount} media download failures.`, 'warn');
        return;
    }

    setStatus(`Current-chat export complete. Saved ${runState.messageCount} messages.`);
    appendLog('Current-chat export completed successfully.');
}

(async () => {
    try {
        await startCurrentExport();
    } catch (error) {
        setStatus(error.message || 'Current-chat export failed.', true);
        appendLog(error.message || 'Current-chat export failed.', 'error');
    }
})();