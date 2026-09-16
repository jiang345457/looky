import { isNativeRuntime, startNativeKeepAlive, stopNativeKeepAlive, updateNativeMediaMetadata } from '../native-bridge.js';

// ▼▼▼ [新增] 微型本地数据库：用于永久保存上传的本地音频文件 ▼▼▼
const NETEASE_API_BASE_URL = "https://my-music-api-h8qk.onrender.com";
const LocalMusicDB = {
    db: null,
    async init() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            // 【核心修复】：数据库版本升级为2，增加歌单分组仓库
            const req = indexedDB.open('LookyMusicDB', 2);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                // 原有的歌曲仓库
                if (!db.objectStoreNames.contains('playlist')) {
                    db.createObjectStore('playlist', { keyPath: 'id', autoIncrement: true });
                }
                // 新增的歌单分组仓库
                if (!db.objectStoreNames.contains('groups')) {
                    db.createObjectStore('groups', { keyPath: 'id' });
                }
            };
            req.onsuccess = () => { this.db = req.result; resolve(this.db); };
            req.onerror = () => reject(req.error);
        });
    },
    async saveSong(song) {
        const db = await this.init();
        return new Promise(resolve => {
            const tx = db.transaction('playlist', 'readwrite');
            tx.objectStore('playlist').add(song);
            tx.oncomplete = () => resolve();
        });
    },
    async getAllSongs() {
        const db = await this.init();
        return new Promise(resolve => {
            const tx = db.transaction('playlist', 'readonly');
            const req = tx.objectStore('playlist').getAll();
            req.onsuccess = () => resolve(req.result);
        });
    },
    // ▼▼▼ [新增] 支持永久删除单曲 (安全落盘版) ▼▼▼
    async deleteSong(title, artist) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('playlist', 'readwrite');
            const store = tx.objectStore('playlist');
            const req = store.openCursor(); // 使用游标精确定位
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value.title === title && cursor.value.artist === artist) {
                        const deleteReq = cursor.delete();
                        deleteReq.onsuccess = () => resolve(); // 确保彻底从硬盘删除后再放行
                        deleteReq.onerror = () => reject(deleteReq.error);
                        return;
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => reject(req.error);
        });
    },
    // ▼▼▼ [新增] 支持永久修改单曲信息 (安全落盘版) ▼▼▼
    async updateSong(oldTitle, oldArtist, newSongData) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('playlist', 'readwrite');
            const store = tx.objectStore('playlist');
            const req = store.openCursor(); // 使用游标精确定位
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value.title === oldTitle && cursor.value.artist === oldArtist) {
                        const updateReq = cursor.update({ ...cursor.value, ...newSongData });
                        updateReq.onsuccess = () => resolve(); // 确保数据 100% 写入硬盘后再放行
                        updateReq.onerror = () => reject(updateReq.error);
                        return;
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => reject(req.error);
        });
    },

     async saveAllGroups(groups) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('groups', 'readwrite');
            const store = tx.objectStore('groups');
            
            store.clear(); // 1. 先安全地清空旧数据库
            groups.forEach(g => {
                // 【核心修复】：如果遇到以前的旧歌单没有 ID，就自动给它补发一个，防止数据库崩溃
                if (!g.id) g.id = Date.now().toString() + Math.floor(Math.random() * 1000);
                store.put(g);
            }); 
            
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getAllGroups() {
        const db = await this.init();
        return new Promise(resolve => {
            const tx = db.transaction('groups', 'readonly');
            const req = tx.objectStore('groups').getAll();
            req.onsuccess = () => resolve(req.result);
        });
    }
    // ▲▲▲ 新增结束 ▲▲▲
};
export const MusicPlayer = {
    // ▼▼▼ [新增] 通用图片压缩引擎 (防内存撑爆) ▼▼▼
    async compressImage(file, maxWidth = 800, quality = 0.7) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxWidth) {
                        height = Math.round(height * (maxWidth / width));
                        width = maxWidth;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality)); // 强转为JPG压缩，画质0.7
                };
                img.onerror = () => resolve(e.target.result); // 降级：万一出错则原样返回
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    },
    // ▼▼▼ [新增] 将自己挂载到 window 上，让 chat-service 能调用 ▼▼▼
    initGlobal() { window.MusicPlayer = this; },

    async syncListeningAvatars(char) {
        const fallbackAvatar = 'images/default-avatar.svg';
        const userAvatarEl = document.getElementById('listening-user-avatar');
        const charAvatarEl = document.getElementById('listening-char-avatar');
        if (!userAvatarEl && !charAvatarEl) return;

        let finalUserAvatar = fallbackAvatar;
        let finalCharAvatar = char?.avatar || fallbackAvatar;
        try {
            const { AppState } = await import('../state.js');
            const profiles = Array.isArray(AppState.characterProfiles) ? AppState.characterProfiles : [];
            const targetChar = profiles.find(c => String(c.id) === String(char?.id));
            const identities = Array.isArray(AppState.userIdentities) ? AppState.userIdentities : [];
            const identityId = targetChar?.chatIdentityId || AppState.currentIdentityId;
            const identity = identities.find(id => String(id.id) === String(identityId)) || identities[0];
            finalUserAvatar = targetChar?.chatOverrideUserAvatar || identity?.avatar || fallbackAvatar;
            finalCharAvatar = targetChar?.chatOverrideAvatar || targetChar?.avatar || char?.avatar || fallbackAvatar;
        } catch (err) {
            console.error('Failed to sync listening avatars', err);
        }

        if (userAvatarEl) userAvatarEl.src = finalUserAvatar || fallbackAvatar;
        if (charAvatarEl) charAvatarEl.src = finalCharAvatar || fallbackAvatar;
    },

    // ▼▼▼ [新增] 处理 AI 的听歌反应 ▼▼▼
    async processAiDecision(decision, charId, newSongName) {
        if (decision === 'reject') {
            if(typeof window.showDynamicIsland === 'function'){
                window.showDynamicIsland(`Ta现在不太方便听歌`, 'warning');
            }
            // 恢复邀请UI
            document.getElementById('widget-invite-btn').style.display = 'flex';
            document.getElementById('widget-listening-status').style.display = 'none';
            this.currentListeningChar = null;
            if(this.listenSessionInterval) clearInterval(this.listenSessionInterval);
            return null;
            
        } else if (decision === 'change') {
            // 【核心护栏：前端模糊匹配与随机回退，0 Token 消耗】
            let targetIdx = -1;
            
            // 1. 如果AI给出了需求，尝试在本地全局曲库模糊匹配 (忽略大小写)
            if (newSongName) {
                const matchedData = this.findSongByKeyword(newSongName) ||
                    (typeof this.searchAndImportNeteaseSong === 'function'
                        ? await this.searchAndImportNeteaseSong(newSongName, {
                            appendToCurrentPlaylist: false,
                            persistToLibrary: false
                        })
                        : null);
                if (matchedData?.temporary && matchedData.song) {
                    if(typeof window.showDynamicIsland === 'function'){
                        window.showDynamicIsland(`Ta切成了: ${matchedData.song.title}`, 'info');
                    }
                    this.playlist = [matchedData.song];
                    this.updatePlaylistDrawer();
                    this.playSongAtIndex(0);
                    this.startListeningSession(this.currentListeningChar);
                    return matchedData.song.title;
                }
                if (matchedData?.song) {
                    targetIdx = this.globalPlaylist.findIndex(s =>
                        (matchedData.song.neteaseId && s.neteaseId === matchedData.song.neteaseId) ||
                        (s.title === matchedData.song.title && s.artist === matchedData.song.artist)
                    );
                }
            }
            
            // 2. 如果没找到，或者AI瞎编的，随机挑一首（避免切到正在播放的同一首）
            if (targetIdx === -1 && this.globalPlaylist.length > 0) {
                if (this.globalPlaylist.length === 1) {
                    targetIdx = 0;
                } else {
                    let r;
                    do { r = Math.floor(Math.random() * this.globalPlaylist.length); } while (r === this.currentIndex);
                    targetIdx = r;
                }
            }

            // 3. 播放真正的本地库歌曲，并返回真实名字给 UI
            if (targetIdx !== -1) {
                const actualSong = this.globalPlaylist[targetIdx];
                if(typeof window.showDynamicIsland === 'function'){
                    window.showDynamicIsland(`Ta切成了: ${actualSong.title}`, 'info');
                }
                this.playlist = [...this.globalPlaylist]; // 切回全局列表
                this.updatePlaylistDrawer();
                this.playSongAtIndex(targetIdx);
                this.startListeningSession(this.currentListeningChar); // 启动 UI
                
                return actualSong.title; // 把真实的歌名返回给 chat-service.js
            }
            return null;
            
        } else {
            // accept 接受
            if(typeof window.showDynamicIsland === 'function'){
                window.showDynamicIsland(`Ta接受了邀请，正在和你一起听`, 'success');
            }
            this.startListeningSession(this.currentListeningChar); // 启动 UI
            return null;
        }
    },
     // ▼▼▼ [新增] 启动一起听UI的通用函数 ▼▼▼
    startListeningSession(char) {
        if(!char) return;
        
        // ▼▼▼ 新增：把当前一起听的角色ID存入本地防丢 ▼▼▼
        localStorage.setItem('looky_listening_char_id', char.id);
        this.syncListeningAvatars(char);
        // ▲▲▲ 新增结束 ▲▲▲

        document.getElementById('widget-invite-btn').style.display = 'none';
        const listeningStatus = document.getElementById('widget-listening-status');

        if(listeningStatus) listeningStatus.style.display = 'flex';
        
        this.totalListenSeconds = 0; 
        const listenModeText = document.getElementById('widget-listen-mode-text');
        if (listenModeText) listenModeText.textContent = '沉浸陪伴'; 
        
        if(this.listenSessionInterval) clearInterval(this.listenSessionInterval);
        this.listenSessionInterval = setInterval(() => {}, 1000);
    },
    stopListeningSession() {
        if(this.listenSessionInterval) clearInterval(this.listenSessionInterval);
        const charName = this.currentListeningChar ? this.currentListeningChar.name : '';
        this.currentListeningChar = null; // 解除角色锁定
        localStorage.removeItem('looky_listening_char_id');
        // 恢复 邀请 UI
        const listeningStatus = document.getElementById('widget-listening-status');
        if(listeningStatus) listeningStatus.style.display = 'none';
        const inviteBtn = document.getElementById('widget-invite-btn');
        if(inviteBtn) inviteBtn.style.display = 'flex';

        return charName; // 返回角色名字供提示词使用
    },
     // ▼▼▼ 新增：供 AI 调用的“曲库搜歌”功能 ▼▼▼
    findSongByKeyword(keyword) {
        if (!keyword || this.globalPlaylist.length === 0) return null;
        const kw = keyword.toLowerCase();
        // 1. 尝试根据 AI 说的名字或歌手模糊搜索
        const song = this.globalPlaylist.find(s => 
            String(s.title || '').toLowerCase().includes(kw) || String(s.artist || '').toLowerCase().includes(kw)
        );
        // 2. 如果 AI 瞎编了一首你库里没有的歌，就随机挑一首给你
        if (!song) return null;
        return { song: song, index: this.globalPlaylist.indexOf(song) };
    },

    getNeteaseCookieParam() {
        const cookie = localStorage.getItem('netease_cookie');
        return cookie ? `&cookie=${encodeURIComponent(cookie)}` : '';
    },

    getNeteaseArtistName(apiSong = {}) {
        const artists = apiSong.ar || apiSong.artists || [];
        return artists.map(artist => artist?.name).filter(Boolean).join(' / ') || '未知歌手';
    },

    getNeteaseCover(apiSong = {}) {
        const cover = apiSong.al?.picUrl || apiSong.album?.picUrl || '';
        return cover ? `${cover}?param=300y300` : "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=100&auto=format&fit=crop";
    },

    async searchAndImportNeteaseSong(keyword, options = {}) {
        const cleanKeyword = String(keyword || '').trim();
        if (!cleanKeyword) return null;
        const appendToCurrentPlaylist = options.appendToCurrentPlaylist !== false;
        const persistToLibrary = options.persistToLibrary !== false;
        const cookieParam = this.getNeteaseCookieParam();
        try {
            const searchRes = await fetch(`${NETEASE_API_BASE_URL}/search?keywords=${encodeURIComponent(cleanKeyword)}&limit=1&timestamp=${Date.now()}${cookieParam}`);
            const searchData = await searchRes.json();
            const apiSearchSong = searchData?.result?.songs?.[0];
            if (searchData?.code !== 200 || !apiSearchSong?.id) return null;

            let apiSong = apiSearchSong;
            try {
                const detailRes = await fetch(`${NETEASE_API_BASE_URL}/song/detail?ids=${apiSearchSong.id}&timestamp=${Date.now()}${cookieParam}`);
                const detailData = await detailRes.json();
                if (detailData?.code === 200 && detailData?.songs?.[0]) apiSong = detailData.songs[0];
            } catch (error) {
                console.warn('Netease song detail fetch failed:', error);
            }

            const urlRes = await fetch(`${NETEASE_API_BASE_URL}/song/url/v1?id=${apiSearchSong.id}&level=exhigh&timestamp=${Date.now()}${cookieParam}`);
            const urlData = await urlRes.json();
            const finalUrl = urlData?.data?.[0]?.url || '';
            if (urlData?.code !== 200 || !finalUrl) return null;

            let finalLyric = '';
            try {
                const lyrRes = await fetch(`${NETEASE_API_BASE_URL}/lyric?id=${apiSearchSong.id}&timestamp=${Date.now()}${cookieParam}`);
                const lyrData = await lyrRes.json();
                if (lyrData?.code === 200 && lyrData?.lrc?.lyric) {
                    finalLyric = lyrData.lrc.lyric;
                    if (lyrData?.tlyric?.lyric) finalLyric += '\n\n---翻译---\n\n' + lyrData.tlyric.lyric;
                }
            } catch (error) {
                console.warn('Netease lyric fetch failed:', error);
            }

            const songName = apiSong.name || apiSearchSong.name || cleanKeyword;
            const artistName = this.getNeteaseArtistName(apiSong);
            const existingSong = this.globalPlaylist.find(song => 
                song.neteaseId === apiSearchSong.id || (song.title === songName && song.artist === artistName)
            );
            if (existingSong) return { song: existingSong, index: this.globalPlaylist.indexOf(existingSong), added: false };

            const songObj = {
                title: songName,
                artist: artistName,
                cover: this.getNeteaseCover(apiSong),
                src: finalUrl,
                lyric: finalLyric,
                neteaseId: apiSearchSong.id
            };

            if (!persistToLibrary) return { song: songObj, index: -1, added: false, temporary: true };

            this.globalPlaylist.push(songObj);
            if (appendToCurrentPlaylist && this.playlist !== this.globalPlaylist) {
                this.playlist.push(songObj);
            }
            this.saveSongToLocal(songObj.title, songObj.artist, songObj.cover, songObj.src, songObj.lyric, null);
            this.renderSongToDOM(songObj.title, songObj.artist, songObj.cover, songObj.src, songObj.lyric);
            this.updateProfileStats();

            return { song: songObj, index: this.globalPlaylist.indexOf(songObj), added: true };
        } catch (error) {
            console.error('Netease song import failed:', error);
            return null;
        }
    },
    // ▲▲▲ 新增结束 ▲▲▲

    // ▼▼▼ [新增] 侧边栏状态控制 ▼▼▼
    hasActivatedWidget: false, 
    widgetForceClosed: false,
    totalListenSeconds: 0,
    // ▲▲▲
    playlist: [], // 存储所有加载或添加的歌曲信息
    globalPlaylist: [], // ▼▼▼ [新增] 用于保存全局“我的歌曲”库的备份，防止被覆盖 ▼▼▼

    groups: [],
    recentPlays: [], // ▼▼▼ [新增] 最近播放记录列表 ▼▼▼
    currentIndex: 0, // 当前播放的歌曲索引
    playMode: 'loop', 
    isPlaying: false, 
    isLyricsView: false, 
    showTranslation: false, // ▼▼▼ [新增] 全局翻译显示状态 ▼▼▼
    hasClearedPlaceholder: false, 
    lyricOffset: 0.48, 
    lastHiddenLyricSyncTime: 0,
    animationFrameId: null, // ▼▼▼ [新增] 60Hz高刷计时器
    // ▼▼▼ [新增] 一起听逻辑的独立状态锁 ▼▼▼
    currentListeningChar: null, 
    listenSessionInterval: null, 
    skipCounter: 0, // 记录连续切歌次数
    skipTimer: null,
    // 向数据库发送隐形行为日志
    async sendHiddenMusicEvent(actionDesc) {
        if (!this.currentListeningChar) return;
        try {
            const charId = this.currentListeningChar.id;
            const { db, tempState, AppState } = await import('../state.js');
            const msg = {
                chatId: charId,
                timestamp: new Date(),
                text: `[系统监测：在"一起听"期间，${actionDesc}]`,
                type: 'sent', // 伪装成你发的
                uiVisible: false, // 隐形！你不觉得尴尬
                aiVisible: true,  // AI看得到！
                recalled: false
            };
            const msgId = await db.chatMessages.add(msg);
            if (String(charId) === String(tempState.currentChatId)) {
                const newMsg = await db.chatMessages.get(msgId);
                if(AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
            }
        } catch(e) { console.error("发送音乐行为日志失败", e); }
    },

       // ▼▼▼ [新增] 最近播放功能模块 ▼▼▼
    loadRecentPlays() {
        const saved = localStorage.getItem('looky_music_recent_v2');
        if (saved) {
            try { this.recentPlays = JSON.parse(saved); } catch(e) { this.recentPlays = []; }
        }
    },
    updateRecentPlays(song) {
        // 查找是否已经存在，存在则先移除
        const idx = this.recentPlays.findIndex(s => s.title === song.title && s.artist === song.artist);
        if (idx !== -1) {
            this.recentPlays.splice(idx, 1);
        }
        // 剔除封面图片(cover)和长歌词，只存文字，坚决防止撑爆本地缓存
        this.recentPlays.unshift({ title: song.title, artist: song.artist, src: song.src });
        if (this.recentPlays.length > 15) this.recentPlays.pop(); // 最多存15首最近播放
        localStorage.setItem('looky_music_recent_v2', JSON.stringify(this.recentPlays));
        this.renderRecentPlaysToDOM();
    },
    renderRecentPlaysToDOM() {
        const container = document.querySelector('.recent-gallery-scroll');
        if (!container) return;
        container.innerHTML = ''; // 清除HTML里写死的静态占位图
        
        if (this.recentPlays.length === 0) {
            container.innerHTML = '<div style="font-size: 12px; color: #ccc; padding: 20px;">暂无最近播放记录</div>';
            return;
        }

        // 用精简记录去全局大曲库里匹配完整数据(把封面图片借过来)
        const richRecentPlays = this.recentPlays.map(slimSong => {
            const globalSong = this.globalPlaylist.find(s => s.title === slimSong.title && s.artist === slimSong.artist);
            return globalSong ? globalSong : slimSong;
        });

        richRecentPlays.forEach((song, idx) => {
            const defaultCover = "https://images.unsplash.com/photo-1493225457124-a1a2a5377047?q=80&w=200&auto=format&fit=crop";
            const cover = song.cover || defaultCover;
            const el = document.createElement('div');
            el.className = 'recent-item';
            el.innerHTML = `
                <div class="cover-box" style="background-image: url('${cover}');">
                  <div class="play-mask"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 19 12 8 19"></polygon></svg></div>
                </div>
                <span class="title">${song.title}</span>
                <span class="artist">${song.artist}</span>
            `;
            // 点击最近播放时的逻辑：变成一个专属的“最近播放分组”
            el.onclick = () => {
                this.playlist = [...richRecentPlays];
                this.updatePlaylistDrawer();
                this.playSongAtIndex(idx);
                if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`播放最近记录: ${song.title}`, 'success');
            };
            container.appendChild(el);
        });
    },
    // ▼▼▼ [新增] 专门用于刷新底部播放列表抽屉的函数 ▼▼▼
    updatePlaylistDrawer() {
        const drawerList = document.querySelector('#music-playlist-drawer .drawer-scroll-list');
        if (!drawerList) return;
        drawerList.innerHTML = ''; // 清空抽屉
        
        this.playlist.forEach((song, idx) => {
            const el = document.createElement('div');
            el.className = 'drawer-song-item';
            // 给当前正在播放的歌加上动态音阶效果
            if (idx === this.currentIndex) {
                el.classList.add('playing');
                el.innerHTML = `
                    <div class="song-info"><span class="name">${song.title}</span><span class="artist">- ${song.artist}</span></div>
                    <div class="playing-icon animated-eq"><span></span><span></span><span></span><span></span></div>
                `;
            } else {
                el.innerHTML = `<div class="song-info"><span class="name">${song.title}</span><span class="artist">- ${song.artist}</span></div>`;
            }
            // 点击抽屉里的歌直接播放
            el.onclick = () => this.playSongAtIndex(idx);
            drawerList.appendChild(el);
        });
        // 同步更新抽屉标题栏的歌曲总数
        document.querySelectorAll('#play-mode-text .count').forEach(span => span.innerHTML = `(${this.playlist.length})`);
    },

    // ▼▼▼ [新增] 动态计算并更新主页卡片的等级和听歌量 ▼▼▼
    updateProfileStats() {
        // 获取真实的总歌曲数量
        const count = this.globalPlaylist ? this.globalPlaylist.length : 0;
        // 计算等级：向下取整，每 20 首为 1 级
        const level = Math.floor(count / 20); 
        
        const countEl = document.getElementById('music-profile-song-count');
        const levelEl = document.getElementById('music-profile-level');
         if (countEl) countEl.textContent = count;
        if (levelEl) levelEl.textContent = 'Lv.' + level;
    },

    // ▼▼▼ [新增] 检查刷新导致的意外中断，并通知 AI ▼▼▼
    async checkInterruptedSession() {
        const charId = localStorage.getItem('looky_listening_char_id');
        if (charId) {
            // 发现遗留的ID，说明被刷新或杀后台打断了
            localStorage.removeItem('looky_listening_char_id');
            console.log(`[Music] 检测到页面刷新打断了与角色 ${charId} 的一起听`);
                        try {
                const { db, tempState, AppState } = await import('../state.js');
                
                // 悄悄塞一条最高权重的上帝指令给AI，让它彻底明白断开了
                const interruptMsg = {
                    chatId: charId,
                    timestamp: new Date(),
                    text: `<[系统紧急通知：由于网络波动或页面刷新，你们刚才的"一起听"连接已经【意外断开】了！音乐已经停止。请在你接下来的回复中，自然地体现出你注意到了音乐突然中断这件事。]>`,
                    type: 'sent', // 关键！伪装成用户发送，绕过普通的系统消息过滤机制
                    uiVisible: false, // 对用户隐形，不会弄脏聊天界面
                    aiVisible: true,  // AI肯定能看到
                    recalled: false
                };
                const msgId = await db.chatMessages.add(interruptMsg);

                // 如果用户正好在这个角色的聊天界面，同步到内存里
                 if (String(charId) === String(tempState.currentChatId)) {
                    const newMsg = await db.chatMessages.get(msgId);
                    if(AppState.currentChatHistory) AppState.currentChatHistory.push(newMsg);
                }
            } catch(e) { 
                console.error("发送意外中断消息失败", e); 
            }
        }
    },
    init() {
        console.log("🎵 网易云黑胶音乐模块已初始化");
        this.initGlobal();
        this.checkInterruptedSession(); // ▼▼▼ [新增] 初始化时检查意外中断 ▼▼▼
        this.bindEvents();
        this.bindProfileSettings(); 
        this.bindPageBgSettings(); 
        this.bindFullscreenBgSettings(); // ▼▼▼ [新增] 激活播放器背景设置逻辑 ▼▼▼
        this.loadSavedPlaylist(); 
        this.loadSavedGroups(); 
        this.setupAudioEngine(); // [新增] 专门初始化引擎事件
        this.initGlobalWidget();
        this.updateUI();
// ▼▼▼ 在这里 [新增] 初始化网易云相关功能 ▼▼▼
        this.initNeteaseSearch();
        this.initNeteaseLogin();
// ▲▲▲ 新增结束 ▲▲▲
    },
    // --- 搜歌功能 ---
    initNeteaseSearch() {
        const searchInput = document.getElementById('music-global-search-input');
        const searchContainer = document.getElementById('music-global-search-container');
        const resultsPanel = document.getElementById('music-search-dropdown');
        const resultsList = document.getElementById('music-search-results-list');
        const spinner = document.getElementById('music-search-spinner');
        const clearBtn = document.getElementById('music-search-clear-btn');
        let searchTimeout = null;
        if (!searchInput) return;
        // 获取 Cookie 参数的方法 (如果登录了的话)
        const getCookieParam = () => {
            const cookie = localStorage.getItem('netease_cookie');
            return cookie ? `&cookie=${encodeURIComponent(cookie)}` : '';
        };
        // 监听输入
        searchInput.addEventListener('input', (e) => {
            const keyword = e.target.value.trim();
            if (keyword) {
                clearBtn.style.display = 'flex';
                clearTimeout(searchTimeout);
                spinner.style.display = 'block';
               // 防抖设计，停下打字 5 秒后才自动搜索
                searchTimeout = setTimeout(() => this.performSearch(keyword, resultsPanel, resultsList, spinner, getCookieParam), 5000);
            } else {
                clearBtn.style.display = 'none';
                spinner.style.display = 'none';
                resultsPanel.style.display = 'none';
                resultsList.innerHTML = '';
            }
        });
        // 新增：回车键立刻触发搜索
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const keyword = searchInput.value.trim();
                if (keyword) {
                    clearTimeout(searchTimeout); // 清除5秒自动搜索倒计时
                    spinner.style.display = 'block';
                    this.performSearch(keyword, resultsPanel, resultsList, spinner, getCookieParam);
                }
            }
        });
        // 清除按钮
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input'));
        });
        // 点击外部关闭搜索框
        document.addEventListener('click', (e) => {
            if (!searchContainer.contains(e.target)) {
                resultsPanel.style.display = 'none';
            }
        });
        
        // 点击输入框重新显示
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim() && resultsList.innerHTML !== '') {
                resultsPanel.style.display = 'block';
            }
        });
    },
    async performSearch(keyword, panel, listEl, spinner, getCookieParam) {
        try {
                        let playlistId = null;
            // 正则匹配网易云分享链接中的 id=xxx，或者纯输入的数字 ID
            const match = keyword.match(/id=(\d+)/);
            if (match && match[1]) {
                playlistId = match[1];
            } else if (/^\d{6,}$/.test(keyword)) {
                playlistId = keyword;
            }
            // 如果查到是歌单 ID
            if (playlistId) {
                const plRes = await fetch(`${NETEASE_API_BASE_URL}/playlist/detail?id=${playlistId}&timestamp=${Date.now()}${getCookieParam()}`);
                const plData = await plRes.json();
                
                if (plData.code === 200 && plData.playlist) {
                    spinner.style.display = 'none';
                    panel.style.display = 'block';
                    listEl.innerHTML = '';
                    
                    const plCover = plData.playlist.coverImgUrl ? plData.playlist.coverImgUrl + '?param=300y300' : "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=200&auto=format&fit=crop";
                    const plName = plData.playlist.name;
                    const plCount = plData.playlist.trackCount;
                    const el = document.createElement('div');
                    el.className = 'search-result-item';
                    el.innerHTML = `
                        <img src="${plCover}" class="s-cover">
                        <div class="s-info">
                            <span class="s-name">[歌单] ${plName}</span>
                            <span class="s-artist">共 ${plCount} 首歌曲</span>
                        </div>
                        <div class="s-action">
                            <button class="add-btn">收藏</button>
                        </div>
                    `;
                    const addBtn = el.querySelector('.add-btn');
                    addBtn.onclick = async (e) => {
                        e.stopPropagation();
                        addBtn.textContent = "导入中...";
                        addBtn.disabled = true;
                        try {
                            const trackRes = await fetch(`${NETEASE_API_BASE_URL}/playlist/track/all?id=${playlistId}&limit=50&timestamp=${Date.now()}${getCookieParam()}`);
                            const trackData = await trackRes.json();
                            
                            if (trackData.code === 200 && trackData.songs) {
                                const newGroup = {
                                    id: Date.now().toString(),
                                    name: plName,
                                    desc: plData.playlist.description || '从网易云导入的歌单',
                                    cover: plCover,
                                    songs: []
                                };
                                
                                // 批量获取这批歌的URL
                                const songIds = trackData.songs.map(s => s.id).join(',');
                                const urlRes = await fetch(`${NETEASE_API_BASE_URL}/song/url/v1?id=${songIds}&level=exhigh&timestamp=${Date.now()}${getCookieParam()}`);
                                const urlData = await urlRes.json();
                                
                                const urlMap = {};
                                if (urlData.data) urlData.data.forEach(item => { if (item.url) urlMap[item.id] = item.url; });
                              let importedCount = 0;
                                const totalCount = trackData.songs.length;
                                for (const apiSong of trackData.songs) {
                                    const songUrl = urlMap[apiSong.id];
                                    if (!songUrl) continue; // 跳过无版权的歌
                                    
                                    importedCount++;
                                    addBtn.textContent = `导入中(${importedCount}/${totalCount})`; // 实时更新进度
                                    const finalCover = apiSong.al?.picUrl ? apiSong.al.picUrl + '?param=300y300' : plCover;
                                    const artistName = apiSong.ar ? apiSong.ar.map(a=>a.name).join(' / ') : '未知';
                                    
                                    // 获取歌词
                                    let finalLyric = '';
                                    try {
                                        const lyrRes = await fetch(`${NETEASE_API_BASE_URL}/lyric?id=${apiSong.id}&timestamp=${Date.now()}${getCookieParam()}`);
                                        const lyrData = await lyrRes.json();
                                        if (lyrData.code === 200 && lyrData.lrc && lyrData.lrc.lyric) {
                                            finalLyric = lyrData.lrc.lyric;
                                            if (lyrData.tlyric && lyrData.tlyric.lyric) {
                                                finalLyric += '\n\n---翻译---\n\n' + lyrData.tlyric.lyric;
                                            }
                                        }
                                    } catch(e) {}
                                       const songObj = {
                                title: apiSong.name, artist: artistName, cover: finalCover, src: songUrl, lyric: finalLyric, neteaseId: apiSong.id 
                            };

                                    newGroup.songs.push(songObj);
                                    
                                    // 存入全局曲库
                                    if (!this.globalPlaylist.some(ls => ls.title === songObj.title && ls.artist === songObj.artist)) {
                                        this.globalPlaylist.push(songObj);
                                        this.saveSongToLocal(songObj.title, songObj.artist, songObj.cover, songObj.src, songObj.lyric, null);
                                    }
                                }
                                this.groups.push(newGroup);
                                await this.saveGroupsToLocal();
                                this.renderGroupsToDOM();
                                addBtn.textContent = "已收藏";
                                addBtn.style.background = "#34c759";
                                if (typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`歌单《${plName}》导入成功`, 'success');
                            }
                        } catch (err) {
                            console.error("歌单导入失败", err);
                            addBtn.textContent = "导入失败";
                            addBtn.style.background = "#ff3b30";
                        }
                    };
                    listEl.appendChild(el);
                    return; // 如果是歌单，到此结束，不再往下搜索单曲
                }
            }
            // 1. 本地模糊搜索
            const localResults = this.globalPlaylist.filter(s => 
                s.title.toLowerCase().includes(keyword.toLowerCase()) || 
                s.artist.toLowerCase().includes(keyword.toLowerCase())
            );
            // 2. 网易云 API 搜索 (加上 timestamp 防止缓存)
            let apiResults = [];
            try {
                const res = await fetch(`${NETEASE_API_BASE_URL}/search?keywords=${encodeURIComponent(keyword)}&limit=15&timestamp=${Date.now()}${getCookieParam()}`);
                const data = await res.json();
                if (data.code === 200 && data.result.songs) {
                    apiResults = data.result.songs;
                // 拿着简略版搜索结果的 ID，去换取带有高清封面的完整数据
                    const ids = apiResults.map(s => s.id).join(',');
                    const detailRes = await fetch(`${NETEASE_API_BASE_URL}/song/detail?ids=${ids}&timestamp=${Date.now()}${getCookieParam()}`);
                    const detailData = await detailRes.json();
                    if (detailData.code === 200 && detailData.songs) {
                        apiResults = detailData.songs;
                    }
                }
            } catch (err) {
                console.error("API 搜索失败", err);
            }
            spinner.style.display = 'none';
            panel.style.display = 'block';
            listEl.innerHTML = '';
            if (localResults.length === 0 && apiResults.length === 0) {
                listEl.innerHTML = '<div class="search-empty">没有找到相关歌曲</div>';
                return;
            }
            // 3. 渲染本地结果
            localResults.forEach(song => {
                const defaultCover = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop&grayscale";
                const el = document.createElement('div');
                el.className = 'search-result-item';
                el.innerHTML = `
                    <img src="${song.cover || defaultCover}" class="s-cover">
                    <div class="s-info">
                        <span class="s-name">${song.title}</span>
                        <span class="s-artist">${song.artist}</span>
                    </div>
                    <div class="s-action">
                        <span class="local-tag">本地已存</span>
                    </div>
                `;
                // 点击本地结果直接播放
                el.onclick = () => {
                    panel.style.display = 'none';
                    const targetIdx = this.globalPlaylist.findIndex(s => s.title === song.title && s.artist === song.artist);
                    if (targetIdx !== -1) {
                        this.playlist = [...this.globalPlaylist];
                        this.updatePlaylistDrawer();
                        this.playSongAtIndex(targetIdx);
                    }
                };
                listEl.appendChild(el);
            });
             // 4. 渲染网易云结果
            apiResults.forEach(apiSong => {
                // 【修复】兼容网易云新旧接口的歌手字段名 (ar 或 artists)
                const songArtists = apiSong.ar || apiSong.artists || [];
                const firstArtistName = songArtists[0] ? songArtists[0].name : '未知歌手';
                const fullArtistName = songArtists.map(a => a.name).join(' / ') || '未知歌手';
                
                // 检查是否已经在本地曲库中
                const isLocal = this.globalPlaylist.some(ls => ls.title === apiSong.name && ls.artist === firstArtistName);
                
                // 如果本地有了，就不再显示 API 的重复项
                if (isLocal) return;
                const el = document.createElement('div');
                el.className = 'search-result-item';
                // API 搜索接口可能不带高清封面，先用占位图，点击添加时再获取
                const defaultCover = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=100&auto=format&fit=crop";
                el.innerHTML = `
                    <img src="${apiSong.al?.picUrl ? apiSong.al.picUrl + '?param=100y100' : defaultCover}" class="s-cover">
                    <div class="s-info">
                        <span class="s-name">${apiSong.name}</span>
                        <span class="s-artist">${firstArtistName}</span>
                    </div>
                    <div class="s-action">
                        <button class="add-btn">添加</button>
                    </div>
                `;
                const addBtn = el.querySelector('.add-btn');
                addBtn.onclick = async (e) => {

                    e.stopPropagation();
                    const prevText = addBtn.textContent;
                    addBtn.textContent = "解析中...";
                    addBtn.disabled = true;
                    try {
                        // ① 获取播放 URL (使用 exhigh 极高音质)
                        const urlRes = await fetch(`${NETEASE_API_BASE_URL}/song/url/v1?id=${apiSong.id}&level=exhigh&timestamp=${Date.now()}${getCookieParam()}`);
                        const urlData = await urlRes.json();
                        let finalUrl = '';
                        if (urlData.code === 200 && urlData.data && urlData.data[0] && urlData.data[0].url) {
                            finalUrl = urlData.data[0].url;
                        } else {
                            throw new Error("无法获取该歌曲的播放链接，可能是VIP歌曲或无版权");
                        }
                        // ② 获取歌词
                        let finalLyric = '';
                        const lyrRes = await fetch(`${NETEASE_API_BASE_URL}/lyric?id=${apiSong.id}&timestamp=${Date.now()}${getCookieParam()}`);
                        const lyrData = await lyrRes.json();
                        if (lyrData.code === 200 && lyrData.lrc && lyrData.lrc.lyric) {
                            finalLyric = lyrData.lrc.lyric;
                            if (lyrData.tlyric && lyrData.tlyric.lyric) {
                                finalLyric += '\n\n---翻译---\n\n' + lyrData.tlyric.lyric;
                            }
                        }
                        // ③ 获取封面并压画质 (极大地减少网速消耗和内存占用)
                        let finalCover = apiSong.al?.picUrl ? apiSong.al.picUrl + '?param=300y300' : defaultCover;
                        // 组装新歌
                        const songName = apiSong.name;
                        const artistName = fullArtistName;
                        const songObj = { title: songName, artist: artistName, cover: finalCover, src: finalUrl, lyric: finalLyric, neteaseId: apiSong.id };

                        // 加入播放列表并保存
                        if (this.playlist !== this.globalPlaylist) {
                            this.playlist = [...this.globalPlaylist];
                        }
                        this.playlist.push(songObj);
                        this.globalPlaylist.push(songObj);
                        this.renderSongToDOM(songName, artistName, finalCover, finalUrl, finalLyric);
                        this.saveSongToLocal(songName, artistName, finalCover, finalUrl, finalLyric, null);
                        
                        // 播放这首歌
                        this.playSongAtIndex(this.playlist.length - 1);
                        this.updateProfileStats();
                        addBtn.textContent = "已添加";
                        addBtn.style.background = "#34c759";
                        
                        if (typeof window.showDynamicIsland === 'function') {
                            window.showDynamicIsland(`已添加: ${songName}`, 'success');
                        }
                    } catch (error) {
                        console.error("添加歌曲失败:", error);
                        addBtn.textContent = "添加失败";
                        addBtn.style.background = "#ff3b30";
                        alert(error.message || "添加歌曲失败，请稍后重试");
                        setTimeout(() => {
                            addBtn.textContent = "添加";
                            addBtn.style.background = "#111";
                            addBtn.disabled = false;
                        }, 2000);
                    }
                };
                listEl.appendChild(el);
            });
        } catch (e) {
            console.error("搜歌发生致命错误", e);
            spinner.style.display = 'none';
            listEl.innerHTML = '<div class="search-empty" style="color:#ff3b30;">搜索请求失败，请检查后端状态</div>';
        }
    },
     // --- 扫码登录功能 ---
    initNeteaseLogin() {
        const loginMenuBtn = document.getElementById('music-menu-netease-login');
        const loginModal = document.getElementById('netease-login-modal-overlay');
        const closeBtn = document.getElementById('close-netease-login-btn');
        const qrImg = document.getElementById('netease-qr-img');
        const loadingText = document.getElementById('netease-qr-loading');
        const expiredMask = document.getElementById('netease-qr-expired');
        const refreshBtn = document.getElementById('netease-qr-refresh-btn');
        const statusText = document.getElementById('netease-login-status');
        const loginStatusMenuText = document.getElementById('netease-login-text');
        
        let checkTimer = null;
        let currentKey = '';

        // 检查初始化登录状态
        const checkLocalStatus = () => {
            const cookie = localStorage.getItem('netease_cookie');
            if (cookie && loginStatusMenuText) {
                loginStatusMenuText.textContent = "网易云 (已登录)";
                loginStatusMenuText.style.color = "#d43c33"; // 网易红
            }
        };
        checkLocalStatus();

        // ▼▼▼ 修复：完整的关闭动画逻辑 ▼▼▼
        const closeLoginModal = () => {
            loginModal.classList.remove('active');
            loginModal.style.opacity = '0';
            loginModal.style.visibility = 'hidden';
            loginModal.style.pointerEvents = 'none';
            setTimeout(() => {
                loginModal.style.display = 'none';
            }, 300); // 等待淡出动画结束
            
            if (checkTimer) clearInterval(checkTimer);
        };
        // ▲▲▲ 修复结束 ▲▲▲

        if (loginMenuBtn) {
            loginMenuBtn.addEventListener('click', () => {
                // 收起右上角菜单
                const actionMenu = document.getElementById('music-action-menu');
                if(actionMenu) {
                    actionMenu.style.display = 'none';
                    actionMenu.style.opacity = '0';
                    actionMenu.style.visibility = 'hidden';
                    actionMenu.style.pointerEvents = 'none';
                    actionMenu.classList.remove('active');
                }
                
                // ▼▼▼ 修复：完整的弹窗显示逻辑 (摘下隐形斗篷) ▼▼▼
                loginModal.style.display = 'flex';
                void loginModal.offsetWidth; // 强制浏览器重绘，触发动画
                loginModal.style.opacity = '1';
                loginModal.style.visibility = 'visible';
                loginModal.style.pointerEvents = 'auto';
                loginModal.classList.add('active');
                // ▲▲▲ 修复结束 ▲▲▲
                
                startLoginFlow();
            });
        }

        if (closeBtn) closeBtn.addEventListener('click', closeLoginModal);
        if (refreshBtn) refreshBtn.addEventListener('click', startLoginFlow);

        async function startLoginFlow() {
            if (checkTimer) clearInterval(checkTimer);
            qrImg.style.display = 'none';
            expiredMask.style.display = 'none';
            loadingText.style.display = 'block';
            statusText.textContent = '';
            statusText.style.color = '#111';

            try {
                // 1. 获取 key
                const keyRes = await fetch(`${NETEASE_API_BASE_URL}/login/qr/key?timestamp=${Date.now()}`);
                const keyData = await keyRes.json();
                if (keyData.code !== 200) throw new Error("获取 Key 失败");
                currentKey = keyData.data.unikey;

                // 2. 获取二维码 Base64
                const qrRes = await fetch(`${NETEASE_API_BASE_URL}/login/qr/create?key=${currentKey}&qrimg=true&timestamp=${Date.now()}`);
                const qrData = await qrRes.json();
                if (qrData.code !== 200) throw new Error("生成二维码失败");

                qrImg.src = qrData.data.qrimg;
                qrImg.style.display = 'block';
                loadingText.style.display = 'none';
                statusText.textContent = '请使用网易云音乐 APP 扫码';

                // 3. 开始轮询状态
                checkTimer = setInterval(() => checkScanStatus(), 3000);

            } catch (err) {
                console.error("登录流程出错:", err);
                loadingText.textContent = "获取失败，请检查网络或后端接口";
            }
        }

        async function checkScanStatus() {
            try {
                const res = await fetch(`${NETEASE_API_BASE_URL}/login/qr/check?key=${currentKey}&timestamp=${Date.now()}`);
                const data = await res.json();
                
                if (data.code === 800) {
                    // 二维码过期
                    clearInterval(checkTimer);
                    expiredMask.style.display = 'flex';
                    statusText.textContent = '二维码已过期，请刷新';
                } else if (data.code === 802) {
                    // 已扫码，等待确认
                    statusText.textContent = '扫描成功，请在手机上确认';
                    statusText.style.color = '#34c759'; // 绿色
                } else if (data.code === 803) {
                    // 登录成功
                    clearInterval(checkTimer);
                    statusText.textContent = '登录成功！';
                    statusText.style.color = '#34c759';
                    
                    // 保存 cookie 到本地，极其关键！
                    localStorage.setItem('netease_cookie', data.cookie);
                    checkLocalStatus();

                    if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('网易云登录成功', 'success');

                    setTimeout(() => {
                        closeLoginModal();
                    }, 1500);
                }
            } catch (err) {
                console.error("检查状态失败", err);
            }
        }
    },

    // ▼▼▼ [新增] 关于歌单的本地读取和渲染函数 ▼▼▼
    async loadSavedGroups() {
        // 1. 从大容量 IndexedDB 提取歌单
        try {
            this.groups = await LocalMusicDB.getAllGroups();
        } catch (e) {
            console.error("加载歌单失败", e);
        }

        // ▼▼▼ [新增] 确保"我喜欢的音乐"固定分组存在且在第一位 ▼▼▼
        let favGroup = this.groups.find(g => g.id === 'group-favorite');
        if (!favGroup) {
            favGroup = {
                id: 'group-favorite',
                name: '我喜欢的音乐',
                desc: '所有我标记为喜欢的歌曲',
                cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?q=80&w=200&auto=format&fit=crop',
                songs: []
            };
            this.groups.unshift(favGroup);
            await this.saveGroupsToLocal();
        } else {
            this.groups = this.groups.filter(g => g.id !== 'group-favorite');
            this.groups.unshift(favGroup); // 强制提到最前面
        }
        // ▲▲▲ 新增结束 ▲▲▲

        // 2. 清理遗留问题：移除爆满的 localStorage 缓存，释放空间

        const savedGroupsStr = localStorage.getItem('looky_music_groups');
        if (savedGroupsStr) {
            try { 
                const oldGroups = JSON.parse(savedGroupsStr); 
                // 兼容：把之前旧的缓存无缝搬到新数据库里
                if (oldGroups && oldGroups.length > 0 && this.groups.length === 0) {
                    this.groups = oldGroups;
                    await this.saveGroupsToLocal(); 
                }
                localStorage.removeItem('looky_music_groups'); // 删除爆满的缓存
            } catch(e) {}
        }
        
        this.renderGroupsToDOM();
        this.updateLikeButtonUI();
    },
  async saveGroupsToLocal() {
        await LocalMusicDB.saveAllGroups(this.groups);
    },
    renderGroupsToDOM() {
/* 原代码后两行： */
        const playlistContainer = document.querySelector('.playlist-list-view');
        if (!playlistContainer) return;

        
        playlistContainer.innerHTML = ''; // 清除原先写死的示例HTML
        
        if (this.groups.length === 0) {
            playlistContainer.innerHTML = '<div style="text-align:center; padding: 40px; color:#ccc; font-size:13px;">暂无分组，点击右上角 + 创建</div>';
            return;
        }

                this.groups.forEach((group, idx) => {

            // 如果没上传封面，给个默认好听的极简图
            const defaultCover = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=200&auto=format&fit=crop";
            const coverSrc = group.cover || defaultCover;
            const songCount = group.songs ? group.songs.length : 0;

            const el = document.createElement('div');
            el.className = 'pl-list-item';
            el.innerHTML = `
              <div class="pl-cover" style="background-image: url('${coverSrc}');"></div>
              <div class="pl-info">
                <h4>${group.name}</h4>
                <p>${songCount} 首</p>
              </div>
                        <button class="pl-more">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
              </button>
            `;
            
            // ▼▼▼ 新增：拦截“更多”按钮的点击事件，弹出菜单 ▼▼▼
            const moreBtn = el.querySelector('.pl-more');
            if (moreBtn) {
                moreBtn.onclick = (e) => {
                    e.stopPropagation(); // 阻止点击事件传给整个卡片
                    this.showGroupActionMenu(e, group);
                };
            }
            
            // ▼▼▼ 【核心修复】赋予歌单真实的播放交互逻辑 ▼▼▼
            el.onclick = () => {
                this.currentOpenGroupId = group.id;

                // 1. 切换视图显示
                const mainLayout = document.getElementById('music-layout-container');
                const detailView = document.getElementById('music-group-detail-view');
                if(mainLayout) mainLayout.style.display = 'none';
                if(detailView) detailView.style.display = 'block';

                // 2. 渲染头部信息
                const detailCover = document.getElementById('music-group-detail-cover');
                const detailTitle = document.getElementById('music-group-detail-title');
                const detailDesc = document.getElementById('music-group-detail-desc');
                const detailCount = document.getElementById('music-group-detail-count');
                
                if(detailCover) detailCover.src = coverSrc;
                if(detailTitle) detailTitle.textContent = group.name;
                if(detailDesc) detailDesc.textContent = group.desc || "暂无描述";
                if(detailCount) detailCount.textContent = `${songCount} 首歌曲`;

                // 3. 渲染歌曲列表
                const detailSongList = document.getElementById('music-group-detail-song-list');
                if(detailSongList) {
                    detailSongList.innerHTML = '';
                    if(!group.songs || group.songs.length === 0) {
                        detailSongList.innerHTML = '<div style="text-align:center; padding:40px; color:#ccc; font-size:13px;">暂无歌曲</div>';
                    } else {
                        group.songs.forEach((song, idx) => {
                            const newIndex = idx < 9 ? `0${idx + 1}` : `${idx + 1}`;
                            const songEl = document.createElement('div');
                            songEl.className = 'song-list-item';
                            songEl.innerHTML = `
                                <div class="song-index" style="color:#d43c33;">${newIndex}</div>
                                <div class="song-info">
                                    <div class="s-title">${song.title}</div>
                                    <div class="s-artist">${song.artist}</div>
                                </div>
                                <button class="song-more">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                                </button>
                            `;

                            // ▼▼▼ [新增] 为歌单内的“更多”按钮绑定移除菜单 ▼▼▼
                            const moreBtn = songEl.querySelector('.song-more');
                            if (moreBtn) {
                                moreBtn.onclick = (e) => {
                                    e.stopPropagation(); // 阻止触发整首歌的播放
                                    this.showGroupSongActionMenu(e, group, idx, songEl);
                                };
                            }
                            // ▲▲▲ 新增结束 ▲▲▲

                            // 【修正】不覆盖全局列表，直接在总歌单中匹配并播放
                           songEl.onclick = () => {

                                this.playlist = [...group.songs];
                                this.updatePlaylistDrawer(); 
                                this.playSongAtIndex(idx);
                                if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`正在播放: ${song.title}`, 'success');
                             };
// ▼▼▼ 在这里 [新增] 隐藏多余歌曲 ▼▼▼
                            if (idx >= 20) songEl.style.display = 'none';
// ▲▲▲ 新增结束 ▲▲▲
                            detailSongList.appendChild(songEl);
                        });
                        
// ▼▼▼ 在这里 [新增] 分组内歌曲的折叠按钮 ▼▼▼
                        if (group.songs.length > 20) {
                            const toggleBtn = document.createElement('div');
                            toggleBtn.style.cssText = 'text-align: center; padding: 15px; color: #888; font-size: 13px; cursor: pointer;';
                            toggleBtn.textContent = '展开全部歌曲 ▼';
                            let expanded = false;
                            toggleBtn.onclick = () => {
                                expanded = !expanded;
                                toggleBtn.textContent = expanded ? '收起歌曲 ▲' : '展开全部歌曲 ▼';
                                const items = detailSongList.querySelectorAll('.song-list-item');
                                items.forEach((item, i) => {
                                    if (i >= 20) item.style.display = expanded ? '' : 'none';
                                });
                            };
                            detailSongList.appendChild(toggleBtn);
                        }
// ▲▲▲ 新增结束 ▲▲▲
                    }
                }
                // 4. 绑定播放全部按钮 (仅播放分组的第一首歌)

          const playAllBtn = document.getElementById('music-group-play-all-btn');
                if(playAllBtn) {
                    playAllBtn.onclick = () => {
                        if (!group.songs || group.songs.length === 0) {
                            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`歌单为空，无法播放`, 'warning');
                            return;
                        }
                        this.playlist = [...group.songs];
                        this.updatePlaylistDrawer(); 
                        this.playSongAtIndex(0);
                        if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`开始播放分组: ${group.name}`, 'success');
                    };
                }

                // ▼▼▼ [新增] 绑定管理歌曲按钮 (右上角更多按钮) ▼▼▼
                const manageBtn = document.getElementById('music-group-more-btn');
                if (manageBtn) {
                    manageBtn.onclick = () => {
                        this.openManageGroupSongsModal(group);
                    };
                }
                // ▲▲▲ 新增结束 ▲▲▲
            };
            // ▲▲▲ 修复结束 ▲▲▲

