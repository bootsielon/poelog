const statusElement = document.getElementById('status');
const countsElement = document.getElementById('counts');
const progressElement = document.getElementById('progress');
const cancelButton = document.getElementById('cancelBtn');
const logElement = document.getElementById('log');
const folderNameElement = document.getElementById('folderName');

const params = new URLSearchParams(window.location.search);
const sourceTabId = Number.parseInt(params.get('sourceTabId') || '', 10);
const includeHuman = params.get('includeHuman') !== '0';
const includeBot = params.get('includeBot') !== '0';
const MAX_PARALLEL_WORKERS = 20;
const DEFAULT_PARALLEL_WORKERS = Math.max(1, Math.min(MAX_PARALLEL_WORKERS, Number(navigator.hardwareConcurrency || 8) || 8));

function clampParallelWorkers(value) {
    const numericValue = Number.parseInt(String(value || ''), 10);
    if (!Number.isInteger(numericValue)) {
        return DEFAULT_PARALLEL_WORKERS;
    }

    return Math.max(1, Math.min(MAX_PARALLEL_WORKERS, numericValue));
}

const configuredWorkerCount = clampParallelWorkers(params.get('workers'));

const runState = {
    cancelRequested: false,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    folderName: buildRunFolderName(),
    workerCount: 0,
    results: []
};

cancelButton.addEventListener('click', () => {
    runState.cancelRequested = true;
    cancelButton.disabled = true;
    appendLog('Cancellation requested. The exporter will stop after the current chat.', 'warn');
});

folderNameElement.textContent = `Download folder: ${runState.folderName}`;

function buildRunFolderName() {
    const now = new Date();
    const parts = [
        now.getFullYear().toString().padStart(4, '0'),
        (now.getMonth() + 1).toString().padStart(2, '0'),
        now.getDate().toString().padStart(2, '0'),
        now.getHours().toString().padStart(2, '0'),
        now.getMinutes().toString().padStart(2, '0'),
        now.getSeconds().toString().padStart(2, '0')
    ];
    return `PoeLog_Bulk_${parts.join('')}`;
}

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

function updateCounts(currentTitle = '') {
    const total = runState.total || 0;
    progressElement.max = Math.max(total, 1);
    progressElement.value = Math.min(runState.completed + runState.failed, total);

    const segments = [
        `Completed: ${runState.completed}`,
        `Failed: ${runState.failed}`,
        `Skipped: ${runState.skipped}`,
        `Total queued: ${total}`
    ];

    if (currentTitle) {
        segments.push(`Current: ${currentTitle}`);
    }

    countsElement.textContent = segments.join(' • ');
}

function isClearlyIncompleteCatalog(catalogSummary) {
    if (!catalogSummary) {
        return false;
    }

    const mainRowsAtCompletion = Number(catalogSummary.diagnostics?.mainRowsAtCompletion || 0);
    const sidebarRowsAtCompletion = Number(catalogSummary.diagnostics?.sidebarRowsAtCompletion || 0);
    const nextDataRecordCount = Number(catalogSummary.diagnostics?.nextDataRecordCount || 0);
    const capturedChatHistoryRecordCount = Number(catalogSummary.diagnostics?.capturedChatHistoryRecordCount || 0);

    if (mainRowsAtCompletion === 0 && sidebarRowsAtCompletion > 0 && catalogSummary.totalCount <= Math.max(sidebarRowsAtCompletion, 60)) {
        return true;
    }

    if (capturedChatHistoryRecordCount >= 20 && catalogSummary.resolvedCount < Math.floor(capturedChatHistoryRecordCount * 0.8)) {
        return true;
    }

    if (nextDataRecordCount >= 20 && catalogSummary.totalCount < Math.floor(nextDataRecordCount * 0.5)) {
        return true;
    }

    if (catalogSummary.totalCount < 20) {
        return false;
    }

    const minimumResolvedCount = Math.max(10, Math.floor(catalogSummary.totalCount * 0.35));
    return catalogSummary.resolvedCount < minimumResolvedCount;
}

function isValidPoeChatUrl(url) {
    return /^https:\/\/(www\.)?poe\.com\/chat\/[a-z0-9]{12,32}$/.test(url || '');
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

function createTab(createProperties) {
    return chromeCallback(chrome.tabs.create, chrome.tabs, createProperties);
}

function updateTab(tabId, updateProperties) {
    return chromeCallback(chrome.tabs.update, chrome.tabs, tabId, updateProperties);
}

function getTab(tabId) {
    return chromeCallback(chrome.tabs.get, chrome.tabs, tabId);
}

function removeTab(tabId) {
    return chromeCallback(chrome.tabs.remove, chrome.tabs, tabId);
}

function sendMessageToTab(tabId, message) {
    return chromeCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message);
}

function downloadFile(downloadOptions) {
    return chromeCallback(chrome.downloads.download, chrome.downloads, downloadOptions);
}

