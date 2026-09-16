import { db } from '../state.js';

const DEFAULT_VECTOR_API_CONFIG = {
    enabled: false,
    provider: 'custom_openai_compatible',
    url: '',
    key: '',
    model: 'text-embedding-3-small',
    applyTo: 'memory',
    embeddingPath: '',
    memoryThreshold: 0.25,
    memoryBoostWeight: 15,
    imageThreshold: 0.5
};

function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

export function guessVectorProviderFromUrl(url = '') {
    const value = String(url || '').trim().toLowerCase();
    if (!value) return DEFAULT_VECTOR_API_CONFIG.provider;
    if (value.includes('open.bigmodel.cn/api/paas/v4')) return 'zhipu';
    if (value.includes('siliconflow.cn')) return 'siliconflow';
    if (value.includes('dashscope.aliyuncs.com') || value.includes('maas.aliyuncs.com')) return 'aliyun';
    if (value.includes('api.openai.com')) return 'openai';
    return DEFAULT_VECTOR_API_CONFIG.provider;
}

function normalizeVectorApiConfig(value = {}) {
    const merged = {
        ...DEFAULT_VECTOR_API_CONFIG,
        ...(value && typeof value === 'object' ? value : {})
    };
    merged.enabled = merged.enabled === true;
    merged.url = String(merged.url || '').trim().replace(/\/$/, '');
    merged.key = String(merged.key || '').trim();
    merged.model = String(merged.model || DEFAULT_VECTOR_API_CONFIG.model).trim() || DEFAULT_VECTOR_API_CONFIG.model;
    merged.applyTo = ['memory', 'image', 'both'].includes(merged.applyTo) ? merged.applyTo : DEFAULT_VECTOR_API_CONFIG.applyTo;
    merged.provider = ['openai', 'siliconflow', 'aliyun', 'zhipu', 'custom_openai_compatible'].includes(merged.provider)
        ? merged.provider
        : guessVectorProviderFromUrl(merged.url);
    merged.embeddingPath = String(merged.embeddingPath || '').trim().replace(/^\/+/, '/');
    merged.memoryThreshold = clampNumber(merged.memoryThreshold, 0, 1, DEFAULT_VECTOR_API_CONFIG.memoryThreshold);
    merged.memoryBoostWeight = clampNumber(merged.memoryBoostWeight, 0, 1000, DEFAULT_VECTOR_API_CONFIG.memoryBoostWeight);
    merged.imageThreshold = clampNumber(merged.imageThreshold, 0, 1, DEFAULT_VECTOR_API_CONFIG.imageThreshold);
    return merged;
}

export async function getVectorApiConfig() {
    try {
        const record = await db.appData.get('vector_api_config');
        return normalizeVectorApiConfig(record?.value);
    } catch (error) {
        console.warn('[Vector API] Failed to read config, using defaults.', error);
        return normalizeVectorApiConfig();
    }
}

export async function getApiEmbedding(text, config) {
    const queryText = String(text || '').trim();
    const safeConfig = normalizeVectorApiConfig(config);
    if (!queryText || !safeConfig.enabled || !safeConfig.url || !safeConfig.model) return null;

    try {
        let baseUrl = safeConfig.url.replace(/\/+$/, '');
        const provider = safeConfig.provider && safeConfig.provider !== 'custom_openai_compatible'
            ? safeConfig.provider
            : guessVectorProviderFromUrl(baseUrl);
        const endpointPath = safeConfig.embeddingPath
            || (provider === 'zhipu' ? '/embeddings' : '/v1/embeddings');
        if (endpointPath === '/v1/embeddings' && /\/v1$/i.test(baseUrl)) {
            baseUrl = baseUrl.replace(/\/v1$/i, '');
        }
        const response = await fetch(`${baseUrl}${endpointPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(safeConfig.key ? {
                    Authorization: `Bearer ${safeConfig.key}`,
                    'api-key': safeConfig.key,
                    'x-api-key': safeConfig.key
                } : {})
            },
            body: JSON.stringify({
                model: safeConfig.model,
                input: queryText
            })
        });

        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const message = data?.error?.message || data?.message || `Embedding request failed: ${response.status}`;
            throw new Error(message);
        }

        const embedding = data?.data?.[0]?.embedding || data?.embedding || null;
        return Array.isArray(embedding) ? embedding : null;
    } catch (error) {
        console.warn('[Vector API] Embedding request failed.', error);
        return null;
    }
}

export function apiCosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) return 0;
    const len = Math.min(vecA.length, vecB.length);
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
        const a = Number(vecA[i]) || 0;
        const b = Number(vecB[i]) || 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }

    if (normA === 0 || normB === 0) return 0;
    const cosine = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return Math.max(0, Math.min(1, cosine));
}