// ▼▼▼ 在这里 [新增] 隐藏多余歌单 ▼▼▼
            if (idx >= 20) el.style.display = 'none';
// ▲▲▲ 新增结束 ▲▲▲
            playlistContainer.appendChild(el);
        });

// ▼▼▼ 在这里 [新增] 歌单折叠按钮 ▼▼▼
        if (this.groups.length > 20) {
            const toggleBtn = document.createElement('div');
            toggleBtn.style.cssText = 'text-align: center; padding: 15px; color: #888; font-size: 13px; cursor: pointer;';
            toggleBtn.textContent = '展开全部歌单 ▼';
            let expanded = false;
            toggleBtn.onclick = () => {
                expanded = !expanded;
                toggleBtn.textContent = expanded ? '收起歌单 ▲' : '展开全部歌单 ▼';
                const items = playlistContainer.querySelectorAll('.pl-list-item');
                items.forEach((item, i) => {
                    if (i >= 20) item.style.display = expanded ? '' : 'none';
                });
            };
            playlistContainer.appendChild(toggleBtn);
        }
// ▲▲▲ 新增结束 ▲▲▲
    },

     async loadSavedPlaylist() {
        this.playlist = []; // 清空重载
        
        // 1. 【数据迁移】旧版本的网络直链和笨重的封面图片，无缝搬家到大容量数据库，并清空旧缓存释放内存！
        const savedStr = localStorage.getItem('looky_custom_playlist');
        if (savedStr) {
            try {
                const oldSongs = JSON.parse(savedStr);
                for (let song of oldSongs) {
                    await LocalMusicDB.saveSong({
                        title: song.title, artist: song.artist, cover: song.cover,
                        src: song.src, audioBlob: null, lyric: song.lyric
                    });
                }
                localStorage.removeItem('looky_custom_playlist'); // 清理垃圾缓存
            } catch (e) {}
        }

        // 2. 【统一提取】现在所有的音乐（直链+本地文件）都从大容量的 IndexedDB 提取
        try {
            const localSongs = await LocalMusicDB.getAllSongs();
            localSongs.forEach(song => {
                // 判断：如果是文件就生成播放链接，如果是直链就直接用
                const finalSrc = song.audioBlob ? URL.createObjectURL(song.audioBlob) : song.src;
                this.playlist.push({ title: song.title, artist: song.artist, cover: song.cover, src: finalSrc, lyric: song.lyric });
                this.renderSongToDOM(song.title, song.artist, song.cover, finalSrc, song.lyric);
            });
        } catch (e) {
            console.error('提取音乐失败', e);
        }
        if (this.playlist.length > 0) {
            this.globalPlaylist = [...this.playlist]; // ▼▼▼ [新增] 将加载好的全部歌曲存入全局备份 ▼▼▼
            const firstSong = this.playlist[0];
            this.currentIndex = 0;
            this.updatePlayerInfoOnly(firstSong.title, firstSong.artist, firstSong.cover, firstSong.src, firstSong.lyric);
            this.highlightCurrentSong();
        }
        
        // ▼▼▼ [新增] 在曲库完全加载完毕后，加载并渲染最近播放 (以便能匹配到封面图) ▼▼▼
        this.loadRecentPlays();
        this.renderRecentPlaysToDOM();

        // [新增] 加载完歌曲后，刷新资料卡片的数据
        this.updateProfileStats();
         this.renderSilenceCard();
    },
    // ▼▼▼ [新增] 后台保活静音卡片的本体方法 ▼▼▼
    renderSilenceCard() {
        const tabSongsList = document.getElementById('tab-songs');
        // 防止重复添加
        if (!tabSongsList || document.getElementById('silence-track-card')) return;
        
        const silenceEl = document.createElement('div');
        silenceEl.id = 'silence-track-card';
        silenceEl.className = 'song-list-item';
        // 恢复成 00 序号，并把主副标题字体稍微缩小变淡
        silenceEl.innerHTML = `
            <div class="song-index" style="color:#999; font-size:14px; font-weight:500;">00</div>
            <div class="song-info">
              <div class="s-title" style="color:#444; font-weight:500; font-size:14px;">后台保活专属 (静音轨道)</div>
              <div class="s-artist" style="color:#aaa; font-size:11px;">点击进入后台循环，切歌即可退出</div>
            </div>
            <button class="song-more" style="opacity: 0.2; pointer-events: none;">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="12" r="2"></circle></svg>
            </button>
        `;
        silenceEl.onclick = () => {

            this.isSilenceTrack = true;
            this.currentMediaTitle = '后台保活 (静音)';
            this.currentMediaArtist = '系统运行中';
            this.currentMediaCover = '';
            this.currentIndex = -1; // 赋一个负数，脱离常规播放列表
            
            // 1. 先用 updatePlayerInfoOnly 更新所有UI界面和 src (此时会设置 src 但不会播放)
            this.updatePlayerInfoOnly(
                "后台保活 (静音)", 
                "系统运行中", 
                "", 
                "assets/silence.mp3", // ★★★ 在这里填你的静音音频路径 ★★★
                "[00:00.00]已开启静音保活模式，有效防止断联\n[00:05.00]轨道仅循环自身，切歌即可退出。"
            );
            // 使用 audio 元素自身循环，避免 ended 事件和重新 play 之间出现后台空档。
            if (isNativeRuntime()) {
                this.audioEngine.loop = true;
                this.audioEngine.preload = 'auto';
                startNativeKeepAlive().catch(error => console.warn('[Music] 原生后台保活启动失败:', error));
            }
            
            // 2. 然后再统一执行播放逻辑，就不会被打断了
            let playPromise = this.audioEngine.play();
            if (playPromise !== undefined) {
                playPromise.catch(e => console.log("静音轨道播放等待中...", e));
            }
            
            this.isPlaying = true;
            this.updateUI();
            this.highlightCurrentSong();
            
            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`已开启后台保活模式`, 'success');
        };

        // 永远插在第一行
        tabSongsList.prepend(silenceEl);
    },
    // ▲▲▲ 新增结束 ▲▲▲

    // ▼▼▼ [新增] 仅更新播放器界面信息而不自动播放（用于初始化） ▼▼▼
    updatePlayerInfoOnly(title, artist, coverUrl, audioSrc, lyricText) {
        this.audioEngine.src = audioSrc;
        this.isPlaying = false;
        this.updateUI();

        document.querySelectorAll('.song-title, .m-title').forEach(el => el.textContent = title);
        document.querySelectorAll('.song-artist, .m-artist').forEach(el => el.textContent = artist);

        const defaultCover = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=600&auto=format&fit=crop&grayscale";
         const finalCover = coverUrl || defaultCover;
        document.querySelectorAll('.album-cover, .mini-album-art img').forEach(img => img.src = finalCover);
        document.querySelectorAll('.mini-player-dynamic-bg, .widget-dynamic-bg').forEach(bg => bg.style.backgroundImage = `url('${finalCover}')`); // ▼ 这里加了 .widget-dynamic-bg 同步背景

        const widgetCover = document.getElementById('widget-cover-img');
        if(widgetCover) widgetCover.src = finalCover;
        const widgetTitle = document.getElementById('widget-song-title');
        if(widgetTitle) widgetTitle.textContent = title;
        const lyricsContainer = document.querySelector('.lyrics-scroll-container');
        const snippetEl = document.querySelector('.lyric-snippet p');
        this.currentLyrics = [];
        this.lastActiveLyricIndex = -1;
        if (lyricsContainer) {
            lyricsContainer.innerHTML = ''; 
            if (lyricText) {
                let origLines = [];
                let transMap = {};
                let isDual = false;
                
                // ▼▼▼ 全新高成功率解析法：按分隔符拆分 ▼▼▼
                if (lyricText.includes('---翻译---')) {
                    isDual = true;
                    const parts = lyricText.split('---翻译---');
                    origLines = parts[0].split('\n');
                    const tLines = parts[1] ? parts[1].split('\n') : [];
                    
                    tLines.forEach(line => {
                        const match = line.match(/\[(\d{2}):(\d{2}(?:\.\d{2,3})?)\](.*)/);
                        if (match && match[3].trim()) {
                            const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                            transMap[Math.round(time * 10)] = match[3].trim();
                        }
                    });
                } else {
                    origLines = lyricText.split('\n');
                }
                // ▲▲▲ 解析结束 ▲▲▲

                origLines.forEach(line => {

                    const match = line.match(/\[(\d{2}):(\d{2}(?:\.\d{2,3})?)\](.*)/);
                    if (match && match[3].trim()) {
                        const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                        const text = match[3].trim();
                        let tText = '';
                        if (isDual) {
                            const key = Math.round(time * 10);
                            for(let t = key - 2; t <= key + 2; t++) {
                                if (transMap[t]) { tText = transMap[t]; break; }
                            }
                        }
                        this.currentLyrics.push({ time: time, text: text, tText: tText });
                        const p = document.createElement('p');
                        p.innerHTML = `<span class="orig">${text}</span>` + (tText ? `<br><span class="trans" style="display:${this.showTranslation ? 'inline-block' : 'none'}; font-size:0.85em; opacity:0.7; margin-top:2px;">${tText}</span>` : '');
                        lyricsContainer.appendChild(p);
                    }
                });
                // ▼▼▼ 修复：将歌词也同步赋予悬浮小窗 ▼▼▼
                const wLyricEl = document.querySelector('#widget-lyrics-container p');
                if (this.currentLyrics.length > 0) {
                    if (lyricsContainer.firstChild) lyricsContainer.firstChild.classList.add('active'); 
                    if (snippetEl) snippetEl.textContent = this.currentLyrics[0].text;
                    if (wLyricEl) wLyricEl.textContent = this.currentLyrics[0].text; // 同步给悬浮窗
                } else {
                    lyricsContainer.innerHTML = '<p>暂无滚动歌词</p>';
                    if (snippetEl) snippetEl.textContent = "未找到时间轴";
                    if (wLyricEl) wLyricEl.textContent = "未找到时间轴";
                }
            } else {
                const wLyricEl = document.querySelector('#widget-lyrics-container p');
                lyricsContainer.innerHTML = '<p>纯音乐，请欣赏</p>';
                if (snippetEl) snippetEl.textContent = "纯音乐，请欣赏";
                if (wLyricEl) wLyricEl.textContent = "纯音乐，请欣赏";
            }
        }
    },

    // ▼▼▼ [新增] 播放特定索引的歌曲（封装统一逻辑） ▼▼▼
    async playSongAtIndex(index) {
        this.isSilenceTrack = false;
        if (isNativeRuntime()) {
            stopNativeKeepAlive().catch(error => console.warn('[Music] 原生后台保活停止失败:', error));
        }
        if (this.playlist.length === 0) return;
        if (index < 0) index = this.playlist.length - 1;
        if (index >= this.playlist.length) index = 0;
        
        this.currentIndex = index;
        const song = this.playlist[index];
        if (song && !song.src && song.title && typeof this.searchAndImportNeteaseSong === 'function') {
            try {
                if (typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`正在查找: ${song.title}`, 'info');
                const fetched = await this.searchAndImportNeteaseSong(`${song.title} ${song.artist || ''}`, {
                    appendToCurrentPlaylist: false,
                    persistToLibrary: false
                });
                if (fetched && fetched.song && fetched.song.src) {
                    Object.assign(song, fetched.song);
                } else {
                    if (typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`暂时无法播放: ${song.title}`, 'warning');
                    return;
                }
            } catch (error) {
                console.error('临时查找歌单歌曲失败', error);
                return;
            }
        }
        
        // ▼▼▼ [核心修复] 1. 老歌曲自动救援计划 (按歌名歌手比对找回丢失的ID) ▼▼▼
        if (!song.neteaseId && song.src && (song.src.includes('126.net') || song.src.includes('163.com'))) {
            try {
                if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`正在自动修复老歌曲...`, 'info');
                const getCookieParam = () => { const c = localStorage.getItem('netease_cookie'); return c ? `&cookie=${encodeURIComponent(c)}` : ''; };
                // 后台偷偷按名字重新搜索
                const searchRes = await fetch(`${NETEASE_API_BASE_URL}/search?keywords=${encodeURIComponent(song.title + ' ' + song.artist)}&limit=1&timestamp=${Date.now()}${getCookieParam()}`);
                const searchData = await searchRes.json();
                if (searchData.code === 200 && searchData.result.songs && searchData.result.songs.length > 0) {
                    song.neteaseId = searchData.result.songs[0].id; // 找回遗失的身份证ID
                    // 永久写入数据库，以后这首歌再也不需要救援了
                    await LocalMusicDB.updateSong(song.title, song.artist, { neteaseId: song.neteaseId });
                    // 同步内存中的全局曲库
                    const gSong = this.globalPlaylist.find(s => s.title === song.title && s.artist === song.artist);
                    if (gSong) gSong.neteaseId = song.neteaseId;
                }
            } catch(e) { console.error("老歌曲救援失败", e); }
        }

        // ▼▼▼ [核心修复] 2. 拿着ID去换取绝对不会过期的最新播放链接 ▼▼▼
        if (song.neteaseId) {
            try {
                const getCookieParam = () => { const c = localStorage.getItem('netease_cookie'); return c ? `&cookie=${encodeURIComponent(c)}` : ''; };
                const urlRes = await fetch(`${NETEASE_API_BASE_URL}/song/url/v1?id=${song.neteaseId}&level=exhigh&timestamp=${Date.now()}${getCookieParam()}`);
                const urlData = await urlRes.json();
                if (urlData.code === 200 && urlData.data && urlData.data[0] && urlData.data[0].url) {
                    song.src = this.normalizeAudioSource(urlData.data[0].url); // APK 将网易明文音频安全升级为 HTTPS
                    const gSong = this.globalPlaylist.find(s => s.title === song.title && s.artist === song.artist);
                    if (gSong) gSong.src = song.src;
                }
            } catch(e) { console.error("刷新网易云链接失败", e); }
        }
        // ▲▲▲ 修复结束 ▲▲▲

        this.playTrack(song.title, song.artist, song.cover, song.src, song.lyric);
        this.highlightCurrentSong();
    },

    // ▼▼▼ [新增] 上一首 / 下一首逻辑 ▼▼▼
    // ▼▼▼ 修改 playNext 和 playPrev，加入疯狂切歌检测 ▼▼▼
     playNext(isAuto = false) {
        if (this.playlist.length === 0) return;
          if (this.isSilenceTrack) {
            this.playSongAtIndex(0);
            return;
        }
        // 疯狂切歌检测逻辑
        if (this.currentListeningChar && !isAuto) {
            this.skipCounter++;
            clearTimeout(this.skipTimer);
            if (this.skipCounter >= 3) {
                this.sendHiddenMusicEvent('用户在短时间内频繁切歌，似乎有些焦躁或找不到想听的歌。');
                this.skipCounter = 0; // 触发后清零
            } else {
                this.sendHiddenMusicEvent('用户手动切换了下一首歌。');
            }
            this.skipTimer = setTimeout(() => { this.skipCounter = 0; }, 8000); // 8秒内切3次算频繁
        }

        if (this.playMode === 'random') {
            this.currentIndex = Math.floor(Math.random() * this.playlist.length);
        } else {
            this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
        }
        this.playSongAtIndex(this.currentIndex);
    },
    
    playPrev() {
        if (this.playlist.length === 0) return;
        if (this.isSilenceTrack) {
            this.playSongAtIndex(0);
            return;
        }
        if (this.currentListeningChar) {
            this.sendHiddenMusicEvent('用户手动切换回了上一首歌。');
        }

        if (this.playMode === 'random') {
            this.currentIndex = Math.floor(Math.random() * this.playlist.length);
        } else {
            this.currentIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        }
        this.playSongAtIndex(this.currentIndex);
    },
    // ▲▲▲ 修改结束 ▲▲▲

    // ▼▼▼ [新增] 高亮当前播放项及更新列表数量 ▼▼▼
    highlightCurrentSong() {
        const tabSongsList = document.getElementById('tab-songs');
        if (tabSongsList) {
            // ▼▼▼ 过滤静音卡片，单独处理高亮，防止错位 ▼▼▼
            const realSongs = Array.from(tabSongsList.children).filter(el => el.id !== 'silence-track-card');
            realSongs.forEach((el, idx) => {
                if (idx === this.currentIndex && !this.isSilenceTrack) el.classList.add('playing');
                else el.classList.remove('playing');
            });
            const silenceCard = document.getElementById('silence-track-card');
            if (silenceCard) {
                if (this.isSilenceTrack) silenceCard.classList.add('playing');
                else silenceCard.classList.remove('playing');
            }
        }
        const drawerList = document.querySelector('#music-playlist-drawer .drawer-scroll-list');

        if (drawerList) {
            Array.from(drawerList.children).forEach((el, idx) => {
                if (idx === this.currentIndex) {
                    el.classList.add('playing');
                    if (!el.querySelector('.playing-icon')) {
                        el.innerHTML += `
                            <div class="playing-icon animated-eq">
                                <span></span><span></span><span></span><span></span>
                            </div>
                        `;
                    }
                } else {
                    el.classList.remove('playing');
                    const icon = el.querySelector('.playing-icon');
                    if (icon) icon.remove();
                }
            });
        }
        const countSpan = document.querySelectorAll('#play-mode-text .count');
        countSpan.forEach(span => span.innerHTML = `(${this.playlist.length})`);
    },
    async saveSongToLocal(title, artist, cover, src, lyric, audioBlob = null) {
        // 【统一存储】无论是真实的音频文件，还是 URL 网络直链，统统存入大容量数据库 IndexedDB
        // 因为即使 URL 不占空间，上传的封面图片(Base64)也很大，旧方法会很快把 LocalStorage 撑爆
        try {
            await LocalMusicDB.saveSong({ 
                title, 
                artist, 
                cover, 
                src: audioBlob ? null : src, // 如果有实体文件，就不存URL
                audioBlob, 
                lyric 
            });
        } catch (e) {
            console.error('保存音乐失败', e);
        }
    },

    renderSongToDOM(title, artist, cover, src, lyric) {
        // ▼▼▼ [新增] 首次添加真实歌曲时，一键清空HTML里的演示占位内容 ▼▼▼
        if (!this.hasClearedPlaceholder) {
            const tabSongsList = document.getElementById('tab-songs');
            const drawerList = document.querySelector('#music-playlist-drawer .drawer-scroll-list');
            if (tabSongsList) tabSongsList.innerHTML = '';
            if (drawerList) drawerList.innerHTML = '';
            this.hasClearedPlaceholder = true;
            this.renderSilenceCard();
        }
        // ▲▲▲ 新增结束 ▲▲▲

          // 1. 渲染到“我的歌曲”列表
        const tabSongsList = document.getElementById('tab-songs');
        if (tabSongsList) {

            // ▼▼▼ 排除静音卡片 ▼▼▼
            const currentCount = tabSongsList.querySelectorAll('.song-list-item:not(#silence-track-card)').length;
            const newIndex = currentCount < 9 ? `0${currentCount + 1}` : `${currentCount + 1}`;

            const newSongEl = document.createElement('div');
            newSongEl.className = 'song-list-item';
            newSongEl.innerHTML = `
                <div class="song-index" style="color:#d43c33;">${newIndex}</div>
                <div class="song-info">
                  <div class="s-title">${title}</div>
                  <div class="s-artist">${artist}</div>
                </div>
                <button class="song-more">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                </button>
            `;
             const moreBtn = newSongEl.querySelector('.song-more');
            if (moreBtn) {
                moreBtn.onclick = (e) => {
                    e.stopPropagation(); // 【关键】阻止事件冒泡，防止误触歌曲播放
                    this.showSongActionMenu(e, title, artist, cover, src, lyric, newSongEl);
                };
            }
                  // ▼▼▼ [修正] 在首页点击单曲时，确保播放队列切回“全局歌曲”并刷新抽屉 ▼▼▼
            newSongEl.onclick = () => {
                if (this.playlist !== this.globalPlaylist) {
                    this.playlist = [...this.globalPlaylist];
                    this.updatePlaylistDrawer(); 
                }
                // ▼▼▼ 排除静音卡片和展开按钮获取正确的索引 ▼▼▼
                const realSongs = Array.from(tabSongsList.children).filter(el => el.classList.contains('song-list-item') && el.id !== 'silence-track-card');
                const idx = realSongs.indexOf(newSongEl);
                this.playSongAtIndex(idx);
            };

// ▼▼▼ 在这里 [新增] 本地歌曲超过20首折叠逻辑 ▼▼▼
            let toggleBtn = document.getElementById('songs-toggle-btn');
            const isExpanded = toggleBtn ? toggleBtn.dataset.expanded === 'true' : false;
            // 超过20首且当前未展开时，隐藏新加入的歌曲
            if (currentCount >= 20 && !isExpanded) {
                newSongEl.style.display = 'none';
            }
            tabSongsList.appendChild(newSongEl);

            // 当加上这首歌总数超过20时，确保底部有展开按钮
            if (currentCount + 1 > 20) {
                if (!toggleBtn) {
                    toggleBtn = document.createElement('div');
                    toggleBtn.id = 'songs-toggle-btn';
                    toggleBtn.style.cssText = 'text-align: center; padding: 15px; color: #888; font-size: 13px; cursor: pointer; width: 100%;';
                    toggleBtn.textContent = '展开全部歌曲 ▼';
                    toggleBtn.dataset.expanded = 'false';
                    toggleBtn.onclick = () => {
                        const exp = toggleBtn.dataset.expanded === 'true';
                        toggleBtn.dataset.expanded = !exp;
                        toggleBtn.textContent = !exp ? '收起歌曲 ▲' : '展开全部歌曲 ▼';
                        const items = tabSongsList.querySelectorAll('.song-list-item:not(#silence-track-card)');
                        items.forEach((item, i) => {
                            if (i >= 20) item.style.display = !exp ? '' : 'none';
                        });
                    };
                }
                tabSongsList.appendChild(toggleBtn); // 保证按钮永远被挤到最下面
            }
// ▲▲▲ 新增结束 ▲▲▲
        }

        // 2. 渲染到播放列表抽屉

        const drawerList = document.querySelector('#music-playlist-drawer .drawer-scroll-list');
        if (drawerList) {
            const newDrawerSongEl = document.createElement('div');
            newDrawerSongEl.className = 'drawer-song-item';
            newDrawerSongEl.innerHTML = `
                <div class="song-info">
                  <span class="name">${title}</span>
                  <span class="artist">- ${artist}</span>
                </div>
            `;
            // ▼▼▼ 修改：点击通过索引播放 ▼▼▼
            newDrawerSongEl.onclick = () => {
                const idx = Array.from(drawerList.children).indexOf(newDrawerSongEl);
                this.playSongAtIndex(idx);
            };
            drawerList.appendChild(newDrawerSongEl);
        }
    },

    // ▼▼▼ 【新增】整个音乐页面的背景设置逻辑 ▼▼▼
    bindPageBgSettings() {
        const modal = document.getElementById('music-page-bg-modal');
        const closeBtn = document.getElementById('close-music-page-bg-btn');
        const saveBtn = document.getElementById('save-music-page-bg-btn');
        const layoutContainer = document.getElementById('music-layout-container');
        
        const alphaInput = document.getElementById('music-page-bg-alpha');
        const alphaVal = document.getElementById('val-page-bg-alpha');
        const bgInput = document.getElementById('music-page-bg-input');
        const resetBgBtn = document.getElementById('reset-music-page-bg-btn');

        if (!modal || !layoutContainer) return;

        // 【重构】保存到 IndexedDB 数据库
        const saveAllData = async () => {
            const dataToSave = {
                bgAlpha: alphaInput.value,
                bgImage: layoutContainer.dataset.bgImage || ''
            };
            try {
                const { db } = await import('../state.js');
                await db.appData.put({ key: 'music_page_global_bg_data', value: dataToSave });
            } catch (e) {
                console.error("保存页面背景配置失败", e);
            }
        };

        // ▼▼▼ 将这里的函数替换掉 ▼▼▼
        const updatePageBackground = () => {

            const alpha = alphaInput.value / 100;
            const currentBgImage = layoutContainer.dataset.bgImage || ''; 
            const detailView = document.getElementById('music-group-detail-view'); // 抓取分组子页面
            
            if (currentBgImage) {
                // fixed 属性让背景图不会随页面滚动，拥有非常高级的视差感
                const bgStyle = `linear-gradient(rgba(255,255,255,${alpha}), rgba(255,255,255,${alpha})), url('${currentBgImage}') center/cover fixed no-repeat`;
                layoutContainer.style.background = bgStyle;
                if (detailView) detailView.style.background = bgStyle; // 同步背景给子页面
            } else {
                layoutContainer.style.background = '#FAFAFA'; // 没图时恢复极简纯色底
                   if (detailView) detailView.style.background = '#FAFAFA'; // 同步清除子页面的背景
            }
        };
        // ▲▲▲ 替换结束 ▲▲▲


        // 【重构】初始化加载数据与无缝迁移
        const loadSavedData = async () => {
            try {
                const { db } = await import('../state.js');
                let data = null;
                const dbRecord = await db.appData.get('music_page_global_bg_data');
                
                if (dbRecord) {
                    data = dbRecord.value; // 如果新数据库里有，直接用
                } else {
                    // 如果新库没有，去老旧的 localStorage 里找（给老用户搬家）
                    const savedStr = localStorage.getItem('music_page_global_bg_data');
                    if (savedStr) {
                        data = JSON.parse(savedStr);
                        await db.appData.put({ key: 'music_page_global_bg_data', value: data }); // 存入新库
                        localStorage.removeItem('music_page_global_bg_data'); // 清理旧垃圾释放空间
                    }
                }

                if (data) {
                    if(data.bgAlpha) { alphaInput.value = data.bgAlpha; alphaVal.textContent = data.bgAlpha; }
                    if(data.bgImage) layoutContainer.dataset.bgImage = data.bgImage;
                }
            } catch (e) { console.error("读取页面背景配置失败", e); }
            updatePageBackground();
        };

        loadSavedData();

        // 弹窗关闭函数

        const closeModal = () => { 
            modal.style.display = 'none'; 
            modal.style.opacity = '0';
            modal.style.visibility = 'hidden';
            modal.style.pointerEvents = 'none';
            modal.classList.remove('active');
            saveAllData(); 
        };

        closeBtn?.addEventListener('click', closeModal);
        saveBtn?.addEventListener('click', closeModal);

        // 监听滑块
        alphaInput?.addEventListener('input', (e) => { 
            alphaVal.textContent = e.target.value; 
            updatePageBackground(); 
            saveAllData(); 
        });
        // 监听图片上传
        bgInput?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                layoutContainer.dataset.bgImage = compressedBase64;
                updatePageBackground();
                saveAllData();
            }
        });
        // 清除背景
        resetBgBtn?.addEventListener('click', () => {

            layoutContainer.dataset.bgImage = '';
            bgInput.value = '';
            updatePageBackground();
            saveAllData();
        });
    },

    // ▼▼▼ [新增] 播放器全屏界面的背景设置逻辑 ▼▼▼
    bindFullscreenBgSettings() {
        const modal = document.getElementById('music-fullscreen-bg-modal');
        const moreBtn = document.getElementById('music-player-more-btn');
        const closeBtn = document.getElementById('close-music-fullscreen-bg-btn');
        const saveBtn = document.getElementById('save-music-fullscreen-bg-btn');
        const fullscreenLayer = document.getElementById('music-fullscreen-layer');
        
        const alphaInput = document.getElementById('music-fullscreen-bg-alpha');
        const alphaVal = document.getElementById('val-fullscreen-bg-alpha');
        const bgInput = document.getElementById('music-fullscreen-bg-input');
        const resetBgBtn = document.getElementById('reset-music-fullscreen-bg-btn');
        if (!modal || !fullscreenLayer || !moreBtn) return;

        // 【重构】保存到 IndexedDB 数据库
        const saveAllData = async () => {
            const dataToSave = {
                bgAlpha: alphaInput.value,
                bgImage: fullscreenLayer.dataset.bgImage || ''
            };
            try {
                const { db } = await import('../state.js');
                await db.appData.put({ key: 'music_fullscreen_global_bg_data', value: dataToSave });
            } catch (e) {
                console.error("保存全屏背景配置失败", e);
            }
        };

        const updateFullscreenBackground = () => {

            const alpha = alphaInput.value / 100;
            const currentBgImage = fullscreenLayer.dataset.bgImage || ''; 
            
            if (currentBgImage) {
                // 原默认背景是 #FAFAFA，我们用 rgba(250,250,250, alpha) 做遮罩，使得即使换了图片，上面的文字和UI也能看清楚
                const bgStyle = `linear-gradient(rgba(250,250,250,${alpha}), rgba(250,250,250,${alpha})), url('${currentBgImage}') center/cover fixed no-repeat`;
                fullscreenLayer.style.background = bgStyle;
                } else {
                fullscreenLayer.style.background = '#FAFAFA'; 
            }
        };

        // 【重构】初始化加载数据与无缝迁移
        const loadSavedData = async () => {
            try {
                const { db } = await import('../state.js');
                let data = null;
                const dbRecord = await db.appData.get('music_fullscreen_global_bg_data');
                
                if (dbRecord) {
                    data = dbRecord.value;
                } else {
                    const savedStr = localStorage.getItem('music_fullscreen_global_bg_data');
                    if (savedStr) {
                        data = JSON.parse(savedStr);
                        await db.appData.put({ key: 'music_fullscreen_global_bg_data', value: data });
                        localStorage.removeItem('music_fullscreen_global_bg_data');
                    }
                }

                if (data) {
                    if(data.bgAlpha) { alphaInput.value = data.bgAlpha; alphaVal.textContent = data.bgAlpha; }
                    if(data.bgImage) fullscreenLayer.dataset.bgImage = data.bgImage;
                }
            } catch (e) { console.error("读取播放器背景配置失败", e); }
            updateFullscreenBackground();
        };

        loadSavedData();

        // 弹窗出现与收起

        const openModal = (e) => {
            e.stopPropagation();
            modal.style.display = 'flex';
            modal.style.opacity = '1';
            modal.style.visibility = 'visible';
            modal.style.pointerEvents = 'auto';
            modal.classList.add('active');
        };

        const closeModal = () => { 
            modal.style.display = 'none'; 
            modal.style.opacity = '0';
            modal.style.visibility = 'hidden';
            modal.style.pointerEvents = 'none';
            modal.classList.remove('active');
            saveAllData(); 
        };

        moreBtn.addEventListener('click', openModal);
        closeBtn?.addEventListener('click', closeModal);
        saveBtn?.addEventListener('click', closeModal);

        // 调整透明度滑块
        alphaInput?.addEventListener('input', (e) => { 
            alphaVal.textContent = e.target.value; 
            updateFullscreenBackground(); 
            saveAllData(); 
        });
        // 选图并生成Base64
        bgInput?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                fullscreenLayer.dataset.bgImage = compressedBase64;
                updateFullscreenBackground();
                saveAllData();
            }
        });

        // 还原默认无图状态
        resetBgBtn?.addEventListener('click', () => {

            fullscreenLayer.dataset.bgImage = '';
            bgInput.value = '';
            updateFullscreenBackground();
            saveAllData();
        });
    },
    // ▲▲▲ 新增结束 ▲▲▲

    bindProfileSettings() {
        const moreBtn = document.getElementById('profile-card-more-btn');
        const modal = document.getElementById('music-profile-settings-modal');

        const closeBtn = document.getElementById('close-music-profile-settings-btn');
        const saveBtn = document.getElementById('save-music-profile-settings-btn');
        const cardEl = document.getElementById('premium-profile-card');
        const metaBarEl = cardEl?.querySelector('.profile-meta-bar');

        const alphaInput = document.getElementById('music-profile-card-alpha');
        const alphaVal = document.getElementById('val-profile-card-alpha');
        const metaColorInput = document.getElementById('music-profile-meta-color');
        const metaAlphaInput = document.getElementById('music-profile-meta-alpha');
        const metaAlphaVal = document.getElementById('val-profile-meta-alpha');
        const bgInput = document.getElementById('music-profile-bg-input');
        const resetBgBtn = document.getElementById('reset-music-profile-bg-btn');
        const resetMetaColorBtn = document.getElementById('reset-music-profile-meta-color-btn');

        // 新增的自定义元素
        const avatarImg = document.getElementById('music-profile-avatar-img');
        const avatarUpload = document.getElementById('music-avatar-upload');
        const nameEl = document.getElementById('music-profile-name');
        const bioEl = document.getElementById('music-profile-bio');
        if (!moreBtn || !modal) return;

        // 【重构】保存数据到 IndexedDB
        const saveAllData = async () => {
            const dataToSave = {
                cardAlpha: alphaInput.value,
                bgImage: cardEl.dataset.bgImage || '',
                metaColor: metaColorInput.value,
                metaAlpha: metaAlphaInput.value,
                avatarSrc: avatarImg ? avatarImg.src : '',
                profileName: nameEl ? nameEl.innerText : '',
                profileBio: bioEl ? bioEl.innerText : ''
            };
            try {
                const { db } = await import('../state.js');
                await db.appData.put({ key: 'music_profile_custom_data', value: dataToSave });
            } catch (e) {
                console.error("保存音乐资料卡配置失败", e);
            }
        };

        // 辅助函数：将 Hex 转 RGBA

        const hexToRgb = (hex) => {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '255, 255, 255';
        };

        // 刷新卡片背景UI
        const updateCardBackground = () => {
            if(!cardEl) return;
            const alpha = alphaInput.value / 100;
            const currentBgImage = cardEl.dataset.bgImage || ''; 
            if (currentBgImage) {
                cardEl.style.background = `linear-gradient(rgba(255,255,255,${alpha}), rgba(255,255,255,${alpha})), url('${currentBgImage}') center/cover no-repeat`;
            } else {
                cardEl.style.background = `rgba(255, 255, 255, ${alpha})`;
            }
        };

        // 刷新数据栏UI
        const updateMetaBar = () => {
            if (!metaBarEl) return;
            const rgb = hexToRgb(metaColorInput.value);
            const alpha = metaAlphaInput.value / 100;
            metaBarEl.style.background = `rgba(${rgb}, ${alpha})`;
        };

        // 【重构】初始化加载数据与无缝迁移
        const loadSavedData = async () => {
            try {
                const { db } = await import('../state.js');
                let data = null;
                const dbRecord = await db.appData.get('music_profile_custom_data');
                
                if (dbRecord) {
                    data = dbRecord.value;
                } else {
                    const savedStr = localStorage.getItem('music_profile_custom_data');
                    if (savedStr) {
                        data = JSON.parse(savedStr);
                        await db.appData.put({ key: 'music_profile_custom_data', value: data });
                        localStorage.removeItem('music_profile_custom_data');
                    }
                }

                if (data) {
                    // 恢复滑块和颜色选择器数值
                    if(data.cardAlpha) { alphaInput.value = data.cardAlpha; alphaVal.textContent = data.cardAlpha; }
                    if(data.metaColor) metaColorInput.value = data.metaColor;
                    if(data.metaAlpha) { metaAlphaInput.value = data.metaAlpha; metaAlphaVal.textContent = data.metaAlpha; }
                    // 恢复背景图
                    if(data.bgImage) cardEl.dataset.bgImage = data.bgImage;
                    // 恢复头像
                    if(data.avatarSrc && avatarImg) avatarImg.src = data.avatarSrc;
                    // 恢复文字
                    if(data.profileName && nameEl) nameEl.innerText = data.profileName;
                    if(data.profileBio && bioEl) bioEl.innerText = data.profileBio;
                }
            } catch (e) { console.error("读取音乐配置失败", e); }
            
            updateCardBackground();
            updateMetaBar();
        };

        // 页面打开时，先加载一次数据
        loadSavedData();

        // 弹窗开关逻辑
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            modal.style.display = 'flex';
            modal.style.opacity = '1';
            modal.style.visibility = 'visible';
            modal.style.pointerEvents = 'auto';
            modal.classList.add('active');
        });
        const closeModal = () => { 
            modal.style.display = 'none'; 
            modal.style.opacity = '0';
            modal.style.visibility = 'hidden';
            modal.style.pointerEvents = 'none';
            modal.classList.remove('active');
            saveAllData(); // 关闭时保存一次
        };
        closeBtn?.addEventListener('click', closeModal);
        saveBtn?.addEventListener('click', closeModal);

        // 监听UI调整并保存
        alphaInput?.addEventListener('input', (e) => { alphaVal.textContent = e.target.value; updateCardBackground(); saveAllData(); });
        metaColorInput?.addEventListener('input', () => { updateMetaBar(); saveAllData(); });
        metaAlphaInput?.addEventListener('input', (e) => { metaAlphaVal.textContent = e.target.value; updateMetaBar(); saveAllData(); });
        // 背景图上传
        bgInput?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file && cardEl) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                cardEl.dataset.bgImage = compressedBase64;
                updateCardBackground();
                saveAllData();
            }
        });

        // 背景重置
        resetBgBtn?.addEventListener('click', () => {

            if (cardEl) cardEl.dataset.bgImage = '';
            bgInput.value = '';
            updateCardBackground();
            saveAllData();
        });

        // 颜色重置
        resetMetaColorBtn?.addEventListener('click', () => {
            metaColorInput.value = "#ffffff";
            metaAlphaInput.value = "60";
            metaAlphaVal.textContent = "60";
            updateMetaBar();
            saveAllData();
        });
        // 【新增】监听头像上传并保存
        avatarUpload?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file && avatarImg) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                avatarImg.src = compressedBase64;
                saveAllData();
            }
        });

        // 【新增】监听打字修改（失去焦点时保存）
        nameEl?.addEventListener('blur', saveAllData);

        bioEl?.addEventListener('blur', saveAllData);
 /* 原代码前两行： */
    },
    bindEvents() {
        // === 新增：右上角加号菜单的交互逻辑 ===
        const addBtn = document.getElementById('music-add-btn');
        const actionMenu = document.getElementById('music-action-menu');

        if (addBtn && actionMenu) {
   // 封装一个收起菜单的函数
            const closeActionMenu = () => {
                actionMenu.style.display = 'none';
                actionMenu.style.opacity = '0';
                actionMenu.style.visibility = 'hidden';
                actionMenu.style.pointerEvents = 'none';
                actionMenu.classList.remove('active');
            };
            // 1. 点击加号显示/隐藏菜单
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止点击事件乱跑
                // 检查当前是否显示
                if (actionMenu.style.opacity === '1') {
                    closeActionMenu();
                } else {
                    // 强制覆盖 CSS 的透明度设置，让它绝对可见
                    actionMenu.style.display = 'flex';
                    actionMenu.style.opacity = '1';
                    actionMenu.style.visibility = 'visible';
                    actionMenu.style.pointerEvents = 'auto';
                    actionMenu.classList.add('active');
                }
            });
            // 2. 点击屏幕其他空白地方，自动收起菜单
            document.addEventListener('click', (e) => {
                if (!actionMenu.contains(e.target) && e.target !== addBtn) {
                    closeActionMenu();
                }
            });
            // 3. 给三个选项绑定占位功能 (收起菜单并弹出顶部提示)
          document.getElementById('music-menu-change-bg')?.addEventListener('click', () => {
                closeActionMenu();
                const bgModal = document.getElementById('music-page-bg-modal');
                if(bgModal) {
                    bgModal.style.display = 'flex';
                    bgModal.style.opacity = '1';
                    bgModal.style.visibility = 'visible';
                    bgModal.style.pointerEvents = 'auto';
                    bgModal.classList.add('active');
                }
            });
                   // ▼▼▼ 【重构】绑定上传歌曲面板的完整交互逻辑 ▼▼▼
            document.getElementById('music-menu-upload-song')?.addEventListener('click', () => {
                closeActionMenu(); // 收起右上角的加号菜单
                const uploadModal = document.getElementById('music-upload-modal');
                if (uploadModal) {
                    uploadModal.classList.add('active'); // 触发CSS动画滑出面板
                }
            });

            const uploadModal = document.getElementById('music-upload-modal');
            if (uploadModal) {
                const closeBtn = document.getElementById('close-music-upload-btn');
                const confirmBtn = document.getElementById('confirm-upload-music-btn');
                
                // Tab 相关
                const tabFile = document.getElementById('tab-upload-file');
                const tabUrl = document.getElementById('tab-upload-url');
                const viewFile = document.getElementById('view-upload-file');
                const viewUrl = document.getElementById('view-upload-url');
                // 输入框相关
                const titleInput = document.getElementById('music-title-input');
                const artistInput = document.getElementById('music-artist-input');
                const coverUploadInput = document.getElementById('music-cover-upload');
                const coverPreviewImg = document.getElementById('music-cover-preview');
                const coverPlaceholder = document.getElementById('music-cover-placeholder');
                
                // ▼▼▼ [升级版] 更强大的智能解析歌词逻辑 ▼▼▼
                const lyricTextInput = document.getElementById('music-lyric-text-input');
                const lyricStatus = document.getElementById('lyric-format-status');
                
                if (lyricTextInput) {
                    lyricTextInput.addEventListener('paste', () => {
                        setTimeout(() => {
                            let val = lyricTextInput.value.trim();
                            if (!val) return;
                            let extractedLyric = val; // 默认保留原文本，防止瞎删
                            try { 
                                // 1. 尝试解析标准 JSON 
                                const jsonObj = JSON.parse(val);
                                if (jsonObj.lrc && jsonObj.lrc.lyric) {
                                    extractedLyric = jsonObj.lrc.lyric;
                                    // ▼▼▼ 把翻译像写文章一样拼在下面，而不是变成乱码JSON ▼▼▼
                                    if (jsonObj.tlyric && jsonObj.tlyric.lyric) {
                                        extractedLyric += '\n\n---翻译---\n\n' + jsonObj.tlyric.lyric;
                                    }
                                }
                                else if (jsonObj.lyric) extractedLyric = jsonObj.lyric;
                            } catch (err) { 

                                // 2. 如果 JSON 报错（比如复制不完整），用更强力的正则硬抠
                                const match = val.match(/"lyric"\s*:\s*"([\s\S]*?)"(,|})/);
                                if (match && match[1]) {
                                    extractedLyric = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                                } else if (val.includes('\\n')) {
                                    // 3. 处理带有字面量 \n 的纯文本
                                    extractedLyric = val.replace(/\\n/g, '\n');
                                }
                            }
                              // 最终检查：只要包含时间轴 [00: 就说明提纯成功
                            if (extractedLyric && extractedLyric.includes('[00:')) {
                                lyricTextInput.value = extractedLyric;
                                if (lyricStatus) {
                                    lyricStatus.style.opacity = '1';
                                    setTimeout(() => lyricStatus.style.opacity = '0', 3000);
                                }
                            }
                        }, 50);
                    });
                }
                // ▲▲▲ 升级结束 ▲▲▲

                // ▼▼▼ [新增] 一键提取歌词核心逻辑 ▼▼▼
                const autoFetchBtn = document.getElementById('auto-fetch-lyric-btn');
                if (autoFetchBtn) {
                    autoFetchBtn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        const urlInput = document.getElementById('music-url-input');
                        if (!urlInput || !urlInput.value) {
                            alert('请先在上方输入网易云音乐直链！');
                            return;
                        }
                        // 从链接里抠出歌曲的 ID
                        const match = urlInput.value.match(/id=(\d+)/);
                        if (!match || !match[1]) {
                            alert('链接中找不到歌曲ID，请确认链接中包含 id=xxx');
                            return;
                        }
                        
                        const songId = match[1];
                        const prevText = autoFetchBtn.textContent;
                         autoFetchBtn.textContent = '提取中...';
                        autoFetchBtn.disabled = true;

                        try {
                            const apiUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
                            
                            // ▼▼▼ 【核心升级】3路代理节点自动路由，防堵车防报错 ▼▼▼
                            const proxyNodes = [
                                `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`, // 极速节点
                                `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`,       // 稳定节点
                                `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`                     // 兜底节点
                            ];

                            let realData = null;
                            for (let proxy of proxyNodes) {
                                try {
                                    // 设定 5 秒超时，一旦卡住立刻换下一条路
                                    const controller = new AbortController();
                                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                                    const response = await fetch(proxy, { signal: controller.signal });
                                    clearTimeout(timeoutId);

                                    if (response.ok) {
                                        realData = await response.json();
                                        break; // 成功拿到数据，立刻跳出循环
                                    }
                                } catch (e) {
                                    console.log("当前节点拥堵，自动切换备用节点...");
                                }
                            }

                            if (!realData) throw new Error("所有节点均被挤爆，拉取失败");
                            // ▲▲▲ 升级结束 ▲▲▲

                            let extractedLyric = '';
                            if (realData.lrc && realData.lrc.lyric) {
                                extractedLyric = realData.lrc.lyric;

                                // 如果有翻译，像写文章一样拼在下面
                                if (realData.tlyric && realData.tlyric.lyric) {
                                    extractedLyric += '\n\n---翻译---\n\n' + realData.tlyric.lyric;
                                }
                            }
                            
                            if (extractedLyric && extractedLyric.includes('[00:')) {
                                if (lyricTextInput) lyricTextInput.value = extractedLyric;
                                if (lyricStatus) {
                                    lyricStatus.textContent = '✨ 提取成功';
                                    lyricStatus.style.opacity = '1';
                                    setTimeout(() => lyricStatus.style.opacity = '0', 3000);
                                }
                            } else {
                                alert('提取失败：该歌曲可能没有提供滚动歌词，或是纯音乐。');
                            }
                        } catch (err) {
                            console.error('一键提取歌词失败', err);
                            alert('网络请求失败，请稍后再试，或继续使用手动复制粘贴。');
                        } finally {
                            autoFetchBtn.textContent = prevText;
                            autoFetchBtn.disabled = false;
                        }
                    });
                }
                // ▲▲▲ 新增结束 ▲▲▲

                // 文件名显示
                const musicFileInput = document.getElementById('music-file-input');
                // ▼▼▼ [修复苹果 Safari 无法选中 MP3 的 Bug] ▼▼▼
                if (musicFileInput) {
                    musicFileInput.accept = "audio/*, audio/mpeg, .mp3, .wav, .m4a, .flac";
                }
                // ▲▲▲ 修复结束 ▲▲▲

                const lyricFileInput = document.getElementById('lyric-file-input');
                musicFileInput?.addEventListener('change', e => {
                    document.getElementById('music-file-name').textContent = e.target.files[0] ? e.target.files[0].name : "未选择文件";
                });
                lyricFileInput?.addEventListener('change', e => {
                    document.getElementById('lyric-file-name').textContent = e.target.files[0] ? e.target.files[0].name : "未选择文件";
                });

                // 关闭面板
                const closeUploadModal = () => uploadModal.classList.remove('active');
                closeBtn?.addEventListener('click', closeUploadModal);
                uploadModal.addEventListener('click', (e) => {
                    if (e.target === uploadModal) closeUploadModal(); 
                });

                // Tab 切换逻辑
                const switchTab = (activeBtn, inactiveBtn, activeView, inactiveView) => {
                    activeBtn.classList.add('active');
                    inactiveBtn.classList.remove('active');
                    activeView.style.display = 'flex';
                    inactiveView.style.display = 'none';
                };
                tabFile?.addEventListener('click', () => switchTab(tabFile, tabUrl, viewFile, viewUrl));
                tabUrl?.addEventListener('click', () => switchTab(tabUrl, tabFile, viewUrl, viewFile));
                // 封面图片预览
                let currentCoverBase64 = ''; 
                coverUploadInput?.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const compressedBase64 = await MusicPlayer.compressImage(file);
                        currentCoverBase64 = compressedBase64;
                        coverPreviewImg.src = currentCoverBase64;
                        coverPreviewImg.style.display = 'block';
                        coverPlaceholder.style.display = 'none';
                    }
                });
                // ★★★ 核心修复：确认添加并绑定播放逻辑 ★★★
                confirmBtn?.addEventListener('click', async () => {

                    const titleStr = titleInput.value.trim() || '未知歌曲';
                    const artistStr = artistInput.value.trim() || '未知歌手';
                    let finalAudioSrc = '';
                    let finalLyricText = '';
                    let finalAudioBlob = null; // [新增] 用于截获真实文件

                    // 判断是哪种上传模式
                    if (tabUrl.classList.contains('active')) {
                        // 网络直链模式
                        finalAudioSrc = document.getElementById('music-url-input').value.trim();
                        finalLyricText = lyricTextInput ? lyricTextInput.value.trim() : '';
                    } else {
                        // 本地文件模式
                        const audioFile = musicFileInput.files[0];
                        const lyricFile = lyricFileInput.files[0];
                        if (audioFile) {
                            finalAudioBlob = audioFile; // 保存文件实体
                            finalAudioSrc = URL.createObjectURL(audioFile); 
                        }
                        if (lyricFile) {
                            finalLyricText = await lyricFile.text(); 
                        }
                    }
                    if (!finalAudioSrc) {
                        alert("请提供音乐链接或上传音乐文件！");
                        return;
                    }
                    
                    // ▼▼▼ [修改] 添加歌曲同步进入全局播放列表 ▼▼▼
                    const songObj = { title: titleStr, artist: artistStr, cover: currentCoverBase64, src: finalAudioSrc, lyric: finalLyricText };
                   if (this.playlist !== this.globalPlaylist) {
                        this.playlist = [...this.globalPlaylist];
                    }
                    this.playlist.push(songObj);
                    this.globalPlaylist.push(songObj);

                    // 1. 渲染到列表
                    MusicPlayer.renderSongToDOM(titleStr, artistStr, currentCoverBase64, finalAudioSrc, finalLyricText);
                    
                    // 2. 永久保存 (带上文件实体)
                    MusicPlayer.saveSongToLocal(titleStr, artistStr, currentCoverBase64, finalAudioSrc, finalLyricText, finalAudioBlob);
                    
                // 3. 自动播放刚才添加的这首歌
                MusicPlayer.playSongAtIndex(this.playlist.length - 1);

                MusicPlayer.updateProfileStats(); // [新增] 加歌后刷新数量和等级

                if (typeof window.showDynamicIsland === 'function') {
                    window.showDynamicIsland(`《${titleStr}》已添加到列表`, 'success');
                }

                    // 清空输入框内容

                    titleInput.value = ''; artistInput.value = '';
                    if(document.getElementById('music-url-input')) document.getElementById('music-url-input').value = '';
                    if(lyricTextInput) lyricTextInput.value = '';
                    if(musicFileInput) musicFileInput.value = '';
                    if(lyricFileInput) lyricFileInput.value = '';
                    coverPreviewImg.style.display = 'none';
                    coverPlaceholder.style.display = 'flex';
                    currentCoverBase64 = '';
/* 原代码前两行： */
                    closeUploadModal();
                });
            }
            // ▼▼▼ [重构] 添加分组的真实交互逻辑 ▼▼▼
            document.getElementById('music-menu-add-group')?.addEventListener('click', () => {
                closeActionMenu(); // 收起右上角小菜单
                const groupModal = document.getElementById('music-add-group-modal');
                const songSelectionContainer = document.getElementById('music-group-song-selection');
                
                if (groupModal && songSelectionContainer) {
                    // 1. 动态读取当前曲库里的所有歌曲，生成复选框
                    songSelectionContainer.innerHTML = '';
                    if (this.playlist.length === 0) {
                        songSelectionContainer.innerHTML = '<div style="padding:15px; color:#999; font-size:12px; text-align:center;">当前曲库为空，请先添加一些歌曲吧</div>';
                    } else {
                        this.playlist.forEach((song, idx) => {
                            const item = document.createElement('label');
                            item.className = 'song-select-item';
                            // 【美化升级】：在选歌列表里加上每首歌的微型缩略图，更像真实的音乐软件
                            const defaultMiniCover = 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop&grayscale';
                            const finalCover = song.cover || defaultMiniCover;
                            
                            item.innerHTML = `
                                <input type="checkbox" value="${idx}">
                                <div style="width: 32px; height: 32px; border-radius: 6px; background-image: url('${finalCover}'); background-size: cover; background-position: center; flex-shrink: 0; margin-left: 5px;"></div>
                                <div class="s-info">
                                    <span class="s-name">${song.title}</span>
                                    <span class="s-artist">${song.artist}</span>
                                </div>
                            `;
                            songSelectionContainer.appendChild(item);
                        });
                    }
                    groupModal.classList.add('active'); // 弹出创建面板
                }
            });


            // 初始化【创建歌单面板】内的按钮交互
            const groupModal = document.getElementById('music-add-group-modal');
            if (groupModal) {
                const closeGroupBtn = document.getElementById('close-music-group-btn');
                const confirmGroupBtn = document.getElementById('confirm-add-music-group-btn');
                const coverInput = document.getElementById('music-group-cover-upload');
                const coverPreview = document.getElementById('music-group-cover-preview');
                const coverPlaceholder = document.getElementById('music-group-cover-placeholder');
                const nameInput = document.getElementById('music-group-name-input');
                const descInput = document.getElementById('music-group-desc-input');

                let currentGroupCover = '';

                // 还原表单的函数
                const closeGroupModal = () => {
                    groupModal.classList.remove('active');
                    nameInput.value = ''; descInput.value = '';
                    coverInput.value = ''; currentGroupCover = '';
                    coverPreview.style.display = 'none';
                    coverPlaceholder.style.display = 'flex';
                };

                closeGroupBtn?.addEventListener('click', closeGroupModal);
                groupModal.addEventListener('click', (e) => { if(e.target === groupModal) closeGroupModal(); });
                // 监听封面图片上传
                coverInput?.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (file) {
                        const compressedBase64 = await MusicPlayer.compressImage(file);
                        currentGroupCover = compressedBase64;
                        coverPreview.src = currentGroupCover;
                        coverPreview.style.display = 'block';
                        coverPlaceholder.style.display = 'none';
                /* 原代码前两行： */
                    }
                });
                // 点击确认保存

                // ▼▼▼ 修改：加上 async ▼▼▼
                confirmGroupBtn?.addEventListener('click', async () => {
                    const name = nameInput.value.trim();
                    if (!name) { alert("请输入歌单名称！"); return; }

                    // 【核心修复】：不要只存纯数字的索引，而是把用户打勾的“完整歌曲对象”都提取出来
                    // 这样以后不管你的曲库怎么删减排序，歌单里的歌永远不会错乱
                    const checkboxes = groupModal.querySelectorAll('input[type="checkbox"]:checked');
                    const selectedSongs = Array.from(checkboxes).map(cb => {
                        const idx = parseInt(cb.value);
                        return this.playlist[idx];
                    });
                    
                    // 【智能补全】：如果你没有手动上传歌单封面，自动用歌单里选中的第一首歌的封面当做分组封面
                    let finalGroupCover = currentGroupCover;
                    if (!finalGroupCover && selectedSongs.length > 0) {
                        finalGroupCover = selectedSongs[0].cover;
                    }

                    // 组装新歌单对象并存入
                    const newGroup = {
                        id: Date.now().toString(),
                        name: name,
                        desc: descInput.value.trim(),
                        cover: finalGroupCover, // 使用最终决定好的封面
                        songs: selectedSongs    // 存入完整实体歌曲数组
                    };

                    this.groups.push(newGroup);
                    // ▼▼▼ 修改：加上 await，等待大容量数据库保存完毕 ▼▼▼
                    await this.saveGroupsToLocal();

                    this.renderGroupsToDOM(); // 立刻刷新页面上的歌单列表

                    if(typeof window.showDynamicIsland === 'function') {
                        window.showDynamicIsland(`歌单《${name}》创建成功`, 'success');
                    }
                    closeGroupModal();
                });
                // ▲▲▲ 修改结束 ▲▲▲
            }
            // ▲▲▲ 修改结束 ▲▲▲
        }
