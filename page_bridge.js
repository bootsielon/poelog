(function () {
    const CAPTURE_EVENT = '__poelogChatHistoryCapture';
    const COMMAND_EVENT = '__poelogChatHistoryCommand';
    const RESPONSE_EVENT = '__poelogChatHistoryCommandResponse';
    const QUERY_IDS = new Set([
        'f55d3b916a2658148a9f46d9aa5b9d7f4113609e33dd2f9b3c41226d0430020',
        'c5235d69e40df37c8d367884cd3452500410521c99706e3a49b33451a2855c3',
        'cc0ac0b49b28ae328ff5ec1ab4fc8515e2e54e430f74c8a189c9aa3736d1bfd',
        'f392f0dd7751cf50849c4d3549b2e0fc07bb6bfbcd08a5533526037f2858b202',
        '8ab423f3d595f4d535de0cbd9ca76644c8af218958026558df65dd01a57a96e6',
        'b7e7d8a6529ae356f8bf1e0b3e8626f759ea16ccf36fc67a5bac27724cba02a'
    ]);
    const QUERY_NAMES = new Set([
        'chatsHistoryPageQuery',
        'ChatHistoryListWithSearchPaginationQuery',
        'ChatHistoryListWithMessageSearchPaginationQuery',
        'ChatHistoryFilteredListPaginationQuery',
        'ChatHistoryPagedSearchResultsPaginationQuery',
        'ChatHistoryPagedSearchResultsQuery'
    ]);
    const CATALOG_INITIAL_QUERY = {
        queryName: 'ChatHistoryPagedSearchResultsQuery',
        queryId: 'b7e7d8a6529ae356f8bf1e0b3e8626f759ea16ccf36fc67a5bac27724cba02a'
    };
    const CATALOG_PAGINATION_QUERY = {
        queryName: 'ChatHistoryPagedSearchResultsPaginationQuery',
        queryId: '8ab423f3d595f4d535de0cbd9ca76644c8af218958026558df65dd01a57a96e6'
    };
    const TRANSPORT_QUERY_PRIORITY = [
        'ChatHistoryPagedSearchResultsPaginationQuery',
        'ChatHistoryPagedSearchResultsQuery',
        'ChatHistoryListWithSearchPaginationQuery',
        'ChatHistoryListWithMessageSearchPaginationQuery',
        'chatsHistoryPageQuery',
        'ChatHistoryFilteredListPaginationQuery'
    ];

    if (window.__poelogChatHistoryBridgeInstalled) {
        document.documentElement.dataset.poelogChatHistoryBridgeReady = '1';
        return;
    }
    window.__poelogChatHistoryBridgeInstalled = true;

    const state = {
        templates: [],
        lastPageInfo: null,
        lastActivityAt: 0
    };

    function dispatch(eventName, payload) {
        document.dispatchEvent(new CustomEvent(eventName, {
            detail: JSON.stringify(payload)
        }));
    }

    function safeJsonParse(value) {
        if (typeof value !== 'string' || !value.trim()) {
            return null;
        }

        try {
            return JSON.parse(value);
        } catch (error) {
            return null;
        }
    }

    function serializeHeaders(headers) {
        if (!headers) {
            return {};
        }

        if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
        }

        if (Array.isArray(headers)) {
            return Object.fromEntries(headers);
        }

        if (typeof headers === 'object') {
            return { ...headers };
        }

        return {};
    }

    function extractQueryMetadata(requestJson, bodyText) {
        const queryName = requestJson?.queryName
            || requestJson?.operationName
            || requestJson?.params?.name
            || null;
        const queryId = requestJson?.id
            || requestJson?.queryId
            || requestJson?.params?.id
            || null;
        const variables = requestJson?.variables && typeof requestJson.variables === 'object'
            ? { ...requestJson.variables }
            : {};
        const trackedByName = Boolean(queryName && QUERY_NAMES.has(queryName));
        const trackedById = Boolean(queryId && QUERY_IDS.has(queryId));
        const trackedByBody = typeof bodyText === 'string'
            && bodyText.length > 0
            && (Array.from(QUERY_IDS).some((id) => bodyText.includes(id))
                || Array.from(QUERY_NAMES).some((name) => bodyText.includes(name))
                || (/chatCode|lastInteractionTime|lastMessage/i.test(bodyText)
                    && /cursor|after|count|first/i.test(bodyText)));

        return {
            queryName,
            queryId,
            variables,
            isTracked: trackedByName || trackedById || trackedByBody
        };
    }

    function isChatConnection(candidate) {
        return Boolean(
            candidate
            && typeof candidate === 'object'
            && Array.isArray(candidate.edges)
            && candidate.edges.some((edge) => typeof edge?.node?.chatCode === 'string' && typeof edge?.node?.title === 'string')
        );
    }

    function getPreferredConnectionAliases(queryName) {
        if (queryName === 'ChatHistoryFilteredListPaginationQuery') {
            return ['filteredChats'];
        }

        if (queryName && QUERY_NAMES.has(queryName)) {
            return ['chats'];
        }

        return [];
    }

    function collectConnectionPayload(connection, seenCodes) {
        const records = [];

        connection.edges.forEach((edge) => {
            const node = edge?.node;
            if (!node || typeof node.chatCode !== 'string' || typeof node.title !== 'string') {
                return;
            }

            if (seenCodes.has(node.chatCode)) {
                return;
            }
            seenCodes.add(node.chatCode);

            records.push({
                chatCode: node.chatCode,
                title: node.title,
                preview: node.lastMessage?.textPreview || node.lastMessage?.text || '',
                lastInteractionTime: node.lastInteractionTime || 0,
                cursor: typeof edge?.cursor === 'string' ? edge.cursor : null
            });
        });

        return {
            records,
            pageInfo: connection.pageInfo && typeof connection.pageInfo === 'object'
                ? {
                    endCursor: typeof connection.pageInfo.endCursor === 'string' ? connection.pageInfo.endCursor : null,
                    hasNextPage: Boolean(connection.pageInfo.hasNextPage)
                }
                : null
        };
    }

    function extractChatConnectionPayload(source, queryName = null) {
        const records = [];
        const seenCodes = new Set();
        const queue = [source];
        const visited = new WeakSet();
        let pageInfo = null;
        const preferredAliases = getPreferredConnectionAliases(queryName);
        const preferredConnections = [];

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || typeof current !== 'object') {
                continue;
            }

            if (visited.has(current)) {
                continue;
            }
            visited.add(current);

            if (Array.isArray(current)) {
                current.slice(0, 1_000).forEach((value) => queue.push(value));
                continue;
            }

            Object.entries(current).slice(0, 500).forEach(([key, value]) => {
                if (preferredAliases.includes(key) && isChatConnection(value)) {
                    preferredConnections.push(value);
                }
                queue.push(value);
            });
        }

        const candidateConnections = preferredConnections.length > 0
            ? preferredConnections
            : [];

        if (candidateConnections.length === 0) {
            const fallbackQueue = [source];
            const fallbackVisited = new WeakSet();

            while (fallbackQueue.length > 0) {
                const current = fallbackQueue.shift();
                if (!current || typeof current !== 'object') {
                    continue;
                }

                if (fallbackVisited.has(current)) {
                    continue;
                }
                fallbackVisited.add(current);

                if (Array.isArray(current)) {
                    current.slice(0, 1_000).forEach((value) => fallbackQueue.push(value));
                    continue;
                }

                if (isChatConnection(current)) {
                    candidateConnections.push(current);
                }

                Object.values(current).slice(0, 500).forEach((value) => fallbackQueue.push(value));
            }
        }

        candidateConnections.forEach((connection) => {
            const extracted = collectConnectionPayload(connection, seenCodes);
            records.push(...extracted.records);
            if (extracted.pageInfo) {
                pageInfo = extracted.pageInfo;
            }
        });

        if (queryName === CATALOG_INITIAL_QUERY.queryName || queryName === CATALOG_PAGINATION_QUERY.queryName) {
            records.sort((left, right) => Number(right.lastInteractionTime || 0) - Number(left.lastInteractionTime || 0));
        }

        return {
            records,
            pageInfo
        };
    }

    function templateKey(template) {
        return template.queryName || template.queryId || template.url || 'unknown';
    }

    function rememberTemplate(template) {
        const key = templateKey(template);
        state.templates = [template].concat(state.templates.filter((candidate) => templateKey(candidate) !== key)).slice(0, 8);
    }

    function getTransportTemplate() {
        const prioritizedTemplates = state.templates.slice().sort((left, right) => {
            const leftPriority = TRANSPORT_QUERY_PRIORITY.indexOf(left.queryName || '');
            const rightPriority = TRANSPORT_QUERY_PRIORITY.indexOf(right.queryName || '');
            const normalizedLeft = leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority;
            const normalizedRight = rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority;
            return normalizedLeft - normalizedRight;
        });

        return prioritizedTemplates.find((template) => template.requestJson && typeof template.requestJson === 'object')
            || prioritizedTemplates[0]
            || null;
    }

    function getBestTemplate() {
        return state.templates.find((template) => {
            const variables = template.variables || {};
            return Object.prototype.hasOwnProperty.call(variables, 'cursor')
                || Object.prototype.hasOwnProperty.call(variables, 'after');
        }) || state.templates[0] || null;
    }

    function cloneRequestJson(template) {
        const source = template?.requestJson && typeof template.requestJson === 'object'
            ? template.requestJson
            : safeJsonParse(template?.bodyText);

        return source && typeof source === 'object'
            ? JSON.parse(JSON.stringify(source))
            : null;
    }

    function applyQueryDescriptor(requestJson, queryDefinition, variables) {
        if (!requestJson || typeof requestJson !== 'object') {
            return null;
        }

        requestJson.queryName = queryDefinition.queryName;
        requestJson.operationName = queryDefinition.queryName;
        requestJson.id = queryDefinition.queryId;
        requestJson.queryId = queryDefinition.queryId;
        requestJson.variables = variables;

        if (requestJson.params && typeof requestJson.params === 'object') {
            requestJson.params.name = queryDefinition.queryName;
            requestJson.params.id = queryDefinition.queryId;
        }

        return requestJson;
    }

    function buildReplayHeaders(headers) {
        const replayHeaders = {};

        Object.entries(headers || {}).forEach(([name, value]) => {
            const lowerName = String(name).toLowerCase();
            if (
                lowerName === 'accept'
                || lowerName === 'content-type'
                || lowerName.startsWith('x-')
                || lowerName.startsWith('poe-')
                || lowerName.startsWith('apollographql-')
            ) {
                replayHeaders[name] = value;
            }
        });

        if (!Object.keys(replayHeaders).some((name) => String(name).toLowerCase() === 'content-type')) {
            replayHeaders['content-type'] = 'application/json';
        }

        return replayHeaders;
    }

    function buildRequestDescriptor(url, method, headers, bodyText) {
        const requestJson = safeJsonParse(bodyText);
        const metadata = extractQueryMetadata(requestJson, bodyText);

        return {
            url,
            method: method || 'GET',
            headers,
            bodyText,
            requestJson,
            queryName: metadata.queryName,
            queryId: metadata.queryId,
            variables: metadata.variables,
            isTracked: metadata.isTracked
        };
    }

    function capturePayload(url, method, headers, bodyText, payload, responseStatus) {
        const descriptor = buildRequestDescriptor(url, method, headers, bodyText);
        if (!descriptor.isTracked) {
            return;
        }

        const extracted = extractChatConnectionPayload(payload, descriptor.queryName);
        if (extracted.records.length === 0 && !extracted.pageInfo) {
            return;
        }

        rememberTemplate(descriptor);
        state.lastPageInfo = extracted.pageInfo || state.lastPageInfo;
        state.lastActivityAt = Date.now();

        dispatch(CAPTURE_EVENT, {
            request: {
                url: descriptor.url,
                method: descriptor.method,
                headers: descriptor.headers,
                bodyText: descriptor.bodyText,
                queryName: descriptor.queryName,
                queryId: descriptor.queryId,
                variables: descriptor.variables
            },
            responseStatus,
            pageInfo: extracted.pageInfo,
            records: extracted.records,
            observedAt: new Date().toISOString()
        });
    }

    async function captureFetchResponse(input, init, response) {
        try {
            const requestUrl = typeof input === 'string' ? input : input?.url || '';
            const requestMethod = init?.method || input?.method || 'GET';
            const requestHeaders = serializeHeaders(init?.headers || input?.headers);
            let bodyText = '';

            if (typeof init?.body === 'string') {
                bodyText = init.body;
            } else if (input instanceof Request && !init?.body && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
                bodyText = await input.clone().text();
            }

            const contentType = response.headers.get('content-type') || '';
            if (!/application\/json/i.test(contentType)) {
                return;
            }

            const payload = await response.clone().json();
            capturePayload(requestUrl, requestMethod, requestHeaders, bodyText, payload, response.status);
        } catch (error) {
            return;
        }
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
        const response = await originalFetch(input, init);
        captureFetchResponse(input, init, response);
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__poelogMethod = method;
        this.__poelogUrl = url;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
        this.__poelogBodyText = typeof body === 'string' ? body : '';
        this.addEventListener('load', () => {
            try {
                const contentType = this.getResponseHeader('content-type') || '';
                if (!/application\/json/i.test(contentType) || typeof this.responseText !== 'string') {
                    return;
                }

                const payload = safeJsonParse(this.responseText);
                if (!payload) {
                    return;
                }

                capturePayload(
                    this.__poelogUrl || '',
                    this.__poelogMethod || 'GET',
                    {},
                    this.__poelogBodyText || '',
                    payload,
                    this.status
                );
            } catch (error) {
                return;
            }
        });

        return originalSend.apply(this, arguments);
    };

    async function fetchQueryUsingTransport(queryDefinition, variables) {
        const template = getTransportTemplate();
        if (!template) {
            throw new Error('No chat history request template has been observed yet.');
        }

        const requestJson = applyQueryDescriptor(cloneRequestJson(template), queryDefinition, variables);
        if (!requestJson) {
            throw new Error('The observed chat history request could not be cloned.');
        }

        const bodyText = JSON.stringify(requestJson);
        const headers = buildReplayHeaders(template.headers);

        const response = await originalFetch(template.url, {
            method: template.method || 'POST',
            credentials: 'include',
            headers,
            body: bodyText
        });

        const contentType = response.headers.get('content-type') || '';
        if (!/application\/json/i.test(contentType)) {
            throw new Error('The chat history response was not JSON.');
        }

        const responsePayload = await response.clone().json();
        capturePayload(template.url, template.method || 'POST', headers, bodyText, responsePayload, response.status);
        const extracted = extractChatConnectionPayload(responsePayload, queryDefinition.queryName);

        return {
            ok: response.ok,
            status: response.status,
            records: extracted.records,
            pageInfo: extracted.pageInfo || state.lastPageInfo,
            templateCount: state.templates.length
        };
    }

    async function fetchChatHistoryPage(payload) {
        const template = getBestTemplate();
        if (!template) {
            throw new Error('No chat history pagination request template has been observed yet.');
        }

        const requestJson = template.requestJson ? { ...template.requestJson } : safeJsonParse(template.bodyText);
        if (!requestJson || typeof requestJson !== 'object') {
            throw new Error('The observed chat history request did not contain JSON variables.');
        }

        const variables = requestJson.variables && typeof requestJson.variables === 'object'
            ? { ...requestJson.variables }
            : {};
        const nextCursor = Object.prototype.hasOwnProperty.call(payload, 'cursor') ? payload.cursor : variables.cursor;
        const nextCount = Number.isFinite(payload.count) ? payload.count : undefined;

        if (Object.prototype.hasOwnProperty.call(variables, 'cursor') || nextCursor !== undefined) {
            variables.cursor = nextCursor ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(variables, 'after')) {
            variables.after = nextCursor ?? null;
        }
        if (nextCount !== undefined || Object.prototype.hasOwnProperty.call(variables, 'count')) {
            variables.count = nextCount ?? variables.count ?? 50;
        }
        if (nextCount !== undefined || Object.prototype.hasOwnProperty.call(variables, 'first')) {
            variables.first = nextCount ?? variables.first ?? 50;
        }

        requestJson.variables = variables;
        const bodyText = JSON.stringify(requestJson);
        const headers = buildReplayHeaders(template.headers);

        const response = await originalFetch(template.url, {
            method: template.method || 'POST',
            credentials: 'include',
            headers,
            body: bodyText
        });

        const contentType = response.headers.get('content-type') || '';
        if (!/application\/json/i.test(contentType)) {
            throw new Error('The chat history pagination response was not JSON.');
        }

        const responsePayload = await response.clone().json();
        capturePayload(template.url, template.method || 'POST', headers, bodyText, responsePayload, response.status);
        const extracted = extractChatConnectionPayload(responsePayload, template.queryName);

        return {
            ok: response.ok,
            status: response.status,
            records: extracted.records,
            pageInfo: extracted.pageInfo || state.lastPageInfo,
            templateCount: state.templates.length
        };
    }

    async function fetchPreferredCatalogPage(payload) {
        const mode = payload?.mode === 'pagination' ? 'pagination' : 'initial';
        const queryDefinition = mode === 'pagination' ? CATALOG_PAGINATION_QUERY : CATALOG_INITIAL_QUERY;
        const variables = mode === 'pagination'
            ? {
                count: Number.isFinite(payload?.count) ? payload.count : 200,
                cursor: payload?.cursor ?? null
            }
            : {};

        return fetchQueryUsingTransport(queryDefinition, variables);
    }

    document.addEventListener(COMMAND_EVENT, async (event) => {
        const detail = safeJsonParse(event.detail);
        if (!detail || typeof detail !== 'object') {
            return;
        }

        const { commandId, action, payload } = detail;
        if (!commandId || !action) {
            return;
        }

        try {
            if (action === 'resetChatHistoryCapture') {
                state.templates = [];
                state.lastPageInfo = null;
                state.lastActivityAt = 0;
                dispatch(RESPONSE_EVENT, {
                    commandId,
                    ok: true,
                    templateCount: 0,
                    pageInfo: null
                });
                return;
            }

            if (action === 'getChatHistoryCaptureState') {
                dispatch(RESPONSE_EVENT, {
                    commandId,
                    ok: true,
                    templateCount: state.templates.length,
                    pageInfo: state.lastPageInfo,
                    lastActivityAt: state.lastActivityAt
                });
                return;
            }

            if (action === 'fetchChatHistoryPage') {
                const response = await fetchChatHistoryPage(payload || {});
                dispatch(RESPONSE_EVENT, {
                    commandId,
                    ...response
                });
                return;
            }

            if (action === 'fetchPreferredCatalogPage') {
                const response = await fetchPreferredCatalogPage(payload || {});
                dispatch(RESPONSE_EVENT, {
                    commandId,
                    ...response
                });
                return;
            }

            dispatch(RESPONSE_EVENT, {
                commandId,
                ok: false,
                error: 'Unknown bridge action.'
            });
        } catch (error) {
            dispatch(RESPONSE_EVENT, {
                commandId,
                ok: false,
                error: error?.message || 'Bridge command failed.'
            });
        }
    });

    document.documentElement.dataset.poelogChatHistoryBridgeReady = '1';
})();