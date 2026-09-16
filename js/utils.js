// link.js/utils.js (更新后)

// 封装的点击/触摸事件监听器，兼容移动端和PC端
export function addTapListener(element, callback) {
    if (!element) return;
    let moved = false;
    element.addEventListener('touchstart', () => {
        moved = false;
    }, {
        passive: true
    });
    element.addEventListener('touchmove', () => {
        moved = true;
    }, {
        passive: true
    });
    element.addEventListener('touchend', (e) => {
        if (!moved) {
            e.preventDefault();
            callback(e);
        }
    });
    element.addEventListener('click', (e) => {
        if (e.detail !== 0) {
            callback(e);
        }
    });
}

// HTML转义函数，防止XSS攻击
export function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, function(match) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        } [match];
    });
}

// 清理消息显示层和查手机副本里的内部标记。
// 不改数据库里的主聊天原始消息，也不改变 AI 上下文里单独使用的消息 ID。
export function cleanVisibleMessageText(text) {
    return String(text || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\[MSG ID:\s*[^\]]+\]\s*/gi, '')
        .replace(/\[语音消息\]/g, '')
        .trim();
}

// 小世界正文按段落包裹，保证每段都能独立首行缩进。
export function formatIflineWorldBodyHtml(safeHtml) {
    const html = String(safeHtml || '').replace(/\r/g, '').trim();
    if (!html) return '';
    return html
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => `<p class="ifline-world-para">${line}</p>`)
        .join('');
}

export function normalizeIflineWorldMessageCards(root = document) {
    root.querySelectorAll('#ifline-world-message-list .offline-message-card:not(#world-typing):not(.is-friend-request-bar) .card-body').forEach(body => {
        if (body.querySelector('.ifline-world-para')) return;
        if (/<(?:p|div|section|article|ul|ol|details)\b/i.test(body.innerHTML)) return;
        body.innerHTML = formatIflineWorldBodyHtml(body.innerHTML);
    });
}

// 验证头像URL是否有效，防止加载无效或空的图片源
export function isValidAvatarSrc(src) {
    if (typeof src !== 'string' || src.trim() === '') {
        return false;
    }
    return src.startsWith('data:image') || src.startsWith('http') || src.startsWith('blob:');
}

/**
 * 压缩本地图片 Data URL，失败时返回原图。
 * GIF 和 SVG 保持原样，避免破坏动画图片和矢量图。
 */