/* 原代码后两行： */
                // === 新增：点击胶囊右侧列表图标，弹出歌曲列表抽屉 ===
        const playlistBtn = document.getElementById('mini-playlist-btn');

        const playlistDrawer = document.getElementById('music-playlist-drawer');
        const closePlaylistBtn = document.getElementById('close-playlist-btn');
        if (playlistBtn && playlistDrawer) {
            // 点击列表图标弹出
            playlistBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止触发进入黑胶全屏页面的点击事件
                playlistDrawer.classList.add('active');
            });
            // 点击弹窗右上角 X 关闭
            if (closePlaylistBtn) {
                closePlaylistBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    playlistDrawer.classList.remove('active');
                });
            }
            
            // ▼▼▼ [删除旧的 currentModeIndex 逻辑，替换为统一的模式和控件逻辑] ▼▼▼
            const prevBtn = document.getElementById('music-prev-btn');
            const nextBtn = document.getElementById('music-next-btn');
            const modeBtn = document.getElementById('music-mode-btn'); 
            const fullscreenPlaylistBtn = document.getElementById('fullscreen-playlist-btn');
            const modeToggleBtn = document.getElementById('play-mode-toggle-btn');
            
            // 绑定上一首 / 下一首
            prevBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.playPrev(); });
            nextBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.playNext(); });
            
            // 全屏页面的列表按钮也绑定弹出
            fullscreenPlaylistBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (playlistDrawer) playlistDrawer.classList.add('active');
            });

            // 统一模式切换函数
            const toggleMode = (e) => {
                e.stopPropagation();
                const modes = ['loop', 'single', 'random'];
                let idx = modes.indexOf(this.playMode);
                idx = (idx + 1) % modes.length;
                this.playMode = modes[idx];
                
                // 更新悬浮窗抽屉内的图标
                const drawerModeText = document.getElementById('play-mode-text');
                const loopIcon = playlistDrawer.querySelector('.loop-icon');
                const singleIcon = playlistDrawer.querySelector('.single-icon');
                const randomIcon = playlistDrawer.querySelector('.random-icon');
                
                if (loopIcon) loopIcon.style.display = 'none';
                if (singleIcon) singleIcon.style.display = 'none';
                if (randomIcon) randomIcon.style.display = 'none';
                
                if (this.playMode === 'loop') {
                    if(loopIcon) loopIcon.style.display = 'block';
                    if(drawerModeText) drawerModeText.innerHTML = `列表循环 <span class="count">(${this.playlist.length})</span>`;
                    if(modeBtn) modeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
                } else if (this.playMode === 'single') {
                    if(singleIcon) singleIcon.style.display = 'block';
                    if(drawerModeText) drawerModeText.innerHTML = `单曲循环 <span class="count">(${this.playlist.length})</span>`;
                    if(modeBtn) modeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path><text x="12" y="16" font-size="9" text-anchor="middle" stroke-width="0.5" fill="currentColor" font-family="sans-serif">1</text></svg>`;
                } else if (this.playMode === 'random') {
                    if(randomIcon) randomIcon.style.display = 'block';
                    if(drawerModeText) drawerModeText.innerHTML = `随机播放 <span class="count">(${this.playlist.length})</span>`;
                    if(modeBtn) modeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>`;
                }
                
                if (typeof window.showDynamicIsland === 'function') {
                    const modeNames = { 'loop': '列表循环', 'single': '单曲循环', 'random': '随机播放' };
                    window.showDynamicIsland(`已切换至: ${modeNames[this.playMode]}`, 'info');
                }
            };

            // 分别绑定抽屉标题栏和全屏左下角的模式切换按钮
            if (modeToggleBtn) modeToggleBtn.addEventListener('click', toggleMode);
            if (modeBtn) modeBtn.addEventListener('click', toggleMode);
            // ▲▲▲ 修改结束 ▲▲▲
        }

        // ▼▼▼ [新增] 喜欢按钮的点击交互 ▼▼▼
        const likeBtn = document.getElementById('music-like-btn');
        if (likeBtn) {
            likeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (this.playlist.length === 0) return;
                
                const currentSong = this.playlist[this.currentIndex];
                let favGroup = this.groups.find(g => g.id === 'group-favorite');
                if (!favGroup) return;

                const songIdx = favGroup.songs.findIndex(s => s.title === currentSong.title && s.artist === currentSong.artist);
                if (songIdx !== -1) {
                    favGroup.songs.splice(songIdx, 1);
                    if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('已取消喜欢', 'info');
                } else {
                    favGroup.songs.unshift(currentSong); // 永远加到最前面
                    if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('已添加到我喜欢的音乐', 'success');
                }
                
                await this.saveGroupsToLocal();
                this.renderGroupsToDOM();
                this.updateLikeButtonUI();
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
         // ▼▼▼ [新增] 音乐分享按钮交互逻辑 ▼▼▼
        const shareBtn1 = document.getElementById('music-share-btn');       // 全屏播放器的分享
        const shareBtn2 = document.getElementById('music-group-share-btn'); // 歌单详情页的分享
        const shareModal = document.getElementById('music-share-modal-overlay');
        const closeShareBtn = document.getElementById('music-share-close-btn');
             const shareCharList = document.getElementById('music-share-char-list');

        const openShareModal = (e) => {
            e.stopPropagation();
            // ▼ 新增：通过判断点击的按钮 ID，来区分是单曲还是歌单分享
            const isPlaylistShare = e.currentTarget && e.currentTarget.id === 'music-group-share-btn';
            
            let contacts = [];
            
            // 提取DOM中真实存在的好友及他们的ID
            const friendItems = document.querySelectorAll('.conversation-item');
            friendItems.forEach(item => {
                const nameEl = item.querySelector('.chat-name');
                const avatarEl = item.querySelector('.chat-avatar');
                const charId = item.dataset.charId; 
                
                if (nameEl && avatarEl && charId && nameEl.textContent.trim() !== '角色名') {
                    contacts.push({ id: charId, name: nameEl.textContent.trim(), avatar: avatarEl.src });
                }
            });

            shareCharList.innerHTML = '';
            if (contacts.length === 0) {
                shareCharList.innerHTML = '<div style="text-align:center; padding:20px; color:#999; font-size:14px;">请先在通讯录中添加好友哦</div>';
            } else {
                contacts.forEach(char => {
                    const charEl = document.createElement('div');
                    charEl.style.cssText = 'display: flex; align-items: center; padding: 10px; border-radius: 12px; background: #f9f9f9; cursor: pointer; transition: background 0.2s;';
                    charEl.innerHTML = `
                        <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                        <span style="font-size: 15px; font-weight: 600; color: #333; flex: 1;">${char.name}</span>
                        <button style="background: #111; color: #fff; border: none; padding: 6px 16px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;">发送</button>
                    `;
                    // 点击发送
                    charEl.onclick = async () => {
                        try {
                            const { db, tempState } = await import('../state.js');
                            const { createAndAppendMessage, getCurrentChatIdentity } = await import('./chat-ui.js');
                            const currentUser = getCurrentChatIdentity();

                            let messageToSave;

                            // ▼▼▼ 分流：如果是分享歌单 ▼▼▼
                            if (isPlaylistShare) {
                                // 直接从详情页的 DOM 抓取当前正在看的歌单数据
                                const pTitle = document.getElementById('music-group-detail-title').textContent;
                                const pDesc = document.getElementById('music-group-detail-desc').textContent;
                                const pCover = document.getElementById('music-group-detail-cover').src;
                                const pCount = document.getElementById('music-group-detail-count').textContent;
                                
                                const currentGroup = this.groups.find(g => g.id === this.currentOpenGroupId);
                                const songList = ((currentGroup && currentGroup.songs) ? currentGroup.songs : []).map(song => ({
                                    title: song.title,
                                    artist: song.artist || '未知歌手',
                                    cover: song.cover || pCover,
                                    src: song.src || '',
                                    lyric: song.lyric || '',
                                    neteaseId: song.neteaseId || null
                                }));

                                messageToSave = {
                                    chatId: char.id,
                                    timestamp: new Date(),
                                    text: `[分享歌单] ${pTitle}`,
                                    type: 'sent',
                                    contentType: 'playlist_share', // 新的歌单类型
                                    content: { title: pTitle, desc: pDesc, cover: pCover, count: pCount, songs: songList },
                                    avatarSrc: currentUser ? currentUser.avatar : 'images/default-avatar.svg',
                                    recalled: false,
                                    replyToMessageId: null
                                };
                                
                                if (typeof window.showDynamicIsland === 'function') {
                                    window.showDynamicIsland(`已将歌单《${pTitle}》分享给 ${char.name}`, 'success');
                                }
                            } 
                            // ▼▼▼ 分流：如果是分享单曲 ▼▼▼
                            else {
                                const currentSong = MusicPlayer.playlist[MusicPlayer.currentIndex];
                                const songName = currentSong ? currentSong.title : '未知歌曲';
                                if (!currentSong) return;
                                
                                messageToSave = {
                                    chatId: char.id,
                                    timestamp: new Date(),
                                    text: `[分享音乐] ${songName}`, 
                                    type: 'sent',
                                    contentType: 'music_share',
                                    content: { title: currentSong.title, artist: currentSong.artist, cover: currentSong.cover, src: currentSong.src, lyric: currentSong.lyric },
                                    avatarSrc: currentUser ? currentUser.avatar : 'images/default-avatar.svg',
                                    recalled: false,
                                    replyToMessageId: null
                                };
                                
                                if (typeof window.showDynamicIsland === 'function') {
                                    window.showDynamicIsland(`已将《${songName}》分享给 ${char.name}`, 'success');
                                }
                            }
                            
                            // 存入数据库并渲染
                            const messageId = await db.chatMessages.add(messageToSave);
                            if (String(char.id) === String(tempState.currentChatId)) {
                                const newMessage = await db.chatMessages.get(messageId);
                                if (typeof createAndAppendMessage === 'function') {
                                    await createAndAppendMessage(newMessage);
                                }
                            }
                        } catch(err) { console.error("发送卡片失败", err); }

                        closeShareModal(); 
                    };
                    shareCharList.appendChild(charEl);
                });
            }

            // 强制覆盖CSS的透明度设置，并添加active触发动画
            shareModal.style.display = 'flex';
            shareModal.style.opacity = '1';
            shareModal.style.visibility = 'visible';
            shareModal.style.pointerEvents = 'auto';
            shareModal.classList.add('active');
        };

        const closeShareModal = () => {
            shareModal.classList.remove('active');
            shareModal.style.opacity = '0';
            shareModal.style.visibility = 'hidden';
            shareModal.style.pointerEvents = 'none';
            setTimeout(() => shareModal.style.display = 'none', 300);
        };

        if (shareModal && shareCharList) {
            // 给两个分享按钮都绑定事件
            if (shareBtn1) shareBtn1.addEventListener('click', openShareModal);
            if (shareBtn2) shareBtn2.addEventListener('click', openShareModal);

            if (closeShareBtn) closeShareBtn.addEventListener('click', closeShareModal);
            
            // 点击半透明黑灰背景也能关闭
            shareModal.addEventListener('click', (e) => {
                if (e.target === shareModal) closeShareModal();
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲


        // 播放按钮逻辑
        const playBtn = document.getElementById('music-play-btn');
        if (playBtn) {
            playBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePlay(); // 使用真实的音频播放/暂停逻辑
            });
        }

       // ▼▼▼ 新增：歌单详情页返回按钮逻辑 ▼▼▼
        const groupDetailBackBtn = document.getElementById('music-group-detail-back-btn');
        if (groupDetailBackBtn) {
            groupDetailBackBtn.addEventListener('click', () => {
                const mainLayout = document.getElementById('music-layout-container');
                const detailView = document.getElementById('music-group-detail-view');
                if(mainLayout) mainLayout.style.display = 'block';
                if(detailView) detailView.style.display = 'none';
            });
        }
        // 点击中间区域切换黑胶/歌词视图
         const viewToggle = document.getElementById('music-view-toggle');
        if (viewToggle) {
            viewToggle.addEventListener('click', () => {
                this.isLyricsView = !this.isLyricsView;
                this.updateView();
            });
        }
        
        // ▼▼▼ [新增] 翻译按钮交互 ▼▼▼
        const transBtn = document.getElementById('music-translate-btn');
        if (transBtn) {
            transBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showTranslation = !this.showTranslation;
                
                // 更新UI颜色指示状态
                transBtn.style.color = this.showTranslation ? '#111' : '#888';
                
                // 动态切换正在显示的歌词和短片段中的翻译元素
                const transSpans = document.querySelectorAll('.lyrics-scroll-container .trans, .lyric-snippet .trans');
                transSpans.forEach(span => {
                    span.style.display = this.showTranslation ? 'inline-block' : 'none';
                });
                
                if (typeof window.showDynamicIsland === 'function') {
                    window.showDynamicIsland(this.showTranslation ? '已显示翻译' : '已隐藏翻译', 'success');
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
    },
    setupAudioEngine() {
        this.currentLyrics = [];
        this.lastActiveLyricIndex = -1;
        this.audioEngine.preload = 'metadata';
        this.audioEngine.setAttribute('playsinline', '');
        if (isNativeRuntime()) document.addEventListener('visibilitychange', () => {
            if (!this.isSilenceTrack || !this.isPlaying || !this.audioEngine.paused) return;
            void this.startAudioPlayback();
        });

        this.audioEngine.addEventListener('timeupdate', () => this.handleTimeUpdate());
        this.audioEngine.addEventListener('timeupdate', () => {
            if (!isNativeRuntime() || !this.isPlaying) return;
            const now = Date.now();
            if (now - (this.lastNativeMediaSyncAt || 0) < 1000) return;
            this.lastNativeMediaSyncAt = now;
            void updateNativeMediaMetadata(
                this.currentMediaTitle || 'LOOKY',
                this.currentMediaArtist || '',
                true,
                this.audioEngine.currentTime,
                Number.isFinite(this.audioEngine.duration) ? this.audioEngine.duration : 0,
                this.currentMediaCover || ''
            ).catch(error => console.warn('[Music] 原生进度同步失败:', error));
        });
        this.audioEngine.addEventListener('loadedmetadata', () => this.handleTimeUpdate());
        
        this.audioEngine.addEventListener('play', () => {
            this.startLyricSync();
            if (isNativeRuntime()) {
                void startNativeKeepAlive()
                    .then(() => updateNativeMediaMetadata(this.currentMediaTitle || 'LOOKY', this.currentMediaArtist || '', true, this.audioEngine.currentTime, this.audioEngine.duration, this.currentMediaCover || ''))
                    .catch(error => console.warn('[Music] 原生媒体状态同步失败:', error));
            }
            // 【新增打点】只有手动点播放，且在一起听时记录
            if(this.currentListeningChar && this.audioEngine.currentTime > 1) {
                this.sendHiddenMusicEvent('用户继续播放了音乐。');
            }
        });
        
        this.audioEngine.addEventListener('pause', () => {
            this.stopLyricSync();
            if (isNativeRuntime()) void updateNativeMediaMetadata(this.currentMediaTitle || 'LOOKY', this.currentMediaArtist || '', false, this.audioEngine.currentTime, this.audioEngine.duration, this.currentMediaCover || '')
                .catch(error => console.warn('[Music] 原生暂停状态同步失败:', error));
            if (isNativeRuntime() && this.isSilenceTrack && this.isPlaying && document.visibilityState === 'hidden') {
                // 系统切后台时部分 WebView 会自动暂停音频，立即补回播放状态。
                setTimeout(() => {
                    if (this.isSilenceTrack && this.isPlaying && this.audioEngine.paused) {
                        void this.startAudioPlayback();
                    }
                }, 0);
                return;
            }
            // 【新增打点】不是因为切歌导致的暂停，说明用户手动按了暂停
            if(this.currentListeningChar && this.audioEngine.currentTime > 0 && this.audioEngine.currentTime < this.audioEngine.duration) {
                this.sendHiddenMusicEvent(`用户暂停了音乐播放，当前停在《${this.playlist[this.currentIndex]?.title}》。`);
            }
        });
         this.audioEngine.addEventListener('ended', () => {
            if (this.isSilenceTrack) {
                this.audioEngine.currentTime = 0;
                void this.startAudioPlayback();
                return;
            }

            if (this.playMode === 'single') {
                this.audioEngine.currentTime = 0;
                void this.startAudioPlayback();
            } else {
                // 【修复】去除了自然放完时的强制报警。
                // 这样AI不会觉得突兀，只会把它当成普通的BGM，除非遇到有感触的歌才会主动提。
                this.playNext(true);

            }
        });


        const progressTrack = document.querySelector('.progress-track');
        if (progressTrack) {
            progressTrack.addEventListener('click', (e) => {
                const rect = progressTrack.getBoundingClientRect();
                const percent = (e.clientX - rect.left) / rect.width;
                if (this.audioEngine.duration) {
                    this.audioEngine.currentTime = percent * this.audioEngine.duration;
                }
                this.syncLyrics(); 
            });
        }
    },

    // ▼▼▼ [新增] 电竞级 60Hz 歌词同步引擎 ▼▼▼
    startLyricSync() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        const sync = () => {
            this.syncLyrics();
            if (this.isPlaying) {
                this.animationFrameId = requestAnimationFrame(sync); // 帧级循环调用
            }
        };
        sync();
    },

    stopLyricSync() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    },

    syncLyrics(forceFullUpdate = false) {
        if (!this.currentLyrics || this.currentLyrics.length === 0) return;

        // 【核心算法】加上补偿时间。强制将判断时间往后拨，从而让歌词“提前”触发
        const currentTime = (this.audioEngine.currentTime || 0) + this.lyricOffset;
        const memoPage = document.getElementById('page-memo');
        const isMemoVisible = forceFullUpdate || (memoPage && memoPage.style.display !== 'none');
        const now = Date.now();
        if (!isMemoVisible && now - this.lastHiddenLyricSyncTime < 1000) return;
        if (!isMemoVisible) this.lastHiddenLyricSyncTime = now;

        let activeIndex = -1;
        // 找到最后一句时间小于当前进度的歌词
        for (let i = 0; i < this.currentLyrics.length; i++) {
            if (currentTime >= this.currentLyrics[i].time) {
                activeIndex = i;
            } else { break; }
        }
        // 当切换到新的一句歌词时
        if (activeIndex !== -1 && (activeIndex !== this.lastActiveLyricIndex || forceFullUpdate)) {
            this.lastActiveLyricIndex = activeIndex;
            
            // 1. 更新黑胶页面下方的短歌词 (瞬间换字 + 丝滑上浮淡入)
            const snippetEl = document.querySelector('.lyric-snippet p');
            const cur = this.currentLyrics[activeIndex];
            // 取纯文本对比防止重复刷新
            const curOrigText = snippetEl ? (snippetEl.querySelector('.orig') ? snippetEl.querySelector('.orig').textContent : snippetEl.textContent) : '';
            const wLyricEl = document.querySelector('#widget-lyrics-container p');
            if (wLyricEl && wLyricEl.textContent !== cur.text) {
                wLyricEl.textContent = cur.text;
            }
            if (!isMemoVisible) return;
            if (snippetEl && curOrigText !== cur.text) {
                snippetEl.style.transition = 'none';
                snippetEl.style.opacity = '0';
                snippetEl.style.transform = 'translateY(6px)';
                
                snippetEl.innerHTML = `<span class="orig">${cur.text}</span>` + (cur.tText ? `<br><span class="trans" style="display:${this.showTranslation ? 'inline-block' : 'none'}; font-size:0.85em; opacity:0.7;">${cur.tText}</span>` : '');
                
                void snippetEl.offsetWidth; // 强制重绘
                
                snippetEl.style.transition = 'all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
                snippetEl.style.opacity = '1';

                snippetEl.style.transform = 'translateY(0)';
            }

            // 2. 更新歌词大页面的高亮和滚动
            const container = document.querySelector('.lyrics-scroll-container');
            if (container) {
                const ps = container.querySelectorAll('p');
                ps.forEach(p => p.classList.remove('active'));
                if (ps[activeIndex]) {
                    ps[activeIndex].classList.add('active');
                    // 计算滚动，确保这句歌词永远呆在屏幕中心
                    const pOffset = ps[activeIndex].offsetTop;
                    const cHeight = container.clientHeight;
                    container.scrollTo({
                        top: pOffset - cHeight / 2 + ps[activeIndex].clientHeight / 2, 
                        behavior: 'smooth'
                    });
                }
            }
        }
    },
    // ▲▲▲ 新增结束 ▲▲▲

    handleTimeUpdate() {
        // 这里现在纯粹只处理绿色的进度条，不再管歌词
        const currentTime = this.audioEngine.currentTime || 0;
        const duration = this.audioEngine.duration || 0;
        
        const formatTime = (time) => {
            if (isNaN(time)) return "00:00";
            const m = Math.floor(time / 60).toString().padStart(2, '0');
            const s = Math.floor(time % 60).toString().padStart(2, '0');
            return `${m}:${s}`;
        };

        const currentEl = document.querySelector('.time.current');
        const totalEl = document.querySelector('.time.total');
        const fillEl = document.querySelector('.progress-fill');
        const wTimeEl = document.getElementById('widget-song-time');
        if (wTimeEl) wTimeEl.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
        const memoPage = document.getElementById('page-memo');
        if (!memoPage || memoPage.style.display === 'none') return;
        if (currentEl) currentEl.textContent = formatTime(currentTime);
        if (totalEl) totalEl.textContent = formatTime(duration);
        if (fillEl && duration > 0) {
            fillEl.style.width = `${(currentTime / duration) * 100}%`;
        }
    },
    updateUI() {
         const playBtn = document.getElementById('music-play-btn');
        const iconPlay = playBtn?.querySelector('.icon-play');
        const iconPause = playBtn?.querySelector('.icon-pause');
        const recordContainer = document.getElementById('vinyl-record');

        // 获取小悬浮窗上的按钮，确保两边同步
        const miniPlayIcon = document.querySelector('.m-icon-play');
        const miniPauseIcon = document.querySelector('.m-icon-pause');

        // ▼▼▼ 【核心修复】分别获取挂件横条 (bar) 和展开面板 (panel) 里的播放按钮 ▼▼▼
        const barPlayBtn = document.getElementById('widget-play-btn');
        const panelPlayBtn = document.getElementById('widget-panel-play-btn');
        
        // 分别拿到它们里面的 播放/暂停 SVG 图标
        const barPlayIcon = barPlayBtn?.querySelector('.w-icon-play');
        const barPauseIcon = barPlayBtn?.querySelector('.w-icon-pause');
        const panelPlayIcon = panelPlayBtn?.querySelector('.w-icon-play');
        const panelPauseIcon = panelPlayBtn?.querySelector('.w-icon-pause');
        
        const wCover = document.getElementById('widget-cover-img');

        if (!playBtn || !recordContainer) return;

        if (this.isPlaying) {
            this.hasActivatedWidget = true;
            this.widgetForceClosed = false; 
            if (typeof this.updateGlobalWidgetVisibility === 'function') this.updateGlobalWidgetVisibility();
            if (iconPlay) iconPlay.style.display = 'none';
            if (iconPause) iconPause.style.display = 'block';
            if (miniPlayIcon) miniPlayIcon.style.display = 'none';
            if (miniPauseIcon) miniPauseIcon.style.display = 'block';
            recordContainer.classList.add('playing');
            
            // ▼▼▼ 挂件同步 (同时控制横条和面板) ▼▼▼
            if (barPlayIcon) barPlayIcon.style.display = 'none';
            if (barPauseIcon) barPauseIcon.style.display = 'block';
            if (panelPlayIcon) panelPlayIcon.style.display = 'none';
            if (panelPauseIcon) panelPauseIcon.style.display = 'block';
            if (wCover) wCover.style.animationPlayState = 'running';
        } else {
            if (typeof this.updateGlobalWidgetVisibility === 'function') this.updateGlobalWidgetVisibility();
            if (iconPlay) iconPlay.style.display = 'block';
            if (iconPause) iconPause.style.display = 'none';
            if (miniPlayIcon) miniPlayIcon.style.display = 'block';
            if (miniPauseIcon) miniPauseIcon.style.display = 'none';
            recordContainer.classList.remove('playing');
            
            // ▼▼▼ 挂件同步 (同时控制横条和面板) ▼▼▼
            if (barPlayIcon) barPlayIcon.style.display = 'block';
            if (barPauseIcon) barPauseIcon.style.display = 'none';
            if (panelPlayIcon) panelPlayIcon.style.display = 'block';
            if (panelPauseIcon) panelPauseIcon.style.display = 'none';
            if (wCover) wCover.style.animationPlayState = 'paused';
        }
    },

    updateView() {
        const vinylView = document.getElementById('music-vinyl-view');
        const lyricsView = document.getElementById('music-lyrics-view');
        if (!vinylView || !lyricsView) return;

        if (this.isLyricsView) {
            vinylView.style.display = 'none';
            lyricsView.style.display = 'flex';
        } else {
            lyricsView.style.display = 'none';
            vinylView.style.display = 'flex';
        }
    }, 

    audioEngine: new Audio(),

    normalizeAudioSource(audioSrc) {
        if (!isNativeRuntime() || typeof audioSrc !== 'string') return audioSrc;
        try {
            const url = new URL(audioSrc, window.location.href);
            const isNeteaseMediaHost = /(^|\.)(?:music\.126\.net|music\.163\.com)$/i.test(url.hostname);
            if (url.protocol === 'http:' && isNeteaseMediaHost) url.protocol = 'https:';
            return url.href;
        } catch {
            return audioSrc;
        }
    },

    async startAudioPlayback(title = '') {
        try {
            const playPromise = this.audioEngine.play();
            if (playPromise !== undefined) await playPromise;
            this.isPlaying = true;
            this.updateUI();
            this.startLyricSync();
            if (title && typeof window.showDynamicIsland === 'function') {
                window.showDynamicIsland(`正在播放: ${title}`, 'success');
            }
            return true;
        } catch (error) {
            this.isPlaying = false;
            this.updateUI();
            const mediaErrorCode = this.audioEngine.error?.code || 0;
            console.error('[Music] 音频播放失败', {
                name: error?.name || 'MediaError',
                message: error?.message || '未知播放错误',
                mediaErrorCode,
                currentSrc: this.audioEngine.currentSrc || this.audioEngine.src,
                networkState: this.audioEngine.networkState,
                readyState: this.audioEngine.readyState
            });
            if (isNativeRuntime() && typeof window.showDynamicIsland === 'function') {
                window.showDynamicIsland('歌曲播放失败，请检查网络后重试', 'warning');
            }
            return false;
        }
    },

    playTrack(title, artist, coverUrl, audioSrc, lyricText) {
        this.currentMediaTitle = title;
        this.currentMediaArtist = artist;
        this.currentMediaCover = typeof coverUrl === 'string' && /^https?:\/\//i.test(coverUrl) ? coverUrl : '';
        if (isNativeRuntime()) {
            void startNativeKeepAlive()
                .then(() => updateNativeMediaMetadata(title, artist, true, 0, 0, this.currentMediaCover))
                .catch(error => console.warn('[Music] 原生媒体服务启动失败:', error));
        }
        this.updateRecentPlays({ title, artist, cover: coverUrl, src: audioSrc, lyric: lyricText });
        this.audioEngine.loop = false;
        
        // 1. 播放声音
        this.audioEngine.src = this.normalizeAudioSource(audioSrc);
        this.isPlaying = false;
        this.updateUI();
        void this.startAudioPlayback(title);

        // 2. 更新文字和图片
        document.querySelectorAll('.song-title, .m-title').forEach(el => el.textContent = title);
        document.querySelectorAll('.song-artist, .m-artist').forEach(el => el.textContent = artist);
        const defaultCover = "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=600&auto=format&fit=crop&grayscale";
        const finalCover = coverUrl || defaultCover;
        document.querySelectorAll('.album-cover, .mini-album-art img').forEach(img => img.src = finalCover);
        // ▼▼▼ 【核心修复】同步更新侧边栏和底部悬浮播放器的毛玻璃动态背景 ▼▼▼
        document.querySelectorAll('.mini-player-dynamic-bg, .widget-dynamic-bg').forEach(bg => bg.style.backgroundImage = `url('${finalCover}')`);

        const widgetCover = document.getElementById('widget-cover-img');

        if(widgetCover) widgetCover.src = finalCover;
        const widgetTitle = document.getElementById('widget-song-title');
        if(widgetTitle) widgetTitle.textContent = title;
        // 3. 智能解析歌词 (提取时间轴供滚动系统使用)
        const lyricsContainer = document.querySelector('.lyrics-scroll-container');
        const snippetEl = document.querySelector('.lyric-snippet p');
        this.currentLyrics = [];
        this.lastActiveLyricIndex = -1;
         if (lyricsContainer) {
            lyricsContainer.innerHTML = ''; 
            if (lyricText) {
                let origLines = [];
                let transMap = {};
                let isDual = false;
                
                // ▼▼▼ 全新高成功率解析法：按分隔符拆分 ▼▼▼
                if (lyricText.includes('---翻译---')) {
                    isDual = true;
                    const parts = lyricText.split('---翻译---');
                    origLines = parts[0].split('\n');
                    const tLines = parts[1] ? parts[1].split('\n') : [];
                    
                    tLines.forEach(line => {
                        const match = line.match(/\[(\d{2}):(\d{2}(?:\.\d{2,3})?)\](.*)/);
                        if (match && match[3].trim()) {
                            const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                            transMap[Math.round(time * 10)] = match[3].trim();
                        }
                    });
                } else {
                    origLines = lyricText.split('\n');
                }
                // ▲▲▲ 解析结束 ▲▲▲

                origLines.forEach(line => {

                    const match = line.match(/\[(\d{2}):(\d{2}(?:\.\d{2,3})?)\](.*)/);
                    if (match && match[3].trim()) {
                        const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                        const text = match[3].trim();
                        let tText = '';
                        if (isDual) {
                            const key = Math.round(time * 10);
                            for(let t = key - 2; t <= key + 2; t++) {
                                if (transMap[t]) { tText = transMap[t]; break; }
                            }
                        }
                        this.currentLyrics.push({ time: time, text: text, tText: tText });
                        
                        const p = document.createElement('p');
                        p.innerHTML = `<span class="orig">${text}</span>` + (tText ? `<br><span class="trans" style="display:${this.showTranslation ? 'inline-block' : 'none'}; font-size:0.85em; opacity:0.7; margin-top:2px;">${tText}</span>` : '');
                        lyricsContainer.appendChild(p);
                    }
                });
                
                 // ▼▼▼ 修复：将歌词也同步赋予悬浮小窗 ▼▼▼
                const wLyricEl = document.querySelector('#widget-lyrics-container p');
                if (this.currentLyrics.length > 0) {
                    if (lyricsContainer.firstChild) lyricsContainer.firstChild.classList.add('active'); 
                    if (snippetEl) snippetEl.textContent = this.currentLyrics[0].text;
                    if (wLyricEl) wLyricEl.textContent = this.currentLyrics[0].text; // 同步给悬浮窗
                } else {
                    lyricsContainer.innerHTML = '<p>暂无滚动歌词</p>';
                    if (snippetEl) snippetEl.textContent = "未找到时间轴";
                    if (wLyricEl) wLyricEl.textContent = "未找到时间轴";
                }
            } else {
                const wLyricEl = document.querySelector('#widget-lyrics-container p');
                lyricsContainer.innerHTML = '<p>纯音乐，请欣赏</p>';
                if (snippetEl) snippetEl.textContent = "纯音乐，请欣赏";
                if (wLyricEl) wLyricEl.textContent = "纯音乐，请欣赏";
            }
        }
        this.updateLikeButtonUI(); // 更新红心状态
    },

    // ▼▼▼ [新增] 更新红心按钮 UI 状态 ▼▼▼
    updateLikeButtonUI() {
        const likeBtn = document.getElementById('music-like-btn');
        if (!likeBtn) return;
        
        const currentSong = this.playlist[this.currentIndex];
        const favGroup = this.groups.find(g => g.id === 'group-favorite');
        const outlineIcon = likeBtn.querySelector('.icon-like-outline');
        const solidIcon = likeBtn.querySelector('.icon-like-solid');
        
        if (currentSong && favGroup && favGroup.songs.some(s => s.title === currentSong.title && s.artist === currentSong.artist)) {
            if (outlineIcon) outlineIcon.style.display = 'none';
            if (solidIcon) solidIcon.style.display = 'block';
        } else {
            if (outlineIcon) outlineIcon.style.display = 'block';
            if (solidIcon) solidIcon.style.display = 'none';
        }
    },
    // ▲▲▲ 新增结束 ▲▲▲

    async togglePlay() {

        if (this.audioEngine.src) {
            if (this.isPlaying) {
                this.audioEngine.pause();
                this.isPlaying = false;
            } else {
                await this.startAudioPlayback();
            }
        } else {
            this.isPlaying = !this.isPlaying; 
        }
 this.updateUI();
    }, // <--- 【核心注意】一定要补上这个逗号！
    // ▼▼▼ [升级版] 歌曲独立操作与动态编辑面板引擎 ▼▼▼
    showSongActionMenu(e, title, artist, cover, src, lyric, songEl) {
        let menu = document.getElementById('song-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'song-context-menu';
            // 使用全新的高级专属类名
            menu.className = 'music-song-context-menu active';
            menu.innerHTML = `
                <div class="menu-item" id="song-ctx-edit">
                    <div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div>
                    <span>重新编辑</span>
                </div>
                <div class="menu-divider"></div>
                <div class="menu-item danger" id="song-ctx-delete">
                    <div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
                    <span>删除歌曲</span>
                </div>
            `;
            document.body.appendChild(menu);
            // 点击屏幕其他区域收起
            document.addEventListener('click', (ev) => {
                if (menu && !menu.contains(ev.target)) {
                    menu.classList.remove('active');
                    setTimeout(() => menu.style.display = 'none', 200); // 等待淡出动画
                }
            });
        }
        
        // 智能定位与顺滑出现
        menu.style.display = 'flex';
        // 强制重绘以触发 CSS 过渡
        void menu.offsetWidth; 
        menu.classList.add('active');
        
        // 防止菜单超屏，定位偏下一点避开手指
        menu.style.top = (e.clientY + 15) + 'px';
        menu.style.left = (e.clientX + 140 > window.innerWidth) ? (e.clientX - 130) + 'px' : (e.clientX - 20) + 'px';

        // 功能 1：删除
        document.getElementById('song-ctx-delete').onclick = async (ev) => {
            ev.stopPropagation();
            menu.classList.remove('active');
            setTimeout(() => menu.style.display = 'none', 200);
            
            if(confirm(`确定要从曲库中永久删除《${title}》吗？`)) {
                await LocalMusicDB.deleteSong(title, artist);
                const gIdx = this.globalPlaylist.findIndex(s => s.title === title && s.artist === artist);
                if (gIdx !== -1) this.globalPlaylist.splice(gIdx, 1);
                const pIdx = this.playlist.findIndex(s => s.title === title && s.artist === artist);
                if (pIdx !== -1) this.playlist.splice(pIdx, 1);

                // ▼▼▼ [新增] 1. 同步把所有歌单里包含的这首歌也删掉 ▼▼▼
                let groupChanged = false;
                this.groups.forEach(g => {
                    if (g.songs) {
                        const originalLen = g.songs.length;
                        g.songs = g.songs.filter(s => !(s.title === title && s.artist === artist));
                        if (g.songs.length !== originalLen) groupChanged = true;
                    }
                });
                if (groupChanged) {
                    await this.saveGroupsToLocal();
                    this.renderGroupsToDOM(); // 刷新界面上的歌单
                }

                // ▼▼▼ [新增] 2. 同步把最近播放里的这首歌也删掉 ▼▼▼
                const rIdx = this.recentPlays.findIndex(s => s.title === title && s.artist === artist);
                if (rIdx !== -1) {
                    this.recentPlays.splice(rIdx, 1);
                    localStorage.setItem('looky_music_recent_v2', JSON.stringify(this.recentPlays));
                    this.renderRecentPlaysToDOM(); // 刷新界面上的最近播放
                }
                // ▲▲▲ 新增结束 ▲▲▲

                songEl.style.transform = 'scale(0.95)';
                songEl.style.opacity = '0';
                setTimeout(() => {
                    songEl.remove();
                    const list = document.getElementById('tab-songs');
                    if (list) {
                        // ▼▼▼ 过滤静音卡片后再重排序号 ▼▼▼
                        const realSongs = Array.from(list.children).filter(el => el.id !== 'silence-track-card');
                        realSongs.forEach((el, i) => {
                            const idxDiv = el.querySelector('.song-index');
                            if(idxDiv) idxDiv.textContent = i < 9 ? `0${i+1}` : `${i+1}`;
                        });
                }

                 this.updatePlaylistDrawer();
                this.updateProfileStats(); // [新增] 删歌后刷新数量和等级
            }, 300);

            // ▼▼▼ [新增] 删歌后联动刷新红心状态 ▼▼▼
            this.updateLikeButtonUI();
            // ▲▲▲ 新增结束 ▲▲▲
            
            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`已删除: ${title}`, 'success');

            }
        };


        // 功能 2：编辑
        document.getElementById('song-ctx-edit').onclick = (ev) => {
            ev.stopPropagation();
            menu.classList.remove('active');
            setTimeout(() => menu.style.display = 'none', 200);
            this.openEditSongModal(title, artist, cover, src, lyric, songEl);
        };
    },

    openEditSongModal(oldTitle, oldArtist, cover, src, lyric, songEl) {
        let editModal = document.getElementById('music-edit-song-modal');
        if (!editModal) {
            editModal = document.createElement('div');
            editModal.id = 'music-edit-song-modal';
            // 复用底层蒙版，使用专属高级卡片类名
            editModal.className = 'modal-overlay'; 
            editModal.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
            editModal.innerHTML = `
              <div class="music-edit-modal-card" style="width: 92%; max-width: 380px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow: hidden;">
                <div class="edit-header">
                    <h3>编辑音乐信息</h3>
                    <p>Edit Track Info</p>
                </div>
                <div class="edit-body" style="min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                    <!-- ▼▼▼ 新增：封面图修改区 ▼▼▼ -->
                    <div class="input-group" style="align-items: center;">
                        <label style="width: 100%; text-align: left;">封面图 (点击更换)</label>
                        <div style="width: 80px; height: 80px; border-radius: 12px; overflow: hidden; cursor: pointer; border: 1px solid #eee; margin-top: 4px;" onclick="document.getElementById('edit-song-cover-upload').click()">
                            <img id="edit-song-cover-preview" src="" style="width: 100%; height: 100%; object-fit: cover;">
                        </div>
                        <input type="file" id="edit-song-cover-upload" accept="image/*" style="display: none;">
                    </div>
                    <!-- ▲▲▲ 新增结束 ▲▲▲ -->
                    <div class="input-group">
                        <label>歌曲名称 TITLE</label>
                        <input type="text" id="edit-song-title" class="premium-input" placeholder="输入歌名">
                    </div>
                    <div class="input-group">
                        <label>歌手名称 ARTIST</label>
                        <input type="text" id="edit-song-artist" class="premium-input" placeholder="输入歌手">
                    </div>
                    <div class="input-group">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <label>滚动歌词 LYRICS (可选)</label>
                            <button id="edit-auto-fetch-btn" style="background: #f2f2f7; color: #111; border: none; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: 0.2s;">一键提取</button>
                        </div>
                        <textarea id="edit-song-lyric" class="premium-input lyric-input" rows="4" placeholder="点击右上角提取，或手动粘贴..."></textarea>
                    </div>
                </div>
                <div class="edit-footer">

                    <button id="edit-song-cancel" class="btn-cancel">取消</button>
                    <button id="edit-song-save" class="btn-save">保存修改</button>
                </div>
              </div>
            `;
            document.body.appendChild(editModal);
            
            document.getElementById('edit-song-cancel').onclick = () => {
                editModal.classList.remove('active');
                editModal.style.opacity = '0';
                editModal.style.visibility = 'hidden';
                editModal.style.pointerEvents = 'none';
                setTimeout(() => editModal.style.display = 'none', 300);
            };

            const editLyricInput = document.getElementById('edit-song-lyric');
            if (editLyricInput) {
                editLyricInput.addEventListener('paste', () => {
                    setTimeout(() => {
                        let val = editLyricInput.value.trim();
                        if (!val) return;
                        let extractedLyric = val; 
                                try { 
                            const jsonObj = JSON.parse(val);
                            if (jsonObj.lrc && jsonObj.lrc.lyric) {
                                extractedLyric = jsonObj.lrc.lyric;
                                // ▼▼▼ 把翻译像写文章一样拼在下面 ▼▼▼
                                if (jsonObj.tlyric && jsonObj.tlyric.lyric) {
                                    extractedLyric += '\n\n---翻译---\n\n' + jsonObj.tlyric.lyric;
                                }
                            }
                            else if (jsonObj.lyric) extractedLyric = jsonObj.lyric;
                        } catch (err) { 

                            const match = val.match(/"lyric"\s*:\s*"([\s\S]*?)"(,|})/);
                            if (match && match[1]) {
                                extractedLyric = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                            } else if (val.includes('\\n')) {
                                extractedLyric = val.replace(/\\n/g, '\n');
                            }
                        }
                        if (extractedLyric && extractedLyric.includes('[00:')) {
                            editLyricInput.value = extractedLyric;
                            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('✨ 已自动提取纯净歌词', 'success');
                        }
                    }, 50);
                });
            }

            // ▼▼▼ [新增] 编辑界面的“一键提取”专属功能 ▼▼▼
            const editAutoFetchBtn = document.getElementById('edit-auto-fetch-btn');
            if (editAutoFetchBtn) {
                editAutoFetchBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    // 弹出一个原生框让用户粘贴链接
                    const userInput = prompt('请输入你要提取的网易云音乐链接，或者直接输入歌曲的数字 ID：\n例如：http://music.163.com/song/media/outer/url?id=12345');
                    if (!userInput) return;
                    
                    let songId = userInput.trim();
                    // 智能抠出ID
                    const match = userInput.match(/id=(\d+)/);
                    if (match && match[1]) {
                        songId = match[1];
                    } else if (!/^\d+$/.test(songId)) {
                        alert('无法识别链接中的 ID，请检查链接格式或直接输入纯数字 ID。');
                        return;
                    }

                    const prevText = editAutoFetchBtn.textContent;
                    editAutoFetchBtn.textContent = '提取中...';
                    editAutoFetchBtn.disabled = true;

                    try {
                        const apiUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
                        
                        // ▼▼▼ 【核心升级】3路代理节点自动路由，防堵车防报错 ▼▼▼
                        const proxyNodes = [
                            `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`,
                            `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`, 
                            `https://corsproxy.io/?${encodeURIComponent(apiUrl)}` 
                        ];

                        let realData = null;
                        for (let proxy of proxyNodes) {
                            try {
                                const controller = new AbortController();
                                const timeoutId = setTimeout(() => controller.abort(), 5000);
                                const response = await fetch(proxy, { signal: controller.signal });
                                clearTimeout(timeoutId);

                                if (response.ok) {
                                    realData = await response.json();
                                    break; 
                                }
                            } catch (e) {
                                console.log("当前节点拥堵，自动切换备用节点...");
                            }
                        }

                        if (!realData) throw new Error("所有节点均被挤爆，拉取失败");
                        // ▲▲▲ 升级结束 ▲▲▲
                        
                        let extractedLyric = '';
                        if (realData.lrc && realData.lrc.lyric) {
                            extractedLyric = realData.lrc.lyric;

                            if (realData.tlyric && realData.tlyric.lyric) {
                                extractedLyric += '\n\n---翻译---\n\n' + realData.tlyric.lyric;
                            }
                        }
                        
                        if (extractedLyric && extractedLyric.includes('[00:')) {
                            document.getElementById('edit-song-lyric').value = extractedLyric;
                            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland('✨ 歌词提取成功！', 'success');
                        } else {
                            alert('提取失败：该歌曲可能没有提供滚动歌词，或是纯音乐。');
                        }
                    } catch (err) {
                        console.error('一键提取歌词失败', err);
                        alert('网络请求失败，请稍后再试。');
                    } finally {
                        editAutoFetchBtn.textContent = prevText;
                        editAutoFetchBtn.disabled = false;
                    }
                });
            }
            // ▲▲▲ 新增结束 ▲▲▲
        }

        editModal.style.display = 'flex';

        editModal.style.opacity = '1';
        editModal.style.visibility = 'visible';
        editModal.style.pointerEvents = 'auto';
        editModal.classList.add('active');
        
        // 渲染旧数据
        document.getElementById('edit-song-title').value = oldTitle;
        document.getElementById('edit-song-artist').value = oldArtist;
        document.getElementById('edit-song-lyric').value = lyric || '';

        // ▼▼▼ 新增：渲染旧封面并绑定上传事件 ▼▼▼
        let currentEditCoverBase64 = cover || ''; 
        const previewImg = document.getElementById('edit-song-cover-preview');
        previewImg.src = currentEditCoverBase64 || "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=600&auto=format&fit=crop&grayscale";

            const uploadInput = document.getElementById('edit-song-cover-upload');
        const newUploadInput = uploadInput.cloneNode(true);
        uploadInput.replaceWith(newUploadInput);
        
        newUploadInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                currentEditCoverBase64 = compressedBase64;
                previewImg.src = currentEditCoverBase64;
            }
        });
        // ▲▲▲ 新增结束 ▲▲▲

        const saveBtn = document.getElementById('edit-song-save');

        saveBtn.replaceWith(saveBtn.cloneNode(true));
        
        // ▼▼▼ 将这里的点击事件替换为带有 try...catch 的安全版本 ▼▼▼
        document.getElementById('edit-song-save').onclick = async () => {
            try {
                const newTitle = document.getElementById('edit-song-title').value.trim() || oldTitle;
                const newArtist = document.getElementById('edit-song-artist').value.trim() || oldArtist;
                const newLyric = document.getElementById('edit-song-lyric').value.trim();

                // 1. 保存到硬盘，带上新封面
                await LocalMusicDB.updateSong(oldTitle, oldArtist, { title: newTitle, artist: newArtist, lyric: newLyric, cover: currentEditCoverBase64 });

                // 2. 更新内存大曲库，带上新封面
                const gSong = this.globalPlaylist.find(s => s.title === oldTitle && s.artist === oldArtist);
                if (gSong) { gSong.title = newTitle; gSong.artist = newArtist; gSong.lyric = newLyric; gSong.cover = currentEditCoverBase64; }
                const pSong = this.playlist.find(s => s.title === oldTitle && s.artist === oldArtist);
                if (pSong) { pSong.title = newTitle; pSong.artist = newArtist; pSong.lyric = newLyric; pSong.cover = currentEditCoverBase64; }

                // 3. 同步修改所有歌单里这首歌的信息
                let groupChanged = false;
                this.groups.forEach(g => {
                    if (g.songs) {
                        g.songs.forEach(s => {
                            if (s.title === oldTitle && s.artist === oldArtist) {
                                s.title = newTitle;
                                s.artist = newArtist;
                                s.lyric = newLyric;
                                s.cover = currentEditCoverBase64; // 同步封面
                                groupChanged = true;
                            }
                        });
                    }
                });
                if (groupChanged) {
                    await this.saveGroupsToLocal();
                    this.renderGroupsToDOM(); // 刷新界面
                }

                // 4. 同步修改最近播放里这首歌的信息
                const rSong = this.recentPlays.find(s => s.title === oldTitle && s.artist === oldArtist);
                if (rSong) {
                    rSong.title = newTitle;
                    rSong.artist = newArtist;
                    rSong.cover = currentEditCoverBase64; // 同步封面
                    localStorage.setItem('looky_music_recent_v2', JSON.stringify(this.recentPlays));
                    this.renderRecentPlaysToDOM(); // 刷新界面
                }

                // 5. 更新列表UI的名字
                if (songEl) {
                    const tEl = songEl.querySelector('.s-title');
                    const aEl = songEl.querySelector('.s-artist');
                    if (tEl) tEl.textContent = newTitle;
                    if (aEl) aEl.textContent = newArtist;
                    
                    const moreBtn = songEl.querySelector('.song-more');
                    if (moreBtn) {
                        moreBtn.onclick = (e) => {
                            e.stopPropagation();
                            // 重新绑定更新后的参数
                            this.showSongActionMenu(e, newTitle, newArtist, currentEditCoverBase64, src, newLyric, songEl);
                        };
                    }
                }
                
                // 6. 如果当前播放的就是这首歌，立即刷新界面的大封面
                if (this.playlist[this.currentIndex] && this.playlist[this.currentIndex].title === newTitle) {
                    this.updatePlayerInfoOnly(newTitle, newArtist, currentEditCoverBase64, src, newLyric);
                }
                
                this.updatePlaylistDrawer();
                editModal.classList.remove('active');
                editModal.style.opacity = '0';
                editModal.style.visibility = 'hidden';
                editModal.style.pointerEvents = 'none';
                setTimeout(() => editModal.style.display = 'none', 300);
                if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`《${newTitle}》已保存`, 'success');

            } catch (error) {
                console.error("保存歌曲信息时发生数据库错误:", error);
                alert("保存歌曲信息失败，请稍后重试！");
            }
        };
        // ▲▲▲ 替换结束 ▲▲▲
    },

    // ▼▼▼ [新增] 歌单专属的悬浮菜单和编辑面板 ▼▼▼
    showGroupActionMenu(e, group) {
        let menu = document.getElementById('group-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'group-context-menu';
            menu.className = 'music-song-context-menu active';
            menu.innerHTML = `
                <div class="menu-item" id="group-ctx-edit">
                    <div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></div>
                    <span>编辑歌单</span>
                </div>
                <div class="menu-divider"></div>
                <div class="menu-item danger" id="group-ctx-delete">
                    <div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
                    <span>删除歌单</span>
                </div>
            `;
            document.body.appendChild(menu);
            document.addEventListener('click', (ev) => {
                if (menu && !menu.contains(ev.target)) {
                    menu.classList.remove('active');
                    setTimeout(() => menu.style.display = 'none', 200);
                }
            });
        }

        // ▼▼▼ [新增] 动态判断是否为固定歌单，隐藏删除选项 ▼▼▼
        const delBtn = document.getElementById('group-ctx-delete');
        const divLine = menu.querySelector('.menu-divider');
        if (group.id === 'group-favorite') {
            if (delBtn) delBtn.style.display = 'none';
            if (divLine) divLine.style.display = 'none';
        } else {
            if (delBtn) delBtn.style.display = 'flex';
            if (divLine) divLine.style.display = 'block';
        }
        // ▲▲▲ 新增结束 ▲▲▲
        
        menu.style.display = 'flex';
        void menu.offsetWidth; 
        menu.classList.add('active');

        menu.style.top = (e.clientY + 15) + 'px';
        menu.style.left = (e.clientX + 140 > window.innerWidth) ? (e.clientX - 130) + 'px' : (e.clientX - 20) + 'px';

        // 删除功能
        document.getElementById('group-ctx-delete').onclick = async (ev) => {
            ev.stopPropagation();
            menu.classList.remove('active');
            setTimeout(() => menu.style.display = 'none', 200);
            
            if(confirm(`确定要删除歌单《${group.name}》吗？`)) {
                const idx = this.groups.findIndex(g => g.id === group.id);
                if(idx !== -1) {
                    this.groups.splice(idx, 1);
                    await this.saveGroupsToLocal(); // 保存到数据库
                    this.renderGroupsToDOM(); // 刷新列表
                    // 如果正好在看这个详情页，退出来
                    document.getElementById('music-layout-container').style.display = 'block';
                    document.getElementById('music-group-detail-view').style.display = 'none';
                    if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`歌单已删除`, 'success');
                }
            }
        };

        // 编辑功能
        document.getElementById('group-ctx-edit').onclick = (ev) => {
            ev.stopPropagation();
            menu.classList.remove('active');
            setTimeout(() => menu.style.display = 'none', 200);
            this.openEditGroupModal(group);
        };
    },

    openEditGroupModal(group) {
        let editModal = document.getElementById('music-edit-group-modal');
        if (!editModal) {
            editModal = document.createElement('div');
            editModal.id = 'music-edit-group-modal';
            editModal.className = 'modal-overlay'; 
            editModal.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100dvh; min-height: 100dvh; align-items: center; justify-content: center; box-sizing: border-box; overflow: hidden; touch-action: none; overscroll-behavior: contain; padding: max(20px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom)) 0;';
            editModal.innerHTML = `
              <div class="music-edit-modal-card" style="width: 92%; max-width: 380px; max-height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); box-sizing: border-box; overflow: hidden;">
                <div class="edit-header">
                    <h3>编辑歌单信息</h3>
                    <p>Edit Playlist Info</p>
                </div>
                <div class="edit-body" style="min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                    <div class="input-group" style="align-items: center;">
                        <label style="width: 100%; text-align: left;">封面图 (点击更换)</label>
                        <div style="width: 80px; height: 80px; border-radius: 12px; overflow: hidden; cursor: pointer; border: 1px solid #eee; margin-top: 4px;" onclick="document.getElementById('edit-group-cover-upload').click()">
                            <img id="edit-group-cover-preview" src="" style="width: 100%; height: 100%; object-fit: cover;">
                        </div>
                        <input type="file" id="edit-group-cover-upload" accept="image/*" style="display: none;">
                    </div>
                    <div class="input-group">
                        <label>歌单名称 TITLE</label>
                        <input type="text" id="edit-group-title" class="premium-input" placeholder="输入歌单名">
                    </div>
                    <div class="input-group">
                        <label>简介 DESCRIPTION</label>
                        <textarea id="edit-group-desc" class="premium-input lyric-input" rows="2" placeholder="输入简介..."></textarea>
                    </div>
                </div>
                <div class="edit-footer">
                    <button id="edit-group-cancel" class="btn-cancel">取消</button>
                    <button id="edit-group-save" class="btn-save">保存修改</button>
                </div>
              </div>
            `;
            document.body.appendChild(editModal);
            
            document.getElementById('edit-group-cancel').onclick = () => {
                editModal.classList.remove('active');
                editModal.style.opacity = '0';
                editModal.style.visibility = 'hidden';
                editModal.style.pointerEvents = 'none';
                setTimeout(() => editModal.style.display = 'none', 300);
            };
        }

        // 显示弹窗
        editModal.style.display = 'flex';
        editModal.style.opacity = '1';
        editModal.style.visibility = 'visible';
        editModal.style.pointerEvents = 'auto';
        editModal.classList.add('active');

        // 数据回显
        document.getElementById('edit-group-title').value = group.name;
        document.getElementById('edit-group-desc').value = group.desc || '';
        
        let currentCoverBase64 = group.cover;
        const previewImg = document.getElementById('edit-group-cover-preview');
        previewImg.src = currentCoverBase64 || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=200&auto=format&fit=crop";
        // 图片上传逻辑
        const uploadInput = document.getElementById('edit-group-cover-upload');
        // 克隆节点清除旧事件防多次触发
        const newUploadInput = uploadInput.cloneNode(true);
        uploadInput.replaceWith(newUploadInput);
        
        newUploadInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const compressedBase64 = await MusicPlayer.compressImage(file);
                currentCoverBase64 = compressedBase64;
                previewImg.src = currentCoverBase64;
            }
        });

        const saveBtn = document.getElementById('edit-group-save');

        saveBtn.replaceWith(saveBtn.cloneNode(true));
        
        document.getElementById('edit-group-save').onclick = async () => {
            const newName = document.getElementById('edit-group-title').value.trim() || group.name;
            const newDesc = document.getElementById('edit-group-desc').value.trim();

            // 更新对象
            const targetGroup = this.groups.find(g => g.id === group.id);
            if(targetGroup) {
                targetGroup.name = newName;
                targetGroup.desc = newDesc;
                targetGroup.cover = currentCoverBase64;
            }

            await this.saveGroupsToLocal(); // 保存到数据库
            this.renderGroupsToDOM(); // 刷新列表

            // 关闭弹窗
            editModal.classList.remove('active');
            editModal.style.opacity = '0';
            editModal.style.visibility = 'hidden';
            editModal.style.pointerEvents = 'none';
            setTimeout(() => editModal.style.display = 'none', 300);
            
            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`歌单《${newName}》已更新`, 'success');
        };
    },

    // ▼▼▼ [新增] 管理歌单歌曲的独立面板逻辑 ▼▼▼
    openManageGroupSongsModal(group) {
        const modal = document.getElementById('music-manage-group-songs-modal');
        const songSelectionContainer = document.getElementById('manage-group-song-selection');
        const closeBtn = document.getElementById('close-manage-group-songs-btn');
        const confirmBtn = document.getElementById('confirm-manage-group-songs-btn');

        if (!modal || !songSelectionContainer) return;

        // 1. 生成列表并回显打勾状态
        songSelectionContainer.innerHTML = '';
        if (this.globalPlaylist.length === 0) {
            songSelectionContainer.innerHTML = '<div style="padding:15px; color:#999; font-size:12px; text-align:center;">当前总曲库为空，请先添加歌曲</div>';
        } else {
            this.globalPlaylist.forEach((song, idx) => {
                const item = document.createElement('label');
                item.className = 'song-select-item';
                const defaultMiniCover = 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop&grayscale';
                const finalCover = song.cover || defaultMiniCover;
                
                // 判断这首歌是否已经在当前歌单里
                const isChecked = group.songs && group.songs.some(s => s.title === song.title && s.artist === song.artist) ? 'checked' : '';

                item.innerHTML = `
                    <input type="checkbox" value="${idx}" ${isChecked}>
                    <div style="width: 32px; height: 32px; border-radius: 6px; background-image: url('${finalCover}'); background-size: cover; background-position: center; flex-shrink: 0; margin-left: 5px;"></div>
                    <div class="s-info">
                        <span class="s-name">${song.title}</span>
                        <span class="s-artist">${song.artist}</span>
                    </div>
                `;
                songSelectionContainer.appendChild(item);
            });
        }

        // 2. 显示弹窗
        modal.classList.add('active');

        // 3. 弹窗关闭逻辑
        const closeModal = () => modal.classList.remove('active');
        closeBtn.onclick = closeModal;
        const oldClickHandler = modal.onclick;
        if (oldClickHandler) modal.removeEventListener('click', oldClickHandler);
        modal.onclick = (e) => { if(e.target === modal) closeModal(); };

        // 4. 确认保存逻辑 (克隆节点清空旧事件)
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.replaceWith(newConfirmBtn);

        newConfirmBtn.addEventListener('click', async () => {
            const checkboxes = modal.querySelectorAll('input[type="checkbox"]:checked');
            const selectedSongs = Array.from(checkboxes).map(cb => {
                const idx = parseInt(cb.value);
                return this.globalPlaylist[idx]; // 从全局大曲库里抓取完整的歌曲数据
            });

            // 更新当前歌单对象
            const targetGroup = this.groups.find(g => g.id === group.id);
            if(targetGroup) {
                targetGroup.songs = selectedSongs;
            }

            // 保存到本地大数据库
            await this.saveGroupsToLocal();
            // 刷新首页的歌单列表
            this.renderGroupsToDOM();

            // 实时刷新当前正在看的详情页
            const detailSongList = document.getElementById('music-group-detail-song-list');
            const detailCount = document.getElementById('music-group-detail-count');
            if(detailCount) detailCount.textContent = `${selectedSongs.length} 首歌曲`;
            
            if(detailSongList) {
                detailSongList.innerHTML = '';
                if(selectedSongs.length === 0) {
                    detailSongList.innerHTML = '<div style="text-align:center; padding:40px; color:#ccc; font-size:13px;">暂无歌曲</div>';
                } else {
                    selectedSongs.forEach((song, idx) => {
                        const newIndex = idx < 9 ? `0${idx + 1}` : `${idx + 1}`;
                        const songEl = document.createElement('div');
                        songEl.className = 'song-list-item';
                        songEl.innerHTML = `
                            <div class="song-index" style="color:#d43c33;">${newIndex}</div>
                            <div class="song-info">
                                <div class="s-title">${song.title}</div>
                                <div class="s-artist">${song.artist}</div>
                            </div>
                            <button class="song-more">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                            </button>
                        `;
                        songEl.onclick = () => {
                            this.playlist = [...selectedSongs];
                            this.updatePlaylistDrawer(); 
                            this.playSongAtIndex(idx);
                            if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`正在播放: ${song.title}`, 'success');
                        };
                        detailSongList.appendChild(songEl);
                    });
                }
            }
             if(typeof window.showDynamicIsland === 'function') {
                window.showDynamicIsland(`歌单歌曲已更新`, 'success');
            }
            this.updateLikeButtonUI();
            closeModal();
        });
    },


    // ▼▼▼ [新增] 歌单详情里，单首歌曲专属的“移除”悬浮菜单 ▼▼▼
    showGroupSongActionMenu(e, group, songIdx, songEl) {
        let menu = document.getElementById('group-song-context-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'group-song-context-menu';
            // 完美复用你现有的高级毛玻璃菜单样式
            menu.className = 'music-song-context-menu active';
            menu.innerHTML = `
                <div class="menu-item danger" id="group-song-ctx-remove">
                    <div class="icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
                    <span>从歌单中移除</span>
                </div>
            `;
            document.body.appendChild(menu);
            // 点击空白处收起
            document.addEventListener('click', (ev) => {
                if (menu && !menu.contains(ev.target)) {
                    menu.classList.remove('active');
                    setTimeout(() => menu.style.display = 'none', 200);
                }
            });
        }

        // 显示并跟随鼠标点击的位置
        menu.style.display = 'flex';
        void menu.offsetWidth; 
        menu.classList.add('active');
        menu.style.top = (e.clientY + 15) + 'px';
        menu.style.left = (e.clientX + 140 > window.innerWidth) ? (e.clientX - 130) + 'px' : (e.clientX - 20) + 'px';

        // 绑定真正的移除逻辑（先克隆清除旧事件防叠加BUG）
        const removeBtn = document.getElementById('group-song-ctx-remove');
        const newRemoveBtn = removeBtn.cloneNode(true);
        removeBtn.replaceWith(newRemoveBtn);

        newRemoveBtn.onclick = async (ev) => {
            ev.stopPropagation();
            menu.classList.remove('active');
            setTimeout(() => menu.style.display = 'none', 200);

            const songTitle = group.songs[songIdx].title;
            if(confirm(`确定要把《${songTitle}》从本歌单移除吗？`)) {
                
                // 1. 从歌单的数据数组里删掉这首歌
                group.songs.splice(songIdx, 1);
                
                // 2. 永久保存到本地数据库
                await this.saveGroupsToLocal();
                this.renderGroupsToDOM(); // 刷新外层数据
                
                // 3. 在当前列表中加个优雅的消失动画，然后重新排编号
                songEl.style.transform = 'scale(0.95)';
                songEl.style.opacity = '0';
                setTimeout(() => {
                    songEl.remove();
                    // 重新梳理数字序号 01, 02...
                    const list = document.getElementById('music-group-detail-song-list');
                    if (list) {
                        Array.from(list.children).forEach((el, i) => {
                            const idxDiv = el.querySelector('.song-index');
                            if(idxDiv) idxDiv.textContent = i < 9 ? `0${i+1}` : `${i+1}`;
                        });
                    }
                    // 更新顶部“多少首歌曲”的文字
                    const detailCount = document.getElementById('music-group-detail-count');
                    if (detailCount) detailCount.textContent = `${group.songs.length} 首歌曲`;
                    // 如果歌全移除了，显示一个空状态提示
                    if (group.songs.length === 0 && list) {
                        list.innerHTML = '<div style="text-align:center; padding:40px; color:#ccc; font-size:13px;">暂无歌曲</div>';
                    }
                }, 300);

                // ▼▼▼ [新增] 联动刷新播放页面的红心状态 ▼▼▼
                this.updateLikeButtonUI();
                // ▲▲▲ 新增结束 ▲▲▲

                if(typeof window.showDynamicIsland === 'function') window.showDynamicIsland(`已从歌单移除`, 'success');
            }
        };
    },    // ▼▼▼ [新增] 悬浮挂件拖拽与点击引擎 ▼▼▼
    initGlobalWidget() {
        const widget = document.getElementById('global-music-widget');
        const trigger = document.getElementById('music-widget-trigger');
        
        // ▼▼▼ 修改开始：同时获取横条和面板里的按钮 ▼▼▼
        const playBtn = document.getElementById('widget-play-btn');
        const prevBtn = document.getElementById('widget-prev-btn');
        const nextBtn = document.getElementById('widget-next-btn');
        const panelPlayBtn = document.getElementById('widget-panel-play-btn');
        const panelPrevBtn = document.getElementById('widget-panel-prev-btn');
        const panelNextBtn = document.getElementById('widget-panel-next-btn');
        // ▲▲▲ 修改结束 ▲▲▲

        const expandBtn = document.getElementById('widget-expand-btn');

        const closeBtn = document.getElementById('widget-close-btn'); // 收起小窗
        const forceCloseBtn = document.getElementById('widget-force-close-btn'); // 彻底关闭侧边栏
        const inviteBtn = document.getElementById('widget-invite-btn');

        if (!widget || !trigger) return;

        // 1. 核心可见性检查：由页面切换和播放状态变化触发，避免后台空转轮询
        const updateWidgetVisibility = () => {
            const memoPage = document.getElementById('page-memo');
            if(!memoPage) return;
             // 如果点过播放，且没有被用户强行点X关掉
            if (this.hasActivatedWidget && !this.widgetForceClosed) {
                // 检查音乐主页是否显示 (非 'none')
                const isMemoVisible = memoPage.style.display !== 'none';
                if (isMemoVisible) {
                    requestAnimationFrame(() => {
                        this.handleTimeUpdate();
                        this.syncLyrics(true);
                    });
                }
                if (isMemoVisible) {
                    widget.style.display = 'none'; // 在音乐界面里，隐藏挂件

                } else {
                    widget.style.display = 'flex'; // 离开音乐界面，显示挂件
                }
            } else {
                widget.style.display = 'none';
            }
        };
        this.updateGlobalWidgetVisibility = updateWidgetVisibility;
        window.addEventListener('looky:page-opened', updateWidgetVisibility);
        updateWidgetVisibility();

        // 2. 听歌时长累加器
        setInterval(() => {
            if(this.isPlaying) {
                this.totalListenSeconds++;
                const m = Math.floor(this.totalListenSeconds / 60).toString().padStart(2, '0');
                const s = (this.totalListenSeconds % 60).toString().padStart(2, '0');
                
                const timeEl = document.getElementById('widget-total-listen-time');
                if(timeEl) {
                    // 只显示 mm:ss，如果是超长则算成小时，这里简写处理
                    const h = Math.floor(this.totalListenSeconds / 3600);
                    if (h > 0) {
                        const hrM = Math.floor((this.totalListenSeconds % 3600) / 60).toString().padStart(2, '0');
                        timeEl.textContent = `${h}:${hrM}:${s}`;
                    } else {
                        timeEl.textContent = `${m}:${s}`;
                    }
                }
            }
        }, 1000);
        // 3. 按钮功能绑定
        playBtn.addEventListener('click', (e) => { e.stopPropagation(); this.togglePlay(); });
        prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playPrev(); });
        nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playNext(); });
        
        // ▼▼▼ 新增：绑定面板内按钮的功能 ▼▼▼
        panelPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); this.togglePlay(); });
        panelPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playPrev(); });
        panelNextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.playNext(); });
        // ▲▲▲ 新增结束 ▲▲▲

        // 展开面板

        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            widget.classList.add('panel-active');
        });
        
        // 仅仅收起面板
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            widget.classList.remove('panel-active');
            widget.classList.remove('bar-active');
        });

        // 彻底关闭侧边栏
        forceCloseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            widget.classList.remove('panel-active');
            widget.classList.remove('bar-active');
            this.widgetForceClosed = true; // 强制隐藏
            updateWidgetVisibility();
            if(typeof window.showDynamicIsland === 'function'){
                window.showDynamicIsland('侧边栏已关闭，再次播放即可唤醒', 'info');
            }
        });

         // ▼▼▼ 【重构】邀请按钮功能：弹出选人弹窗，建立专属防冲突状态 ▼▼▼
        
        // 【新增】封装标准的弹窗关闭函数，处理透明度动画
        const closeInviteModal = () => {
            const inviteModal = document.getElementById('music-invite-modal-overlay');
            if (!inviteModal) return;
            inviteModal.classList.remove('active');
            inviteModal.style.opacity = '0';
            inviteModal.style.visibility = 'hidden';
            inviteModal.style.pointerEvents = 'none';
            setTimeout(() => inviteModal.style.display = 'none', 300);
        };

        inviteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 【核心修复1】阻止事件冒泡导致挂件错误收起
            const inviteModal = document.getElementById('music-invite-modal-overlay');
            const charListContainer = document.getElementById('music-invite-char-list');
            
            if (inviteModal && charListContainer) {
                // 1. 获取聊天列表中的好友数据
                let contacts = [];
                const friendItems = document.querySelectorAll('.conversation-item');
                friendItems.forEach(item => {
                    const nameEl = item.querySelector('.chat-name');
                    const avatarEl = item.querySelector('.chat-avatar');
                    const charId = item.dataset.charId; 
                    if (nameEl && avatarEl && charId && nameEl.textContent.trim() !== '角色名') {
                        contacts.push({ id: charId, name: nameEl.textContent.trim(), avatar: avatarEl.src });
                    }
                });

                charListContainer.innerHTML = '';
                if (contacts.length === 0) {
                    charListContainer.innerHTML = '<div style="text-align:center; padding:20px; color:#999; font-size:14px;">请先在通讯录中添加好友哦</div>';
                } else {
                    contacts.forEach(char => {
                        const charEl = document.createElement('div');
                        charEl.style.cssText = 'display: flex; align-items: center; padding: 10px; border-radius: 12px; background: #f9f9f9; cursor: pointer; transition: background 0.2s;';
                        charEl.innerHTML = `
                            <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                            <span style="font-size: 15px; font-weight: 600; color: #333; flex: 1;">${char.name}</span>
                            <button style="background: #111; color: #fff; border: none; padding: 6px 16px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;">邀请</button>
                        `;
                        // 2. 点击邀请 (重构版：精准头像 + 重置计时 + 系统消息 + 隐形AI触发)
                        charEl.onclick = async () => {
                            closeInviteModal();
                            widget.classList.remove('panel-active', 'bar-active');
                            
                            // 暂存角色信息，等待 AI 决定后再启动 UI
                            this.currentListeningChar = char;
                            
                            // ▼▼▼ 修复头像空白问题 ▼▼▼
                            let finalUserAvatar = 'images/default-avatar.svg';
                            try {
                                const { AppState } = await import('../state.js');
                                const targetChar = AppState.characterProfiles.find(c => c.id === char.id);
                                if (targetChar) {
                                    const identityId = targetChar.chatIdentityId || AppState.currentIdentityId;
                                    const identity = AppState.userIdentities.find(id => id.id === identityId) || AppState.userIdentities[0];
                                    finalUserAvatar = targetChar.chatOverrideUserAvatar || (identity ? identity.avatar : 'images/default-avatar.svg');
                                }
                                // 把获取到的正确头像赋给侧边栏UI
                                const userAvatarEl = document.getElementById('listening-user-avatar');
                                const charAvatarEl = document.getElementById('listening-char-avatar');
                                if(userAvatarEl) userAvatarEl.src = finalUserAvatar;
                                if(charAvatarEl) charAvatarEl.src = char.avatar;
                            } catch(err){ console.error('获取专属头像失败', err); }
                            // ▲▲▲ 修复结束 ▲▲▲

                            try {
                                const { db, tempState, AppState } = await import('../state.js');
                                const { createAndAppendMessage } = await import('./chat-ui.js');
                                const { triggerAiResponse } = await import('./chat-service.js');

                                const currentSong = MusicPlayer.playlist[MusicPlayer.currentIndex];
                                const songName = currentSong ? currentSong.title : '未知歌曲';
                                
                                // ▼▼▼ 替换开始 ▼▼▼
                                // 1. 在屏幕上生成一条【纯UI展示】的灰色系统胶囊，提示用户主动发消息
                                const visualMsg = {
                                    chatId: char.id,
                                    timestamp: new Date(),
                                    text: `🎵 发起了沉浸陪伴: 一起听《${songName}》。 (请发送任意消息以获取对方回应)`, 
                                    type: 'system', 
                                    contentType: 'system_event', 
                                    eventType: 'info', 
                                    uiVisible: true,
                                    aiVisible: false, // 对AI隐身
                                    recalled: false
                                };
                                const visualMsgId = await db.chatMessages.add(visualMsg);
                                
                                // 2. 向数据库塞入上帝指令，等用户下次说话时，AI 就会顺带处理这个请求
                                const hiddenPromptMsg = {
                                    chatId: char.id,
                                    timestamp: new Date(Date.now() + 10), 
                                    text: `<[系统强制指令：用户邀请你一起听歌《${songName}》。在你接下来的回复中，你必须包含一个 "music_decision" 的 JSON 对象来做决定（accept/reject/change）。]>`, 
                                    type: 'sent', 
                                    uiVisible: false, 
                                    aiVisible: true,  
                                    recalled: false
                                };
                                const hiddenMsgId = await db.chatMessages.add(hiddenPromptMsg);

                                // 渲染UI，【注意：删除了之前的 triggerAiResponse 自动触发】
                                if (String(char.id) === String(tempState.currentChatId)) {
                                    const newVisualMsg = await db.chatMessages.get(visualMsgId);
                                    const newHiddenMsg = await db.chatMessages.get(hiddenMsgId);
                                    AppState.currentChatHistory.push(newVisualMsg);
                                    AppState.currentChatHistory.push(newHiddenMsg);
                                            if (typeof createAndAppendMessage === 'function') {
                                        await createAndAppendMessage(newVisualMsg); 
                                    }
                                    // 删除了原本在这里的 triggerAiResponse，这样AI就不会立刻回复了
                                }
                            } catch(err) { console.error("发送一起听邀请失败", err); }
                        };

                        charListContainer.appendChild(charEl);
                    });
                }
                
                // 【核心修复2】强制覆盖透明度、可见性和指针事件，使其弹窗显现
                inviteModal.style.display = 'flex';
                // 强制浏览器重绘以触发动画
                void inviteModal.offsetWidth; 
                inviteModal.style.opacity = '1';
                inviteModal.style.visibility = 'visible';
                inviteModal.style.pointerEvents = 'auto';
                inviteModal.classList.add('active');
            }
        });
        
        // ▼▼▼ 绑定停止一起听按钮 ▼▼▼
        const stopListenBtn = document.getElementById('widget-stop-listen-btn');
        if (stopListenBtn) {
            stopListenBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if(this.listenSessionInterval) clearInterval(this.listenSessionInterval);
                const charName = this.currentListeningChar ? this.currentListeningChar.name : '';
                this.currentListeningChar = null; // 解除角色锁定
                
                // 恢复 邀请 UI
                const listeningStatus = document.getElementById('widget-listening-status');
                if(listeningStatus) listeningStatus.style.display = 'none';
                inviteBtn.style.display = 'flex';

                if(typeof window.showDynamicIsland === 'function'){
                    window.showDynamicIsland(`已结束与 ${charName} 的一起听`, 'info');
                }
            });
        }

        // ▼▼▼ 选人弹窗关闭事件 ▼▼▼
        const closeInviteBtn = document.getElementById('music-invite-close-btn');
        const inviteModal = document.getElementById('music-invite-modal-overlay');
        if (closeInviteBtn && inviteModal) {
            closeInviteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeInviteModal();
            });
            // 点击黑色遮罩层关闭
            inviteModal.addEventListener('click', (e) => {
                if(e.target === inviteModal) closeInviteModal();
            });
        }
        // ▲▲▲ 重构结束 ▲▲▲


        // ==== 4. 拖拽与吸附逻辑 ====
        let isDragging = false;
        let startX, startY, initialX, initialY;
        const phoneScreen = document.querySelector('.phone-screen');

        trigger.addEventListener('touchstart', (e) => {
            isDragging = false;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            const rect = widget.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            widget.style.transition = 'none'; // 拖拽时取消过渡
        }, {passive: true});

        trigger.addEventListener('touchmove', (e) => {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging = true;
            
            if (isDragging) {
                // 如果拖拽时面板开着，强制关掉
                widget.classList.remove('bar-active', 'panel-active');
                
                let newX = initialX + dx;
                let newY = initialY + dy;
                
                // 获取容器边界，防越界
                const pRect = phoneScreen.getBoundingClientRect();
                const wRect = widget.getBoundingClientRect();
                
                if (newX < pRect.left) newX = pRect.left;
                if (newX > pRect.right - wRect.width) newX = pRect.right - wRect.width;
                if (newY < pRect.top + 40) newY = pRect.top + 40; // 避开状态栏
                if (newY > pRect.bottom - wRect.height) newY = pRect.bottom - wRect.height;

                widget.style.left = `${newX - pRect.left}px`;
                widget.style.top = `${newY - pRect.top}px`;
                widget.style.right = 'auto'; // 拖拽中解除 right 约束
            }
        }, {passive: true});

        trigger.addEventListener('touchend', (e) => {
            widget.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
            
            if (!isDragging) {
                // 是点击事件，处理菜单收放
                if (widget.classList.contains('panel-active')) return;
                widget.classList.toggle('bar-active');
                return;
            }

            // 是拖拽结束，处理四边吸附
            const pRect = phoneScreen.getBoundingClientRect();
            const wRect = widget.getBoundingClientRect();
            
            const distLeft = wRect.left - pRect.left;
            const distRight = pRect.right - wRect.right;
            const distTop = wRect.top - pRect.top;
            const distBottom = pRect.bottom - wRect.bottom;
            
            const minDist = Math.min(distLeft, distRight, distTop, distBottom);
            
            // 清除旧的状态
            widget.classList.remove('edge-left', 'edge-right', 'edge-top', 'edge-bottom');
            
            // 吸附到最近的边
            if (minDist === distLeft) {
                widget.style.left = '-5px';
                widget.style.right = 'auto';
                widget.classList.add('edge-left');
            } else if (minDist === distRight) {
                widget.style.left = 'auto';
                widget.style.right = '-5px';
                widget.classList.add('edge-right');
            } else if (minDist === distTop) {
                widget.style.top = '-5px';
                widget.classList.add('edge-top');
            } else {
                widget.style.top = 'auto';
                widget.style.bottom = '-5px';
                widget.classList.add('edge-bottom');
            }
        });
        
    }

};