async function waitForTabComplete(tabId) {
    const existingTab = await getTab(tabId);
    if (existingTab.status === 'complete') {
        await delay(1_200);
        return existingTab;
    }

    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('Timed out waiting for the Poe worker tab to finish loading.'));
        }, 30_000);

        function listener(updatedTabId, changeInfo, tab) {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
                return;
            }

            chrome.tabs.onUpdated.removeListener(listener);
            window.clearTimeout(timeout);
            window.setTimeout(() => resolve(tab), 1_200);
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function sendMessageWithRetry(tabId, message, options = {}) {
    const retries = options.retries ?? 15;
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

function sanitizePathSegment(value, fallback) {
    const cleaned = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();

    return cleaned || fallback;
}

function buildTranscriptDownloadPath(index, originalFilename) {
    const baseName = String(originalFilename || `conversation-${index + 1}`).replace(/\.txt$/i, '');
    const numberedName = `${String(index + 1).padStart(4, '0')} ${sanitizePathSegment(baseName, `conversation-${index + 1}`)}.txt`;
    return `${runState.folderName}/${numberedName}`;
}

async function downloadTextFile(relativePath, text, mimeType = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);

    try {
        await downloadFile({
            url,
            filename: relativePath,
            saveAs: false,
            conflictAction: 'uniquify'
        });
    } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
}

async function collectCatalogFromSourceTab() {
    setStatus('Collecting chats from the source /chats tab…');
    appendLog('Starting catalog crawl on the source Poe /chats tab.');

    const response = await sendMessageWithRetry(sourceTabId, { action: 'collectChatCatalog' }, { retries: 8, retryDelayMs: 1_000 });
    if (!response?.ok) {
        throw new Error(response?.error || 'Could not collect the Poe chat catalog.');
    }

    return response;
}

async function exportResolvedChats(chats) {
    const workerCount = Math.max(1, Math.min(configuredWorkerCount, chats.length));
    let nextIndex = 0;

    runState.workerCount = workerCount;
    appendLog(`Starting ${workerCount} worker tabs for ${chats.length} chats.`);
    setStatus(`Exporting ${chats.length} chats with ${workerCount} workers.`);

    function claimNextChat() {
        if (runState.cancelRequested || nextIndex >= chats.length) {
            return null;
        }

        const index = nextIndex;
        nextIndex += 1;
        return {
            index,
            chat: chats[index]
        };
    }

    async function runWorker(workerNumber) {
        let workerTab = null;

        try {
            while (true) {
                const assignment = claimNextChat();
                if (!assignment) {
                    return;
                }

                const { index, chat } = assignment;
                updateCounts();
                appendLog(`[W${workerNumber}] Exporting ${index + 1}/${chats.length}: ${chat.title}`);

                try {
                    if (!workerTab) {
                        workerTab = await createTab({ url: chat.url, active: false });
                        appendLog(`[W${workerNumber}] Opened worker tab ${workerTab.id}.`);
                    } else {
                        await updateTab(workerTab.id, { url: chat.url });
                    }

                    await waitForTabComplete(workerTab.id);

                    const response = await sendMessageWithRetry(
                        workerTab.id,
                        {
                            action: 'exportTranscript',
                            includeHuman,
                            includeBot
                        },
                        { retries: 20, retryDelayMs: 1_000 }
                    );

                    if (!response?.ok) {
                        throw new Error(response?.error || 'Transcript export failed.');
                    }

                    const downloadPath = buildTranscriptDownloadPath(index, response.filename);
                    await downloadTextFile(downloadPath, response.text);

                    runState.completed += 1;
                    runState.results[index] = {
                        title: chat.title,
                        preview: chat.preview,
                        url: chat.url,
                        status: 'completed',
                        messageCount: Number(response.messageCount || 0),
                        attachmentCount: Number(response.attachmentCount || 0),
                        downloadPath
                    };

                    appendLog(`[W${workerNumber}] Saved ${downloadPath} (${Number(response.messageCount || 0)} messages, ${Number(response.attachmentCount || 0)} attachments)`);
                } catch (error) {
                    runState.failed += 1;
                    runState.results[index] = {
                        title: chat.title,
                        preview: chat.preview,
                        url: chat.url,
                        status: 'failed',
                        error: error.message || 'Transcript export failed.'
                    };
                    appendLog(`[W${workerNumber}] Failed ${chat.title}: ${error.message || 'Transcript export failed.'}`, 'error');
                }

                updateCounts();
                setStatus(`Exporting chats: ${runState.completed + runState.failed}/${chats.length} finished with ${workerCount} workers.`);
            }
        } finally {
            if (workerTab?.id) {
                try {
                    await removeTab(workerTab.id);
                    appendLog(`[W${workerNumber}] Closed worker tab ${workerTab.id}.`);
                } catch (error) {
                    appendLog(`[W${workerNumber}] Could not close worker tab ${workerTab.id}: ${error.message}`, 'warn');
                }
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index + 1)));
}

