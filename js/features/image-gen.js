import { AppState, db } from '../state.js';
import { escapeHTML } from '../utils.js';
import { showDynamicIsland, showInputModal, showPage } from '../ui.js';
import { isAppleMobile, isNativeRuntime, openImageForAppleSave, saveImageToNativeGallery, shareBlobToApple } from '../native-bridge.js';
import { UPDATE_MANIFEST_URL } from '../live-update.js';

export const IMAGE_GEN_PROVIDERS = {
    gpt_image: {
        name: ' OpenAI（使用中转站最推荐）',
        defaultUrl: '',
        models: ['gpt-image-1'],
        defaultModel: 'gpt-image-1',
        supportsNegativePrompt: false,
        supportsFaceRef: true,
        buildRequest(prompt, options) {
            const { settings, faceRef } = options;
            const faceBlob = dataUrlToBlob(faceRef);
            if (faceBlob) {
                const form = new FormData();
                form.append('model', settings.model || this.defaultModel);
                form.append('prompt', prompt);
                form.append('n', '1');
                form.append('size', settings.size);
                form.append('image', faceBlob, 'reference.png');
                return {
                    url: `${getOpenAiStyleBaseUrl(settings.url)}/v1/images/edits`,
                    headers: { Authorization: `Bearer ${settings.apiKey}` },
                    body: form,
                    isFormData: true
                };
            }
            const body = {
                model: settings.model || this.defaultModel,
                prompt,
                n: 1,
                size: settings.size,
                quality: settings.quality,
                response_format: 'b64_json'
            };
            return {
                url: `${getOpenAiStyleBaseUrl(settings.url)}/v1/images/generations`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
                body
            };
        },
        parseResponse(data) {
            return parseOpenAiImageResponse(data);
        }
    },
    gemini_image: {
        name: 'Gemini Image',
        defaultUrl: 'https://generativelanguage.googleapis.com',
        models: ['gemini-2.5-flash-image-preview', 'imagen-3.0-generate-002'],
        defaultModel: 'gemini-2.5-flash-image-preview',
        supportsNegativePrompt: false,
        supportsFaceRef: true,
        buildRequest(prompt, options) {
            const { settings, faceRef } = options;
            const parts = [{ text: prompt }];
            const inline = dataUrlToInlineData(faceRef);
            if (inline) parts.push({ inlineData: inline });
            return {
                url: `${trimTrailingSlash(settings.url)}/v1beta/models/${settings.model || this.defaultModel}:generateContent`,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
                body: {
                    contents: [{ role: 'user', parts }],
                    generationConfig: { responseModalities: ['IMAGE'] }
                }
            };
        },
        parseResponse(data) {
            const parts = data?.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(part => part.inlineData?.data);
            if (!imagePart) throw new Error('生图接口没有返回图片');
            const mimeType = imagePart.inlineData.mimeType || 'image/png';
            return `data:${mimeType};base64,${imagePart.inlineData.data}`;
        }
    },
    novelai: {
        name: 'NovelAI/novel中转站',
        defaultUrl: 'https://image.novelai.net',
        models: [
            'nai-diffusion-4-5-full',
            'nai-diffusion-4-5-curated',
            'nai-diffusion-4-full',
            'nai-diffusion-4-curated-preview',
            'nai-diffusion-3',
            'nai-diffusion-furry-3'
        ],
        defaultModel: 'nai-diffusion-4-5-full',
        supportsNegativePrompt: true,
        supportsFaceRef: true,
        buildRequest(prompt, options) {
            const { settings, negativePrompt, faceRef, faceStrength } = options;
            const [width, height] = parseSize(settings.size);
            const model = settings.model || this.defaultModel;
            const isV4 = /nai-diffusion-4/i.test(model);
            const seed = Math.floor(Math.random() * 4294967295);
            const parameters = {
                width,
                height,
                n_samples: 1,
                seed,
                sampler: 'k_euler_ancestral',
                steps: 28,
                scale: 6,
                noise_schedule: 'karras',
                negative_prompt: negativePrompt || ''
            };
            if (isV4) {
                parameters.params_version = 3;
                parameters.use_coords = false;
                parameters.legacy = false;
                parameters.v4_prompt = {
                    caption: { base_caption: prompt, char_captions: [] },
                    use_coords: false,
                    use_order: true
                };
                parameters.v4_negative_prompt = {
                    caption: { base_caption: negativePrompt || '', char_captions: [] }
                };
            }
            const base64Ref = stripDataUrlPrefix(faceRef);
            if (base64Ref && !isV4) {
                parameters.reference_image_multiple = [base64Ref];
                parameters.reference_strength_multiple = [Number(faceStrength || 0.6)];
                parameters.reference_information_extracted_multiple = [1.0];
            }
            return {
                url: `${trimTrailingSlash(settings.url)}/ai/generate-image`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
                body: {
                    input: prompt,
                    model,
                    action: 'generate',
                    parameters
                },
                responseType: 'arrayBuffer'
            };
        },
        async parseResponse(_data, bufferOrResponse) {
        const JSZip = (await import('../lib/jszip.min.js')).default;
            const buffer = bufferOrResponse instanceof ArrayBuffer
                ? bufferOrResponse
                : await bufferOrResponse.arrayBuffer();
            const zip = await JSZip.loadAsync(buffer);
            const file = Object.values(zip.files).find(item => !item.dir && /\.(png|jpe?g|webp)$/i.test(item.name));
            if (!file) throw new Error('NovelAI 返回包里没有图片');
            const base64 = await file.async('base64');
            const mimeType = file.name.toLowerCase().endsWith('.webp') ? 'image/webp'
                : (/\.jpe?g$/i.test(file.name) ? 'image/jpeg' : 'image/png');
            return `data:${mimeType};base64,${base64}`;
        }
    },
    grok: {
        name: 'Grok',
        defaultUrl: 'https://api.x.ai',
        models: ['grok-2-image'],
        defaultModel: 'grok-2-image',
        supportsNegativePrompt: false,
        supportsFaceRef: true,
        buildRequest(prompt, options) {
            const { settings, faceRef, faceStrength } = options;
            const body = { model: settings.model || this.defaultModel, prompt, n: 1 };
            const fallbackBody = { ...body };
            appendOpenAiLikeFaceReference(body, faceRef, faceStrength);
            return {
                url: `${getOpenAiStyleBaseUrl(settings.url)}/v1/images/generations`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
                body,
                fallbackBody: faceRef ? fallbackBody : null
            };
        },
        parseResponse(data) {
            return parseOpenAiImageResponse(data);
        }
    },
    openai_compatible: {
        name: '文生图OpenAI 兼容 / 中转（接口是 v1/chat/completions）',
        defaultUrl: '',
        models: [],
        defaultModel: '',
        supportsNegativePrompt: false,
        supportsFaceRef: true,
        buildRequest(prompt, options) {
            const { settings, faceRef, faceStrength } = options;
            const content = [];
            if (faceRef) {
                const strengthPct = Math.round(Number(faceStrength || 0.6) * 100);
                const strengthNote = `\n\n[FACE FIDELITY]\nMatch the reference face at about ${strengthPct}% fidelity. Higher percent = stick more strictly to the reference face; lower percent = a little more freedom, but it must still clearly be the same person.`;
                content.push({ type: 'text', text: `${FACE_LOCK_MASTER_PROMPT}${strengthNote}\n\n${prompt}` });
                content.push({ type: 'image_url', image_url: { url: faceRef } });
            } else {
                content.push({ type: 'text', text: prompt });
            }
            return {
                url: `${getOpenAiStyleBaseUrl(settings.url)}/v1/chat/completions`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
                body: {
                    model: settings.model,
                    messages: [{ role: 'user', content }]
                }
            };
        },
        parseResponse(data) {
            return parseChatImageResponse(data);
        }
    }
};

const INS_REAL_PROMPT_REVISION = 7;
const INS_REAL_PROMPT = `CRITICAL INSTRUCTION: render ONLY what the scene description says, and do NOT add a person, face, body or character when the scene is only an object, food, animal, room or landscape. Photorealistic Instagram lifestyle creator snapshot from a real phone camera: natural, flattering and personal, never a stock photo or a studio shoot. Capture a believable in-between moment with a relaxed posture, natural weight distribution, slightly imperfect framing and a real sense of place. Use soft window light or open shade, gentle directional shadows, accurate neutral-to-slightly-cool white balance and true-to-life skin tones; avoid the orange/golden social-media filter look. Keep adult anatomy natural with a correctly sized head, neck and shoulders (head-to-body ratio about 1:7 to 1:8), realistic body scale, relaxed shoulders and natural hands with five separate fingers and correctly connected joints. When a hand or object is close to the lens, keep the perspective believable without stretched fingers, duplicated digits, melted joints or an unintentionally oversized body part. Keep the face attractive through healthy skin and authentic expression, not makeup-like retouching: preserve pores, fine facial hair, subtle asymmetry, small imperfections and natural eye highlights. Match the expression to the scene and let the gaze, pose and clothing feel unplanned rather than posed. Include believable clothing folds, hair flyaways, small everyday details and a lived-in background when the description calls for them. Use a casual phone-camera perspective, slight depth-of-field falloff and restrained sensor grain; keep the subject and important objects clear and well composed with a natural foreground, midground and background. Make the result feel like a beautiful real post from someone's camera roll, while faithfully following the user's exact scene description.`;
const LEGACY_INS_REAL_PROMPT_REVISION_4 = INS_REAL_PROMPT;
const INS_REAL_PROMPT_V5 = `CRITICAL INSTRUCTION: render ONLY what the scene description says, and do NOT add a person, face, body or character when the scene is only an object, food, animal, room or landscape. Photorealistic Instagram lifestyle creator snapshot from a real phone camera: natural, flattering and personal, never a stock photo or a studio shoot. Treat the attached face reference as identity guidance only, never as a template for its original pose, expression, crop or lighting. Rebuild the face naturally inside the requested moment and atmosphere. Use a flattering but believable phone-camera composition with enough environmental context; avoid an overly tight passport-like crop, stiff centered portrait or exaggerated wide-angle distortion. Keep adult anatomy natural: the head should be proportionate to the visible torso, the neck should transition cleanly into relaxed shoulders, and the shoulder line should be about 2 to 2.5 head-widths without making the upper body bulky. Keep arms, hands and fingers anatomically connected and correctly scaled, especially when a hand is close to the lens. Let the expression come from the described action and mood: relaxed eyes, natural eyelid tension, a small asymmetric smile or focused look when appropriate, never a blank stare, frozen mouth or forced model expression. Match the face, body and environment to one shared camera perspective, focal length, light direction, shadow softness, white balance, skin tone and grain; the reference image must not bring its old lighting or mood into the new scene. Preserve recognizable identity through face shape, key features, hair and skin tone while allowing natural head angle, gaze, micro-expression and pose changes. Keep pores, fine facial hair, subtle asymmetry, small imperfections, hair flyaways and realistic clothing folds; avoid beauty-filter smoothing. Add only scene-appropriate everyday details and maintain a clear foreground, subject and background relationship. The final image should feel like a beautiful, spontaneous post from a real Instagram camera roll, faithfully following the user's exact description.`;
const LEGACY_INS_REAL_PROMPT_REVISION_5 = INS_REAL_PROMPT_V5;
const INS_REAL_NEGATIVE_PROMPT = 'pasted-on face, face swap artifact, mismatched face and body, mismatched lighting, mismatched skin tone, oversized head, undersized head, narrow shoulders, unnaturally broad shoulders, short neck, stretched neck, stiff mannequin pose, passport photo, centered studio portrait, dead eyes, blank stare, frozen expression, emotionless face, forced smile, plastic skin, beauty filter, airbrushed skin, wide-angle distortion, fisheye distortion, stretched hands, malformed hands, extra fingers, fused fingers, duplicated fingers, dislocated joints, broken anatomy, cloned face, identical faces, mirrored face, duplicate person';
const LEGACY_INS_REAL_PROMPT_REVISION_6 = INS_REAL_PROMPT_V5;
const INS_REAL_PROMPT_V7 = `${INS_REAL_PROMPT_V5} When the subject is feminine-presenting or the user asks for a feminine, soft, romantic or lifestyle-blogger mood, add a refined but believable feminine visual language: gentle flattering light, softly coordinated colors, graceful relaxed posture, clean natural styling, flattering clothing drape and restrained details such as natural makeup or delicate jewelry only when the scene mentions them or they clearly fit the requested look. Favor a warm, inviting everyday atmosphere and quiet confidence over a hard commercial fashion pose. Keep the beauty editorial polish subtle and lived-in: healthy skin, natural texture, small asymmetries and a real camera moment must remain visible. Do not turn the subject into a doll, model, beauty advertisement or overly sweet stereotype.`;
const LEGACY_INS_REAL_PROMPT_REVISION_3 = `CRITICAL INSTRUCTION: render ONLY what the scene description says, and do NOT add a person, face, body or character when the scene is only an object, food, animal, room or landscape. Photorealistic Instagram lifestyle creator snapshot from a real phone camera: natural, flattering and personal, never a stock photo or a studio shoot. Capture a believable in-between moment with a relaxed posture, natural weight distribution, slightly imperfect framing and a real sense of place. Use soft window light or open shade, gentle directional shadows, accurate neutral-to-slightly-cool white balance and true-to-life skin tones; avoid the orange/golden social-media filter look. Keep adult anatomy natural with a correctly sized head, neck and shoulders (head-to-body ratio about 1:7 to 1:8), realistic body scale, relaxed shoulders and natural hands. Keep the face attractive through healthy skin and authentic expression, not makeup-like retouching: preserve pores, fine facial hair, subtle asymmetry, small imperfections and natural eye highlights. Match the expression to the scene and let the gaze, pose and clothing feel unplanned rather than posed. Include believable clothing folds, hair flyaways, small everyday details and a lived-in background when the description calls for them. Use a casual phone-camera perspective, slight depth-of-field falloff and restrained sensor grain; keep the subject and important objects clear and well composed. Make the result feel like a beautiful real post from someone's camera roll, while faithfully following the user's exact scene description.`;
const LEGACY_INS_REAL_PROMPT_ORIGINAL = `a candid unposed everyday snapshot of the subject as if a friend quickly took the photo, caught mid-moment, natural relaxed posture with believable weight shift and loose shoulders, natural body language, hands relaxed with correct anatomy and a natural gesture, subtle genuine facial expression with relaxed muscles and a soft natural gaze often slightly off camera, faint natural facial asymmetry, realistic skin with visible pores, fine peach fuzz, flyaway baby hairs and tiny natural imperfections, soft even diffused daylight like an overcast day or open shade near a window, neutral accurate white balance, true-to-life natural color, no warm orange or golden cast, balanced neutral to slightly cool tones, realistic natural skin tone, detailed lived-in background with everyday objects and real depth, clear environmental context around the subject, shot on a modern smartphone, slightly off-center imperfect casual framing, shallow depth of field with soft natural background blur, subtle sensor grain and realistic phone-camera dynamic range, ultra realistic authentic photo straight from a phone camera roll`;
const LEGACY_INS_REAL_PROMPT_REVISION_2 = `CRITICAL INSTRUCTION: render ONLY what the scene description says, do NOT add objects or elements not mentioned. Photorealistic candid smartphone photo taken by a friend, captured mid-moment, unposed and spontaneous. Use natural adult proportions with a correctly sized head, neck and shoulders (head-to-body ratio about 1:7 to 1:8); never make the head oversized. Natural relaxed posture with believable weight distribution and loose shoulders, hands with correct five-finger anatomy in a natural resting gesture. Facial expression must genuinely match the described scene mood, subtle authentic micro-expression with relaxed facial muscles, soft natural gaze slightly off-camera, natural facial asymmetry and real skin texture with visible pores and fine peach fuzz and tiny imperfections, NO airbrushed or beauty-filtered or over-smoothed skin. Soft diffused natural daylight, neutral accurate white balance, true-to-life color with NO warm orange or golden cast, balanced neutral to slightly cool tones, realistic natural skin tone. Detailed lived-in background with real environmental depth matching the scene description. Slightly off-center casual framing, shallow depth of field with soft natural background blur, subtle phone-camera sensor grain, authentic everyday photo from a phone camera roll`;
const LEGACY_INS_REAL_PROMPT_REVISION_1 = LEGACY_INS_REAL_PROMPT_REVISION_2
    .replace('head-to-body ratio about 1:7 to 1:8', 'head-to-body ratio 1:7.5');

