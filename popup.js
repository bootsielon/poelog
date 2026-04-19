const downloadButton = document.getElementById('downloadBtn');
const bulkDownloadButton = document.getElementById('bulkDownloadBtn');
const bulkWorkersInput = document.getElementById('bulkWorkers');
const includeMediaDownloadsInput = document.getElementById('includeMediaDownloads');
const statusElement = document.getElementById('status');
const modeHintElement = document.getElementById('modeHint');
const defaultButtonLabel = downloadButton.textContent;
const defaultBulkButtonLabel = bulkDownloadButton.textContent;
const MAX_BULK_WORKERS = 20;
let activeTab = null;

function getSuggestedBulkWorkers() {
    const reportedConcurrency = Number(navigator.hardwareConcurrency || 0);
    if (!Number.isFinite(reportedConcurrency) || reportedConcurrency <= 0) {
        return 8;
    }

    return Math.max(1, Math.min(MAX_BULK_WORKERS, reportedConcurrency));
}

function clampBulkWorkers(value) {
    const numericValue = Number.parseInt(String(value || ''), 10);
    if (!Number.isInteger(numericValue)) {
        return getSuggestedBulkWorkers();
    }

    return Math.max(1, Math.min(MAX_BULK_WORKERS, numericValue));
}

bulkWorkersInput.value = String(getSuggestedBulkWorkers());
bulkWorkersInput.addEventListener('change', () => {
    bulkWorkersInput.value = String(clampBulkWorkers(bulkWorkersInput.value));
});

function setBusy(isBusy) {
    downloadButton.disabled = isBusy;
    downloadButton.textContent = isBusy ? 'Preparing transcript...' : defaultButtonLabel;
    includeMediaDownloadsInput.disabled = isBusy;
}

function setBulkBusy(isBusy) {
    bulkDownloadButton.disabled = isBusy;
    bulkDownloadButton.textContent = isBusy ? 'Opening bulk exporter...' : defaultBulkButtonLabel;
}

function setStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.className = isError ? 'error' : '';
}

function setModeHint(message) {
    modeHintElement.textContent = message;
}

function isPoeUrl(url) {
    return /^https:\/\/(www\.)?poe\.com\//i.test(url || '');
}

function isChatsPage(url) {
    return /^https:\/\/(www\.)?poe\.com\/chats(?:[/?#].*)?$/i.test(url || '');
}

function isConversationPage(url) {
    return /^https:\/\/(www\.)?poe\.com\/chat\//i.test(url || '');
}

function updateButtonAvailability() {
    const url = activeTab?.url || '';
    const onPoe = isPoeUrl(url);
    const onChats = isChatsPage(url);
    const onConversation = isConversationPage(url);

    downloadButton.disabled = !onConversation;
    bulkDownloadButton.disabled = !onChats;
    includeMediaDownloadsInput.disabled = !onConversation;

    if (onChats) {
        setModeHint(`Bulk export is available from this tab. Keep the /chats tab open while the catalog pass runs. Worker tabs default to ${getSuggestedBulkWorkers()} on this machine.`);
    } else if (onConversation) {
        setModeHint('Current-chat export opens a dedicated exporter tab, so it can keep running even after the popup loses focus. The media checkbox downloads linked attachments for the current chat only.');
    } else if (onPoe) {
        setModeHint('Open a Poe conversation for single export, or open https://poe.com/chats for bulk export.');
    } else {
        setModeHint('Open Poe first, then either a conversation or the /chats index.');
    }
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs[0] || null;
    updateButtonAvailability();
});

downloadButton.addEventListener('click', () => {
    const includeHuman = document.getElementById('includeHuman').checked;
    const includeBot = document.getElementById('includeBot').checked;
    const includeMediaDownloads = includeMediaDownloadsInput.checked;

    if (!includeHuman && !includeBot) {
        setStatus('Select at least one message type to export.', true);
        return;
    }

    setBusy(true);
    setStatus('Launching current-chat exporter...');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        activeTab = tabs[0] || activeTab;

        if (!activeTab?.id || !isConversationPage(activeTab.url)) {
            setBusy(false);
            setStatus('Open an active Poe chat page first.', true);
            return;
        }

        const exportUrl = new URL(chrome.runtime.getURL('current_export.html'));
        exportUrl.searchParams.set('sourceTabId', String(activeTab.id));
        exportUrl.searchParams.set('includeHuman', includeHuman ? '1' : '0');
        exportUrl.searchParams.set('includeBot', includeBot ? '1' : '0');
        exportUrl.searchParams.set('includeMediaDownloads', includeMediaDownloads ? '1' : '0');

        chrome.tabs.create({ url: exportUrl.toString(), active: true }, (tab) => {
            setBusy(false);

            if (chrome.runtime.lastError || !tab?.id) {
                const errorMessage = chrome.runtime.lastError?.message || 'Could not open the current-chat exporter tab.';
                setStatus(errorMessage, true);
                return;
            }

            window.close();
        });
    });
});

bulkDownloadButton.addEventListener('click', () => {
    const includeHuman = document.getElementById('includeHuman').checked;
    const includeBot = document.getElementById('includeBot').checked;
    const workerCount = clampBulkWorkers(bulkWorkersInput.value);

    if (!includeHuman && !includeBot) {
        setStatus('Select at least one message type to export.', true);
        return;
    }

    if (!activeTab?.id || !isChatsPage(activeTab.url)) {
        setStatus('Open https://poe.com/chats in the active tab first.', true);
        return;
    }

    setBulkBusy(true);
    setStatus('Launching bulk exporter...');

    const bulkUrl = new URL(chrome.runtime.getURL('bulk.html'));
    bulkUrl.searchParams.set('sourceTabId', String(activeTab.id));
    bulkUrl.searchParams.set('includeHuman', includeHuman ? '1' : '0');
    bulkUrl.searchParams.set('includeBot', includeBot ? '1' : '0');
    bulkUrl.searchParams.set('workers', String(workerCount));

    chrome.tabs.create({ url: bulkUrl.toString(), active: true }, (tab) => {
        setBulkBusy(false);

        if (chrome.runtime.lastError || !tab?.id) {
            const errorMessage = chrome.runtime.lastError?.message || 'Could not open the bulk exporter tab.';
            setStatus(errorMessage, true);
            return;
        }

        window.close();
    });
});