async function downloadManifest(catalogSummary) {
    const manifest = {
        exportedAt: new Date().toISOString(),
        sourceTabId,
        includeHuman,
        includeBot,
        folderName: runState.folderName,
        workerCount: runState.workerCount,
        summary: {
            totalDiscovered: catalogSummary.totalCount,
            resolved: catalogSummary.resolvedCount,
            unresolved: catalogSummary.unresolvedCount,
            completed: runState.completed,
            failed: runState.failed,
            skipped: runState.skipped,
            queuedButNotRun: Math.max(runState.total - runState.completed - runState.failed, 0),
            cancelled: runState.cancelRequested
        },
        diagnostics: catalogSummary.diagnostics || null,
        results: runState.results.filter(Boolean),
        unresolvedChats: catalogSummary.unresolvedChats || []
    };

    await downloadTextFile(
        `${runState.folderName}/manifest.json`,
        JSON.stringify(manifest, null, 2),
        'application/json;charset=utf-8'
    );
    appendLog('Saved manifest.json for this bulk run.');
}

async function startBulkExport() {
    if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
        throw new Error('The source /chats tab id was missing. Start bulk export from the popup while /chats is active.');
    }

    const sourceTab = await getTab(sourceTabId);
    if (!sourceTab?.url || !/^https:\/\/(www\.)?poe\.com\/chats(?:[/?#].*)?$/i.test(sourceTab.url)) {
        throw new Error('The source tab is no longer on https://poe.com/chats.');
    }

    appendLog('Chrome may ask you once to allow multiple downloads from this extension.', 'warn');
    appendLog(`Configured worker tabs: ${configuredWorkerCount} (cap ${MAX_PARALLEL_WORKERS}, reported concurrency ${navigator.hardwareConcurrency || 'unknown'}).`);

    const catalogSummary = await collectCatalogFromSourceTab();
    const resolvedChats = catalogSummary.chats.filter((chat) => isValidPoeChatUrl(chat.url));

    runState.total = resolvedChats.length;
    runState.skipped = catalogSummary.chats.length - resolvedChats.length;
    updateCounts();

    appendLog(`Catalog complete: discovered ${catalogSummary.totalCount} chats.`);
    appendLog(`Resolved ${catalogSummary.resolvedCount} chat URLs and skipped ${catalogSummary.unresolvedCount} unresolved rows.`);

    if (catalogSummary.diagnostics) {
        appendLog(`Catalog diagnostics: nextData=${catalogSummary.diagnostics.nextDataRecordCount}, captured=${catalogSummary.diagnostics.capturedChatHistoryRecordCount || 0}, templates=${catalogSummary.diagnostics.capturedRequestTemplateCount || 0}, visibleRows=${catalogSummary.diagnostics.visibleRowsAtCompletion}, container=${catalogSummary.diagnostics.scrollContainerTag} ${catalogSummary.diagnostics.scrollContainerClassName || ''}`.trim());
        appendLog(`Catalog row sources: main=${catalogSummary.diagnostics.mainRowsAtCompletion || 0}, sidebar=${catalogSummary.diagnostics.sidebarRowsAtCompletion || 0}`);
    }

    if (isClearlyIncompleteCatalog(catalogSummary)) {
        throw new Error(`Catalog crawl looks incomplete: found ${catalogSummary.totalCount} chats but resolved only ${catalogSummary.resolvedCount}. Poe likely did not expose the full /chats index yet.`);
    }

    if (catalogSummary.unresolvedCount > 0) {
        appendLog('Some chat rows could not be mapped to direct URLs. They will be listed in manifest.json.', 'warn');
    }

    if (resolvedChats.length === 0) {
        throw new Error('No exportable chat URLs were discovered on the /chats page. Poe likely changed the row structure again.');
    }

    try {
        await exportResolvedChats(resolvedChats);
    } finally {
        await downloadManifest(catalogSummary);
    }

    if (runState.cancelRequested) {
        setStatus('Bulk export cancelled. Completed files and manifest were saved.');
        appendLog('Bulk export finished in a cancelled state.', 'warn');
        return;
    }

    if (runState.failed > 0) {
        setStatus(`Bulk export finished with ${runState.failed} failures. Saved ${runState.completed} transcripts into ${runState.folderName}.`);
        appendLog(`Bulk export finished with failures. Saved ${runState.completed} transcripts and recorded ${runState.failed} failures.`, 'warn');
    } else {
        setStatus(`Bulk export complete. Saved ${runState.completed} transcripts into ${runState.folderName}.`);
        appendLog(`Bulk export complete: ${runState.completed} transcripts saved.`);
    }
    cancelButton.disabled = true;
}

(async () => {
    try {
        updateCounts();
        await startBulkExport();
    } catch (error) {
        setStatus(error.message || 'Bulk export failed.', true);
        appendLog(error.message || 'Bulk export failed.', 'error');
        cancelButton.disabled = true;
    }
})();