function normalizePromptText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isLegacyBuiltInInsPreset(item) {
    if (item?.id !== 'ins_real') return false;
    const revision = Number(item.revision || 0);
    const prompt = String(item.prompt || '');
    if (revision >= INS_REAL_PROMPT_REVISION) return false;
    const normalizedPrompt = normalizePromptText(prompt);
    const exactLegacyPrompt = [
        LEGACY_INS_REAL_PROMPT_ORIGINAL,
        LEGACY_INS_REAL_PROMPT_REVISION_1,
        LEGACY_INS_REAL_PROMPT_REVISION_2,
        LEGACY_INS_REAL_PROMPT_REVISION_3,
        LEGACY_INS_REAL_PROMPT_REVISION_4,
        LEGACY_INS_REAL_PROMPT_REVISION_5,
        LEGACY_INS_REAL_PROMPT_REVISION_6
    ].some(legacyPrompt => normalizedPrompt === normalizePromptText(legacyPrompt));
    return exactLegacyPrompt;
}

export const DEFAULT_IMAGE_GEN_SETTINGS = {
    enabled: false,
    matchMode: 'match_then_gen',
    authorizedScenes: {
        chat: true,
        moments: false
    },
    provider: 'gemini_image',
    url: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    negativePrompt: 'ai generated look, generic ai beauty face, plastic skin, over-smoothed skin, airbrushed, heavy retouching, beauty filter, instagram filter, glossy magazine finish, overexposed skin, waxy skin, doll face, symmetrical perfect face, fake flawless complexion, studio lighting, posed studio portrait, professional model pose, stiff pose, staring directly into camera, dead eyes, blank stare, oversaturated, warm orange color cast, golden hour glow, heavy yellow tint, sepia tone, orange skin, hdr, oversharpened, cgi, 3d render, cartoon, illustration, painting, extra fingers, fused fingers, bad hands, deformed hands, bad anatomy, distorted proportions, mutated, extra limbs, lowres, worst quality, jpeg artifacts, blurry, out of focus, watermark, signature, text, logo, frame, border',
    qualitySuffix: 'best quality, highly detailed, masterpiece',
    stylePresets: [
        { id: 'default', name: '默认', prompt: '' },
        { id: 'anime', name: '动漫', prompt: 'anime style, vibrant colors, clean lineart' },
        { id: 'realistic', name: '写实', prompt: 'photorealistic, cinematic lighting, sharp focus' },
        { id: 'illustration', name: '插画', prompt: 'illustration, painterly, soft shading' },
        { id: 'cg', name: '厚涂', prompt: 'digital painting, thick brush strokes, dramatic lighting' },
        { id: 'jpc', name: '日系胶片', prompt: 'japanese film photography, soft grain, natural light' },
        { id: 'ins_real', name: 'INS随手拍', revision: INS_REAL_PROMPT_REVISION, prompt: INS_REAL_PROMPT_V7, negativePrompt: INS_REAL_NEGATIVE_PROMPT }
    ],
    activeStylePresetId: 'default'
};

export const IMAGE_GEN_MATCH_MODE_LABELS = {
    match_only: '纯匹配相册',
    gen_only: '纯生图',
    match_then_gen: '匹配不到再生图'
};

function mergeAuthorizedScenes(raw = {}) {
    const incoming = raw?.authorizedScenes ?? raw?.scopes;
    const hasSceneSettings = incoming && typeof incoming === 'object';
    return {
        chat: hasSceneSettings
            ? incoming.chat !== false
            : (typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_IMAGE_GEN_SETTINGS.authorizedScenes.chat),
        moments: hasSceneSettings ? incoming.moments === true : false
    };
}

function trimTrailingSlash(value = '') {
    return String(value || '').trim().replace(/\/+$/, '');
}

function getOpenAiStyleBaseUrl(value = '') {
    return trimTrailingSlash(value).replace(/\/v1$/i, '');
}

const LOOKY_PROXY_ORIGIN = (() => {
    try {
        return new URL(UPDATE_MANIFEST_URL).origin;
    } catch (_error) {
        return '';
    }
})();

function getImageGenProxyUrl(targetUrl) {
    if (!targetUrl) return '';
    try {
        const baseUrl = isNativeRuntime()
            ? LOOKY_PROXY_ORIGIN
            : (typeof window !== 'undefined' && (window.location.protocol === 'http:' || window.location.protocol === 'https:'))
            ? window.location.origin
            : LOOKY_PROXY_ORIGIN;
        if (!baseUrl) return '';
        const proxyUrl = new URL('/mcp-proxy', baseUrl);
        proxyUrl.searchParams.set('target', targetUrl);
        return proxyUrl.toString();
    } catch (_error) {
        return '';
    }
}

function isHtmlImageGenResponse(response) {
    const contentType = String(response?.headers?.get('content-type') || '').toLowerCase();
    return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
}

async function fetchImageGenEndpoint(targetUrl, init = {}) {
    const proxyUrl = getImageGenProxyUrl(targetUrl);
    if (isNativeRuntime() && proxyUrl) {
        try {
            const proxyResponse = await fetch(proxyUrl, init);
            if (!isHtmlImageGenResponse(proxyResponse)) return proxyResponse;
            console.warn('[ImageGen] 代理返回了 HTML，改走直连：', proxyUrl);
        } catch (proxyError) {
            console.warn('[ImageGen] 代理请求失败，改走直连：', proxyError);
        }
    }

    try {
        return await fetch(targetUrl, init);
    } catch (directError) {
        if (proxyUrl && !isNativeRuntime()) {
            try {
                return await fetch(proxyUrl, init);
            } catch (_proxyError) {
                throw directError;
            }
        }
        throw directError;
    }
}

function parseSize(size = '1024x1024') {
    const [width, height] = String(size).split('x').map(value => parseInt(value, 10));
    return [width || 1024, height || 1024];
}

function stripDataUrlPrefix(dataUrl) {
    return String(dataUrl || '').replace(/^data:[^;]+;base64,/, '');
}
export function dataUrlToBlob(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1];
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}
function dataUrlToInlineData(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
}

function appendOpenAiLikeFaceReference(body, faceRef, faceStrength) {
    const base64 = stripDataUrlPrefix(faceRef);
    if (!base64) return body;
    const strength = Number(faceStrength || 0.6);
    body.image = base64;
    body.images = [base64];
    body.reference_image = base64;
    body.reference_images = [base64];
    body.input_image = base64;
    body.input_images = [base64];
    body.image_strength = strength;
    body.reference_strength = strength;
    body.strength = strength;
    return body;
}

