export const API_BASE = '/api/plugins/strpg';

export function getStContext() {
    if (!globalThis.SillyTavern?.getContext) throw new Error('SillyTavern context is not available');
    return globalThis.SillyTavern.getContext();
}

export function getStudioToken() {
    try {
        return localStorage.getItem('strpg.studioToken') ?? '';
    } catch {
        return '';
    }
}

export function setStudioToken(token) {
    try {
        if (token) localStorage.setItem('strpg.studioToken', token);
        else localStorage.removeItem('strpg.studioToken');
    } catch {
        // ignore storage errors
    }
}

export function getToolToken() {
    try {
        return localStorage.getItem('strpg.toolToken') ?? '';
    } catch {
        return '';
    }
}

export function setToolToken(token) {
    try {
        if (token) localStorage.setItem('strpg.toolToken', token);
        else localStorage.removeItem('strpg.toolToken');
    } catch {
        // ignore storage errors
    }
}

export class ApiError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = options.status;
        this.code = options.code;
        this.details = options.details;
    }
}

export async function api(path, options = {}) {
    const ctx = getStContext();
    const headers = {
        ...(ctx.getRequestHeaders?.() ?? {}),
        ...(options.headers ?? {}),
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const studioToken = getStudioToken();
    if (studioToken) headers['x-strpg-studio-token'] = studioToken;
    const toolToken = getToolToken();
    if (toolToken) headers['x-strpg-tool-token'] = toolToken;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: options.method ?? 'GET',
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            credentials: 'same-origin',
        });
    } catch (error) {
        throw new ApiError(`Cannot reach the STRPG service: ${error.message}`, { code: 'NETWORK_ERROR' });
    }
    if (options.raw) {
        if (!response.ok) throw new ApiError(`HTTP ${response.status}`, { status: response.status });
        return options.raw === 'blob' ? response.blob() : response.text();
    }
    const text = await response.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        payload = { ok: false, error: { message: text || `HTTP ${response.status}` } };
    }
    if (!response.ok || payload?.ok === false) {
        const error = payload?.error ?? {};
        throw new ApiError(error.message ?? `STRPG request failed (HTTP ${response.status})`, {
            status: response.status,
            code: error.code,
            details: error.details,
        });
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) return payload.data;
    return payload;
}

export function getApiBase() {
    return API_BASE;
}

export function getChatKey() {
    const ctx = getStContext();
    const chatId = ctx.getCurrentChatId?.() || ctx.chatId || '(no-chat)';
    const character = ctx.characters?.[ctx.characterId];
    const characterKey = ctx.groupId ? `group:${ctx.groupId}` : (character?.avatar ?? 'unknown');
    return `${characterKey}::${chatId}`;
}

export function getChatName() {
    const ctx = getStContext();
    const character = ctx.characters?.[ctx.characterId];
    if (ctx.groupId) return ctx.groups?.find((group) => String(group.id) === String(ctx.groupId))?.name ?? 'Group chat';
    return character?.name ?? ctx.name2 ?? 'SillyTavern';
}

export function hasChat() {
    const ctx = getStContext();
    return Boolean(ctx.getCurrentChatId?.() || ctx.chatId);
}

export function randomIdempotencyKey(prefix = 'ui') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function downloadJson(path, filename) {
    const ctx = getStContext();
    const response = await fetch(`${API_BASE}${path}`, { headers: { ...(ctx.getRequestHeaders?.() ?? {}) } });
    if (!response.ok) throw new ApiError(`Download failed (HTTP ${response.status})`, { status: response.status });
    const text = await response.text();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileToDataUrl(file, maxBytes = 3 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('No file selected'));
        if (file.size > maxBytes) return reject(new Error('Image exceeds the 3 MB limit. Compress it before importing.'));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read the image.'));
        reader.readAsDataURL(file);
    });
}