export function compressImageDataUrl(dataUrl, { maxDimension = 1280, quality = 0.8 } = {}) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return Promise.resolve(dataUrl);
    }
    if (/^data:image\/(?:gif|svg\+xml)(?:;|,)/i.test(dataUrl)) {
        return Promise.resolve(dataUrl);
    }

    return new Promise(resolve => {
        let img;
        try {
            img = new Image();
        } catch (error) {
            console.warn('[Image] 无法创建图片解码器，保留原图:', error);
            resolve(dataUrl);
            return;
        }
        img.onload = () => {
            try {
                let width = img.naturalWidth || img.width;
                let height = img.naturalHeight || img.height;
                if (!width || !height) {
                    resolve(dataUrl);
                    return;
                }

                if (width > maxDimension || height > maxDimension) {
                    const scale = maxDimension / Math.max(width, height);
                    width = Math.max(1, Math.round(width * scale));
                    height = Math.max(1, Math.round(height * scale));
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext('2d');
                if (!context) {
                    resolve(dataUrl);
                    return;
                }

                context.drawImage(img, 0, 0, width, height);
                const compressed = canvas.toDataURL('image/webp', quality);
                canvas.width = 0;
                canvas.height = 0;
                resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
            } catch (error) {
                console.warn('[Image] 图片压缩失败，保留原图:', error);
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        try {
            img.src = dataUrl;
        } catch (error) {
            console.warn('[Image] 图片解码失败，保留原图:', error);
            resolve(dataUrl);
        }
    });
}

/**
 * 格式化秒数为 mm:ss 格式 (从 chat-ui.js 移入)
 * @param {number} seconds - 总秒数
 * @returns {string} - 格式化后的时间字符串
 */
export const formatTime = (seconds) => {
    if (typeof seconds !== 'number' || isNaN(seconds)) {
        seconds = 0;
    }
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
};

/**
 * @description 生成用于AI时间感知的上下文对象
 * @param {number | null} lastMessageTimestamp - 上一条消息的时间戳 (Date.now())，如果是初次对话则为 null
 * @returns {{
 *  currentTime: string, 
 *  timeOfDay: string, 
 *  dayCategory: string, 
 *  timeSince: string, 
 *  isHoliday: boolean,
 *  holidayName: string | null
 * }} 结构化的时间上下文
 */
export function getTimeContext(lastMessageTimestamp) {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 代表周日, 6 代表周六
    
    // 1. 获取当前完整时间，比如 "2024/05/20 13:14"
    const currentTime = now.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    
    // 2. 判断现在是一天中的哪个时段
    let timeOfDay = 'daytime'; // 默认是白天
    if (hour >= 5 && hour < 11) timeOfDay = 'morning';      // 早晨 (5点-11点)
    else if (hour >= 11 && hour < 14) timeOfDay = 'lunchtime';  // 午饭时间 (11点-14点)
    else if (hour >= 17 && hour < 20) timeOfDay = 'dinnertime'; // 晚饭时间 (17点-20点)
    else if (hour >= 22 || hour < 5) timeOfDay = 'late_night'; // 深夜 (22点 - 次日5点)

    // 3. 判断是工作日还是周末
    const dayCategory = (day === 0 || day === 6) ? 'weekend' : 'weekday';

    // 4. 计算距离上次说话过了多久
    let timeSince = "这是我们第一次对话"; // 默认是初次见面
    let diffSeconds = 0;
    let daysSince = null;
    let lastMessageDate = null;
    let timeSinceText = "这是我们第一次对话";
    if (lastMessageTimestamp) {
        diffSeconds = (now.getTime() - lastMessageTimestamp) / 1000;
        if (diffSeconds < 5) timeSince = "just_now";           // 几秒内，AI会觉得你们在连续聊天
        else if (diffSeconds < 300) timeSince = "a_moment_ago";  // 5分钟内
        else if (diffSeconds < 3600) timeSince = "an_hour_ago";  // 1小时内
        else if (diffSeconds < 86400) timeSince = "hours_ago";   // 一天内
        else if (diffSeconds < 604800) timeSince = "days_ago";   // 一周内，AI会觉得“好几天没见了”
        else timeSince = "long_time_ago";                      // 很久了，AI会觉得“好久不见”

        const nowZero = new Date(now);
        nowZero.setHours(0, 0, 0, 0);
        const lastMessageZero = new Date(lastMessageTimestamp);
        lastMessageZero.setHours(0, 0, 0, 0);
        daysSince = Math.floor((nowZero.getTime() - lastMessageZero.getTime()) / 86400000);
        lastMessageDate = `${lastMessageZero.getFullYear()}年${lastMessageZero.getMonth() + 1}月${lastMessageZero.getDate()}日`;

        if (daysSince === 0 && diffSeconds < 5) timeSinceText = "刚刚";
        else if (daysSince === 0 && diffSeconds < 300) timeSinceText = "几分钟前";
        else if (daysSince === 0 && diffSeconds < 3600) timeSinceText = `${Math.floor(diffSeconds / 60)}分钟前`;
        else if (daysSince === 0) timeSinceText = `${Math.floor(diffSeconds / 3600)}小时前`;
        else if (daysSince === 1) timeSinceText = "昨天";
        else if (daysSince === 2) timeSinceText = "前天";
        else if (daysSince >= 3 && daysSince <= 30) timeSinceText = `${daysSince}天前`;
        else if (daysSince > 30) timeSinceText = `${Math.floor(daysSince / 30)}个月前`;
    }

    // 5. 判断是不是特殊节日（这里只是举例，以后可以加更多）
    const month = now.getMonth() + 1; // getMonth() 返回 0-11，所以要加 1
    const date = now.getDate();
    let isHoliday = false;
    let holidayName = null;
    if (month === 1 && date === 1) { isHoliday = true; holidayName = '元旦'; }
    if (month === 12 && date === 25) { isHoliday = true; holidayName = '圣诞节'; }
    // ... 在这里可以继续添加更多节日，比如春节、情人节等

    // 6. 把所有算好的信息打包成一个“情报包”返回
    return { currentTime, timeOfDay, dayCategory, timeSince, daysSince, lastMessageDate, timeSinceText, isHoliday, holidayName };
}