function joinPromptParts(parts = []) {
    const seen = new Set();
    return parts
        .flatMap(part => String(part || '').replace(/[，、；;]/g, ',').split(','))
        .map(part => part.trim())
        .filter(part => {
            const key = part.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join(', ');
}
// ====== 中文 → Danbooru 标签翻译（离线词典 + 免费API兜底） ======
const ZH_TO_TAG = {
    // 人物动作
    '站': 'standing', '坐': 'sitting', '躺': 'lying down', '蹲': 'squatting',
    '跑': 'running', '走': 'walking', '跳': 'jumping', '飞': 'flying',
    '趴': 'lying on stomach', '靠': 'leaning', '抱': 'hugging', '牵手': 'holding hands',
    '拥抱': 'hug', '亲吻': 'kiss', '微笑': 'smile', '笑': 'smile',
    '哭': 'crying', '害羞': 'blush', '脸红': 'blush', '闭眼': 'closed eyes',
    '睁眼': 'open eyes', '眨眼': 'winking', '回头': 'looking back',
    '低头': 'looking down', '抬头': 'looking up', '侧头': 'head tilt',
    '举手': 'arm up', '叉腰': 'hands on hips', '背手': 'arms behind back',
    '伸懒腰': 'stretching', '打哈欠': 'yawning', '吃': 'eating', '喝': 'drinking',
    '唱歌': 'singing', '跳舞': 'dancing', '睡觉': 'sleeping', '读书': 'reading',
    '写字': 'writing', '打伞': 'holding umbrella', '拍照': 'taking photo',
    '自拍': 'selfie', '挥手': 'waving', '指': 'pointing', '摸头': 'head pat',
    '撑伞': 'holding umbrella', '弹琴': 'playing piano', '弹吉他': 'playing guitar',
    '玩手机': 'holding phone', '看手机': 'looking at phone', '打电话': 'on phone',
    '做饭': 'cooking', '洗澡': 'bathing', '游泳': 'swimming', '骑': 'riding',
    '开车': 'driving', '战斗': 'fighting', '握剑': 'holding sword',

    // 表情
    '开心': 'happy', '难过': 'sad', '生气': 'angry', '惊讶': 'surprised',
    '害怕': 'scared', '困': 'sleepy', '无聊': 'bored', '得意': 'smug',
    '温柔': 'gentle smile', '冷漠': 'expressionless', '委屈': 'teary eyes',
    '撅嘴': 'pout', '吐舌头': 'tongue out', '邪笑': 'evil smile',
    '傲娇': 'tsundere', '呆': 'blank stare', '发呆': 'blank stare',

    // 视角/构图
    '正面': 'front view', '侧面': 'side view', '背面': 'from behind',
    '俯视': 'from above', '仰视': 'from below', '特写': 'close-up',
    '全身': 'full body', '半身': 'upper body', '头像': 'portrait',
    '远景': 'wide shot', '近景': 'close-up', '鸟瞰': "bird's eye view",
    '第一人称': 'pov', '对视': 'eye contact',

    // 场景/地点
    '室内': 'indoors', '室外': 'outdoors', '学校': 'school', '教室': 'classroom',
    '操场': 'schoolyard', '图书馆': 'library', '医院': 'hospital', '公园': 'park',
    '花园': 'garden', '庭院': 'courtyard', '阳台': 'balcony', '屋顶': 'rooftop',
    '天台': 'rooftop', '街道': 'street', '小巷': 'alley', '城市': 'city',
    '乡村': 'countryside', '森林': 'forest', '山': 'mountain', '海边': 'beach',
    '海': 'ocean', '湖': 'lake', '河': 'river', '瀑布': 'waterfall',
    '沙漠': 'desert', '雪地': 'snow', '草地': 'grass', '草原': 'grassland',
    '田野': 'field', '车站': 'train station', '机场': 'airport',
    '咖啡店': 'cafe', '餐厅': 'restaurant', '酒吧': 'bar', '商店': 'shop',
    '超市': 'supermarket', '厨房': 'kitchen', '客厅': 'living room',
    '卧室': 'bedroom', '浴室': 'bathroom', '走廊': 'hallway',
    '楼梯': 'stairs', '电梯': 'elevator', '地铁': 'subway',
    '桥': 'bridge', '城堡': 'castle', '宫殿': 'palace', '神社': 'shrine',
    '寺庙': 'temple', '教堂': 'church', '废墟': 'ruins', '洞穴': 'cave',
    '水下': 'underwater', '太空': 'space', '月球': 'moon surface',
    '异世界': 'fantasy world', '赛博朋克': 'cyberpunk city',
    '沙发': 'couch', '椅子': 'chair', '床': 'bed', '桌子': 'table',
    '窗边': 'by window', '门口': 'doorway', '镜子前': 'in front of mirror',

    // 天气/时间/光线
    '白天': 'daytime', '晚上': 'night', '夜晚': 'night', '黄昏': 'sunset',
    '日落': 'sunset', '日出': 'sunrise', '清晨': 'early morning',
    '傍晚': 'dusk', '午后': 'afternoon', '深夜': 'late night',
    '阳光': 'sunlight', '月光': 'moonlight', '星空': 'starry sky',
    '星星': 'stars', '月亮': 'moon', '太阳': 'sun',
    '晴天': 'clear sky', '多云': 'cloudy', '阴天': 'overcast',
    '下雨': 'rain', '雨': 'rain', '下雪': 'snow', '雪': 'snowing',
    '雾': 'fog', '风': 'wind', '暴风雨': 'storm', '彩虹': 'rainbow',
    '闪电': 'lightning', '樱花': 'cherry blossoms', '落叶': 'falling leaves',
    '飘雪': 'falling snow', '逆光': 'backlighting', '光影': 'light and shadow',
    '柔光': 'soft lighting', '暗光': 'dim lighting',

    // 服装
    '校服': 'school uniform', '制服': 'uniform', '西装': 'suit', '和服': 'kimono',
    '旗袍': 'china dress', '连衣裙': 'dress', '裙子': 'skirt', '短裙': 'miniskirt',
    '长裙': 'long skirt', 'T恤': 't-shirt', '衬衫': 'shirt', '外套': 'jacket',
    '大衣': 'coat', '毛衣': 'sweater', '卫衣': 'hoodie', '背心': 'tank top',
    '泳衣': 'swimsuit', '比基尼': 'bikini', '睡衣': 'pajamas',
    '婚纱': 'wedding dress', '礼服': 'evening dress', '盔甲': 'armor',
    '斗篷': 'cape', '围裙': 'apron', '女仆装': 'maid outfit',
    '护士服': 'nurse outfit', '运动服': 'sportswear', '便装': 'casual clothes',
    '内衣': 'underwear', '丝袜': 'thighhighs', '短裤': 'shorts',
    '牛仔裤': 'jeans', '热裤': 'short shorts',
    '手套': 'gloves', '围巾': 'scarf', '帽子': 'hat', '眼镜': 'glasses',
    '耳机': 'headphones', '项链': 'necklace', '耳环': 'earrings',
    '发带': 'hair ribbon', '蝴蝶结': 'bow', '发卡': 'hair clip',
    '王冠': 'crown', '面具': 'mask', '翅膀': 'wings', '尾巴': 'tail',
    '猫耳': 'cat ears', '兔耳': 'rabbit ears',

    // 发型/发色
    '长发': 'long hair', '短发': 'short hair', '中长发': 'medium hair',
    '马尾': 'ponytail', '双马尾': 'twintails', '单马尾': 'side ponytail',
    '辫子': 'braid', '双辫': 'twin braids', '丸子头': 'hair bun',
    '披肩发': 'hair down', '卷发': 'curly hair', '直发': 'straight hair',
    '刘海': 'bangs', '齐刘海': 'blunt bangs', '侧刘海': 'side bangs',
    '黑发': 'black hair', '白发': 'white hair', '金发': 'blonde hair',
    '银发': 'silver hair', '红发': 'red hair', '蓝发': 'blue hair',
    '粉发': 'pink hair', '绿发': 'green hair', '紫发': 'purple hair',
    '棕发': 'brown hair', '橙发': 'orange hair', '渐变发': 'gradient hair',

    // 眼睛
    '红眼': 'red eyes', '蓝眼': 'blue eyes', '绿眼': 'green eyes',
    '金眼': 'golden eyes', '紫眼': 'purple eyes', '棕眼': 'brown eyes',
    '异色瞳': 'heterochromia',

    // 物品
    '剑': 'sword', '刀': 'katana', '枪': 'gun', '弓': 'bow (weapon)',
    '盾': 'shield', '杖': 'staff', '魔杖': 'wand', '书': 'book',
    '手机': 'phone', '电脑': 'computer', '相机': 'camera',
    '花': 'flower', '玫瑰': 'rose', '百合': 'lily', '向日葵': 'sunflower',
    '伞': 'umbrella', '扇子': 'fan', '气球': 'balloon', '蛋糕': 'cake',
    '糖果': 'candy', '冰淇淋': 'ice cream', '咖啡': 'coffee', '茶': 'tea',
    '酒': 'wine', '杯子': 'cup', '茶杯': 'teacup',
    '猫': 'cat', '狗': 'dog', '兔子': 'rabbit', '鸟': 'bird',
    '蝴蝶': 'butterfly', '鱼': 'fish', '龙': 'dragon',
    '钢琴': 'piano', '吉他': 'guitar', '小提琴': 'violin',
    '包': 'bag', '背包': 'backpack', '行李箱': 'suitcase',
    '钥匙': 'key', '戒指': 'ring', '信': 'letter', '照片': 'photo',
    '镜子': 'mirror', '蜡烛': 'candle', '灯': 'lamp',
    '下午茶': 'afternoon tea',

    // 氛围/风格
    '温馨': 'warm atmosphere', '浪漫': 'romantic', '忧郁': 'melancholic',
    '恐怖': 'horror', '神秘': 'mysterious', '梦幻': 'dreamy',
    '史诗': 'epic', '搞笑': 'comedic', '日常': 'slice of life',
    '唯美': 'aesthetic', '复古': 'retro', '未来': 'futuristic',
    '可爱': 'cute', '帅气': 'cool', '性感': 'sexy', '优雅': 'elegant',
};

// 最长优先匹配分词
function segmentChinese(text) {
    const maxLen = Math.max(...Object.keys(ZH_TO_TAG).map(k => k.length));
    const tags = [];
    let i = 0;
    while (i < text.length) {
        let matched = false;
        for (let len = Math.min(maxLen, text.length - i); len >= 1; len--) {
            const word = text.substring(i, i + len);
            if (ZH_TO_TAG[word]) {
                tags.push(ZH_TO_TAG[word]);
                i += len;
                matched = true;
                break;
            }
        }
        if (!matched) i++;
    }
    return tags;
}

async function translateChineseToNaiTags(chineseText) {
    if (!chineseText || !/[\u4e00-\u9fa5]/.test(chineseText)) return chineseText;

    // 先按逗号拆分（可能是 "庭院,阳光,下午茶" 格式）
    const parts = chineseText.split(/[,，、；;]+/).map(s => s.trim()).filter(Boolean);
    const allTags = [];
    const unmatchedParts = [];

    for (const part of parts) {
        if (!/[\u4e00-\u9fa5]/.test(part)) {
            allTags.push(part); // 已经是英文，直接保留
            continue;
        }
        const tags = segmentChinese(part);
        if (tags.length > 0) {
            allTags.push(...tags);
        } else {
            unmatchedParts.push(part);
        }
    }

    // 词典匹配不到的部分，用免费API兜底
    if (unmatchedParts.length > 0) {
        try {
            const q = unmatchedParts.join(', ');
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=zh-CN|en`;
            const resp = await fetch(url);
            const data = await resp.json();
            const translated = data.responseData?.translatedText;
            if (translated) {
                translated.toLowerCase().split(/[,，]+/).map(s => s.trim()).filter(Boolean)
                    .forEach(t => allTags.push(t));
            }
        } catch (e) {
            console.warn('[Tag Translation] API fallback failed:', e);
        }
    }

    return allTags.length > 0 ? allTags.join(', ') : chineseText;
}
function parseOpenAiImageResponse(data) {
    const item = data?.data?.[0];
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (item?.url) return item.url;
    throw new Error('生图接口没有返回图片');
}
const FACE_LOCK_MASTER_PROMPT = `The attached reference image identifies ONE designated character only. Use it only when that person is explicitly present in the scene. Never add the character to a room, object, food, animal, landscape, or empty scene.

[FIRST, DECIDE IF THIS PERSON BELONGS IN THE SCENE]
Read the scene description below. If it describes a pure environment, landscape, object or empty space with NO person needed, then IGNORE the reference face entirely and just paint the scene. Do NOT force this face, or any face, into a scene that does not call for a person. An unwanted floating or distorted face is a failure.

[IF THE SCENE DOES INCLUDE THIS PERSON - KEEP THE IDENTITY]
1. Preserve the core identity: overall face shape, the general look of the eyes, nose, mouth and eyebrows, skin tone, and distinctive marks like moles or freckles.
2. Keep the same natural hair color and texture unless the scene asks for a different hairstyle.
3. A normal person should instantly say "yes, that's the same individual".

[LET THE FACE COME ALIVE]
1. Do NOT copy the reference pixel by pixel. Redraw the face fresh so it fits the new angle, expression, lighting and art style.
2. Freely change head angle, gaze direction, facial expression and emotion to match the scene.
3. Adapt the rendering to the requested art style while keeping the person recognizable.

[BLEND THE FACE INTO THE BODY AND SCENE - very important]
1. The face must belong to the same body: match the head's angle and perspective to the neck, shoulders and body posture so it never looks pasted on top.
2. Use ONE single consistent light source for the whole image. The lighting, shadows, highlights and color temperature on the face MUST match the lighting on the body and the background exactly.
3. Match skin tone, rendering detail and grain/texture between the face and the rest of the body so they look painted in the same pass.
4. The final image must read as one coherent photo/illustration, never a face cut out and glued onto a different body.
[PROPORTIONS — CRITICAL]
1. Use anatomically correct adult proportions: head-to-body ratio approximately 1:7 to 1:8; never an oversized head.
2. Shoulder width is about 2 to 2.5 head-widths; neck length and thickness must match the body.
3. Scale the face rendering to the body, never the body down to the reference face.

[EXPRESSION — MATCH THE SCENE MOOD]
1. The facial expression MUST match the mood and context described in the scene. A relaxed scene requires a soft relaxed expression. An active scene requires an engaged expression. A sad scene requires a subdued expression.
2. Do NOT default to a neutral blank stare or a generic forced smile regardless of context. Read the scene description and choose the expression accordingly.
3. The expression should feel spontaneous and captured-in-the-moment, not posed for a studio portrait.

[SKIN AND FACE RENDERING — ANTI-AI-LOOK]
1. Skin MUST have visible texture: pores, subtle blemishes, fine facial hair, natural skin unevenness. Absolutely NO plastic, waxy, airbrushed, or beauty-filtered skin.
2. Eyes must have natural catchlights, realistic iris detail, and natural eyelid shapes — NOT perfectly symmetrical doll eyes.
3. Hair must have individual strand detail, flyaway hairs, and natural volume — NOT a smooth helmet shape.
[YOU MAY FREELY CHANGE]
Pose, facial expression, camera angle, clothing, background, lighting and the whole scene.

[GROUP SCENE RULE]
If other people are present, apply this reference identity to the designated character only. Every other person must have a different face, hair and identity; do not duplicate or clone the reference face.

[BALANCE RULE]
Identity, natural proportions and seamless lighting matter together. It must look like the same person, freshly drawn, and fully integrated into one coherent scene. If the scene has no person, skip the face completely.`;
const IMAGE_SCENE_GUARD_PROMPT = `[SCENE RULE] Draw only what the scene describes. Add no person, face, body, or character to an object, food, animal, landscape, room, or empty-scene request. Use character style/reference only when the scene explicitly includes a person. In a group scene, apply one reference identity to one designated person only; never copy it to others.`;
const FACE_LOCK_SCENE_PROMPT = `[REFERENCE FACE SCOPE]
Use the attached reference face for ONE explicitly designated character only. If the scene describes a room, object, food, animal, landscape or empty space, do not show that character or any human face. In a group or couple photo, identify the designated character from the scene description and apply the reference identity to that person only; every other person must have a clearly different face, hair, age impression and identity. Never clone, mirror or repeat the reference face.

[ANATOMY AND INTEGRATION]
Use a natural adult body with a head-to-body ratio around 1:7 to 1:8, correctly scaled head, neck and shoulders, anatomically connected joints, believable limb lengths, natural hands with five separate fingers, and realistic weight distribution. Match the reference face's angle to the neck and torso. Use one consistent camera perspective, focal length, light direction, shadow softness, skin tone and image grain across the face, body and background. The face must look freshly drawn into the scene, never pasted on, stretched, oversized or floating.

[COMPOSITION]
Keep the requested subject and action as the visual priority. Use a believable camera height and distance, stable horizon, natural negative space and a clear foreground/midground/background relationship. Do not add a portrait-like close-up, extra people or extra props just to fill the frame.`;
    const IMAGE_ARTIST_SYSTEM_PROMPT = `You are a top-tier painter and photographer. You can create images in any style the user wants — photorealistic, anime, illustration, thick-paint, cinematic film photography and beyond — and you switch between them effortlessly. You read the user's description closely and turn it into exactly the picture they have in mind, faithfully capturing the subject, scene, composition, mood, lighting, colors and every detail they mention. Draw only what fits the description, keep it natural and coherent, and always output one single finished, high-quality image that matches the request below.`;
    
function parseChatImageResponse(data) {

    const message = data?.choices?.[0]?.message;
    if (message) {
        const fromArray = message.images?.[0]?.image_url?.url || message.images?.[0]?.url;
        if (fromArray) return fromArray;
        const text = typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content)
                ? message.content.map(part => part?.text || part?.image_url?.url || '').join('\n')
                : '';
        const dataUrlMatch = text.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
        if (dataUrlMatch) return dataUrlMatch[0];
        const markdownMatch = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
        if (markdownMatch) return markdownMatch[1];
        const bareUrlMatch = text.match(/https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S+)?/i);
        if (bareUrlMatch) return bareUrlMatch[0];
    }
    const item = data?.data?.[0];
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (item?.url) return item.url;
    throw new Error('生图接口没有返回图片，请确认该中转模型支持图片输出');
}
function mergeNegativePromptIntoPositive(prompt, negativePrompt) {
    if (!negativePrompt) return prompt;
    const negativeText = joinPromptParts([
        negativePrompt,
        'generic low quality artifacts'
    ]);
    if (!negativeText) return prompt;
    return [
        '[IMAGE GENERATION INSTRUCTIONS - READ CAREFULLY AND FOLLOW EXACTLY]',
        'You must render an image that fully satisfies EVERY requirement below. Read the whole thing before drawing. Each line is a hard constraint, not a suggestion.',
        '',
        '=== 1. WHAT TO INCLUDE (POSITIVE - all of these MUST be present) ===',
        prompt,
        '',
        '=== 2. WHAT TO EXCLUDE (NEGATIVE - all of these are STRICTLY FORBIDDEN) ===',
        `Under no circumstances include any of the following: ${negativeText}.`,
        'Treat every item above as a hard ban. If any of them would normally appear by default, you MUST actively remove, replace, or avoid it. Do not add them back for "balance" or "realism".',
        '',
        '=== 3. PRIORITY RULES ===',
        'The positive requirements in section 1 and the bans in section 2 both override your own default style and any habits you have.',
        'If a positive requirement and a negative ban ever seem to conflict, keep the positive requirement and drop only the specific banned detail.',
        'Output exactly one single coherent image that respects all of the above at the same time.'
    ].filter(Boolean).join('\n');
}

function mergeSettings(raw = {}) {
    const merged = {
        ...DEFAULT_IMAGE_GEN_SETTINGS,
        ...(raw || {})
    };
    merged.authorizedScenes = mergeAuthorizedScenes(raw);
    if (typeof merged.negativePrompt === 'string' && !merged.negativePrompt.trim()) {
        merged.negativePrompt = DEFAULT_IMAGE_GEN_SETTINGS.negativePrompt;
    }
    const presetMap = new Map(DEFAULT_IMAGE_GEN_SETTINGS.stylePresets.map(item => [item.id, item]));
    if (Array.isArray(raw?.stylePresets)) {
        raw.stylePresets
            .filter(item => item?.id)
            .forEach(item => {
                presetMap.set(item.id, isLegacyBuiltInInsPreset(item)
                    ? DEFAULT_IMAGE_GEN_SETTINGS.stylePresets.find(preset => preset.id === 'ins_real')
                    : item);
            });
    }
    merged.stylePresets = Array.from(presetMap.values());
    return merged;
}

function hasLegacyBuiltInInsPreset(raw = {}) {
    return Array.isArray(raw?.stylePresets) && raw.stylePresets.some(isLegacyBuiltInInsPreset);
}

export async function getImageGenSettings() {
    if (AppState.imageGenSettings) {
        const rawSettings = AppState.imageGenSettings;
        AppState.imageGenSettings = mergeSettings(rawSettings);
        if (hasLegacyBuiltInInsPreset(rawSettings)) {
            await db.appData.put({ key: 'imageGenSettings', value: AppState.imageGenSettings });
        }
        return AppState.imageGenSettings;
    }
    const record = await db.appData.get('imageGenSettings');
    const settings = mergeSettings(record?.value);
    AppState.imageGenSettings = settings;
    if (hasLegacyBuiltInInsPreset(record?.value)) {
        await db.appData.put({ key: 'imageGenSettings', value: settings });
    }
    return settings;
}

export async function saveImageGenSettings(settings) {
    const value = mergeSettings(settings);
    AppState.imageGenSettings = value;
    await db.appData.put({ key: 'imageGenSettings', value });
    return value;
}

export function isImageGenSceneEnabled(settings = {}, scene = 'chat') {
    const merged = mergeSettings(settings);
    return Boolean(merged.authorizedScenes?.[scene]);
}

export function getCharacterImageGenMode(settings = {}, char = {}, scene = 'chat') {
    const merged = mergeSettings(settings);
    if (!isImageGenSceneEnabled(merged, scene)) return 'match_only';
    if (char?.imageGenEnabled === false) return 'match_only';
    return char?.imageGenMatchMode || merged.matchMode || DEFAULT_IMAGE_GEN_SETTINGS.matchMode;
}

async function getImageGenApiConfigurations() {
    const record = await db.appData.get('imageGenApiConfigurations');
    return Array.isArray(record?.value) ? record.value : [];
}

async function saveImageGenApiConfigurations(configs) {
    const value = Array.isArray(configs) ? configs : [];
    await db.appData.put({ key: 'imageGenApiConfigurations', value });
    return value;
}

async function fetchImageGenModels({ providerKey, url, apiKey } = {}) {
    const provider = IMAGE_GEN_PROVIDERS[providerKey] || IMAGE_GEN_PROVIDERS.gemini_image;
    if (providerKey === 'novelai') return provider.models || [];
    const baseUrl = trimTrailingSlash(url || provider.defaultUrl);
    if (!baseUrl || !apiKey) throw new Error('请先填写 API 地址和 Key');

    const endpoint = providerKey === 'gemini_image'
        ? `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`
        : `${getOpenAiStyleBaseUrl(baseUrl)}/v1/models`;
    const headers = providerKey === 'gemini_image'
        ? {}
        : { Authorization: `Bearer ${apiKey}` };
    const response = await fetchImageGenEndpoint(endpoint, { headers, cache: 'no-store' });
    if (!response.ok) throw await createImageGenHttpError(response, '拉取生图模型');
    const data = await parseImageGenJsonResponse(response, '拉取生图模型');
    const models = data.data?.map(item => item.id)
        || data.models?.map(item => String(item.name || '').replace(/^models\//, ''))
        || [];
    return models
        .filter(Boolean)
        .filter(model => providerKey !== 'gemini_image' || /image|imagen|gemini/i.test(model))
        .sort();
}

async function parseImageGenJsonResponse(response, stageLabel) {
    let bodyText = '';
    try {
        bodyText = await response.text();
    } catch (_error) {
        throw new Error(`${stageLabel}失败：无法读取接口返回内容`);
    }
    if (!bodyText.trim()) throw new Error(`${stageLabel}失败：接口返回了空内容，请检查 API 地址和服务状态`);
    try {
        return JSON.parse(bodyText);
    } catch (_error) {
        const preview = bodyText.replace(/\s+/g, ' ').trim().slice(0, 160);
        const isHtml = /<(!doctype|html|head|body)\b/i.test(bodyText);
        throw new Error(`${stageLabel}失败：接口返回${isHtml ? '的是网页 HTML，不是 JSON' : '的内容不是有效 JSON'}。请检查 API 地址是否填写成了网页地址${preview ? `\n服务端返回：${preview}` : ''}`);
    }
}

async function testImageGenApi({ providerKey, url, apiKey, model } = {}) {
    const provider = IMAGE_GEN_PROVIDERS[providerKey] || IMAGE_GEN_PROVIDERS.gemini_image;
    if (!url) throw new Error('请先填写生图 API 地址');
    if (!apiKey) throw new Error('请先填写生图 API Key');
    if (providerKey === 'novelai') {
        return { manual: true, message: 'NovelAI 没有不消耗额度的模型列表测试接口，请到角色设置里使用“生成预览”测试。' };
    }
    const models = await fetchImageGenModels({ providerKey, url, apiKey });
    return {
        manual: false,
        model,
        modelAvailable: !model || models.length === 0 || models.includes(model),
        modelCount: models.length,
        providerName: provider.name
    };
}

export function resolveImageCharacterPresence({ userPrompt, keywords, naiTags, characterName } = {}) {
    const sceneText = [userPrompt, keywords, naiTags].filter(Boolean).map(value => String(value)).join(' ').trim();
    const normalizedCharacterName = String(characterName || '').trim();
    const escapedCharacterName = normalizedCharacterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const characterNameInScene = normalizedCharacterName.length > 1
        && new RegExp(escapedCharacterName + '(?:在|正在|自拍|合照|肖像|本人)', 'i').test(sceneText);
    const humanScenePattern = /人物|主角|人像|肖像|面孔|人脸|女孩|男孩|女生|男生|女人|男人|少年|少女|情侣|合照|自拍|半身像|全身照|证件照|我在|我穿着|我拿着|我抱着|我坐在|我站在|我的自拍|自己的自拍|他在|她在|朋友在|和朋友|与朋友|和同事|与同事|和家人|与家人|合影|\b(?:portrait|person|people|girl|boy|woman|man|selfie|group photo|couple|with friends|with family)\b/i;
    const noPersonScenePattern = /房间|卧室|客厅|厨房|浴室|书桌|餐桌|蛋糕|奶油|食物|甜点|咖啡|饮料|花|植物|猫|狗|宠物|风景|景色|天空|夕阳|日落|街景|建筑|房子|房屋|物品|空镜|空房间|room|bedroom|living room|kitchen|bathroom|desk|table|cake|food|dessert|coffee|drink|flower|plant|cat|dog|pet|landscape|scenery|sky|sunset|street|building|empty room|still life/i;
    const explicitPersonScenePattern = /人物|主角|人像|肖像|面孔|人脸|女孩|男孩|女生|男生|女人|男人|少年|少女|情侣|合照|自拍|半身像|全身照|证件照|我在|他在|她在|我穿着|我拿着|我抱着|我坐在|我站在|我的自拍|自己的自拍|朋友在|和朋友|与朋友|和同事|与同事|和家人|与家人|合影|\b(?:portrait|person|people|girl|boy|woman|man|selfie|group photo|couple|with friends|with family)\b/i;
    const bodyPartOnlyScene = /(?:画面主体|主体|特写|close[- ]?up).{0,24}(?:手|手指|手腕|脚|脚踝|鞋|眼睛|嘴唇|耳朵|头发)/i.test(sceneText)
        && !/露脸|脸部|面部|人脸|肖像|自拍|合照|半身像|全身照|证件照|人物照|本人入镜|我在|他在|她在|我穿着|我拿着|我抱着|我坐在|我站在|(?:男生|女生|男人|女人|女孩|男孩|朋友|家人)(?:在|站|坐|出现|入镜|拿着|抱着|穿着)|\b(?:portrait|selfie|group photo|full body|half body)\b/i.test(sceneText);
    if (bodyPartOnlyScene) return false;
    return Boolean(characterNameInScene || (humanScenePattern.test(sceneText) && (!noPersonScenePattern.test(sceneText) || explicitPersonScenePattern.test(sceneText))));
}

export async function buildImagePrompt({ userPrompt, keywords, naiTags, charId, stylePresetId, customStyle, includeCharacter } = {}) {
    const settings = await getImageGenSettings();
    const isNai = settings.provider === 'novelai';
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId));
    const sceneText = [userPrompt, keywords, naiTags].filter(Boolean).map(value => String(value)).join(' ').trim();
    const characterName = String(char?.name || char?.chatOverrideName || '').trim();
    const escapedCharacterName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const characterNameInScene = characterName.length > 1
        && new RegExp(`${escapedCharacterName}(?:在|正在|自拍|合照|肖像|本人)`, 'i').test(sceneText);
    // 明确意图优先；旧数据没有该字段时，才用保守关键词兜底。
    const humanScenePattern = /人物|主角|人像|肖像|面孔|人脸|女孩|男孩|女生|男生|女人|男人|少年|少女|情侣|合照|自拍|半身像|全身照|证件照|我在|我穿着|我拿着|我抱着|我坐在|我站在|我的自拍|自己的自拍|他在|她在|朋友在|和朋友|与朋友|和同事|与同事|和家人|与家人|合影|\b(?:portrait|person|people|girl|boy|woman|man|selfie|group photo|couple|with friends|with family)\b/i;
    const noPersonScenePattern = /房间|卧室|客厅|厨房|浴室|书桌|餐桌|蛋糕|奶油|食物|甜点|咖啡|饮料|花|植物|猫|狗|宠物|风景|景色|天空|夕阳|日落|街景|建筑|房子|房屋|物品|空镜|空房间|room|bedroom|living room|kitchen|bathroom|desk|table|cake|food|dessert|coffee|drink|flower|plant|cat|dog|pet|landscape|scenery|sky|sunset|street|building|empty room|still life/i;
    const explicitPersonScenePattern = /人物|主角|人像|肖像|面孔|人脸|女孩|男孩|女生|男生|女人|男人|少年|少女|情侣|合照|自拍|半身像|全身照|证件照|我在|他在|她在|我穿着|我拿着|我抱着|我坐在|我站在|我的自拍|自己的自拍|朋友在|和朋友|与朋友|和同事|与同事|和家人|与家人|合影|\b(?:portrait|person|people|girl|boy|woman|man|selfie|group photo|couple|with friends|with family)\b/i;
    const bodyPartOnlyScenePattern = /(?:画面主体|主体|特写|close[- ]?up).{0,24}(?:手|手指|手腕|脚|脚踝|鞋|眼睛|嘴唇|耳朵|头发)/i;
    const fullPersonCuePattern = /露脸|脸部|面部|人脸|肖像|自拍|合照|半身像|全身照|证件照|人物照|本人入镜|我在|他在|她在|我穿着|我拿着|我抱着|我坐在|我站在|(?:男生|女生|男人|女人|女孩|男孩|朋友|家人)(?:在|站|坐|出现|入镜|拿着|抱着|穿着)|\b(?:portrait|selfie|group photo|full body|half body)\b/i;
    const bodyPartOnlyScene = bodyPartOnlyScenePattern.test(sceneText) && !fullPersonCuePattern.test(sceneText);
    const hasHumanSceneCue = humanScenePattern.test(sceneText);
    const hasNoPersonSceneCue = noPersonScenePattern.test(sceneText);
    const hasExplicitPersonCue = explicitPersonScenePattern.test(sceneText);
    const inferredCharacterInScene = Boolean(
        characterNameInScene
        || (!bodyPartOnlyScene && hasHumanSceneCue && (!hasNoPersonSceneCue || hasExplicitPersonCue))
    );
    const characterInScene = typeof includeCharacter === 'boolean'
        ? (bodyPartOnlyScene ? false : includeCharacter)
        : inferredCharacterInScene;
    const activePreset = settings.stylePresets.find(item => item.id === (stylePresetId || settings.activeStylePresetId));
    const presetPrompt = activePreset?.prompt && activePreset.prompt !== settings.qualitySuffix ? activePreset.prompt : '';
    const artistPrompt = isNai && characterInScene ? (char?.imageGenArtistPrompt || '') : '';
    const faceInstruction = (!isNai && characterInScene && char?.imageGenFaceEnabled && char?.imageGenFaceRef)
        ? 'keep the same character identity and facial features as the reference image'
        : '';
    let prompt;
    if (isNai) {
        const translatedKeywords = await translateChineseToNaiTags(keywords);
        const translatedUserPrompt = await translateChineseToNaiTags(userPrompt);
        prompt = joinPromptParts([
            IMAGE_SCENE_GUARD_PROMPT,
            artistPrompt,
            characterInScene ? char?.imageGenDefaultStyle : '',
            translatedKeywords,
            translatedUserPrompt,
            presetPrompt,
            naiTags,
            customStyle,
            settings.qualitySuffix
        ]);
    } else {
        prompt = [
            IMAGE_SCENE_GUARD_PROMPT,
            joinPromptParts([faceInstruction, characterInScene ? char?.imageGenDefaultStyle : '']) ? `Character: ${joinPromptParts([faceInstruction, characterInScene ? char?.imageGenDefaultStyle : ''])}` : '',
            keywords ? `Visual keywords: ${String(keywords).replace(/[，、；;]/g, ', ')}` : '',
            userPrompt ? `Scene: ${String(userPrompt).trim()}` : '',
            joinPromptParts([presetPrompt, customStyle]) ? `Style: ${joinPromptParts([presetPrompt, customStyle])}` : '',
            settings.qualitySuffix ? `Quality: ${settings.qualitySuffix}` : ''
        ].filter(Boolean).join('\n');
    }
    const negativePrompt = joinPromptParts([
        settings.negativePrompt,
        activePreset?.negativePrompt,
        characterInScene ? char?.imageGenNegative : ''
    ]);
    return { prompt, negativePrompt, characterInScene };
}

async function compressDataImage(imageUrl) {
    if (!String(imageUrl || '').startsWith('data:image/')) return imageUrl;
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const maxSize = 1280;
            let { width, height } = img;
            if (width > height && width > maxSize) {
                height *= maxSize / width;
                width = maxSize;
            } else if (height > maxSize) {
                width *= maxSize / height;
                height = maxSize;
            }
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(width);
            canvas.height = Math.round(height);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => resolve(imageUrl);
        img.src = imageUrl;
    });
}

async function createImageGenHttpError(response, stageLabel, context = {}) {
    const status = Number(response?.status || 0);
    let detail = '';
    try {
        detail = String(await response.clone().text() || '').replace(/\s+/g, ' ').trim();
    } catch (_error) {
        detail = '';
    }

    const detailSuffix = detail ? `\n服务端返回：${detail.slice(0, 120)}` : '';
    const allowMethods = String(response?.headers?.get?.('allow') || '').trim();
    const requestInfo = [
        context.providerName ? '服务商：' + context.providerName : '',
        context.model ? '模型：' + context.model : '',
        context.endpoint ? '请求地址：' + context.endpoint : '',
        allowMethods ? '服务端允许的方法：' + allowMethods : ''
    ].filter(Boolean).join('\n');
    const requestInfoSuffix = requestInfo ? '\n' + requestInfo : '';
    if (status === 401) {
        return new Error(`${stageLabel}失败：接口返回 401，通常是 Key 没填对、已过期或没有权限。请检查 API 地址、Key 和服务商是否一致${detailSuffix}`);
    }
    if (status === 403) {
        return new Error(`${stageLabel}失败：接口返回 403，说明服务端拒绝了这次请求。常见原因是 Key 没权限、Key 失效、接口地址不对，或者服务商临时拦截。请先核对 API 地址、Key 和当前服务商${detailSuffix}`);
    }
    if (status === 404) {
        return new Error(`${stageLabel}失败：接口返回 404，通常是 API 地址或路径写错了。请检查你填的地址是不是当前服务商要求的生图接口${detailSuffix}`);
    }
    if (status === 405) {
        return new Error(`${stageLabel}失败：接口返回 405，当前 API 地址不接受这次请求方法，通常是地址填成了网页地址、接口路径重复，或服务商与接口类型不匹配。请核对服务商和 API 地址${requestInfoSuffix}${detailSuffix}`);
    }
    if (status === 429) {
        return new Error(`${stageLabel}失败：接口返回 429，说明请求太频繁或额度用完了。请稍后再试，或检查账号额度${detailSuffix}`);
    }
    return new Error(`${stageLabel}失败：${status || '未知状态'}${detailSuffix}`);
}

export async function generateImage({ userPrompt, keywords, naiTags, charId, stylePresetId, customStyle, includeCharacter, signal } = {}) {
    const settings = await getImageGenSettings();
    const provider = IMAGE_GEN_PROVIDERS[settings.provider] || IMAGE_GEN_PROVIDERS.gemini_image;
    if (!settings.url || !settings.apiKey) throw new Error('请先配置生图 API 地址和 Key');
    if (settings.provider === 'openai_compatible' && !settings.model) throw new Error('请先填写生图模型名');

    const { prompt, negativePrompt, characterInScene } = await buildImagePrompt({ userPrompt, keywords, naiTags, charId, stylePresetId, customStyle, includeCharacter });
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId));
    const supportsFaceRef = Boolean(provider.supportsFaceRef);
    const faceRef = supportsFaceRef && characterInScene && char?.imageGenFaceEnabled ? char.imageGenFaceRef : null;
    const usesBuiltInPersona = settings.provider === 'openai_compatible' && Boolean(faceRef);
    const basePrompt = provider.supportsNegativePrompt
        ? prompt
        : mergeNegativePromptIntoPositive(prompt, negativePrompt);
    const faceScenePrompt = faceRef && settings.provider !== 'openai_compatible' ? `${FACE_LOCK_SCENE_PROMPT}\n\n` : '';
    const requestPrompt = (provider.supportsNegativePrompt || usesBuiltInPersona)
        ? `${faceScenePrompt}${basePrompt}`
        : `${IMAGE_ARTIST_SYSTEM_PROMPT}\n\n${faceScenePrompt}${basePrompt}`;
    const request = provider.buildRequest(requestPrompt, {
        settings,
        negativePrompt: provider.supportsNegativePrompt ? negativePrompt : '',
        faceRef,
        faceStrength: char?.imageGenFaceStrength || 0.6
    });
    const requestBodyJson = request.isFormData ? request.body : JSON.stringify(request.body);
    const response = await fetchImageGenEndpoint(request.url, {
        method: 'POST',
        headers: request.headers,
        body: requestBodyJson,
        signal
    });
    let responseToUse = response;
    if (!response.ok && request.fallbackBody) {
        const fallbackResponse = await fetchImageGenEndpoint(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.fallbackBody),
            signal
        });
        if (fallbackResponse.ok) {
            responseToUse = fallbackResponse;
        }
    }
    if (!responseToUse.ok) {
        throw await createImageGenHttpError(responseToUse, '生图', {
            providerName: provider.name,
            model: settings.model || provider.defaultModel,
            endpoint: request.url
        });
    }
    let imageUrl;
    if (request.responseType === 'arrayBuffer') {
        const buffer = await responseToUse.arrayBuffer();
        imageUrl = await provider.parseResponse(null, buffer);
    } else {
        imageUrl = await provider.parseResponse(await parseImageGenJsonResponse(responseToUse, '生图'), responseToUse);
    }
    return { imageUrl: await compressDataImage(imageUrl), prompt: requestPrompt, negativePrompt };
}

function getShortImageGenErrorDetail(message) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const firstSentence = text.split('。').map(item => item.trim()).filter(Boolean)[0] || text;
    if (firstSentence.length <= 80) return firstSentence;
    return `${firstSentence.slice(0, 80).trim()}…`;
}

function showImageGenErrorNotice(title, detail = '', copyText = '') {
    const fullText = String(copyText || [title, detail].filter(Boolean).join('\n') || '生图失败');
    showDynamicIsland(String(title || '生图失败'), {
        variant: 'error',
        detail: getShortImageGenErrorDetail(detail || fullText),
        copyText: fullText,
        duration: 6000
    });
}

export async function saveGeneratedImageToGallery({ imageUrl, charId, content, keywords, groupId = null } = {}) {
    if (!imageUrl || !charId) throw new Error('缺少图片或角色信息，无法保存');
    const description = String(content || keywords || '').trim();
    return await db.galleryImages.add({
        charId,
        url: imageUrl,
        description,
        keywords: keywords || '',
        generationPrompt: content || '',
        isAiGenerated: true,
        timestamp: new Date(),
        groupId
    });
}

function getImageGenOverlayHost() {
    return document.querySelector('.phone-screen') || document.body;
}

function ensureImageGenModalStyles() {
    if (document.getElementById('image-gen-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'image-gen-modal-style';
    style.textContent = `
        .image-gen-overlay{position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;backdrop-filter:blur(6px)}
        .image-gen-card{width:min(390px,calc(100vw - 28px));max-height:88dvh;overflow:hidden;background:#fff;border-radius:10px;box-shadow:0 18px 46px rgba(0,0,0,.18);box-sizing:border-box;border:1px solid rgba(0,0,0,.12)}
        .image-gen-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #ededed;position:sticky;top:0;background:#fff;z-index:1}
        .image-gen-head h3{margin:0;font-size:calc(16px * var(--looky-font-scale, 1));line-height:1.3;font-weight:700;color:#111;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .image-gen-head button,.image-gen-actions button,.image-gen-small-btn{border:1px solid #e5e5e5;border-radius:8px;padding:8px 12px;background:#f7f7f7;color:#222;font-size:calc(13px * var(--looky-font-scale, 1));white-space:nowrap}
        .image-gen-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:11px;max-height:calc(88dvh - 57px);overflow-y:auto;box-sizing:border-box;background:#fff}
        .image-gen-body label{display:flex;flex-direction:column;gap:7px;font-size:calc(13px * var(--looky-font-scale, 1));color:#555;min-width:0}
        .image-gen-body input,.image-gen-body select,.image-gen-body textarea{width:100%;border:1px solid #dcdcdc;border-radius:8px;padding:10px;font-size:calc(13px * var(--looky-font-scale, 1));line-height:1.45;box-sizing:border-box;background:#fafafa;color:#111;min-width:0}
        .image-gen-body input[type=file]::file-selector-button{border:0;border-radius:7px;background:#111;color:#fff;padding:7px 10px;margin-right:8px}
        .image-gen-body input[type=file],.image-gen-body input[type=number]{height:42px}
        .image-gen-body textarea{min-height:76px;resize:vertical}
        .image-gen-body input[type=range]{padding:0;height:6px;accent-color:#111}
        .image-gen-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:end}
        .image-gen-row>label{min-width:0}
        .image-gen-switch{flex-direction:row!important;align-items:center;justify-content:space-between;border-top:1px solid #eeeeee;border-bottom:1px solid #eeeeee;padding:11px 0;color:#111}
        .image-gen-switch input{width:auto;accent-color:#111}
        .image-gen-preview{border:1px solid #dedede;border-radius:8px;min-height:174px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#f6f6f6;color:#999;text-align:center;font-size:calc(13px * var(--looky-font-scale, 1));cursor:pointer;padding:12px;box-sizing:border-box;white-space:normal;word-break:break-word;overflow-wrap:anywhere;line-height:1.45}
        .image-gen-preview.is-error{justify-content:flex-start;align-items:flex-start;text-align:left}
        .image-gen-preview img{width:100%;height:auto;display:block}
        .image-gen-used-prompt{font-size:calc(12px * var(--looky-font-scale, 1));color:#666;line-height:1.55;word-break:break-word;background:#fafafa;border:1px solid #eeeeee;border-radius:8px;padding:10px}
        .image-gen-actions{display:flex;gap:8px;flex-wrap:wrap}
        .image-gen-actions .primary{background:#111;color:#fff;border-color:#111}
        .image-gen-actions .danger{background:#fff;color:#b3261e;border-color:#f0c7c3}
        .image-gen-actions button:disabled{opacity:.45}
        .image-gen-actions button{flex:1;min-height:38px;font-weight:600}
        .image-gen-role-card{width:min(390px,calc(100vw - 28px))}
        .image-gen-subtitle{margin:0;color:#777;font-size:calc(12px * var(--looky-font-scale, 1));line-height:1.5}
        .image-gen-field,.image-gen-preview-box{border:1px solid #e8e8e8;border-radius:8px;background:#fff;padding:10px;display:flex;flex-direction:column;gap:8px}
        .image-gen-field span,.image-gen-preview-head span{font-size:calc(12px * var(--looky-font-scale, 1));color:#777}
        .image-gen-field textarea,.image-gen-preview-box textarea{border:0;background:#fafafa;border-radius:8px}
        .image-gen-preview-head{display:flex;justify-content:space-between;gap:10px;align-items:center}
        .image-gen-preview-head strong{font-size:calc(14px * var(--looky-font-scale, 1));color:#111}
        .image-gen-face-card{border:1px solid #e8e8e8;border-radius:8px;background:#fff;padding:11px;display:flex;flex-direction:column;gap:11px}
        .image-gen-face-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
        .image-gen-face-title{display:flex;flex-direction:column;gap:4px;min-width:0}
        .image-gen-face-title strong{font-size:calc(14px * var(--looky-font-scale, 1));color:#111}
        .image-gen-face-title span,.image-gen-strength-help{font-size:calc(12px * var(--looky-font-scale, 1));color:#777;line-height:1.5}
        .image-gen-face-toggle{display:flex;align-items:center;gap:8px;font-size:calc(12px * var(--looky-font-scale, 1));color:#555;white-space:nowrap}
        .image-gen-face-toggle input{display:none}
        .image-gen-face-toggle i{width:40px;height:24px;border-radius:999px;background:#e9e9ee;position:relative;display:block;transition:.2s}
        .image-gen-face-toggle i::after{content:'';position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:.2s}
        .image-gen-face-toggle input:checked+i{background:#111}
        .image-gen-face-toggle input:checked+i::after{transform:translateX(16px)}
        .image-gen-face-upload{border-top:1px solid #f0f0f0;padding-top:10px;display:flex;flex-direction:column;gap:7px}
        .image-gen-file-input{display:none}
        .image-gen-file-picker{min-height:42px;border:1px solid #dcdcdc;border-radius:8px;background:#fafafa;padding:0 10px;display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:space-between;gap:10px;box-sizing:border-box}
        .image-gen-file-picker b{background:#111;color:#fff;border-radius:7px;padding:7px 10px;font-size:calc(12px * var(--looky-font-scale, 1));white-space:nowrap}
        .image-gen-file-picker em{font-style:normal;color:#777;font-size:calc(12px * var(--looky-font-scale, 1));min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .image-gen-role-mode{border-top:1px solid #f0f0f0;padding-top:10px;display:flex;flex-direction:column;gap:7px}
        .image-gen-role-mode span{font-size:calc(12px * var(--looky-font-scale, 1));color:#777}
        .image-gen-role-mode select{width:100%;border:1px solid #dcdcdc;border-radius:8px;padding:10px;background:#fafafa;color:#111;font-size:calc(13px * var(--looky-font-scale, 1));box-sizing:border-box}
        .image-gen-strength-card{border-top:1px solid #f0f0f0;padding-top:10px;display:flex;flex-direction:column;gap:8px}
        .image-gen-strength-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:calc(13px * var(--looky-font-scale, 1));color:#555}
        .image-gen-strength-value{font-weight:700;color:#111}
        .image-gen-face-preview{display:flex;align-items:center;gap:8px;font-size:calc(12px * var(--looky-font-scale, 1));color:#777}
        .image-gen-face-preview img{width:42px;height:42px;border-radius:8px;object-fit:cover}
        .image-gen-choice-card{width:min(360px,calc(100vw - 28px));max-height:76dvh}
        .image-gen-choice-list{padding:8px;max-height:calc(76dvh - 58px);overflow-y:auto;overflow-x:hidden;background:#fff;box-sizing:border-box}
        .image-gen-choice-item{width:100%;box-sizing:border-box;border:0;background:#fff;border-bottom:1px solid #f1f1f1;padding:13px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;color:#1c1c1e;font-size:calc(14px * var(--looky-font-scale, 1))}
        .image-gen-choice-item:last-child{border-bottom:0}
        .image-gen-choice-item.selected{background:#f7f7f7;font-weight:600}
        .image-gen-choice-check{color:#111;font-size:calc(14px * var(--looky-font-scale, 1))}
        .image-gen-empty-choice{padding:22px 12px;text-align:center;color:#8e8e93;font-size:calc(13px * var(--looky-font-scale, 1))}
        .image-gen-config-item{cursor:pointer}
        .image-gen-config-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .image-gen-config-row-actions{display:flex;gap:6px;flex:0 0 auto}
        .image-gen-config-row-actions button{border:1px solid #e5e5e5;border-radius:7px;background:#f7f7f7;color:#111;min-height:30px;padding:0 8px;font-size:calc(12px * var(--looky-font-scale, 1));font-weight:600;white-space:nowrap}
        .image-gen-config-row-actions button.danger{background:#fff;color:#d33;border-color:#f0c7c3}
        .image-gen-viewer{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box}
        .image-gen-viewer img{max-width:100%;max-height:88dvh;border-radius:8px;object-fit:contain;background:#111}
        .image-gen-viewer-actions{position:absolute;right:14px;top:calc(14px + env(safe-area-inset-top));display:flex;gap:8px}
        .image-gen-viewer-actions button{border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(255,255,255,.92);color:#111;min-height:36px;padding:0 12px;font-size:calc(13px * var(--looky-font-scale, 1));font-weight:600}
        .image-gen-viewer-actions button[data-close]{background:rgba(20,20,20,.72);color:#fff}
    `;
    document.head.appendChild(style);
}

if (!window.__lookyFontSizeRefreshImageGenBound) {
    window.__lookyFontSizeRefreshImageGenBound = true;
    window.addEventListener('looky:font-size-changed', () => {
    });
}

async function downloadImageGenPreview(imageUrl, filename = 'image-gen-preview.jpg') {
    if (!imageUrl) return;
    if (isNativeRuntime()) {
        try {
            const saved = await saveImageToNativeGallery(imageUrl, filename);
            showDynamicIsland(saved ? '图片已保存到系统相册' : '已取消保存');
        } catch (error) {
            console.warn('[ImageGen] 原生图片保存失败:', error);
            showDynamicIsland('图片保存失败，请检查手机剩余空间');
        }
        return;
    }
    const link = document.createElement('a');
    link.download = filename;
    let objectUrl = '';
    try {
        if (imageUrl.startsWith('data:')) {
            const blob = dataUrlToBlob(imageUrl);
            const appleShareResult = await shareBlobToApple(blob, filename);
            if (appleShareResult === 'shared' || appleShareResult === 'cancelled') return;
            if (isAppleMobile() && (appleShareResult === 'unavailable' || appleShareResult === 'failed')) {
                openImageForAppleSave(imageUrl);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            link.href = imageUrl;
        } else {
            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error(`图片读取失败: ${response.status}`);
            const blob = await response.blob();
            const appleShareResult = await shareBlobToApple(blob, filename);
            if (appleShareResult === 'shared' || appleShareResult === 'cancelled') return;
            if (isAppleMobile() && (appleShareResult === 'unavailable' || appleShareResult === 'failed')) {
                openImageForAppleSave(imageUrl);
                showDynamicIsland('请在打开的图片页面长按保存');
                return;
            }
            objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
        }
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            link.remove();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }, 3000);
    } catch (_error) {
        link.remove();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (isAppleMobile()) {
            openImageForAppleSave(imageUrl);
            showDynamicIsland('请在打开的图片页面长按保存');
            return;
        }
        link.href = imageUrl;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 3000);
    }
}

export function openImageGenPreviewViewer(imageUrl) {
    if (!imageUrl) return;
    ensureImageGenModalStyles();
    const overlay = document.createElement('div');
    overlay.className = 'image-gen-viewer';
    overlay.innerHTML = `
        <div class="image-gen-viewer-actions">
            <button type="button" data-download="1">下载</button>
            <button type="button" data-close="1">关闭</button>
        </div>
        <img src="${imageUrl}" alt="AI image preview">
    `;
    getImageGenOverlayHost().appendChild(overlay);
    overlay.addEventListener('click', async event => {
        if (event.target === overlay || event.target.dataset.close) {
            overlay.remove();
        } else if (event.target.dataset.download) {
            await downloadImageGenPreview(imageUrl, `image-gen-preview-${Date.now()}.jpg`);
        }
    });
}

export function readFileAsCompressedDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = event => {
            const img = new Image();
            img.onload = async () => resolve(await compressDataImage(event.target.result));
            img.onerror = reject;
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

export async function openImageGenSettingsModal() {
    showPage('page-image-gen-api-settings');
    window.dispatchEvent(new CustomEvent('looky:page-opened', { detail: { pageId: 'page-image-gen-api-settings' } }));
}

export async function openCharacterImageGenSettingsModal({ charId, onSaved } = {}) {
    ensureImageGenModalStyles();
    const char = AppState.characterProfiles.find(item => String(item.id) === String(charId));
    if (!char || char.isGroup) {
        showDynamicIsland('请先选择单人角色');
        return;
    }
    const imageGenSettings = await getImageGenSettings();
    const isNaiProvider = imageGenSettings.provider === 'novelai';
    const isNaiV4Model = isNaiProvider
        && /nai-diffusion-4/i.test(imageGenSettings.model || IMAGE_GEN_PROVIDERS.novelai.defaultModel);
    const faceReferenceHelp = isNaiV4Model
        ? '当前 NAI V4/V4.5 会保存参考图，但生成请求暂不附加锁脸图；切换 NovelAI V3 后生效。'
        : '上传一张清晰正脸图，生图时会尽量保持这个角色的脸部特征。';

    let currentResult = null;
    let activeController = null;
    const overlay = document.createElement('div');
    overlay.className = 'image-gen-overlay';
    overlay.innerHTML = `
        <div class="image-gen-card image-gen-role-card">
            <div class="image-gen-head">
                <h3>${escapeHTML(char.name)} 生图设置</h3>
                <div>
                    <button type="button" data-close="1">关闭</button>
                </div>
            </div>
            <div class="image-gen-body">
                <p class="image-gen-subtitle">这些内容只跟随这个角色保存，不会影响其他角色。</p>
                <div class="image-gen-face-card">
                    <div class="image-gen-face-head">
                        <div class="image-gen-face-title">
                            <strong>自动生图</strong>
                            <span>聊天或朋友圈需要配图时，是否允许这个角色调用生图 API。</span>
                        </div>
                        <label class="image-gen-face-toggle"><span>开启</span><input id="ig-role-image-enabled" type="checkbox" ${char.imageGenEnabled === false ? '' : 'checked'}><i></i></label>
                    </div>
                    <div class="image-gen-role-mode">
                        <span>图片模式</span>
                        <select id="ig-role-match-mode">
                            <option value="match_then_gen" ${(char.imageGenMatchMode || imageGenSettings.matchMode || 'match_then_gen') === 'match_then_gen' ? 'selected' : ''}>匹配不到再生图</option>
                            <option value="gen_only" ${(char.imageGenMatchMode || imageGenSettings.matchMode || 'match_then_gen') === 'gen_only' ? 'selected' : ''}>纯生图</option>
                            <option value="match_only" ${(char.imageGenMatchMode || imageGenSettings.matchMode || 'match_then_gen') === 'match_only' ? 'selected' : ''}>纯匹配相册</option>
                        </select>
                    </div>
                </div>
                <div class="image-gen-field">
                    <span>角色专属正面词</span>
                    <textarea id="ig-role-positive" placeholder="这个角色固定追加的外貌、服装、画风">${escapeHTML(char.imageGenDefaultStyle || '')}</textarea>
                </div>
                <div class="image-gen-field" id="ig-role-artist-field" style="${isNaiProvider ? '' : 'display:none;'}">
                    <span>画师串（仅 NovelAI 生效）</span>
                    <textarea id="ig-role-artist" placeholder="例如：artist:xxxx, artist:yyyy，用逗号分隔">${escapeHTML(char.imageGenArtistPrompt || '')}</textarea>
                </div>
                <div class="image-gen-field">
                    <span>角色专属负面词</span>
                    <textarea id="ig-role-negative" placeholder="这个角色固定避开的内容">${escapeHTML(char.imageGenNegative || '')}</textarea>
                </div>
                <div class="image-gen-face-card">
                    <div class="image-gen-face-head">
                        <div class="image-gen-face-title">
                            <strong>锁脸参考</strong>
                            <span>${escapeHTML(faceReferenceHelp)}</span>
                        </div>
                        <label class="image-gen-face-toggle"><span>启用</span><input id="ig-role-face-enabled" type="checkbox" ${char.imageGenFaceEnabled ? 'checked' : ''}><i></i></label>
                    </div>
                    <div class="image-gen-face-upload">
                        <span>参考图</span>
                        <label class="image-gen-file-picker" for="ig-role-face-ref">
                            <b>选择参考图</b>
                            <em id="ig-role-face-file-name">${char.imageGenFaceRef ? '已保存参考图' : '未选择参考图'}</em>
                        </label>
                        <input id="ig-role-face-ref" class="image-gen-file-input" type="file" accept="image/*">
                    </div>
                    <div class="image-gen-strength-card">
                        <div class="image-gen-strength-head">
                            <span>锁脸强度</span>
                            <strong class="image-gen-strength-value" id="ig-role-face-strength-value">${Number(char.imageGenFaceStrength || 0.6).toFixed(1)}</strong>
                        </div>
                        <input id="ig-role-face-strength" type="range" min="0.1" max="1" step="0.1" value="${Number(char.imageGenFaceStrength || 0.6)}">
                        <div class="image-gen-strength-help">数值越高越贴近参考图，越低越按提示词自由发挥。建议先用 0.5-0.7。</div>
                    </div>
                    <div class="image-gen-face-preview" id="ig-role-face-preview" style="${char.imageGenFaceRef ? '' : 'display:none;'}">
                        <img id="ig-role-face-preview-img" src="${escapeHTML(char.imageGenFaceRef || '')}" alt="锁脸参考图">
                        <span id="ig-role-face-preview-label">已保存参考图</span>
                    </div>
                </div>
                <div class="image-gen-actions">
                    <button type="button" class="primary" id="ig-role-save">保存角色设置</button>
                </div>
                <div class="image-gen-preview-box">
                    <div class="image-gen-preview-head">
                        <strong>生图预览</strong>
                        <span>使用上面的角色设置测试</span>
                    </div>
                    <textarea id="ig-role-preview-prompt" placeholder="写一句预览画面，例如：半身像，微笑，窗边自然光"></textarea>
                    <div class="image-gen-role-mode">
                        <span>画面里有没有这个角色</span>
                        <select id="ig-role-preview-character">
                            <option value="true">画面有这个角色</option>
                            <option value="false">画面没有这个角色</option>
                        </select>
                        <div class="image-gen-strength-help">这里只影响本次预览。AI 对话会根据它自己的图片描述判断，不要出现生成草莓蛋糕结果凭空添加角色。</div>
                    </div>
                    <div class="image-gen-preview" id="ig-role-preview">还没有预览图片</div>
                    <div class="image-gen-used-prompt" id="ig-role-used-prompt" style="display:none;"></div>
                    <div class="image-gen-actions">
                        <button type="button" class="primary" id="ig-role-generate">生成预览</button>
                        <button type="button" class="danger" id="ig-role-stop" disabled>停止</button>
                        <button type="button" id="ig-role-save-gallery" disabled>存到相册</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    getImageGenOverlayHost().appendChild(overlay);

    const $ = selector => overlay.querySelector(selector);
    const saveRoleSettings = async (extra = {}) => {
        const updates = {
            imageGenEnabled: Boolean($('#ig-role-image-enabled').checked),
            imageGenMatchMode: $('#ig-role-match-mode').value || 'match_then_gen',
            imageGenFaceEnabled: Boolean($('#ig-role-face-enabled').checked),
            imageGenFaceStrength: Number($('#ig-role-face-strength').value || 0.6),
            imageGenDefaultStyle: $('#ig-role-positive').value.trim(),
            imageGenArtistPrompt: $('#ig-role-artist')?.value.trim() || '',
            imageGenNegative: $('#ig-role-negative').value.trim(),
            ...extra
        };
        Object.assign(char, updates);
        await db.characterProfiles.update(char.id, updates);
        await onSaved?.();
    };
    const setPreviewLoading = isLoading => {
        $('#ig-role-generate').disabled = isLoading;
        $('#ig-role-stop').disabled = !isLoading;
        $('#ig-role-save-gallery').disabled = isLoading || !currentResult?.imageUrl;
    };
    const runPreview = async () => {
        const userPrompt = $('#ig-role-preview-prompt').value.trim();
        const previewCharacterMode = $('#ig-role-preview-character').value;
        const includeCharacter = previewCharacterMode === 'auto'
            ? undefined
            : previewCharacterMode === 'true';
        if (!userPrompt) {
            showDynamicIsland('请先填写预览提示词');
            return;
        }
        currentResult = null;
        activeController = new AbortController();
        setPreviewLoading(true);
        $('#ig-role-preview').textContent = '图片生成中...';
        $('#ig-role-preview').classList.remove('is-error');
        $('#ig-role-used-prompt').style.display = 'none';
        try {
            await saveRoleSettings();
            currentResult = await generateImage({
                userPrompt,
                keywords: userPrompt,
                charId,
                includeCharacter,
                signal: activeController.signal
            });
            $('#ig-role-preview').innerHTML = `<img src="${currentResult.imageUrl}" alt="AI image preview">`;
            $('#ig-role-preview').classList.remove('is-error');
            $('#ig-role-used-prompt').textContent = currentResult.prompt;
            $('#ig-role-used-prompt').style.display = 'block';
        } catch (error) {
            const errorMessage = error?.name === 'AbortError' ? '已停止生成' : (error?.message || '生成失败');
            $('#ig-role-preview').textContent = errorMessage;
            $('#ig-role-preview').classList.toggle('is-error', error?.name !== 'AbortError');
            if (error?.name !== 'AbortError') {
                showImageGenErrorNotice('预览生成失败', errorMessage, errorMessage);
            } else {
                showDynamicIsland('已停止生成');
            }
        } finally {
            activeController = null;
            setPreviewLoading(false);
        }
    };

    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.dataset.close) {
            if (activeController) activeController.abort();
            overlay.remove();
        }
    });
    $('#ig-role-save').addEventListener('click', async () => {
        await saveRoleSettings();
        showDynamicIsland('角色生图设置已保存');
    });
    $('#ig-role-face-ref').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const imageGenFaceRef = await readFileAsCompressedDataUrl(file);
        $('#ig-role-face-enabled').checked = true;
        $('#ig-role-face-file-name').textContent = file.name || '已选择参考图';
        await saveRoleSettings({ imageGenFaceRef, imageGenFaceEnabled: true });
        $('#ig-role-face-preview-img').src = imageGenFaceRef;
        $('#ig-role-face-preview-label').textContent = '刚刚更新的参考图';
        $('#ig-role-face-preview').style.display = 'flex';
        showDynamicIsland('锁脸参考图已保存');
    });
    $('#ig-role-face-strength').addEventListener('input', event => {
        $('#ig-role-face-strength-value').textContent = Number(event.target.value || 0.6).toFixed(1);
    });
    $('#ig-role-generate').addEventListener('click', runPreview);
    $('#ig-role-stop').addEventListener('click', () => activeController?.abort());
    $('#ig-role-preview').addEventListener('click', () => {
        if (currentResult?.imageUrl) openImageGenPreviewViewer(currentResult.imageUrl);
    });
    $('#ig-role-save-gallery').addEventListener('click', async () => {
        if (!currentResult?.imageUrl) return;
        const userPrompt = $('#ig-role-preview-prompt').value.trim();
        await saveGeneratedImageToGallery({
            imageUrl: currentResult.imageUrl,
            charId,
            content: userPrompt,
            keywords: userPrompt
        });
        await onSaved?.();
        showDynamicIsland('预览图已存到相册');
    });
    setPreviewLoading(false);
}

export function initImageGenApiSettings() {
    const page = document.getElementById('page-image-gen-api-settings');
    if (!page || page.dataset.bound === '1') return;
    page.dataset.bound = '1';

    const providerItem = document.getElementById('image-gen-api-provider-item');
    const providerValue = document.getElementById('image-gen-api-provider-value');
    const urlItem = document.getElementById('image-gen-api-url-item');
    const urlValue = document.getElementById('image-gen-api-url-value');
    const keyItem = document.getElementById('image-gen-api-key-item');
    const keyValue = document.getElementById('image-gen-api-key-value');
    const modelItem = document.getElementById('image-gen-api-model-item');
    const modelValue = document.getElementById('image-gen-api-model-value');
    const modelRefreshBtn = document.getElementById('image-gen-api-model-refresh-btn');
    const sizeItem = document.getElementById('image-gen-api-size-item');
    const sizeValue = document.getElementById('image-gen-api-size-value');
    const qualityItem = document.getElementById('image-gen-api-quality-item');
    const qualityValue = document.getElementById('image-gen-api-quality-value');
    const saveBtn = document.getElementById('image-gen-api-save-btn');
    const testBtn = document.getElementById('image-gen-api-test-btn');
    const saveConfigBtn = document.getElementById('image-gen-api-save-config-btn');
    const configItem = document.getElementById('image-gen-api-config-item');
    const configValue = document.getElementById('image-gen-api-config-value');
    const providerHint = document.getElementById('image-gen-api-provider-hint');

    if (!providerItem || !urlItem || !keyItem || !modelItem || !saveBtn) return;

    let currentApiForm = {
        provider: 'gemini_image',
        url: IMAGE_GEN_PROVIDERS.gemini_image.defaultUrl,
        apiKey: '',
        model: IMAGE_GEN_PROVIDERS.gemini_image.defaultModel,
        size: '1024x1024',
        quality: 'standard'
    };
    let selectedConfigName = '';
    let editingConfigName = '';
    let availableModels = [];

    const getCurrentApiFormValue = () => ({
        ...currentApiForm,
        url: String(currentApiForm.url || '').trim(),
        apiKey: String(currentApiForm.apiKey || '').trim(),
        model: String(currentApiForm.model || '').trim()
    });

    const applyApiFormValue = (value = {}) => {
        const providerKey = value.provider || 'gemini_image';
        const provider = IMAGE_GEN_PROVIDERS[providerKey] || IMAGE_GEN_PROVIDERS.gemini_image;
        currentApiForm = {
            provider: providerKey,
            url: value.url || provider.defaultUrl || '',
            apiKey: value.apiKey || '',
            model: value.model || provider.defaultModel || '',
            size: value.size || '1024x1024',
            quality: value.quality || 'standard'
        };
        updateProviderUI();
        updateDisplay();
    };

    const renderConfigOptions = async () => {
        const configs = await getImageGenApiConfigurations();
        if (selectedConfigName && !configs.some(item => item.name === selectedConfigName)) selectedConfigName = '';
        if (editingConfigName && !configs.some(item => item.name === editingConfigName)) editingConfigName = '';
        if (configValue) configValue.textContent = selectedConfigName || '未选择方案';
        updateDisplay();
        return configs;
    };

    const updateProviderUI = () => {
        const provider = IMAGE_GEN_PROVIDERS[currentApiForm.provider] || IMAGE_GEN_PROVIDERS.gemini_image;
        if (!currentApiForm.url && provider.defaultUrl) currentApiForm.url = provider.defaultUrl;
        if (!currentApiForm.model && provider.defaultModel) currentApiForm.model = provider.defaultModel;
        if (Array.isArray(provider.models)) availableModels = provider.models;
        if (providerHint) {
            const faceText = provider.supportsFaceRef ? '支持锁脸参考图' : '不支持锁脸参考图';
            const negativeText = provider.supportsNegativePrompt ? '支持原生负面提示词' : '不支持原生负面提示词字段';
            providerHint.textContent = `${faceText}，${negativeText}`;
        }
    };

    const updateDisplay = () => {
        const provider = IMAGE_GEN_PROVIDERS[currentApiForm.provider] || IMAGE_GEN_PROVIDERS.gemini_image;
        if (providerValue) providerValue.textContent = provider.name;
        if (urlValue) urlValue.textContent = currentApiForm.url || '未设置';
        if (keyValue) keyValue.textContent = currentApiForm.apiKey ? '••••••••' : '未设置';
        if (modelValue) modelValue.textContent = currentApiForm.model || '未选择';
        if (sizeValue) sizeValue.textContent = currentApiForm.size || '1024x1024';
        if (qualityValue) qualityValue.textContent = currentApiForm.quality || 'standard';
        if (configValue) configValue.textContent = selectedConfigName || '未选择方案';
        if (saveConfigBtn) saveConfigBtn.textContent = editingConfigName ? '保存更改' : '保存为方案';
    };

    const markApiFormChanged = () => {
        if (editingConfigName) {
            selectedConfigName = editingConfigName;
        } else {
            selectedConfigName = '';
        }
        updateDisplay();
    };

    const openImageGenChoiceModal = (title, options, currentValue, onSelect) => {
        ensureImageGenModalStyles();
        const overlay = document.createElement('div');
        overlay.className = 'image-gen-overlay';
        overlay.innerHTML = `
            <div class="image-gen-card image-gen-choice-card">
                <div class="image-gen-head">
                    <h3>${escapeHTML(title)}</h3>
                    <button type="button" data-close="1">关闭</button>
                </div>
                <div class="image-gen-choice-list">
                    ${options.length ? options.map(item => `
                        <button type="button" class="image-gen-choice-item ${item.value === currentValue ? 'selected' : ''}" data-value="${escapeHTML(item.value)}">
                            <span>${escapeHTML(item.label)}</span>
                            ${item.value === currentValue ? '<span class="image-gen-choice-check">✓</span>' : ''}
                        </button>
                    `).join('') : '<div class="image-gen-empty-choice">暂无可选项</div>'}
                </div>
            </div>
        `;
        getImageGenOverlayHost().appendChild(overlay);
        overlay.addEventListener('click', event => {
            if (event.target === overlay || event.target.dataset.close) overlay.remove();
            const button = event.target.closest('.image-gen-choice-item');
            if (!button) return;
            onSelect(button.dataset.value);
            overlay.remove();
        });
    };

    const saveCurrentConfigAs = async (name) => {
        const configName = String(name || '').trim();
        if (!configName) return false;
        const configs = await getImageGenApiConfigurations();
        const nextConfig = { name: configName, ...getCurrentApiFormValue() };
        const index = configs.findIndex(item => item.name === configName);
        if (index >= 0) configs[index] = nextConfig;
        else configs.push(nextConfig);
        await saveImageGenApiConfigurations(configs);
        selectedConfigName = configName;
        editingConfigName = '';
        await renderConfigOptions();
        return true;
    };

    const saveCurrentConfigChanges = async () => {
        if (!editingConfigName) return false;
        const configs = await getImageGenApiConfigurations();
        const index = configs.findIndex(item => item.name === editingConfigName);
        if (index < 0) {
            editingConfigName = '';
            selectedConfigName = '';
            await renderConfigOptions();
            showDynamicIsland('原方案不存在，请重新保存');
            return false;
        }
        configs[index] = { name: editingConfigName, ...getCurrentApiFormValue() };
        await saveImageGenApiConfigurations(configs);
        selectedConfigName = editingConfigName;
        editingConfigName = '';
        await renderConfigOptions();
        showDynamicIsland('生图 API 方案已更新');
        return true;
    };

    const openImageGenConfigModal = async () => {
        ensureImageGenModalStyles();
        const configs = await getImageGenApiConfigurations();
        const overlay = document.createElement('div');
        overlay.className = 'image-gen-overlay';
        overlay.innerHTML = `
            <div class="image-gen-card image-gen-choice-card">
                <div class="image-gen-head">
                    <h3>生图 API 方案</h3>
                    <button type="button" data-close="1">关闭</button>
                </div>
                <div class="image-gen-choice-list">
                    ${configs.length ? configs.map(item => `
                        <div class="image-gen-choice-item image-gen-config-item ${item.name === selectedConfigName ? 'selected' : ''}" data-config-name="${escapeHTML(item.name)}">
                            <span class="image-gen-config-name">${escapeHTML(item.name)}</span>
                            <div class="image-gen-config-row-actions">
                                <button type="button" data-config-update-name="${escapeHTML(item.name)}">修改</button>
                                <button type="button" class="danger" data-config-delete-name="${escapeHTML(item.name)}">删除</button>
                            </div>
                        </div>
                    `).join('') : '<div class="image-gen-empty-choice">还没有保存方案</div>'}
                </div>
            </div>
        `;
        getImageGenOverlayHost().appendChild(overlay);
        overlay.addEventListener('click', async event => {
            if (event.target === overlay || event.target.dataset.close) {
                overlay.remove();
                return;
            }
            const updateName = event.target.closest('[data-config-update-name]')?.dataset.configUpdateName;
            if (updateName) {
                const selected = configs.find(config => config.name === updateName);
                if (!selected) return;
                selectedConfigName = selected.name;
                editingConfigName = selected.name;
                applyApiFormValue(selected);
                overlay.remove();
                showDynamicIsland('请修改内容后点“保存更改”');
                return;
            }
            const deleteName = event.target.closest('[data-config-delete-name]')?.dataset.configDeleteName;
            if (deleteName) {
                if (!window.confirm(`确定删除生图 API 方案 "${deleteName}" 吗？`)) return;
                const nextConfigs = (await getImageGenApiConfigurations()).filter(item => item.name !== deleteName);
                await saveImageGenApiConfigurations(nextConfigs);
                if (selectedConfigName === deleteName) selectedConfigName = '';
                await renderConfigOptions();
                overlay.remove();
                showDynamicIsland('生图 API 方案已删除');
                return;
            }
            const item = event.target.closest('[data-config-name]');
            if (item) {
                const selected = configs.find(config => config.name === item.dataset.configName);
                if (!selected) return;
                selectedConfigName = selected.name;
                editingConfigName = '';
                applyApiFormValue(selected);
                overlay.remove();
                showDynamicIsland('已切换生图 API 方案');
                return;
            }
        });
    };

    const render = async () => {
        const settings = await getImageGenSettings();
        editingConfigName = '';
        applyApiFormValue(settings);
        await renderConfigOptions();
    };

    providerItem.addEventListener('click', () => {
        openImageGenChoiceModal(
            '选择生图服务商',
            Object.entries(IMAGE_GEN_PROVIDERS).map(([value, provider]) => ({ value, label: provider.name })),
            currentApiForm.provider,
            value => {
                const provider = IMAGE_GEN_PROVIDERS[value] || IMAGE_GEN_PROVIDERS.gemini_image;
                currentApiForm.provider = value;
                currentApiForm.url = provider.defaultUrl || '';
                currentApiForm.model = provider.defaultModel || '';
                markApiFormChanged();
                updateProviderUI();
            }
        );
    });

    urlItem.addEventListener('click', () => {
        showInputModal('生图 API 地址', currentApiForm.url || '', value => {
            if (value !== null) {
                currentApiForm.url = String(value || '').trim();
                markApiFormChanged();
            }
        });
    });

    keyItem.addEventListener('click', () => {
        showInputModal('生图 API Key', currentApiForm.apiKey || '', value => {
            if (value !== null) {
                currentApiForm.apiKey = String(value || '').trim();
                markApiFormChanged();
            }
        });
    });

    modelItem.addEventListener('click', event => {
        if (event.target === modelRefreshBtn) return;
        const provider = IMAGE_GEN_PROVIDERS[currentApiForm.provider] || IMAGE_GEN_PROVIDERS.gemini_image;
        const options = (availableModels.length ? availableModels : provider.models || [])
            .map(model => ({ value: model, label: model }));
        openImageGenChoiceModal('选择生图模型', options, currentApiForm.model, value => {
            currentApiForm.model = value;
            markApiFormChanged();
        });
    });

    sizeItem?.addEventListener('click', () => {
        openImageGenChoiceModal('选择图片尺寸', ['1024x1024', '1024x1536', '1536x1024'].map(value => ({ value, label: value })), currentApiForm.size, value => {
            currentApiForm.size = value;
            markApiFormChanged();
        });
    });

    qualityItem?.addEventListener('click', () => {
        openImageGenChoiceModal('选择图片质量', ['standard', 'hd', 'high'].map(value => ({ value, label: value })), currentApiForm.quality, value => {
            currentApiForm.quality = value;
            markApiFormChanged();
        });
    });

    configItem?.addEventListener('click', async () => {
        await openImageGenConfigModal();
    });

    saveConfigBtn?.addEventListener('click', async () => {
        if (editingConfigName) {
            await saveCurrentConfigChanges();
            return;
        }
        showInputModal('生图 API 方案名称', selectedConfigName || '', async name => {
            if (await saveCurrentConfigAs(name)) showDynamicIsland('生图 API 方案已保存');
        });
    });

    modelRefreshBtn?.addEventListener('click', async event => {
        event.stopPropagation();
        try {
            showDynamicIsland('正在拉取生图模型...');
            availableModels = await fetchImageGenModels({
                providerKey: currentApiForm.provider,
                url: currentApiForm.url,
                apiKey: currentApiForm.apiKey
            });
            if (availableModels.length > 0 && !currentApiForm.model) currentApiForm.model = availableModels[0];
            updateDisplay();
            showDynamicIsland(availableModels.length > 0 ? '生图模型已拉取' : '没有找到可用模型');
        } catch (error) {
            const errorMessage = error?.message || '拉取模型失败';
            showImageGenErrorNotice('拉取生图模型失败', errorMessage, errorMessage);
        }
    });

    testBtn?.addEventListener('click', async event => {
        event.stopPropagation();
        const originalText = testBtn.textContent;
        try {
            testBtn.disabled = true;
            testBtn.textContent = '测试中...';
            showDynamicIsland('正在测试生图 API...', { variant: 'loading', loading: true });
            const result = await testImageGenApi(getCurrentApiFormValue());
            if (result.manual) {
                showDynamicIsland(result.message, { duration: 5000 });
            } else if (!result.modelAvailable) {
                showDynamicIsland(`接口可访问，但模型列表中没有“${result.model}”`, { variant: 'error', duration: 5000 });
            } else {
                showDynamicIsland(result.modelCount > 0 ? '生图 API 测试成功' : '接口可访问，但没有返回模型', { duration: 4000 });
            }
        } catch (error) {
            const errorMessage = error?.message || '生图 API 测试失败';
            showImageGenErrorNotice('生图 API 测试失败', errorMessage, errorMessage);
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = originalText;
        }
    });

    saveBtn.addEventListener('click', async () => {
        const settings = await getImageGenSettings();
        await saveImageGenSettings({
            ...settings,
            ...getCurrentApiFormValue()
        });
        showDynamicIsland('生图 API 设置已保存');
    });

    window.addEventListener('looky:page-opened', event => {
        if (event.detail?.pageId === 'page-image-gen-api-settings') render();
    });
    render();
}
