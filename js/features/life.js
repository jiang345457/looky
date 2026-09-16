import { showDynamicIsland, showPage } from '../ui.js';
import { getAllCharacters as _originalGetAllCharacters } from './character.js'; // <-- 改名原接口
import { activateFlightState, updateFlightCapsuleDisplay } from './flight.js'; 

// ▼▼▼ 群聊魔法拦截器：自动将所有商城弹窗限制为只显示群成员 ▼▼▼
async function getAllCharacters() {
    const chars = await _originalGetAllCharacters();
    const currChat = AppState.characterProfiles.find(c => String(c.id) === String(tempState.currentChatId));
    // 如果当前是在群里买，就只显示群友；如果在单聊，保持原有逻辑
    if (currChat && currChat.isGroup) return chars.filter(c => (currChat.memberIds || []).some(id => String(id) === String(c.id)));
    return chars;
}
// ▲▲▲ 拦截器结束 ▲▲▲

import { tempState, AppState, db } from '../state.js'; 
import { sendReceiptMessage, sendPayRequestMessage } from './chat-ui.js';
import { recordLookyLedger, requestLookyPayment } from './looky-pay.js';
// 初始化“生活”页面的所有交互
export function initLifePage() {
    const lifePage = document.getElementById('page-life');
    if (!lifePage) return; // 如果页面不存在，就什么也不做
  const contentContainer = lifePage.querySelector('.life-content-container');
    const topBar = lifePage.querySelector('#life-top-bar');
    // 我们设定一个阈值，比如 100px (大约是大标题消失的位置)
    const triggerHeight = 100; 
    if (contentContainer && topBar) {
            contentContainer.addEventListener('scroll', function() {
            // 如果滚动的距离(scrollTop) 大于 设定高度
            if (contentContainer.scrollTop > triggerHeight) {
                topBar.classList.add('scrolled'); // 加上变色样式
            } else {
                topBar.classList.remove('scrolled'); // 移除样式，变回透明
            }
        }, { passive: true });
    }
    // 找到服务网格容器
    const servicesGrid = lifePage.querySelector('.life-services-grid');
    if (!servicesGrid) return;

    // 为服务网格添加点击事件监听
    servicesGrid.addEventListener('click', (e) => {
        // 找到被点击的具体服务项
        const serviceItem = e.target.closest('.service-item');
        if (!serviceItem) return;

        // 获取服务类型 (food, ride, shop, movie)
        const serviceType = serviceItem.dataset.service;
        
        // 根据不同类型显示不同的提示信息
        switch (serviceType) {
            case 'food':
            if (typeof showPage === 'function') {
                    showPage('page-life-food'); 
                } else {
                    // 备用方案：手动显示
                    document.querySelectorAll('.app-page').forEach(p => p.classList.remove('active', 'page-active'));
                    document.getElementById('page-life-food').classList.add('active', 'page-active');
                }
                break;
            case 'ride':
                // 修改：不再显示小提示，而是直接打开新页面
                if (typeof showPage === 'function') {
                    showPage('page-life-ride');
                }
                break;
          case 'shop':
                if (typeof showPage === 'function') {
                    showPage('page-life-shop');
                }
                break;
            case 'movie':
                showDynamicIsland('正在查询热映影片...', 'info');
                break;
            default:
                showDynamicIsland('此功能正在开发中', 'warning');
        }

        // 这里可以为你将来扩展功能，例如：
        // showPage(`page-life-${serviceType}`);
    });
    const feedList = lifePage.querySelector('.feed-list');
    if (feedList) {
        feedList.addEventListener('click', (e) => {
            const shopItem = e.target.closest('.feed-item');
            if (!shopItem) return;
            // 获取商家名字
            const shopName = shopItem.querySelector('.shop-name').textContent;
            showDynamicIsland(`正在进入 ${shopName}...`, 'success');
        });
    }
    // --- 【新增】外卖页面的滑动监听逻辑 ---
    // 1. 获取外卖页面元素
    const foodPage = document.getElementById('page-life-food');
    // 2. 确保页面存在再执行
    if (foodPage) {
        // 3. 找到滚动的容器 (content-wrapper) 和 顶栏 (header)
        const foodScrollContainer = foodPage.querySelector('.food-content-wrapper');
        const foodHeader = foodPage.querySelector('.food-header');

        // 4. 如果元素都找到了，添加监听
        if (foodScrollContainer && foodHeader) {
            // 注意：这里我们监听整个 page-life-food 的滚动，或者是 wrapper 的滚动
            // 通常 app-page 是 overflow-y: auto 的容器，所以监听 foodPage 自身或者 wrapper
            // 建议直接监听 content-wrapper 的父级，或者 foodPage 本身，取决于你的 main.css 如何定义滚动容器
            // 在你的结构中，app-content通常是滚动区域，所以我们监听 foodScrollContainer
            
            foodScrollContainer.addEventListener('scroll', () => {
                const scrollTop = foodScrollContainer.scrollTop;
                // 当滑动超过 40px 时，添加 scrolled 类名（变白）；否则移除（变透明）
                if (scrollTop > 40) {
                    foodHeader.classList.add('scrolled');
                } else {
                    foodHeader.classList.remove('scrolled');
                }
            }, { passive: true });
        }
    }
    // --- 【新增】外卖分类筛选逻辑 ---
    // 1. 找到所有的分类按钮
    const catPills = foodPage ? foodPage.querySelectorAll('.cat-pill') : [];
    const foodSearchInput = document.getElementById('food-search-input');
    // 卡片会在运行时从本地数据重新渲染，因此每次筛选都重新查询 DOM。
    const getFoodCards = () => foodPage ? foodPage.querySelectorAll('.food-card') : [];
    const getSelectedFoodType = () => {
        const activeCat = foodPage?.querySelector('.cat-pill.active');
        return activeCat?.getAttribute('data-type') || 'all';
    };
    const applyFoodFilters = () => {
        const keyword = foodSearchInput?.value.trim().toLowerCase() || '';
        const selectedType = getSelectedFoodType();

        getFoodCards().forEach(card => {
            const name = card.querySelector('h3')?.textContent.toLowerCase() || '';
            const cardType = card.getAttribute('data-type');
            const replacedByCustomCard = card.dataset.replaced === 'true';
            card.hidden = replacedByCustomCard || !(
                name.includes(keyword) &&
                (selectedType === 'all' || cardType === selectedType)
            );
        });
    };

    // 3. 给每个按钮添加点击事件
    catPills.forEach(pill => {
        pill.addEventListener('click', () => {
            // A. 切换选中状态样式
            // 先移除所有按钮的 active 类
            catPills.forEach(p => p.classList.remove('active'));
            // 再给当前点击的按钮加上 active 类
            pill.classList.add('active');

            // B. 分类和搜索条件统一应用，避免相互覆盖
            applyFoodFilters();
        });
    });
    // --- 【新增】外卖搜索框过滤逻辑 ---
    if (foodSearchInput) foodSearchInput.addEventListener('input', applyFoodFilters);
    // --- 【新增】商品详情弹窗交互逻辑 ---
    const foodGrid = foodPage.querySelector('#food-grid');
    const detailModalOverlay = document.getElementById('food-detail-modal-overlay');
    const detailModalCard = detailModalOverlay ? detailModalOverlay.querySelector('.food-detail-card') : null;
    const closeDetailBtn = detailModalOverlay ? detailModalOverlay.querySelector('.food-detail-close-btn') : null;

    if (foodGrid && detailModalOverlay && detailModalCard && closeDetailBtn) {
        // 1. 点击商品卡片，打开弹窗
        foodGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.food-card');
            if (!card) return;

            // 从卡片获取数据
            const name = card.querySelector('h3').textContent;
            const price = card.querySelector('.card-meta span:first-child').textContent.replace('¥', '').replace('起', '');
            const rating = card.querySelector('.star').textContent;
            const time = card.querySelector('.delivery-time').textContent;
            const image = card.querySelector('.card-img').style.backgroundImage;
            
            // 填充数据到详情弹窗
            detailModalOverlay.querySelector('#food-detail-name').textContent = name;
            detailModalOverlay.querySelector('#food-detail-price').textContent = price;
            detailModalOverlay.querySelector('#footer-price').textContent = price;
            detailModalOverlay.querySelector('#food-detail-rating').textContent = rating;
            detailModalOverlay.querySelector('#food-detail-time').textContent = `约${time}`;
            detailModalOverlay.querySelector('#food-detail-img').style.backgroundImage = image;

            // 显示弹窗
            detailModalOverlay.classList.add('visible');
        });

        // 2. 点击关闭按钮或遮罩层，关闭弹窗
        const closeAction = () => {
            detailModalOverlay.classList.remove('visible');
        };

        closeDetailBtn.addEventListener('click', closeAction);
        detailModalOverlay.addEventListener('click', (e) => {
            // 如果点击的是遮罩层本身（而不是卡片内容），则关闭
            if (e.target === detailModalOverlay) {
                closeAction();
            }
        });

        // 3. 点击加入购物车按钮
        const addToCartBtn = detailModalOverlay.querySelector('.add-to-cart-btn');
        addToCartBtn.addEventListener('click', () => {
            showDynamicIsland('已加入购物车', 'success');
        });
        
    }
     // --- 【终极版】商品管理逻辑：添加、渲染、详情、删除、编辑 ---
    const addFoodBtn = foodPage.querySelector('.food-add-btn');
    const addFoodModalOverlay = document.getElementById('add-food-modal-overlay');
    
    // 获取详情弹窗相关元素
    const detailOverlay = document.getElementById('food-detail-modal-overlay');
    const detailEditBtn = document.getElementById('food-detail-edit-btn');
    const detailDeleteBtn = document.getElementById('food-detail-delete-btn');
    let currentEditingId = null; 
    if (addFoodBtn && addFoodModalOverlay) {

        // ============================
        // 1. 核心工具函数
        // ============================
        
        // 读取所有数据
        const getStoredFoods = () => {
            return JSON.parse(localStorage.getItem('my_life_food_v3') || '[]');
        };

        // 保存所有数据
        const saveStoredFoods = (foods) => {
            try {
                localStorage.setItem('my_life_food_v3', JSON.stringify(foods));
            } catch (e) {
                console.error("保存失败", e);
                // 如果错误包含 Quota，说明是满了
                if (e.name === 'QuotaExceededError' || e.toString().includes('Quota')) {
                    alert('保存失败：存储空间已满。\n\n外卖数据使用的是浏览器缓存(仅5MB)，请删除一些旧商品后再试，或者上传更小的图片。');
                } else {
                    alert('保存失败：' + e.message);
                }
            }
        };
const FOOD_DESCRIPTIONS = {
            '意式罗勒披萨': '新鲜的罗勒叶与马苏里拉芝士的完美结合，每一口都是浓郁的意式风情。薄底脆边，回味无穷。',
            '美式汉堡王': '100%纯牛肉饼，搭配酸黄瓜、洋葱圈和秘制酱料，给你带来最经典的美式快餐体验。',
            '轻食沙拉碗': '新鲜时蔬、烤鸡胸肉与藜麦的健康组合，配上清爽的油醋汁，是健身人士的首选。',
            '日式豚骨拉面': '熬制8小时的浓郁豚骨汤底，搭配溏心蛋和叉烧，每一口都是满满的幸福感。',
            '海鲜墨鱼面': 'Q弹的墨鱼汁面条，配上新鲜的虾仁、鱿鱼和青口，仿佛置身地中海的阳光沙滩。',
            '健康全麦饭': '粗粮爱好者的福音，搭配多种蔬菜和低脂鸡胸肉，营养均衡无负担。',
            '波霸奶茶': '香醇的红茶与牛奶，加入Q弹软糯的黑糖波霸，是下午茶的最佳伴侣。',
            // 你可以继续为其他商品添加描述...
        };
        // 渲染单个卡片 (HTML)
        const renderFoodCard = (data) => {
            // 注意：我们把 ID 存到了 data-id 属性里，这很重要！
            const newCardHTML = `
                <div class="food-card" data-type="${data.category}" data-id="${data.id}">
                    <div class="card-img" style="height: 180px; background-image: url('${data.imageUrl}');">
                        <div class="delivery-time">${data.time} min</div>
                    </div>
                    <div class="card-info">
                       <h3>${data.name}</h3>
                        <div class="card-meta">
                            <span>¥${data.price}起</span>
                            <span class="sales">月售 ${data.sales || '0+'}</span>
                            <span class="star">★ ${data.rating}</span>
                        </div>
                    </div>
                </div>
            `;
            const foodGrid = document.getElementById('food-grid');
            if (foodGrid) {
                foodGrid.insertAdjacentHTML('afterbegin', newCardHTML);
            }
        };
        // 刷新整个列表 (删除或编辑后使用)
        const refreshGrid = () => {
            // 1. 移除所有自定义卡片 (带有 data-id 的)
            const customCards = document.querySelectorAll('.food-card[data-id]');
            customCards.forEach(card => card.remove());
            // 2. 重新加载自定义卡片
            const foods = getStoredFoods();
            foods.forEach(food => renderFoodCard(food));
            
            // 3. 【修改3】同名覆盖机制：隐藏已经被用户换过图的旧版内置商品
            const customNames = foods.map(f => f.name);
            const builtInCards = document.querySelectorAll('.food-card:not([data-id])');
            builtInCards.forEach(card => {
                const title = card.querySelector('h3').textContent;
                if (customNames.includes(title)) {
                    card.dataset.replaced = 'true';
                } else {
                    delete card.dataset.replaced;
                }
            });
            applyFoodFilters();
        };

        // 初始化加载
        refreshGrid();


        // ============================
        // 2. 详情弹窗逻辑 (点击卡片)
        // ============================
        const foodGrid = document.getElementById('food-grid');
        // ============================
        // 2. 详情弹窗逻辑 (点击卡片) - 【修改版】
        // ============================
        if (foodGrid) {
            foodGrid.addEventListener('click', (e) => {
                const card = e.target.closest('.food-card');
                if (!card) return;

                const cardId = card.getAttribute('data-id');
                currentEditingId = cardId; 

                // --- 填充详情数据 ---
                const name = card.querySelector('h3').textContent;
                const priceText = card.querySelector('.card-meta span:first-child').textContent;
                const price = priceText.replace('¥', '').replace('起', '');
                const rating = card.querySelector('.star').textContent;
                const time = card.querySelector('.delivery-time').textContent;
                const sales = card.querySelector('.sales')?.textContent || '月售 0+';
                const image = card.querySelector('.card-img').style.backgroundImage;

                // ▼▼▼【核心修改：动态设置描述文字】▼▼▼
                let description;
                if (cardId) {
                    // 对于自定义商品，从存储中获取描述
                    const foods = getStoredFoods();
                    const foodData = foods.find(f => String(f.id) === String(cardId));
                    description = foodData?.description || '店主很懒，还没有给这个商品写简介哦~';
                } else {
                    // 对于预设商品，沿用旧逻辑
                    description = FOOD_DESCRIPTIONS[name] || '店主很懒，还没有给这个商品写简介哦~';
                }

                // 更新到弹窗里
                if(detailOverlay) {
                    detailOverlay.querySelector('#food-detail-desc').textContent = description;
                }
                // ▲▲▲ 修改结束 ▲▲▲

                if(detailOverlay) {
                    detailOverlay.querySelector('#food-detail-name').textContent = name;
                    detailOverlay.querySelector('#food-detail-price').textContent = price;
                    detailOverlay.querySelector('#footer-price').textContent = price;
                    detailOverlay.querySelector('#food-detail-rating').textContent = rating;
                    detailOverlay.querySelector('#food-detail-sales').textContent = sales;
                    detailOverlay.querySelector('#food-detail-time').textContent = `约${time}`;
                    detailOverlay.querySelector('#food-detail-img').style.backgroundImage = image;
                    if (cardId) {
                        if(detailEditBtn) detailEditBtn.style.display = 'flex';
                        if(detailDeleteBtn) detailDeleteBtn.style.display = 'flex';
                    } else {
                        // 【修改1】让内置商品也能显示编辑按钮，从而支持换图
                        if(detailEditBtn) detailEditBtn.style.display = 'flex'; 
                        if(detailDeleteBtn) detailDeleteBtn.style.display = 'none';
                    }

                    detailOverlay.classList.add('visible');

                }
            });
        }


        // 详情页的关闭按钮逻辑
        const detailCloseBtn = detailOverlay ? detailOverlay.querySelector('.food-detail-close-btn') : null;
        if(detailCloseBtn) {
            detailCloseBtn.addEventListener('click', () => {
                detailOverlay.classList.remove('visible');
                currentEditingId = null; // 清除选中状态
            });
        }


        // ============================
        // 3. 删除逻辑
        // ============================
        if (detailDeleteBtn) {
            detailDeleteBtn.addEventListener('click', () => {
                if (!currentEditingId) return;
                
                if (confirm('确定要删除这个商品吗？')) {
                    const foods = getStoredFoods();
                    // 过滤掉当前ID的商品
                    const newFoods = foods.filter(f => String(f.id) !== String(currentEditingId));
                    saveStoredFoods(newFoods);
                    
                    refreshGrid(); // 刷新界面
                    detailOverlay.classList.remove('visible'); // 关闭详情
                    showDynamicIsland('商品已删除', 'success');
                }
            });
        }


        // ============================
        // 4. 编辑逻辑 (点击铅笔图标)
         if (detailEditBtn) {
            detailEditBtn.addEventListener('click', () => {
                // 1. 关闭详情页
                detailOverlay.classList.remove('visible');
                
                // 2. 获取商品数据 (如果是内置商品，则直接抓取屏幕上的文字)
                let foodData;
                if (currentEditingId) {
                    const foods = getStoredFoods();
                    foodData = foods.find(f => String(f.id) === String(currentEditingId));
                } else {
                    foodData = {
                        name: document.getElementById('food-detail-name').textContent,
                        price: document.getElementById('food-detail-price').textContent,
                        category: document.querySelector('.cat-pill.active')?.getAttribute('data-type') || 'fastfood',
                        rating: document.getElementById('food-detail-rating').textContent.replace('★', '').trim(),
                        sales: document.getElementById('food-detail-sales').textContent,
                        time: document.getElementById('food-detail-time').textContent.replace('约', '').replace('分钟', ''),
                        description: document.getElementById('food-detail-desc').textContent,
                        imageUrl: document.getElementById('food-detail-img').style.backgroundImage.slice(5, -2).replace(/['"]/g, "")
                    };
                }
                if (!foodData) return;

                // 3. 填充“添加弹窗”的表单
                document.getElementById('add-food-name-input').value = foodData.name;

                document.getElementById('add-food-price-input').value = foodData.price;
                document.getElementById('add-food-category-select').value = foodData.category;

                document.getElementById('add-food-rating-input').value = foodData.rating.replace('★', '').trim();
                // ▼▼▼【新增的修复代码】把月售数据也填充到编辑框 ▼▼▼
                document.getElementById('add-food-sales-input').value = foodData.sales || '';
                document.getElementById('add-food-time-input').value = foodData.time;
                document.getElementById('add-food-desc-textarea').value = foodData.description || '';

                const preview = document.getElementById('add-food-image-preview');

                const placeholder = document.getElementById('image-upload-placeholder');

                preview.src = foodData.imageUrl;
                preview.style.display = 'block';
                if(placeholder) placeholder.style.display = 'none';
                // 4. 打开“添加弹窗” (此时变成了编辑模式)
                // 改变按钮文字，让用户知道是在修改
                const saveBtn = document.getElementById('save-new-food-btn');
                saveBtn.textContent = "保存修改";
                
                // 【修复1】如果编辑的是内置商品(无ID)，则转为“新增覆盖”模式，保证图片能存入数据库
                if (currentEditingId && currentEditingId !== 'null') {
                    saveBtn.dataset.mode = "edit"; 
                    saveBtn.dataset.editId = currentEditingId; 
                } else {
                    saveBtn.dataset.mode = "add"; 
                    saveBtn.removeAttribute('data-edit-id');
                }

                addFoodModalOverlay.classList.add('visible');

            });
        }


        // ============================
        // 5. 添加/保存弹窗逻辑
        // ============================
        
        // 打开添加弹窗 (点击右上角加号)
        addFoodBtn.addEventListener('click', () => {
            // 重置表单状态为“新增模式”
            document.querySelector('.add-food-card form')?.reset(); // 如果有form标签
            // 手动清空
            document.getElementById('add-food-name-input').value = '';
            document.getElementById('add-food-price-input').value = '';
            const preview = document.getElementById('add-food-image-preview');
            const placeholder = document.getElementById('image-upload-placeholder');
            preview.src = '';
            preview.style.display = 'none';
            if(placeholder) placeholder.style.display = 'flex';

            const saveBtn = document.getElementById('save-new-food-btn');
            saveBtn.textContent = "确认上架";
            saveBtn.dataset.mode = "add"; // 标记为新增模式
            saveBtn.removeAttribute('data-edit-id');

            addFoodModalOverlay.classList.add('visible');
        });

        // 关闭添加弹窗
        document.getElementById('add-food-close-btn').addEventListener('click', () => {
            addFoodModalOverlay.classList.remove('visible');
        });

        // 图片选择预览
        const imgInput = document.getElementById('add-food-image-input');
        if (imgInput) {
            imgInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                     e.target.value = ''; 
            const reader = new FileReader();
            reader.onload = (evt) => {
                        // 【优化】创建一个图片对象来压缩，防止图片过大撑爆 localStorage
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                          const MAX_WIDTH = 300; 
                            let width = img.width;
                            let height = img.height;
                            
                            // 如果图片太宽，等比例缩小
                            if (width > MAX_WIDTH) {
                                height *= MAX_WIDTH / width;
                                width = MAX_WIDTH;
                            }
                            canvas.width = width;
                            canvas.height = height;
                            
                            // 把图片画在画布上并压缩质量到 0.7
                            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.5);

                            const preview = document.getElementById('add-food-image-preview');
                            preview.src = compressedDataUrl; // 使用压缩后的图片
                            preview.style.display = 'block';
                            document.getElementById('image-upload-placeholder').style.display = 'none';
                        };
                        img.src = evt.target.result;
                    };
                     reader.readAsDataURL(file);
                }
            });
        }

        // --- 最终保存按钮 (处理新增 和 编辑) ---
        const saveFoodBtn = document.getElementById('save-new-food-btn');
        if (saveFoodBtn) {
            saveFoodBtn.addEventListener('click', () => {
                // 获取输入值
                const name = document.getElementById('add-food-name-input').value.trim();
                const price = document.getElementById('add-food-price-input').value;
                const category = document.getElementById('add-food-category-select').value;
                const rating = document.getElementById('add-food-rating-input').value || '5.0';
                const sales = document.getElementById('add-food-sales-input').value || '0+';
             const time = document.getElementById('add-food-time-input').value || '25';
// 1. 获取当前预览图的 src
let imageUrl = document.getElementById('add-food-image-preview').src;
const description = document.getElementById('add-food-desc-textarea').value.trim();

// 2. 智能判断：如果图片是空的（或者是当前网址），说明用户没传图
// 我们给它一个默认的灰色占位图，这样就不会报错，界面也不会崩
if (!imageUrl || imageUrl === window.location.href || document.getElementById('add-food-image-preview').style.display === 'none') {
    imageUrl = 'https://placehold.co/400x300/E0E0E0/999999?text=No+Image';
}

// 3. 修改验证逻辑：只检查名字和价格，删掉了 imageUrl 的检查
if (!name || !price) {
    showDynamicIsland('请至少填写商品名称和价格', 'error');
    return;
}


                const isEditMode = saveFoodBtn.dataset.mode === 'edit';
                let foods = getStoredFoods();

                if (isEditMode) {
                    // --- 编辑模式 ---
                    const editId = saveFoodBtn.dataset.editId;
                    // 找到原来的数据并更新，保留ID不变
                    const index = foods.findIndex(f => String(f.id) === String(editId));
                    if (index !== -1) {
                foods[index] = {
                            ...foods[index], // 保留原属性
                            name, price, category, rating, sales, time, imageUrl, description // 更新新属性
                        };
                        showDynamicIsland('修改已保存', 'success');
                    }
                } else {
                    // --- 新增模式 ---
                    const newFood = {
                        id: Date.now(), // 生成唯一ID
                        name, price, category, rating, sales, time, imageUrl, description
                    };
                    // 加到最前面
                    foods.unshift(newFood);
                    showDynamicIsland('商品上架成功', 'success');
                }

                // 保存并刷新
                saveStoredFoods(foods);
                refreshGrid();
                addFoodModalOverlay.classList.remove('visible');
            });
        }
    }
        // ============================
    // 6. 【新增】购物车核心逻辑 (Cart Logic)
    // ============================
    
    // 状态数据
    let cartData = []; 

    const cartOverlay = document.getElementById('cart-modal-overlay');
    const cartListContainer = document.getElementById('cart-list-container');
    const cartTotalPriceEl = document.getElementById('cart-total-price');
    const floatingCartBtn = foodPage.querySelector('.food-floating-cart');
    const cartBadge = floatingCartBtn ? floatingCartBtn.querySelector('.cart-badge') : null;

    // --- 功能函数：渲染购物车 ---
    const renderCart = () => {
        if (!cartListContainer) return;
        
        cartListContainer.innerHTML = ''; // 清空列表
        let total = 0;
        let totalCount = 0;

        if (cartData.length === 0) {
            cartListContainer.innerHTML = '<div class="cart-empty-state">购物车空空如也</div>';
        } else {
            cartData.forEach((item, index) => {
           const itemTotal = item.price * item.count;
                total += itemTotal;
                totalCount += item.count;
                // 【修复】在商品名称下方显示规格
                const specsHtml = item.specs ? `<p class="cart-item-specs">${item.specs}</p>` : '';
                const itemHTML = `
                    <div class="cart-item">
                        <div class="item-info">
                            <h4>${item.name}</h4>
                            ${specsHtml}
                        </div>
                        <div class="item-controls">
                            <button class="btn-minus" data-index="${index}">-</button>
                            <span class="count">${item.count}</span>
                            <button class="btn-add" data-index="${index}">+</button>
                        </div>
                    </div>
                `;
                cartListContainer.insertAdjacentHTML('beforeend', itemHTML);
            });
        }

    if(cartTotalPriceEl) cartTotalPriceEl.textContent = total;
    if(cartBadge) {
            cartBadge.textContent = totalCount;
 cartBadge.style.display = totalCount > 0 ? 'flex' : 'none';
        }
    };
    const addToCart = (name, price, specs) => { // <-- 区别在这里，增加了 specs 参数
        // 【修复】查找商品时，要同时匹配名字和规格，防止同名不同规格的商品被合并
        const existingItem = cartData.find(item => item.name === name && item.specs === specs);
        if (existingItem) {
            existingItem.count++;
        } else {
            cartData.push({ name: name, price: parseFloat(price), count: 1, specs: specs }); // <-- 保存 specs
        }
        renderCart(); 
        if(floatingCartBtn) {
            floatingCartBtn.style.transform = 'scale(1.2)';
            setTimeout(() => floatingCartBtn.style.transform = 'scale(1)', 200);
        }
    };

    // --- 交互：购物车内的加减操作 ---
    if(cartListContainer) {
        cartListContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
    const index = btn.dataset.index;
            if (btn.classList.contains('btn-add')) {
                cartData[index].count++;
            } else if (btn.classList.contains('btn-minus')) {
                cartData[index].count--;
                if (cartData[index].count <= 0) {
                    cartData.splice(index, 1); 
                }
            }
            renderCart();
        });
    }

    // --- 交互：打开购物车---
    if(floatingCartBtn) {
        floatingCartBtn.addEventListener('click', () => {
            if(cartOverlay) cartOverlay.classList.add('visible');
        });
    }

    // --- 交互：关闭购物车---
    if(cartOverlay) {
        cartOverlay.addEventListener('click', (e) => {
            if(e.target === cartOverlay) {
                cartOverlay.classList.remove('visible');
            }
        });
    }

    // --- 交互：清空购物车 ---
    const clearCartBtn = document.getElementById('clear-cart-btn');
    if(clearCartBtn) {
        clearCartBtn.addEventListener('click', () => {
            if(confirm('确定清空购物车吗？')) {
                cartData = [];
                renderCart();
            }
        });
    }
 // --- 【从这里开始替换】 ---
    // --- 交互：去结算 (修改为弹窗选择) ---
    const payBtn = document.getElementById('cart-pay-btn');
    const payMethodOverlay = document.getElementById('pay-method-modal-overlay');
    
    // 打开支付选择弹窗
    if(payBtn && payMethodOverlay) {
        payBtn.addEventListener('click', () => {
            if(cartData.length === 0) {
                showDynamicIsland('购物车是空的', 'error');
                return;
            }
            if(cartOverlay) cartOverlay.classList.remove('visible');
            
            document.getElementById('pay-options-wrapper').style.display = 'flex';
            document.getElementById('pay-char-list-wrapper').style.display = 'none';
            
            payMethodOverlay.classList.add('visible');
        });
    }
    // 关闭支付选择弹窗
    const closePayMethodBtn = document.getElementById('pay-method-close-btn');
    if(closePayMethodBtn && payMethodOverlay) {
        closePayMethodBtn.addEventListener('click', () => {
            payMethodOverlay.classList.remove('visible');
        });
    }
 const handlePaymentSuccess = async (options) => {
        // 【修复】直接从 DOM 读取最终的总价，而不是自己计算
        const total = parseFloat(cartTotalPriceEl.textContent);
        
        // 【修复】深拷贝购物车数据，包含所有信息（名字、价格、数量、规格）
        const items = JSON.parse(JSON.stringify(cartData)); 
        let targetName = '自己';
        let chatId;
        if (options.isSelf) {
            chatId = tempState.currentChatId;
            targetName = '自己';
        } else {
            chatId = options.character.id;
            targetName = options.character.name;
        }
        if (!chatId) {
            console.error('支付失败：找不到有效的chatId');
            showDynamicIsland('支付失败，请重试', 'error');
            return;
        }
        // 构造小票需要的数据
    const subtotal = items.reduce((sum, item) => sum + item.price * item.count, 0);
        const discountAmount = subtotal * 0.1; 
        // ▼▼▼ 确保 total 是数字，防止 NaN 导致错误 ▼▼▼
        let finalTotal = subtotal - discountAmount - 2.00;
        if (isNaN(finalTotal)) finalTotal = 0; 
        // 确保 items 里的价格也是数字 (双重保险)
        items.forEach(item => item.price = parseFloat(item.price));
        const receiptData = {
            items: items, 
            total: finalTotal,
            discounts: [
                { name: '会员折扣', amount: -discountAmount },
                { name: '免包装费', amount: -2.00 }
            ],
            payMethod: options.isSelf ? '支付宝' : '为Ta免单'
        };
        const payment = await requestLookyPayment({
            amount: finalTotal,
            title: options.isSelf ? '外卖订单' : `外卖送给 ${targetName}`,
            scene: 'food'
        });
        if (!payment) return;
        if (options.isSelf) {
            showDynamicIsland(`已为 ${targetName} 支付 ¥${finalTotal.toFixed(2)}`, 'success');
        } else {
            showDynamicIsland(`已成功为 ${targetName} 下单`, 'success');
        }
        
        // 调用“小票打印机”

        
        // 调用“小票打印机”
        await sendReceiptMessage(chatId, receiptData);
        // 清空购物车并关闭弹窗
        cartData = [];
        renderCart();
        payMethodOverlay.classList.remove('visible');
    };
    // 1. 点击“给自己买”时，告诉函数是给自己买
    const paySelfBtn = document.getElementById('pay-for-self-btn');
    if(paySelfBtn) {
        paySelfBtn.addEventListener('click', () => {
            handlePaymentSuccess({ isSelf: true });
        });
    }
    // 2. 点击“送给朋友” (加载角色列表)
    const payOthersBtn = document.getElementById('pay-for-others-btn');
    const payCharList = document.getElementById('pay-char-list');
    
    if(payOthersBtn && payCharList) {
        payOthersBtn.addEventListener('click', async () => {
            document.getElementById('pay-options-wrapper').style.display = 'none';
            document.getElementById('pay-char-list-wrapper').style.display = 'block';
            payCharList.innerHTML = '<div style="padding:20px;text-align:center;">加载中...</div>';
            try {
                const chars = await getAllCharacters();
                payCharList.innerHTML = '';
                
                if(!chars || chars.length === 0) {
                    payCharList.innerHTML = '<div style="padding:10px;text-align:center;color:#999;">暂无好友</div>';
                    return;
                }
                chars.forEach(char => {
                    const div = document.createElement('div');
                    div.className = 'pay-char-item';
                    div.innerHTML = `
                        <img src="${char.avatar || 'images/default-avatar.svg'}">
                        <span>${char.name}</span>
                    `;
                    // 点击角色时，把整个角色信息传给函数
                    div.addEventListener('click', () => {
                        handlePaymentSuccess({ isSelf: false, character: char });
                    });
                    payCharList.appendChild(div);
                });
            } catch (e) {
                console.error(e);
                payCharList.innerHTML = '加载失败';
            }
        });
    }

    // 返回上一级
    const backToOptionsBtn = document.getElementById('back-to-pay-options');
    if(backToOptionsBtn) {
        backToOptionsBtn.addEventListener('click', () => {
            document.getElementById('pay-options-wrapper').style.display = 'flex';
            document.getElementById('pay-char-list-wrapper').style.display = 'none';
        });
    }

    // === 【修改】加入购物车逻辑：改为打开规格弹窗 ===
    const detailAddToCartBtn = document.querySelector('.food-detail-footer .add-to-cart-btn');
    if (detailAddToCartBtn) {
        detailAddToCartBtn.onclick = () => {
            // 1. 获取当前商品信息
            const name = document.getElementById('food-detail-name').textContent;
            const price = document.getElementById('food-detail-price').textContent;
            const imgBg = document.getElementById('food-detail-img').style.backgroundImage;
            // 提取url
            const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");

            // 2. 设置下一步动作为 "cart" (加入购物车)
            pendingAction = { type: 'cart', name, price };

            // 3. 打开规格弹窗
            openSpecsModal(name, price, imgUrl);
        };
    }

        // --- 【新增】“给ta买” 按钮逻辑 ---
    // 1. 找到所有次级按钮，通过文字内容找到“给ta买”
    const subBtns = document.querySelectorAll('.action-btn-sub');
    let giveToTaBtn = null;
    subBtns.forEach(btn => {
        if (btn.textContent.includes('给ta买')) {
            giveToTaBtn = btn;
        }
    });

    // 2. 获取新弹窗元素
    const giftOverlay = document.getElementById('gift-character-modal-overlay');
    const giftCloseBtn = document.getElementById('gift-modal-close-btn');
    const giftList = document.getElementById('gift-char-list');

    // 3. 点击“给ta买”
    if (giveToTaBtn && giftOverlay && giftList) {
        giveToTaBtn.addEventListener('click', async () => {
            // A. 显示弹窗
            giftOverlay.classList.add('visible');
            
            // B. 加载好友列表
            giftList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载中...</div>';
            
            try {
                const chars = await getAllCharacters(); // 获取数据
                giftList.innerHTML = ''; // 清空加载提示

                if (!chars || chars.length === 0) {
                    giftList.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友，快去添加吧</div>';
                    return;
                }

                // C. 渲染列表
                chars.forEach(char => {
                    const item = document.createElement('div');
                    // 设置样式：整洁的列表项
                    item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s;';
                    item.innerHTML = `
                        <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                        <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                        <span style="margin-left: auto; color: #ccc;">送给Ta ›</span>
                    `;
                    
                    // D. 点击角色触发赠送
                    item.addEventListener('click', () => {
                        const foodName = document.getElementById('food-detail-name').textContent;
                        const price = document.getElementById('food-detail-price').textContent;
                        
                        // 关闭所有弹窗
                        giftOverlay.classList.remove('visible');
                        if(detailModalOverlay) detailModalOverlay.classList.remove('visible');
                        
                        // 显示灵动岛提示
                        showDynamicIsland(`已下单 ${foodName} 送给 ${char.name} (-¥${price})`, 'success');
                    });

                    giftList.appendChild(item);
                });

            } catch (e) {
                console.error(e);
                giftList.innerHTML = '加载失败';
            }
        });
    }

    // 4. 关闭按钮逻辑
    if (giftCloseBtn && giftOverlay) {
        giftCloseBtn.addEventListener('click', () => {
            giftOverlay.classList.remove('visible');
        });
        // 点击遮罩层也能关闭
        giftOverlay.addEventListener('click', (e) => {
            if (e.target === giftOverlay) {
                giftOverlay.classList.remove('visible');
            }
        });
    }
     // 1. 找到“找人代付”按钮和新加的弹窗元素
    const payForFriendBtn = Array.from(subBtns).find(btn => btn.textContent.includes('找人代付'));
    const payForFriendOverlay = document.getElementById('pay-for-friend-modal-overlay');
    const payForFriendList = document.getElementById('pay-for-friend-char-list');
    const payForFriendCloseBtn = document.getElementById('pay-for-friend-close-btn');

    // --- 【关键修改】把这个函数提出来，放在 if 外面，这样下面选好规格后才能调用到它 ---
    const loadPayForFriendList = async () => {
        if (!payForFriendOverlay || !payForFriendList) return; // 安全检查
        
        payForFriendOverlay.classList.add('visible');
        payForFriendList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载中...</div>';
        try {
            const chars = await getAllCharacters();
            payForFriendList.innerHTML = '';
            if (!chars || chars.length === 0) {
                payForFriendList.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友可选</div>';
                return;
            }
            chars.forEach(char => {
                const item = document.createElement('div');
                item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s;';
                   item.innerHTML = `
                    <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex-shrink: 0; margin-right: 12px;">
                    <span style="font-size: 15px; font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${char.name}</span>
                    <span style="margin-left: auto; color: #ccc; flex-shrink: 0;">选择 ›</span>
                `;
                item.addEventListener('click', async () => {
                    // 使用 pendingAction 里的名字，如果没有就用页面上的
                    const foodName = typeof pendingAction !== 'undefined' && pendingAction ? pendingAction.name : document.getElementById('food-detail-name').textContent;
                    const price = pendingAction ? pendingAction.price : '0';
                    const specs = pendingAction ? pendingAction.specs : '';
                    const imgUrl = pendingAction ? pendingAction.imageUrl : '';
                    let targetChatId = char.id;
                    let displayName = foodName;
                    let displaySpecs = specs; // 新增变量
                    const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                    if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                        displaySpecs = (specs ? specs + ' ' : '') + `(请 @${char.name} 代付)`;
                        targetChatId = tempState.currentChatId;
                    }

                    const requestData = {
                        name: displayName,
                        price: price,
                        specs: displaySpecs,
                        imageUrl: imgUrl
                    };

                    await sendPayRequestMessage(targetChatId, requestData);            
                    payForFriendOverlay.classList.remove('visible');
                    if (typeof detailModalOverlay !== 'undefined' && detailModalOverlay) detailModalOverlay.classList.remove('visible');
                    showDynamicIsland(`已将 ${foodName} 的付款链接发给 ${char.name}`, 'success');
                });
                payForFriendList.appendChild(item);
            });
        } catch (e) {
            console.error("加载代付好友列表失败:", e);
            payForFriendList.innerHTML = '加载失败';
        }
    };

    // 2. 确保所有零件都找到了，再绑定按钮点击事件
    if (payForFriendBtn && payForFriendOverlay && payForFriendList && payForFriendCloseBtn) {
      
      // --- 【修改】按钮点击事件：改为打开规格选择弹窗 ---
      payForFriendBtn.onclick = () => {
          const name = document.getElementById('food-detail-name').textContent;
          const price = document.getElementById('food-detail-price').textContent;
          const imgBg = document.getElementById('food-detail-img').style.backgroundImage;
          const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");
          pendingAction = { type: 'pay_friend', name, price, imageUrl: imgUrl };
          
          // 调用打开规格弹窗的函数
          openSpecsModal(name, price, imgUrl);
      };

      // 4. 关闭弹窗的逻辑
      const closePayForFriendModal = () => {
        payForFriendOverlay.classList.remove('visible');
      };
      payForFriendCloseBtn.addEventListener('click', closePayForFriendModal);
      payForFriendOverlay.addEventListener('click', (e) => {
        if (e.target === payForFriendOverlay) {
          closePayForFriendModal();
        }
      });
    }

    // =========================================================
    // ▼▼▼ 【核心逻辑】规格选择弹窗逻辑 (Specs Logic) ▼▼▼
    // =========================================================
    
    const specsOverlay = document.getElementById('food-specs-modal-overlay');
    const specsContentArea = document.getElementById('specs-content-area'); // 获取内容容器
    const specsConfirmBtn = document.getElementById('specs-confirm-btn');
    const specsCloseBtn = document.getElementById('specs-close-btn');
    let pendingAction = null; 

    // --- 定义不同商品的规格数据 ---
    const FOOD_SPECS_DATA = {
        // 饮品类：选温度、糖度、加料
        'drink': [
            { title: '温度', options: ['正常冰', '少冰', '去冰', '温热', '热'] },
            { title: '糖度', options: ['标准糖', '七分糖', '三分糖', '不加糖'] },
            { title: '加料', options: ['不加料', '珍珠', '椰果', '布丁'] }
        ],
        // 快餐/汉堡/披萨：选尺寸、口味
        'fastfood': [
            { title: '规格', options: ['标准份', '大份 (+¥5)'] },
            { title: '口味', options: ['原味', '香辣', '番茄味'] },
            { title: '饮料', options: ['可乐', '雪碧', '芬达', '无需饮料'] }
        ],
        // 面食：选辣度、配菜
        'noodle': [
            { title: '份量', options: ['小碗', '大碗 (+¥3)'] },
            { title: '辣度', options: ['不辣', '微辣', '中辣', '特辣'] },
            { title: '加菜', options: ['不加', '煎蛋', '火腿肠', '青菜'] }
        ],
        // 轻食：选酱汁、主食
        'healthy': [
            { title: '主食基底', options: ['紫米饭', '荞麦面', '全麦面包', '纯蔬菜'] },
            { title: '酱汁', options: ['油醋汁', '千岛酱', '焙煎芝麻酱', '不加酱'] }
        ],
        // 默认通用规格
        'default': [
            { title: '规格', options: ['标准份', '大份 (+¥5)'] },
            { title: '备注', options: ['无忌口', '不要葱', '不要香菜', '多放辣'] }
        ]
    };

    // 1. 打开规格弹窗的函数
    // 增加了一个 type 参数，用来判断是哪类商品
    function openSpecsModal(name, price, imgUrl, type = 'default') {
        if(!specsOverlay || !specsContentArea) return;
        
        // 填充基本信息
        specsOverlay.querySelector('#specs-food-name').textContent = name;
        specsOverlay.querySelector('#specs-food-price').textContent = price;
        specsOverlay.querySelector('#specs-food-img').src = imgUrl;

        // --- 核心：根据类型动态生成规格 HTML ---
        // 尝试匹配类型，匹配不到就用默认的
        // 这里做一个简单的关键词匹配，或者你可以从 data-type 属性传递过来
        let specsConfig = FOOD_SPECS_DATA['default'];
        
        // 简单的关键词匹配逻辑 (或者你可以修改调用处传递准确的 type)
        if (['奶茶', '咖啡', '果汁', '冰', '茶', '拿铁'].some(k => name.includes(k))) specsConfig = FOOD_SPECS_DATA['drink'];
        else if (['汉堡', '披萨', '鸡', '薯条'].some(k => name.includes(k))) specsConfig = FOOD_SPECS_DATA['fastfood'];
        else if (['面', '粉', '饺'].some(k => name.includes(k))) specsConfig = FOOD_SPECS_DATA['noodle'];
        else if (['沙拉', '饭', '轻食'].some(k => name.includes(k))) specsConfig = FOOD_SPECS_DATA['healthy'];

        // 生成 HTML
        let html = '';
        specsConfig.forEach(group => {
            let optionsHtml = group.options.map((opt, index) => 
                `<span class="spec-tag ${index === 0 ? 'active' : ''}">${opt}</span>`
            ).join('');
            
            html += `
                <div class="specs-group">
                    <div class="group-title">${group.title}</div>
                    <div class="specs-tags">${optionsHtml}</div>
                </div>
            `;
        });
        
        specsContentArea.innerHTML = html;

        // 重新绑定标签点击事件 (因为HTML是新生成的)
        bindSpecTagsEvents();

        // 显示弹窗
        specsOverlay.classList.add('visible');
    }

    // 2. 绑定标签点击事件
    function bindSpecTagsEvents() {
        const tags = specsContentArea.querySelectorAll('.spec-tag');
        tags.forEach(tag => {
            tag.addEventListener('click', function() {
                // 找到同组的其他标签，移除 active
                const siblings = this.parentElement.querySelectorAll('.spec-tag');
                siblings.forEach(s => s.classList.remove('active'));
                // 自己加上 active
                this.classList.add('active');
            });
        });
    }

    // 3. 这里的关闭和确认逻辑保持不变...
    if (specsOverlay) {
        specsCloseBtn.addEventListener('click', () => {
            specsOverlay.classList.remove('visible');
        });
        specsOverlay.addEventListener('click', (e) => {
            if(e.target === specsOverlay) specsOverlay.classList.remove('visible');
        });
    }


    // 2. 标签点击交互 (切换选中状态)
    if (specsOverlay) {
        const tags = specsOverlay.querySelectorAll('.spec-tag');
        tags.forEach(tag => {
            tag.addEventListener('click', function() {
                // 找到同组的其他标签，移除 active
                const siblings = this.parentElement.querySelectorAll('.spec-tag');
                siblings.forEach(s => s.classList.remove('active'));
                // 自己加上 active
                this.classList.add('active');
            });
        });

        // 关闭按钮
        specsCloseBtn.addEventListener('click', () => {
            specsOverlay.classList.remove('visible');
        });
        
        // 点击遮罩关闭
        specsOverlay.addEventListener('click', (e) => {
            if(e.target === specsOverlay) specsOverlay.classList.remove('visible');
        });
    }

   if (specsConfirmBtn) {
        specsConfirmBtn.addEventListener('click', () => {
            if (!pendingAction) return;
            // 获取选中的规格文本
            const selectedSpecs = Array.from(specsOverlay.querySelectorAll('.spec-tag.active'))
                                     .map(tag => tag.textContent)
                                     .join(' / ');
            
            // 关闭规格弹窗
            specsOverlay.classList.remove('visible');
            // 根据之前的意图，执行不同操作
            if (pendingAction.type === 'cart') {
                // 加入购物车
                addToCart(pendingAction.name, pendingAction.price, selectedSpecs);
                showDynamicIsland('已加入购物车', 'success');
                if(detailModalOverlay) detailModalOverlay.classList.remove('visible');
            } else if (pendingAction.type === 'gift') {
                // ▼▼▼ 【修改处】将选好的规格存入 pendingAction，供后面使用 ▼▼▼
                pendingAction.specs = selectedSpecs; 
                // ▲▲▲ 修改结束 ▲▲▲
                // 打开好友列表
                if (giftOverlay) {
                    giftOverlay.classList.add('visible');
                    loadGiftFriendsList(); 
                }
            } else if (pendingAction.type === 'pay_friend') {
                loadPayForFriendList(); 
            }
        });
    }

    // 4. 修改“给ta买”按钮的点击事件 (拦截)
    if (giveToTaBtn) {
        giveToTaBtn.onclick = async () => {
             const name = document.getElementById('food-detail-name').textContent;
             const price = document.getElementById('food-detail-price').textContent;
             const imgBg = document.getElementById('food-detail-img').style.backgroundImage;
             const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");

             pendingAction = { type: 'gift', name, price };
             openSpecsModal(name, price, imgUrl);
        };
    }

    // 5. 封装加载好友列表的函数 (给上面用)
    async function loadGiftFriendsList() {
        const giftList = document.getElementById('gift-char-list');
        if(!giftList) return;
        
        giftList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载中...</div>';
        try {
            const chars = await getAllCharacters();
            giftList.innerHTML = ''; 
            if (!chars || chars.length === 0) {
                giftList.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友，快去添加吧</div>';
                return;
            }
            chars.forEach(char => {
                const item = document.createElement('div');
                item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s;';
                item.innerHTML = `
                    <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                    <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                    <span style="margin-left: auto; color: #ccc;">送给Ta ›</span>
                `;
         item.addEventListener('click', async () => {
                    // 1. 获取商品数据
                    const foodName = pendingAction ? pendingAction.name : '美食';
                    // ▼▼▼ 必须转为数字，否则 .toFixed 会报错 ▼▼▼
                    const price = parseFloat(pendingAction ? pendingAction.price : '0'); 
                    const specs = pendingAction ? pendingAction.specs : '';
                    // 2. 构造单品的小票数据
                    const receiptData = {
                        items: [{
                            name: foodName,
                            price: price,
                            count: 1,
                            specs: specs // 带上规格
                        }],
                        total: price, // 总价就是单价
                        discounts: [],
                        payMethod: '为Ta免单'
                    };
                    const payment = await requestLookyPayment({
                        amount: price,
                        title: `外卖 - ${foodName}`,
                        scene: 'food'
                    });
                    if (!payment) return;
                    // 3. 关闭所有弹窗
                    giftOverlay.classList.remove('visible');
                    if(detailModalOverlay) detailModalOverlay.classList.remove('visible');
                    // 4. 发送小票消息
                    await sendReceiptMessage(char.id, receiptData);
                    
                    showDynamicIsland(`已下单 ${foodName} 送给 ${char.name} (-¥${price})`, 'success');
                });
                giftList.appendChild(item);
            });
        } catch (e) {
            console.error(e);
            giftList.innerHTML = '加载失败';
        }
    }

    renderCart();
}
 // --- 【新增】购物页面底部导航栏交互 ---
    const shopHomePageBtn = document.getElementById('shop-nav-home');
    if (shopHomePageBtn) {
        // 使用 click 事件确保能被触发
        shopHomePageBtn.addEventListener('click', () => {
            if (typeof showPage === 'function') {
                showPage('page-life');
            }
        });
    }

// 【修改后】初始化行程页面的交互
function initRideServicePage() {
    const ridePage = document.getElementById('page-life-ride');
    if (!ridePage) return;
    // 将按钮逻辑移到这里，点击时动态获取 currentChatId，彻底解决多角色混淆问题
    const arrivalCard = document.getElementById('arrival-invite-card');
    const arrivalAcceptBtn = document.getElementById('arrival-accept-btn');
    const arrivalRejectBtn = document.getElementById('arrival-reject-btn');
    if (arrivalCard && arrivalAcceptBtn && arrivalRejectBtn) {
        // 1. 净化按钮（移除旧监听器）
        const newAcceptBtn = arrivalAcceptBtn.cloneNode(true);
        arrivalAcceptBtn.parentNode.replaceChild(newAcceptBtn, arrivalAcceptBtn);
        
        const newRejectBtn = arrivalRejectBtn.cloneNode(true);
        arrivalRejectBtn.parentNode.replaceChild(newRejectBtn, arrivalRejectBtn);
        // 2. 绑定“接受”逻辑 (动态读取 currentChatId)
        newAcceptBtn.addEventListener('click', () => {
            const currentId = tempState.currentChatId;
            if (!currentId) return;
            // 隐藏卡片并清除当前角色的行程
            arrivalCard.style.display = 'none';
  if (tempState.activeRides && tempState.activeRides[currentId]) {
                delete tempState.activeRides[currentId];
                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
            }
            // 【新增】同时清理飞机行程数据
            if (tempState.activeFlights && tempState.activeFlights[currentId]) {
                delete tempState.activeFlights[currentId];
                localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
            }

            // 跳转逻辑
            const character = AppState.characterProfiles.find(c => c.id === currentId);
            const titleElement = document.getElementById('offline-mode-title');
            if (titleElement && character) {
                titleElement.textContent = character.chatOverrideName || character.name;
            }
            showPage('page-offline-mode');
            
            // 触发流程
            document.dispatchEvent(new CustomEvent('loadOfflineHistory', { detail: { chatId: currentId } }));
            setTimeout(() => {
                const strongPrompt = `
<系统强制指令：EVENT_MEET_START>
【当前状态】：用户刚刚到达并选择了“与你见面”。你们现在已经处于面对面的线下场景中。
【你的任务】：请根据之前的聊天上下文，立刻描写你看到用户时的反应（动作/神态），并主动说出见面的第一句话。
【注意】：不要复述“用户到了”，直接开始表演。即刻推进剧情。`;
                document.dispatchEvent(new CustomEvent('startOfflineFlow', { 
                    detail: { chatId: currentId, customPrompt: strongPrompt } 
                }));
            }, 300);
        });
        // 3. 绑定“拒绝”逻辑
        newRejectBtn.addEventListener('click', () => {
            const currentId = tempState.currentChatId;
            arrivalCard.style.display = 'none';
            if (currentId && tempState.activeRides && tempState.activeRides[currentId]) {
                delete tempState.activeRides[currentId];
                // ▼▼▼ 同步清理 ▼▼▼
                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
            }
             if (currentId && tempState.activeFlights && tempState.activeFlights[currentId]) {
                delete tempState.activeFlights[currentId];
                localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
            }
            showDynamicIsland('已到达，保持线上聊天', 'success');
        });
    }
    const rideContent = ridePage.querySelector('.ride-content-container');
    const rideHeader = ridePage.querySelector('.ride-header');

    // 1. 顶部导航栏滚动变色逻辑 (保持不变)
    if (rideContent && rideHeader) {
        rideContent.addEventListener('scroll', () => {
            if (rideContent.scrollTop > 50) {
                rideHeader.classList.add('scrolled');
            } else {
                rideHeader.classList.remove('scrolled');
            }
        }, { passive: true });
    }

    // 2. 标签页切换逻辑 (保持不变)
    const tabsContainer = ridePage.querySelector('.ride-nav-tabs');
    const panes = ridePage.querySelectorAll('.tab-pane');
    if (tabsContainer) {
        tabsContainer.addEventListener('click', (e) => {
            if (e.target.matches('.ride-tab-item')) {
                const targetTab = e.target;
                const targetPaneId = 'ride-tab-' + targetTab.dataset.tab;
                tabsContainer.querySelectorAll('.ride-tab-item').forEach(tab => tab.classList.remove('active'));
                targetTab.classList.add('active');
                panes.forEach(pane => pane.classList.remove('active'));
                document.getElementById(targetPaneId)?.classList.add('active');
            }
        });
    }

    // 3. 车型选择逻辑 (保持不变)
    const carOptionsGrid = ridePage.querySelector('.car-options-grid');
    if (carOptionsGrid) {
        carOptionsGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.car-option-card');
            if (card) {
                carOptionsGrid.querySelectorAll('.car-option-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const price = card.querySelector('.car-price').textContent;
                ridePage.querySelector('.trip-details-bar span:last-child').textContent = price;
            }
        });
    }

    // 4. 个人行程记录按钮 (保持不变)
    const historyBtn = ridePage.querySelector('.ride-history-btn');
    if(historyBtn) {
        historyBtn.addEventListener('click', () => {
            showDynamicIsland('行程记录功能待开发', 'info');
        });
    }

    // ==========================================
    // ▼▼▼ 【新增】预订弹窗与交互逻辑 ▼▼▼
    // ==========================================
    
    const bookBtn = ridePage.querySelector('.action-book-btn');
    const bookModal = document.getElementById('ride-book-modal-overlay');
    const closeBookBtn = document.getElementById('ride-book-close-btn');
    const confirmBookBtn = document.getElementById('ride-confirm-btn');
    
    // 目的地输入与图钉特效
    const destInput = document.getElementById('ride-destination-input');
    const mapContainer = ridePage.querySelector('.ride-content-container');
    let mapPin = null;

     // A. 打开弹窗
    if (bookBtn && bookModal) {
        bookBtn.addEventListener('click', () => {
            // 【新增 1】强制收起键盘，防止弹窗被键盘顶飞
            document.activeElement?.blur();
            // 【新增 2】提前预加载汽车图片，防止后面显示时是空白
            ['images/car1.png', 'images/car2.png', 'images/car3.png', 'images/car4.png'].forEach(s => new Image().src = s);

            bookModal.classList.add('visible');
            // 【修改】这里虽然传 'turns'，但上面的函数已经写死了只显示轮数
            switchRideOptions('turns'); 
        });
    }

    // B. 关闭弹窗
    const closeLogic = () => {
        bookModal.classList.remove('visible');
        // 关闭时清除地图上的图钉，保持干净
        if(mapPin) { mapPin.remove(); mapPin = null; }
    };
    if (closeBookBtn) closeBookBtn.addEventListener('click', closeLogic);
    if (bookModal) {
        bookModal.addEventListener('click', (e) => {
            if (e.target === bookModal) closeLogic();
        });
    }

    // C. 输入目的地生成图钉特效
    if (destInput) {
        destInput.addEventListener('input', () => {
            const val = destInput.value.trim();
            
            // 如果有字且没有图钉，生成一个
            if (val.length > 0 && !mapPin) {
                mapPin = document.createElement('div');
                mapPin.className = 'map-pin-marker';
                
                // 随机位置 (限制在屏幕中间区域，不要太靠边)
                // top: 20% ~ 60%, left: 20% ~ 80%
                const randomTop = Math.floor(Math.random() * 40) + 20; 
                const randomLeft = Math.floor(Math.random() * 60) + 20;
                
                mapPin.style.top = randomTop + '%';
                mapPin.style.left = randomLeft + '%';
                
                // 插入到地图容器中 (且是第一个子元素，防止遮挡面板)
                mapContainer.insertBefore(mapPin, mapContainer.firstChild);
                
                // 强制重绘后添加 visible 类触发动画
                setTimeout(() => mapPin.classList.add('visible'), 10);
            } 
            // 如果清空了文字，移除图钉
            else if (val.length === 0 && mapPin) {
                mapPin.classList.remove('visible');
                setTimeout(() => { 
                    if(mapPin) { mapPin.remove(); mapPin = null; } 
                }, 300);
            }
        });
    }

    // D. 类型切换 (时间 vs 轮数)
    const typeBtns = document.querySelectorAll('.ride-type-switch .type-btn');
    typeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            typeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            switchRideOptions(btn.dataset.type);
        });
    });
    // E. 动态渲染选项的函数 (已改为纯轮数模式)
    function switchRideOptions(type) {
        // 【修改】不管传入什么 type，强制隐藏切换按钮，只显示轮数
        const typeSwitch = document.querySelector('.ride-type-switch');
        if (typeSwitch) typeSwitch.style.display = 'none'; // 隐藏“按时间/按轮数”的切换按钮

        const container = document.getElementById('ride-options-container');
        if(!container) return;
        container.innerHTML = ''; 

        // 【修改】只保留这一组选项 (你要求的 8, 10, 15)
        const options = [
            { label: '很近 (8轮)', val: '8' },
            { label: '中等 (10轮)', val: '10' },
            { label: '很远 (15轮)', val: '15' },
            { label: '自定义', isInput: true, unit: '轮' }
        ];

        options.forEach((opt, index) => {
            const el = document.createElement('div');
            el.className = 'ride-option-chip';
            if (index === 0) el.classList.add('active'); 
            if(opt.val) el.dataset.value = opt.val; 

            if (opt.isInput) {
                el.classList.add('is-input');
                el.innerHTML = `<input type="number" class="custom-time-input" placeholder="自定义(${opt.unit})">`;
                const input = el.querySelector('input');
                input.addEventListener('focus', () => selectOption(el));
                input.addEventListener('input', (e) => {
                    el.dataset.value = e.target.value;
                });
            } else {
                el.textContent = opt.label;
                el.addEventListener('click', () => selectOption(el));
            }
            container.appendChild(el);
        });
    }

    // 选中某个选项的辅助函数 (保持不变)
    function selectOption(targetEl) {
        const chips = document.querySelectorAll('.ride-option-chip');
        chips.forEach(c => c.classList.remove('active'));
        const chip = targetEl.closest('.ride-option-chip') || targetEl;
        chip.classList.add('active');
    }
    // F. 确认按钮点击 (三步走流程：填写 -> 寻找 -> 确认)
    if (confirmBookBtn) {
        confirmBookBtn.addEventListener('click', () => {
            // 【新增】点击确认时，立刻让输入框失去焦点（收起键盘），防止布局错乱
            if (destInput) destInput.blur();

            // 1. 获取输入数据 (保持不变)
            const dest = destInput.value.trim();
            if (!dest) {

                showDynamicIsland('请输入目的地', 'error');
                return;
            }
            
            const activeOption = document.querySelector('.ride-option-chip.active');
            let durationValue = activeOption.dataset.value;
            if (activeOption.classList.contains('is-input')) {
                durationValue = activeOption.querySelector('input').value.trim();
            }
            if (!durationValue) {
                showDynamicIsland('请设定行程长短', 'error');
                return;
            }

            // 获取单位和见面状态
            const currentTypeBtn = document.querySelector('.ride-type-switch .type-btn.active');
            const unit = currentTypeBtn.dataset.type === 'time' ? '分钟' : '轮对话';
            const isMeet = document.getElementById('ride-meet-toggle').checked;
            const meetText = isMeet ? '触发线下见面' : '安全陪伴模式';

            // --- 步骤 1：切换到“寻找司机”状态 ---
            document.getElementById('ride-step-booking').style.display = 'none';
            document.getElementById('ride-step-finding').style.display = 'block';

            // 模拟 2.5秒 的寻找时间
            setTimeout(() => {
                // --- 步骤 2：生成丰富的数据 (Upgrade) ---
                
                // 1. 定义司机和车型数据库 (带图片链接)
                // 注意：这里使用的是网络图片，你可以下载这些图片放到你的 images/cars/ 目录下，然后改路径
                const DRIVER_DATA = [
                    { 
                        name: "王师傅", 
                        surname: "王",
                        model: "黑色 · 帕萨特", 
                        // 黑色轿车透明图
                        img:"images/car1.png" 
                    },
                    { 
                        name: "李姐", 
                        surname: "李",
                        model: "白色 · 凯美瑞", 
                        // 白色轿车透明图
                        img: "images/car2.png" 
                    },
                    { 
                        name: "张师傅", 
                        surname: "张",
                        model: "银色 · 迈腾", 
                        // 银色轿车透明图
                        img:"images/car3.png" 
                    },
                    { 
                        name: "赵师傅", 
                        surname: "赵",
                        model: "红色 · 特斯拉 Model 3", 
                        // 红色车透明图
                        img:"images/car4.png" 
                    }
                ];

                // 2. 随机抽取一个司机
                const driver = DRIVER_DATA[Math.floor(Math.random() * DRIVER_DATA.length)];

                // 3. 填充数据
                // A. 车牌
                const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
                const plate = "京" + chars.charAt(Math.floor(Math.random() * chars.length)) + "·" + Math.floor(10000 + Math.random() * 90000);
                document.getElementById('ride-plate-number').textContent = plate;

                // B. 司机信息
                document.getElementById('ride-driver-name').textContent = driver.name;
                document.getElementById('ride-driver-surname').textContent = driver.surname;
                document.getElementById('ride-car-model').textContent = driver.model;
                
                // C. 车辆图片
                const carImgEl = document.getElementById('ride-car-image');
                carImgEl.src = driver.img;
                
                // 图片加载失败的兜底（显示一个默认图或隐藏）
                carImgEl.onerror = function() {
                    this.src = 'https://www.pngmart.com/files/5/Volkswagen-Passat-PNG-Image.png'; // 默认图
                };

                // D. 计算预计到达时间
                const now = new Date();
                const arrivalTime = new Date(now.getTime() + 30 * 60000);
                const hours = arrivalTime.getHours().toString().padStart(2, '0');
                const minutes = arrivalTime.getMinutes().toString().padStart(2, '0');
                document.getElementById('ride-arrival-time').textContent = `${hours}:${minutes}`;

                // E. 随机价格
                const price = (20 + Math.random() * 40).toFixed(1);
                document.getElementById('ride-price-display').textContent = `¥${price}`;

                // 切换显示
                document.getElementById('ride-step-finding').style.display = 'none';
                document.getElementById('ride-step-confirmed').style.display = 'block';
                               const heroSection = document.querySelector('.ride-confirm-hero');
                // 检查是否已经加过按钮，避免重复添加
                if (heroSection && !document.getElementById('ride-rechoose-btn')) {
                    const cancelBtn = document.createElement('button');
                    cancelBtn.id = 'ride-rechoose-btn';
                    cancelBtn.innerHTML = '&times;'; // 一个叉号
                    // 设置样式：右上角圆形灰色按钮
                    cancelBtn.style.cssText = "position: absolute; top: 10px; right: 10px; width: 32px; height: 32px; background: rgba(0,0,0,0.06); color: #666; border-radius: 50%; border: none; font-size: 24px; line-height: 1; cursor: pointer; z-index: 10; display: flex; align-items: center; justify-content: center;";
                    
                    cancelBtn.onclick = () => {
                        // 点击后：隐藏确认页，显示回填写页
                        document.getElementById('ride-step-confirmed').style.display = 'none';
                        document.getElementById('ride-step-booking').style.display = 'block';
                        // 顺手清除一下地图上的图钉，保持干净
                        const mapPin = document.querySelector('.map-pin-marker');
                        if(mapPin) mapPin.remove();
                    };
                    heroSection.appendChild(cancelBtn);
                }
                const ridePayBtn = document.getElementById('ride-pay-friend-btn');
                
                // 为了防止重复绑定，先克隆节点替换（简单粗暴的解绑方式）
                const newRidePayBtn = ridePayBtn.cloneNode(true);
                ridePayBtn.parentNode.replaceChild(newRidePayBtn, ridePayBtn);
                newRidePayBtn.addEventListener('click', async () => {
                    // 1. 获取当前行程信息
                    const currentPrice = document.getElementById('ride-price-display').textContent.replace('¥', '');
                    const currentDest = document.getElementById('ride-destination-input').value || '目的地';
                    const carModel = document.getElementById('ride-car-model').textContent; // 获取车型
                    // 2. 复用“找人代付”的弹窗
                    const overlay = document.getElementById('pay-for-friend-modal-overlay');
                    const list = document.getElementById('pay-for-friend-char-list');
                    
                    if (overlay && list) {
                        overlay.classList.add('visible');
                        list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                        try {
                            // 动态导入获取角色的函数 (如果 character.js 没在作用域内)
                            
                            const { sendPayRequestMessage } = await import('./chat-ui.js'); // 导入发消息函数
                            const chars = await getAllCharacters();
                            list.innerHTML = ''; // 清空加载提示
                            if (!chars || chars.length === 0) {
                                list.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友可选</div>';
                                return;
                            }
                            // 渲染好友列表
                            chars.forEach(char => {
                                const item = document.createElement('div');
                                item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;';
                                item.innerHTML = `
                                    <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                                    <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                                    <span style="margin-left: auto; color: #ff9500; font-size: 13px;">发送代付 ›</span>
                                `;
                                                   // 点击好友，发送代付请求
                                item.addEventListener('click', async () => {
                                    // ▼▼▼ 1. 获取并暂存行程配置 (关键新增) ▼▼▼
                                    const activeOption = document.querySelector('.ride-option-chip.active');
                                    let settingValue = 8;
                                    if (activeOption) {
                                        if (activeOption.classList.contains('is-input')) {
                                            settingValue = parseInt(activeOption.querySelector('input').value) || 8;
                                        } else {
                                            settingValue = parseInt(activeOption.dataset.value) || 8;
                                        }
                                    }
                                    const isMeet = document.getElementById('ride-meet-toggle').checked;
                                    const plateText = document.getElementById('ride-plate-number').textContent;
                                    
                                    // 把这些设置存到 LocalStorage，等付款成功后再取出来用
                                    const pendingRideData = {
                                        destination: currentDest,
                                        carInfo: `${carModel} (${plateText})`,
                                        isMeet: isMeet, // 这里记录了用户是否想见面
                                        remaining: settingValue,
                                        total: settingValue,
                                        status: 'transit',
                                        mode: 'turn'
                                    };
                                    localStorage.setItem('pending_ride_data', JSON.stringify(pendingRideData));
                                    // ▲▲▲ 新增结束 ▲▲▲
                                    let targetChatId = char.id;
                                    let displayName = `行程: 前往 ${currentDest}`;
                                    let displaySpecs = carModel;
                                    const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                                    if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                                        displaySpecs = carModel + ` (请 @${char.name} 代付)`;
                                        targetChatId = tempState.currentChatId;
                                    }

                                    // 构造代付卡片数据
                                    const requestData = {
                                        name: displayName, 
                                        price: currentPrice,
                                        specs: displaySpecs, 
                                         imageUrl: 'https://cdn-icons-png.flaticon.com/512/3097/3097180.png' 
                                    };

                                    // 发送消息
                                    await sendPayRequestMessage(targetChatId, requestData);

                                    overlay.classList.remove('visible'); 
                                    closeLogic(); 
                                    if(typeof showDynamicIsland === 'function') {
                                        showDynamicIsland(`已发送给 ${char.name}，等待对方支付...`, 'success');
                                    }
                                });

                                list.appendChild(item);
                            });
                        } catch (e) {
                            console.error("加载好友列表失败:", e);
                            list.innerHTML = '<div style="text-align:center; padding:20px;">加载失败</div>';
                        }
                    }
                });
            }, 2500);

                // --- 修改位置 1：获取用户选择的模式和数值 ---
           // --- 修改位置 3：确认出发按钮 (纯轮数版) ---
            const finalGoBtn = document.getElementById('ride-final-go-btn');
            finalGoBtn.onclick = async () => { 
                // 1. 获取数值
                const activeOption = document.querySelector('.ride-option-chip.active');
                let settingValue = 8; // 默认8轮
                if (activeOption) {
                    if (activeOption.classList.contains('is-input')) {
                        settingValue = parseInt(activeOption.querySelector('input').value);
                    } else {
                        settingValue = parseInt(activeOption.dataset.value);
                    }
                }
                if (!settingValue || isNaN(settingValue)) settingValue = 8;
                // 2. 保存状态 (强制 mode: 'turn')
                const isMeet = document.getElementById('ride-meet-toggle').checked;
                const isShared = document.getElementById('ride-share-toggle')?.checked ?? true; 
                const dest = document.getElementById('ride-destination-input').value || '目的地';
                const carModelText = document.getElementById('ride-car-model').textContent;
                const plateText = document.getElementById('ride-plate-number').textContent;
                const currentPrice = document.getElementById('ride-price-display')?.textContent || '';
                const payment = await requestLookyPayment({
                    amount: currentPrice,
                    title: `打车 - ${dest}`,
                    scene: 'ride'
                });
                if (!payment) return;
                if (!tempState.activeRides) tempState.activeRides = {}; 
                tempState.activeRides[tempState.currentChatId] = {
                    destination: dest,
                    carInfo: `${carModelText} (${plateText})`,
                    isMeet: isMeet, 
                    mode: 'turn', // 【强制】永远是轮数模式
                    remaining: settingValue,
                    total: settingValue,
                    status: 'transit'
                };
                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
                // 3. 关闭弹窗并通知 AI
                closeLogic();       
                const charIdForRide = tempState.currentChatId;
                if (charIdForRide && tempState.activeRides && tempState.activeRides[charIdForRide]) {
                   const ride = tempState.activeRides[charIdForRide]; 
                    await recordLookyLedger({
                        source: 'ride_self_pay',
                        sourceId: `${charIdForRide}_${Date.now()}`,
                        type: 'expense',
                        amount: currentPrice,
                        category: '出行',
                        title: `打车 - ${ride.destination}`,
                        memo: ride.carInfo || '',
                        char: charIdForRide,
                        paymentMethod: payment.displayName || '',
                        paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                        timestamp: Date.now(),
                        isAuto: true
                    });
                    const eventText = `你已呼叫一辆 ${ride.carInfo} 前往 ${ride.destination} (预计行程: ${settingValue}轮对话)。`;
                    if (window.addSystemEventMessage) {
                         window.addSystemEventMessage(charIdForRide, eventText, 'info');
                      if (isShared) {
                             setTimeout(() => {
                                 window.addSystemEventMessage(charIdForRide, '你已将行程共享给角色。', 'info');
                             }, 100);
                         }
                        } else {
                        import('./chat-service.js').then(module => {
                            module.addSystemEventMessage(charIdForRide, eventText, 'info');
                       if (isShared) {
                                setTimeout(() => {
                                    module.addSystemEventMessage(charIdForRide, '你已将行程共享给角色。', 'info');
                                }, 100);
                            }
                        });
                    }
                }
                // 4. 跳转页面
                const plateNum = document.getElementById('ride-plate-number').textContent;
                if (typeof showPage === 'function') {
                    showPage('page-chat-detail');
                } else {
                    const backBtn = document.querySelector('#page-life-ride .back-button');
                    if(backBtn) backBtn.click();
                }
                 // 5. 显示胶囊 & 启动逻辑 (只保留轮数监听)
                const rideCapsule = document.getElementById('ride-status-capsule');
                if (rideCapsule) {
                    const carModel = document.getElementById('ride-car-model').textContent;
                    // 立即更新一次胶囊外观，防止闪烁
                    rideCapsule.querySelector('#capsule-car-info').textContent = `${plateNum} · ${carModel.split('·')[1] || '轿车'}`;
                    const avatarImg = document.getElementById('ride-capsule-avatar');
                    let finalAvatar = 'images/default-avatar.svg';
                    const char = AppState.characterProfiles.find(c => c.id === charIdForRide);
                    if (char && char.chatOverrideUserAvatar) {
                        finalAvatar = char.chatOverrideUserAvatar;
                    } else {
                        const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
                        if (currentUser && currentUser.avatar) finalAvatar = currentUser.avatar;
                    }
                    avatarImg.src = finalAvatar;
                }

                // 清空数据并重置弹窗状态
                setTimeout(() => {
                    destInput.value = '';
                    document.getElementById('ride-meet-toggle').checked = false;
                    // 不需要再重置 type tab 了，因为现在只有一种模式
                    if(mapPin) { mapPin.remove(); mapPin = null; }
                    document.getElementById('ride-step-booking').style.display = 'block';
                    document.getElementById('ride-step-finding').style.display = 'none';
                    document.getElementById('ride-step-confirmed').style.display = 'none';
                }, 500);
            };
        });
    }
                    // === 核心修复：定义全局通用的轮数监听器 (如果还没定义过) ===
                    // 这个监听器挂在 window 上，它会处理所有角色的打车逻辑
                    if (!window.rideTurnHandler) {
                        window.rideTurnHandler = () => {
                            // 延时一小会儿，确保 tempState.currentChatId 已经是最新的
                            setTimeout(() => {
                                const currentId = tempState.currentChatId;
                              if (currentId && tempState.activeGifts && tempState.activeGifts[currentId]) {
                                    const gifts = tempState.activeGifts[currentId];
                                    let hasUpdates = false;
                                      let arrivedUserGiftsCount = 0; // 统计本轮送达的件数
                                    // 遍历该角色的所有礼物
                                    gifts.forEach(gift => {
                                        if (gift.status === 'delivering') {
                                            gift.remaining--; // 扣1轮
                                            hasUpdates = true;
                                            
                                            if (gift.remaining <= 0) {
                                                gift.remaining = 0;
                                                gift.status = 'delivered';
                                                
                                                // 1. 灵动岛只提示一次就行（这里也可以加个判断，但我建议保留，因为它在屏幕顶端很轻量）
                                                if (typeof showDynamicIsland === 'function' && arrivedUserGiftsCount === 0) {
                                                    showDynamicIsland('📦 有个包裹已送达', 'success');
                                                }
                                                // 2. 拦截重复的系统播报
                                                if (!gift.isFromAiPay) {
                                                    arrivedUserGiftsCount++; // 发现一个到了，只记数，不说话
                                                }
                                                // 3. AI代付的开箱动画（通常一张卡片只有一个动画，这里保持原样）
                                                if (gift.isFromAiPay) {
                                                    import('./chat-ui.js').then(({ showGiftUnboxing }) => {
                                                        setTimeout(() => {
                                                            showGiftUnboxing({
                                                                title: gift.title, 
                                                                img: gift.img  
                                                            });
                                                        }, 1500);
                                                    });
                                                }
// 修改处后两行：
                                            }
                                            // 2. 实时更新 DOM (卡片背面)
                                            // 我们通过 data-message-id 找到对应的消息气泡
                                            const msgEl = document.querySelector(`.message-wrapper[data-message-id="${gift.msgId}"]`);
                                            if (msgEl) {
                                                // 【核心修改】兼容两种卡片：普通物流卡(logistics) 和 3D小票卡(receipt)
                                                // 尝试找到 3D 小票卡背面显示时间的区域 (用户指定的路径)
                                                let valueEl = msgEl.querySelector('.receipt-card-3d .face-back .info-group .value.large');
                                                // 如果没找到，再试试找普通物流卡的时间区域
                                                if (!valueEl) {
                                                    valueEl = msgEl.querySelector('.logistics-card .face-back .value.highlight');
                                                }

                                                if (valueEl) {
                                                    if (gift.status === 'delivered') {
                                                        valueEl.textContent = '已送达';
                                                        valueEl.style.color = '#34c759'; // 送达变绿
                                                        const frontStatus = msgEl.querySelector('.face-front .status');
                                                        if (frontStatus) {
                                                            frontStatus.textContent = '已签收';
                                                            frontStatus.style.backgroundColor = '#34c759';
                                                        }
                                                        const backStamp = msgEl.querySelector('.receipt-card-3d .face-back .back-stamp');
                                                        if (backStamp) backStamp.style.borderColor = '#34c759'; valueEl.style.color = '#34c759';

                                                    } else {
                                                        valueEl.textContent = `${gift.remaining} 轮对话后`;
                                                    }
                                                }
                                            }
                                        }
                                    });
                                     // 【核心逻辑】不管后台登记了几个商品，只要有用户买的快递到了，就只说这一句
                                    if (arrivedUserGiftsCount > 0) {
                                        const eventText = `你为Ta购买的快递已送达`;
                                        if (window.addSystemEventMessage) {
                                            window.addSystemEventMessage(currentId, eventText, 'info');
                                        }
                                    }
                                  tempState.activeGifts[currentId] = gifts.filter(gift => gift.status === 'delivering');
                                    // 3. 保存最新的状态 (此时列表里只剩未送达的了，已送达的已被清理)
                                    if (hasUpdates) {
                                        localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                                    }
                                }
                                // ========== 【修正后代码】飞机误机检测逻辑 ==========
                                if (currentId && tempState.activeFlights && tempState.activeFlights[currentId]) {
                                    const myFlight = tempState.activeFlights[currentId];
                                    
                                    // 只有在“候机中”才计算轮数
                                    if (myFlight.status === 'waiting') {
                                        myFlight.turnsPassed = (myFlight.turnsPassed || 0) + 1; // 轮数+1
                                      const remainingTurns = myFlight.boardingTurns - myFlight.turnsPassed;

                                        console.log(`✈️ 航班[${myFlight.flight}] 候机中，已过 ${myFlight.turnsPassed} 轮，剩余 ${remainingTurns} 轮。`);

                                        // 检查是否误机
                                        if (remainingTurns < 0) {
                                            // 1. 提示误机
                                            const eventText = `[系统提示] 很遗憾，您因在候机大厅逗留太久（超过${myFlight.maxTurns}轮对话），错过了航班 ${myFlight.flight}。飞机已经起飞了。`;
                                            if (window.addSystemEventMessage) {
                                                window.addSystemEventMessage(currentId, eventText, 'error', false);
                                            } else {
                                                import('./chat-service.js').then(module => module.addSystemEventMessage(currentId, eventText, 'error', false));
                                            }
                                            
                                            // 2. 清理数据
                                            delete tempState.activeFlights[currentId];

                                            // 3. 隐藏飞机票
                                            if (typeof updateFlightCapsuleDisplay === 'function') {
                                                updateFlightCapsuleDisplay();
                                            }

                                        } 
                                        // 检查是否需要发送催促提醒
                                        else if (remainingTurns === 2) {
                                            const warningText = `[航班催促] 尊敬的旅客，您乘坐的 ${myFlight.flight} 航班即将起飞（剩余2轮对话），请尽快登机。`;
                                            if (window.addSystemEventMessage) {
                                                // 把最后的 'true' 改成 'false'，让消息显示出来！
                                                window.addSystemEventMessage(currentId, warningText, 'info', false);
                                            } else {
                                                import('./chat-service.js').then(module => module.addSystemEventMessage(currentId, warningText, 'info', false));
                                            }
                                        }

                                        // 4. 无论如何，都保存最新的状态到 localStorage
                                        localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
                                    }

                                    // 【新增】处理飞行中的逻辑 (flying)
                                    else if (myFlight.status === 'flying') {
                                        myFlight.remaining = (myFlight.remaining || 0) - 1;
                                        localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
                                        
                                        // 检查是否到达
                                        if (myFlight.remaining <= 0) {
                                            myFlight.status = 'arrived'; // 标记到达
                                            localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
                                            
                                            // 通知 AI
                                            const eventText = `用户乘坐的航班 ${myFlight.flight} 已落地到达 ${myFlight.toCity}。`;
                                            if (window.addSystemEventMessage) window.addSystemEventMessage(currentId, eventText, 'info');
                                            // 如果不需要见面，直接结束
                                            if (!myFlight.isMeet) {
                                                if(typeof showDynamicIsland === 'function') showDynamicIsland(`已抵达 ${myFlight.toCity}`, 'success');
                                                delete tempState.activeFlights[currentId];
                                                localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
                                            }
                                        }
                                    }
                                }
                                if (currentId && tempState.activeTrains && tempState.activeTrains[currentId]) {
    const myTrain = tempState.activeTrains[currentId];
    if (myTrain.status === 'waiting') {
        myTrain.turnsPassed = (myTrain.turnsPassed || 0) + 1;
        const remainingTurns = myTrain.maxTurns - myTrain.turnsPassed;
        if (remainingTurns < 0) {
            const eventText = `[系统提示] 您因在车站逗留太久，错过了列车 ${myTrain.trainNo}。列车已发车。`;
            if (window.addSystemEventMessage) window.addSystemEventMessage(currentId, eventText, 'error', false);
            delete tempState.activeTrains[currentId];
            if (window.updateTrainCapsuleDisplay) window.updateTrainCapsuleDisplay();
        }
        localStorage.setItem('active_trains_state', JSON.stringify(tempState.activeTrains));
    }
}
                                // 1. 如果当前没在聊天，或者 activeRides 数据还没初始化，直接退出
                                if (!currentId || !tempState.activeRides) return;
                                
                                // 2. 获取当前这个角色的行程数据
                                const myRide = tempState.activeRides[currentId];
                                
                                // 3. 如果这个角色根本没打车，或者车已经到了，直接退出
                                if (!myRide || myRide.status !== 'transit') return;

                                // 4. 只有在“当前角色的页面”发送消息，才扣减“当前角色的轮数”
                                                               // 扣减轮数
                                myRide.remaining--;
                                if (myRide.remaining < 0) myRide.remaining = 0;
                                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
                                console.log(`[行程] 角色 ${currentId} 的行程剩余轮数: ${myRide.remaining}`);
                               // === 检查是否到达 ===
                                if (myRide.remaining <= 0) {
                                // 1. 标记状态
                                myRide.status = 'arrived';
                                
                               
                                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
                                
                                // 2. 隐藏胶囊（确保视觉上立即消失）

                                const capsule = document.getElementById('ride-status-capsule');
                                if(capsule) capsule.style.display = 'none';

                                // 3. 通知 AI (只发送一次)
                                const eventText = `用户已到达目的地：${myRide.destination}`;
                                if (window.addSystemEventMessage) {
                                    window.addSystemEventMessage(currentId, eventText, 'info');
                                } else {
                                    import('./chat-service.js').then(module => {
                                        module.addSystemEventMessage(currentId, eventText, 'info');
                                    });
                                }
                                // 4. 处理“不需要见面”的情况
                                if (!myRide.isMeet) {
                                    if(typeof showDynamicIsland === 'function') showDynamicIsland('您已抵达目的地', 'success');
                                    if(tempState.activeRides) {
                                        delete tempState.activeRides[currentId];
                                        // ▼▼▼ 同步清理本地存储 ▼▼▼
                                        localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
                                    }
                                }


                                return; // 结束本次轮询
                                }

                                // === 行程节点感知提醒 (复制过来的逻辑) ===
                                if (myRide.remaining > 0) {
                                    let reminderText = null;
                                    if (myRide.remaining === 1) {
                                        reminderText = `[系统隐式提示] 车辆即将抵达（最后1轮）。定位显示车子已经到了楼下/门口，正在减速寻找停车位。请准备收尾。`;
                                    } else if (myRide.remaining === 3) {
                                        reminderText = `[系统隐式提示] 距离目的地还有一小段距离（剩余3轮）。定位显示车辆正在接近。`;
                                    } 
                                    
                                    if (reminderText) {
                                        if (window.addSystemEventMessage) {
                                            window.addSystemEventMessage(currentId, reminderText, 'info', true);
                                        } else {
                                            import('./chat-service.js').then(module => {
                                                module.addSystemEventMessage(currentId, reminderText, 'info', true);
                                            });
                                        }
                                    }
                                }
                            }, 50);
                        };

                        // 绑定到发送按钮
                        const sendBtn = document.getElementById('send-message-btn');
                        if (sendBtn) {
                            // 先移除可能的旧监听，防止重复
                            sendBtn.removeEventListener('pointerup', window.rideTurnHandler); 
                            sendBtn.addEventListener('pointerup', window.rideTurnHandler);
                        }
                    }
    // === 修复：全局胶囊关闭按钮逻辑 ===
    const globalCapsuleClose = document.getElementById('ride-capsule-close');
    if (globalCapsuleClose) {
        const newGlobalClose = globalCapsuleClose.cloneNode(true);
        globalCapsuleClose.parentNode.replaceChild(newGlobalClose, globalCapsuleClose);

        newGlobalClose.addEventListener('click', (e) => {
            e.stopPropagation(); 
            
            // 【关键修复】在这里重新获取一下胶囊元素，防止报错
            const capsule = document.getElementById('ride-status-capsule');
            if(capsule) capsule.style.display = 'none';
            
            const currentId = tempState.currentChatId;

            // 1. 清除打车数据 (原有逻辑)
            if (currentId && tempState.activeRides && tempState.activeRides[currentId]) {
                delete tempState.activeRides[currentId];
                localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
            }

            if (currentId && tempState.activeFlights && tempState.activeFlights[currentId]) {
                delete tempState.activeFlights[currentId];
                localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
            }
        });
    }


    // === 新增：监听代付成功事件，启动行程 ===
    document.addEventListener('ride_payment_success', () => {
        // 1. 读取刚才暂存的行程数据
        const rawData = localStorage.getItem('pending_ride_data');
        if (!rawData) return;
        
        const rideData = JSON.parse(rawData);
        const currentId = tempState.currentChatId;
        if (currentId) { 
            if (!tempState.activeRides) tempState.activeRides = {};
            tempState.activeRides[currentId] = rideData;
            
            // 保存并显示胶囊
            localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
            
            // 立即唤醒胶囊显示
            const capsule = document.getElementById('ride-status-capsule');
            if (capsule) {
                capsule.style.display = 'block';
                capsule.querySelector('#capsule-car-info').textContent = rideData.carInfo;
            }
            
            // 通知 AI
            const eventText = `(系统提示) 对方已为你支付车费。你已上车前往目的地，预计 ${rideData.remaining} 轮对话后到达。` + (rideData.isMeet ? ' (到达后触发线下见面)' : '');
            if (window.addSystemEventMessage) window.addSystemEventMessage(currentId, eventText, 'info');
        }
        // 2. 【修复】支付成功后，必须清空打车页面的输入状态，防止下次打开还在
        const destInput = document.getElementById('ride-destination-input');
        if (destInput) destInput.value = ''; // 清空目的地
        const mapPin = document.querySelector('.map-pin-marker');
        if (mapPin) mapPin.remove(); // 移除地图钉子
        // 重置回第一步
        const stepBooking = document.getElementById('ride-step-booking');
        const stepConfirmed = document.getElementById('ride-step-confirmed');
        if (stepBooking) stepBooking.style.display = 'block';
        if (stepConfirmed) stepConfirmed.style.display = 'none';
        // 3. 无论是否见面，都清除暂存数据，防止下次误触
           // 3. 无论是否见面，都清除暂存数据，防止下次误触
        localStorage.removeItem('pending_ride_data');
    });

    // --- 【修改开始】添加机票代付成功监听 ---
    document.addEventListener('flight_payment_success', () => {
        const rawData = localStorage.getItem('pending_flight_data');
        if (!rawData) return;

        const flightData = JSON.parse(rawData);
        
        // 激活飞行状态 (复用 activateFlightState)
        // 注意：activateFlightState 是 export 导出的，如果在监听器里调用不到，
        // 可以直接调用 window.activateFlightState (因为在文件底部你暴露了它)
        if (typeof window.activateFlightState === 'function') {
            window.activateFlightState(flightData);
        } else {
            // 备用方案：直接调用内部逻辑
            activateFlightState(flightData);
        }

        const currentId = tempState.currentChatId;
        if (currentId) {
             const eventText = `(系统提示) 对方已为你支付机票。航班 ${flightData.flight} 出票成功，请按时前往机场。`;
             if (window.addSystemEventMessage) window.addSystemEventMessage(currentId, eventText, 'info');
        }
        // --- 【核心修复】清空飞机页面的输入和设置 ---
        document.getElementById('flight-from-input').value = '';
        document.getElementById('flight-to-input').value = '';
        // 重置显示的轮数文本
        const dateEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value');
        const timeEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value');
        if (dateEl) dateEl.textContent = 'Select Date';
        if (timeEl) timeEl.textContent = '--:--';
        // 清除暂存
        localStorage.removeItem('pending_flight_data');
    });
 document.addEventListener('train_payment_success', () => {
        const rawData = localStorage.getItem('pending_train_data');
        if (!rawData) return;
        const ticketData = JSON.parse(rawData);
        
        // 确保调用的是全局或本地的激活函数
        if (window.activateTrainState) {
            window.activateTrainState(ticketData);
        }
        const currentId = tempState.currentChatId;
        if (currentId) {
             const eventText = `(系统提示) 对方已为你支付车费。高铁 ${ticketData.trainNo} 出票成功，请按时检票。`;
             if (window.addSystemEventMessage) window.addSystemEventMessage(currentId, eventText, 'info');
        }
        localStorage.removeItem('pending_train_data');
    });
    // ==========================================
    // ▼▼▼ 【新增】飞机页面交互逻辑 ▼▼▼
    // ==========================================
     const flightSearchBtn = document.getElementById('flight-search-btn');
    const flightModal = document.getElementById('flight-book-modal-overlay');
    // --- 【修改开始】添加飞机代付按钮逻辑 ---
    const flightPayBtn = document.querySelector('#ride-tab-flight .flight-actions-footer .btn-sub');
    
    if (flightPayBtn) {
        // 防止重复绑定
        const newFlightPayBtn = flightPayBtn.cloneNode(true);
        flightPayBtn.parentNode.replaceChild(newFlightPayBtn, flightPayBtn);

        newFlightPayBtn.addEventListener('click', async () => {
            // 1. 获取页面数据
            const fromVal = document.getElementById('flight-from-input').value.trim() || '出发地';
            const toVal = document.getElementById('flight-to-input').value.trim() || '目的地';
            const dateText = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value').textContent;
            const timeText = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value').textContent;
            // 假设价格是固定的或者从页面获取，这里模拟一个
            const price = '1260'; 

            // 2. 暂存飞机数据 (pending_flight_data)，用于支付成功后激活胶囊
            // 注意：这里我们构造符合 activateFlightState 需要的数据格式
            const pendingFlightData = {
                from: fromVal.substring(0, 3).toUpperCase(),
                to: toVal.substring(0, 3).toUpperCase(),
                fromCity: fromVal,
                toCity: toVal,
                flight: 'CA' + Math.floor(1000 + Math.random() * 9000), // 随机航班号
                date: dateText,
                time: timeText,
                passenger: window.getCurrentChatIdentity ? (window.getCurrentChatIdentity().name || 'User') : 'User',
                passengerSeat: Math.floor(1 + Math.random() * 30) + (Math.random() > 0.5 ? 'A' : 'F'),
                gate: 'T3',
                class: 'Y',
                boardingTurns: parseInt(document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value').textContent) || 20,
                maxTurns: parseInt(document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value').textContent) || 20, // 必须加上这个，胶囊倒计时用的是这个字段
                flightTurns: parseInt(document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value').textContent) || 15,
                isMeet: document.querySelector('#ride-tab-flight .meet-toggle-wrapper input')?.checked || false
            };
            localStorage.setItem('pending_flight_data', JSON.stringify(pendingFlightData));

            // 3. 打开“找人代付”好友列表 (复用现有的代付弹窗)
            const overlay = document.getElementById('pay-for-friend-modal-overlay');
            const list = document.getElementById('pay-for-friend-char-list');
            
            if (overlay && list) {
                overlay.classList.add('visible');
                list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                
                try {
                    
                    const { sendPayRequestMessage } = await import('./chat-ui.js');
                    const chars = await getAllCharacters();
                    list.innerHTML = ''; 

                    if (!chars || chars.length === 0) {
                        list.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友可选</div>';
                        return;
                    }

                    chars.forEach(char => {
                        const item = document.createElement('div');
                        item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;';
                        item.innerHTML = `
                            <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                            <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                            <span style="margin-left: auto; color: #007aff; font-size: 13px;">发送机票代付 ›</span>
                        `;
                        item.addEventListener('click', async () => {
                            let targetChatId = char.id;
                            let displayName = `机票: ${fromVal} - ${toVal}`;
                            let displaySpecs = `${dateText} · ${pendingFlightData.flight}`;
                            const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                            if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                                displaySpecs = displaySpecs + ` (请 @${char.name} 代付)`;
                                targetChatId = tempState.currentChatId;
                            }

                            // 构造代付卡片数据
                            const requestData = {
                                name: displayName, 
                                price: price,
                                specs: displaySpecs, 
                                imageUrl: 'https://cdn-icons-png.flaticon.com/512/2200/2200326.png' // 飞机图标
                            };

                            await sendPayRequestMessage(targetChatId, requestData);

                            overlay.classList.remove('visible');
                            showDynamicIsland(`已发送机票代付请求给 ${char.name}`, 'success');
                            document.getElementById('flight-from-input').value = '';
                            document.getElementById('flight-to-input').value = '';
                            const dateEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value');
                            const timeEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value');
                            if (dateEl) dateEl.textContent = 'Select Date';
                            if (timeEl) timeEl.textContent = '--:--';
                            // --- 修复结束 ---
                        });
                        list.appendChild(item);
                    });
                } catch (e) {
                    console.error("加载好友列表失败:", e);
                    list.innerHTML = '加载失败';
                }
            }
        });
    }
   // js/features/life.js

    // --- 【修改结束】 ---
    
    // ▼▼▼ 以下是新增的高铁页面逻辑 ▼▼▼
    
    // 1. 获取元素
    const trainSwapBtn = document.getElementById('train-swap-btn');
    const trainFromInput = document.getElementById('train-from-input');
    const trainToInput = document.getElementById('train-to-input');
    const trainDateDisplay = document.getElementById('train-date-display');
    const trainDatePicker = document.getElementById('train-date-picker');
    const trainSeatOptions = document.getElementById('train-seat-options');
    const trainBookBtn = document.getElementById('train-book-btn');
    const trainPayBtn = document.getElementById('train-pay-friend-btn');

    // 2. 交换城市逻辑
    if (trainSwapBtn && trainFromInput && trainToInput) {
        trainSwapBtn.addEventListener('click', () => {
            const temp = trainFromInput.value;
            trainFromInput.value = trainToInput.value;
            trainToInput.value = temp;
            
            // 简单的动画效果
            trainSwapBtn.style.transform = 'translateX(-50%) rotate(180deg)';
            setTimeout(() => trainSwapBtn.style.transform = 'translateX(-50%) rotate(0deg)', 300);
        });
    }

    // 3. 日期选择逻辑
  const trainDateTrigger = document.getElementById('train-date-trigger');
    const trainTimeTrigger = document.getElementById('train-time-trigger');
    if (trainDateTrigger) {
        trainDateTrigger.addEventListener('click', () => {
            const options = [
                { label: '20轮内有效', value: 20 },
                { label: '30轮内有效', value: 30 },
                { label: '当天有效', value: 10 },
                { label: '自定义', isInput: true }
            ];
            // 复用 openFlightModal 函数，传入类型 'train-validity'
            openFlightModal('train-validity', '设置车票有效期', '车票将在多少轮对话后失效？', options);
        });
    }
    if (trainTimeTrigger) {
        trainTimeTrigger.addEventListener('click', () => {
            const options = [
                { label: '8轮到达', value: 8 },
                { label: '12轮到达', value: 12 },
                { label: '15轮到达', value: 15 },
                { label: '自定义', isInput: true }
            ];
            // 复用 openFlightModal 函数，传入类型 'train-duration'
            openFlightModal('train-duration', '设置行程时长', '列车行驶多少轮对话后到达？', options);
        });
    }
    // 4. 席位选择逻辑 (排他性选择)
    if (trainSeatOptions) {
        trainSeatOptions.addEventListener('click', (e) => {
            const card = e.target.closest('.seat-card');
            if (card) {
                // 移除所有选中状态
                trainSeatOptions.querySelectorAll('.seat-card').forEach(c => c.classList.remove('selected'));
                // 选中当前
                card.classList.add('selected');
            }
        });
    }
// js/features/life.js

    // 5. 确认购票逻辑
    if (trainBookBtn) {
        // 防止重复绑定
        const newBookBtn = trainBookBtn.cloneNode(true);
        trainBookBtn.parentNode.replaceChild(newBookBtn, trainBookBtn);

        newBookBtn.addEventListener('click', async () => {
            const fromCity = document.getElementById('train-from-input').value || '北京';
            const toCity = document.getElementById('train-to-input').value || '上海';
            const isMeet = document.getElementById('train-meet-toggle').checked;
            const isShare = document.getElementById('train-share-toggle').checked;
            // 获取选中的席位名称和价格
            const selectedSeatCard = document.querySelector('#train-seat-options .seat-card.selected');
            const seatName = selectedSeatCard ? selectedSeatCard.querySelector('.seat-name').textContent : '二等座';
            const seatPrice = selectedSeatCard ? selectedSeatCard.querySelector('.seat-price').textContent : '¥553';
            
            // 简单的数据验证
            if(!fromCity || !toCity) {
                showDynamicIsland('请填写完整行程信息', 'error');
                return;
            }

            // ▼▼▼ 【修改开始】不再直接发消息，而是显示高铁票弹窗 ▼▼▼
            
            // 1. 获取弹窗元素
            const ticketOverlay = document.getElementById('train-ticket-overlay');
            
            // 2. 填充数据到票面
            document.getElementById('ticket-train-from').textContent = fromCity;
            document.getElementById('ticket-train-to').textContent = toCity;
            document.getElementById('ticket-train-price').textContent = seatPrice;
            document.getElementById('ticket-train-seat').textContent = Math.floor(Math.random() * 16) + 1 + (Math.random() > 0.5 ? 'A' : 'F'); // 随机座位
            document.getElementById('ticket-train-no').textContent = 'G' + Math.floor(Math.random() * 9000 + 1000); // 随机车次
            
            // 设置日期和时间
            const dateStr = document.getElementById('train-date-display').textContent;
            // 简单处理一下日期，如果是“明天”，就显示具体日期，这里为了演示直接用当前日期
            const now = new Date();
            const month = (now.getMonth() + 1).toString().padStart(2, '0');
            const day = now.getDate().toString().padStart(2, '0');
            document.getElementById('ticket-train-date').textContent = `${now.getFullYear()}-${month}-${day}`;
            
            // 设置乘客
            const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
            document.getElementById('ticket-train-passenger').textContent = (currentUser && currentUser.name) ? currentUser.name : 'User';

            // 3. 显示弹窗
            if(ticketOverlay) ticketOverlay.classList.add('visible');

            // 4. 绑定弹窗内部按钮事件 (取消/取票)
            // 4.1 取消按钮
            const cancelBtn = document.getElementById('train-ticket-cancel-btn');
            cancelBtn.onclick = () => {
                ticketOverlay.classList.remove('visible');
            };

   // 4.2 取票按钮 (确认)
            const confirmBtn = document.getElementById('train-ticket-confirm-btn');
            confirmBtn.onclick = async () => {
                const currentId = tempState.currentChatId;
                if (!currentId) return;
                // --- ▼▼▼ 修改开始：完善 ticketData 属性 ▼▼▼ ---
                const ticketData = {
                    fromCity: fromCity,
                    toCity: toCity,
                    date: document.getElementById('ticket-train-date').textContent,
                    trainNo: document.getElementById('ticket-train-no').textContent,
                    seatName: seatName,
                    seatNo: document.getElementById('ticket-train-seat').textContent,
                    passenger: document.getElementById('ticket-train-passenger').textContent,
                    maxTurns: parseInt(document.getElementById('train-date-display').textContent) || 20,
                    durationTurns: parseInt(document.getElementById('train-time-display').textContent) || 15,
                    isMeet: isMeet,
                    isShared: isShare // 【新增这一行】确保 AI 逻辑能读取到分享状态
                };
                const payment = await requestLookyPayment({
                    amount: seatPrice,
                    title: `高铁 - ${fromCity} 到 ${toCity}`,
                    scene: 'ride'
                });
                if (!payment) return;
                ticketOverlay.classList.remove('visible');
                // 调用 flight.js 中新写的函数
                if (window.activateTrainState) {
                    window.activateTrainState(ticketData);
                }
                await recordLookyLedger({
                    source: 'train_self_pay',
                    sourceId: `${currentId}_${ticketData.trainNo}_${Date.now()}`,
                    type: 'expense',
                    amount: seatPrice,
                    category: '出行',
                    title: `高铁 - ${fromCity} 到 ${toCity}`,
                    memo: `${ticketData.trainNo} · ${seatName}`,
                    char: currentId,
                    paymentMethod: payment.displayName || '',
                    paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                    timestamp: Date.now(),
                    isAuto: true
                });
                // --- ▲▲▲ 修改结束 ▲▲▲ ---
                // 动画提示
                showDynamicIsland('出票成功！', 'success');
                // 记录到系统事件
                if (window.addSystemEventMessage) {
                    window.addSystemEventMessage(currentId, `[系统事件] 用户购买了前往 ${toCity} 的高铁票 (${ticketData.trainNo})。`, 'info');
                    if(isShare) {
                        setTimeout(() => {
                            window.addSystemEventMessage(currentId, '用户向你分享了高铁行程单。', 'info');
                        }, 500);
                    }
                }
            };
        });
    }


    // 6. 找Ta代付逻辑
    if (trainPayBtn) {
        const newTrainPayBtn = trainPayBtn.cloneNode(true);
        trainPayBtn.parentNode.replaceChild(newTrainPayBtn, trainPayBtn);

        newTrainPayBtn.addEventListener('click', async () => {
            const fromCity = document.getElementById('train-from-input').value;
            const toCity = document.getElementById('train-to-input').value;
            const selectedSeatCard = document.querySelector('#train-seat-options .seat-card.selected');
           const seatName = selectedSeatCard ? selectedSeatCard.querySelector('.seat-name').textContent : '二等座';
const priceText = selectedSeatCard ? selectedSeatCard.querySelector('.seat-price').textContent : '¥553';
            const price = priceText.replace('¥', '');

            // 打开好友选择弹窗 (复用)
            const overlay = document.getElementById('pay-for-friend-modal-overlay');
            const list = document.getElementById('pay-for-friend-char-list');
            
            if (overlay && list) {
                overlay.classList.add('visible');
                list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                
                try {
                    
                    const { sendPayRequestMessage } = await import('./chat-ui.js');
                    const chars = await getAllCharacters();
                    list.innerHTML = ''; 

                    if (!chars || chars.length === 0) {
                        list.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友可选</div>';
                        return;
                    }

                    chars.forEach(char => {
                        const item = document.createElement('div');
                        item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;';
                        item.innerHTML = `
                            <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                            <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                            <span style="margin-left: auto; color: #007aff; font-size: 13px;">发送高铁代付 ›</span>
                        `;
                       item.addEventListener('click', async () => {
                            // 1. 准备好完整的高铁票数据，存入“暂存柜”
                            const pendingTrainData = {
                                fromCity: fromCity,
                                toCity: toCity,
                                date: document.getElementById('train-date-display').textContent,
                                trainNo: 'G' + Math.floor(Math.random() * 9000 + 1000),
                                seatName: seatName,
                                seatNo: Math.floor(Math.random() * 16) + 1 + (Math.random() > 0.5 ? 'A' : 'F'),
                                passenger: window.getCurrentChatIdentity ? (window.getCurrentChatIdentity().name || 'User') : 'User',
                                maxTurns: parseInt(document.getElementById('train-date-display').textContent) || 20,
                                durationTurns: parseInt(document.getElementById('train-time-display').textContent) || 15,
                                isMeet: document.getElementById('train-meet-toggle').checked,
                                isShared: document.getElementById('train-share-toggle').checked // 【新增这一行】
                            };
                            localStorage.setItem('pending_train_data', JSON.stringify(pendingTrainData));
                            // 2. 发送代付卡片消息
                            let targetChatId = char.id;
                            let displayName = `高铁票: ${fromCity} - ${toCity}`;
                            let displaySpecs = `${pendingTrainData.trainNo} · ${seatName}`;
                            const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                            if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                                displaySpecs = displaySpecs + ` (请 @${char.name} 代付)`;
                                targetChatId = tempState.currentChatId;
                            }

                            const requestData = {
                                name: displayName, 
                                price: price,
                                specs: displaySpecs,
                                imageUrl: 'https://cdn-icons-png.flaticon.com/512/3066/3066259.png' 
                            };

                            await sendPayRequestMessage(targetChatId, requestData);

                            overlay.classList.remove('visible');
                            showDynamicIsland(`已发送高铁代付请求给 ${char.name}`, 'success');
                        });
                        list.appendChild(item);
                    });
                } catch (e) {
                    console.error(e);
                    list.innerHTML = '加载失败';
                }
            }
        });
    }

    // 新增：获取飞机页面的各个元素
    const swapBtn = document.querySelector('#ride-tab-flight .swap-locations-btn');
    const fromInput = document.getElementById('flight-from-input');
    const toInput = document.getElementById('flight-to-input');   
    const departureItem = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1)');
    const arrivalItem = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2)'); 
    const flightModalTitle = document.getElementById('flight-modal-title');
    const flightModalHint = document.getElementById('flight-modal-hint');
    const flightOptionsGrid = document.getElementById('flight-options-container');
    const flightConfirmBtn = document.getElementById('flight-confirm-btn');

    let currentFlightSetting = null; // 用于判断当前在设置哪个选项 ('departure' 或 'arrival')

    if (flightSearchBtn && flightModal) {
        const closeFlightBtn = document.getElementById('flight-book-close-btn');
        const flightOptionsContainer = document.getElementById('flight-options-container');

        // 1. 打开弹窗
        flightSearchBtn.addEventListener('click', () => {
            flightModal.classList.add('visible');
        });

        // 2. 关闭弹窗 (点击叉号或背景)
        const closeFlightModal = () => flightModal.classList.remove('visible');
        if(closeFlightBtn) closeFlightBtn.addEventListener('click', closeFlightModal);
        flightModal.addEventListener('click', (e) => {
            if (e.target === flightModal) {
                closeFlightModal();
            }
        });

        // 3. 轮数选项点击高亮
        if (flightOptionsContainer) {
            flightOptionsContainer.addEventListener('click', (e) => {
                const chip = e.target.closest('.ride-option-chip');
                if (chip) {
                    flightOptionsContainer.querySelectorAll('.ride-option-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    const input = chip.querySelector('input');
                    if(input) input.focus();
                }
            });
        }
    }
        // 4. 【新增】城市互换逻辑
        if (swapBtn && fromInput && toInput) {
            swapBtn.addEventListener('click', () => {
                const fromValue = fromInput.value;
                const toValue = toInput.value;
                fromInput.value = toValue;
                toInput.value = fromValue;
            });
        }
        
        // 5. 【新增】打开设置弹窗的逻辑 (支持自定义输入框)
        const openFlightModal = (type, title, hint, options) => {
            currentFlightSetting = type; 
            if(flightModalTitle) flightModalTitle.textContent = title;
            if(flightModalHint) flightModalHint.textContent = hint;
            
            if(flightOptionsGrid) {
                flightOptionsGrid.innerHTML = ''; // 清空旧选项
                
                options.forEach((opt, index) => {
                    const chip = document.createElement('div');
                    chip.className = 'ride-option-chip';
                    
                    if (index === 0) chip.classList.add('active'); // 默认选中第一个

                    if (opt.isInput) {
                        // --- 渲染自定义输入框 ---
                        chip.classList.add('is-input');
                        chip.dataset.isInput = "true";
                        // 创建 input 元素
                        const input = document.createElement('input');
                        input.type = 'number';
                        input.placeholder = '自定义';
                        input.className = 'custom-flight-input';
                        
                        // 输入框聚焦时，自动选中这个选项
                        input.addEventListener('focus', () => {
                            flightOptionsGrid.querySelectorAll('.ride-option-chip').forEach(c => c.classList.remove('active'));
                            chip.classList.add('active');
                        });
                        
                        chip.appendChild(input);
                    } else {
                        // --- 渲染普通选项 ---
                        chip.dataset.value = opt.value;
                        chip.textContent = opt.label;
                    }
                    
                    flightOptionsGrid.appendChild(chip);
                });
            }
            if(flightModal) flightModal.classList.add('visible');
        };

        // 6. 【新增】绑定点击事件 (到达时间包含自定义)
        if (departureItem) {
            departureItem.addEventListener('click', () => {
                const options = [
                    { label: '20轮后', value: 20 },
                    { label: '30轮后', value: 30 },
                    { label: '50轮后', value: 50 },
                    { label: '自定义', isInput: true }, // 这里也加上自定义
                ];
                openFlightModal('departure', '设置机票有效期', '机票将在多少轮对话后失效？', options);
            });
        }

        if (arrivalItem) {
            arrivalItem.addEventListener('click', () => {
                const options = [
                    { label: '15轮', value: 15 },
                    { label: '25轮', value: 25 },
                    { label: '40轮', value: 40 },
                    { label: '自定义', isInput: true }, // 【修改】这里把60轮改成了自定义
                ];
                openFlightModal('arrival', '设置预计行程时长', '选择多少轮对话后到达目的地？', options);
            });
        }

        // 7. 【新增】弹窗内普通选项的点击逻辑
        if (flightOptionsGrid) {
            flightOptionsGrid.addEventListener('click', (e) => {
                // 如果点击的是输入框本身，不处理，交由 focus 事件处理
                if (e.target.tagName === 'INPUT') return;

                const chip = e.target.closest('.ride-option-chip');
                if (chip) {
                    flightOptionsGrid.querySelectorAll('.ride-option-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    
                    // 如果点击的是包含input的chip，自动聚焦input
                    const input = chip.querySelector('input');
                    if(input) input.focus();
                }
            });
        }

        // 8. 【新增】弹窗确认按钮逻辑 (处理自定义数值)
        if (flightConfirmBtn && flightModal) {
            flightConfirmBtn.addEventListener('click', () => {
                const selectedChip = flightOptionsGrid.querySelector('.ride-option-chip.active');
                if (selectedChip) {
                    let finalValue;
                    let finalLabel;

                    // 判断是否是自定义输入
                    if (selectedChip.dataset.isInput === "true") {
                        const input = selectedChip.querySelector('input');
                        const val = input.value.trim();
                        if (!val) {
                            showDynamicIsland('请输入有效的轮数', 'error');
                            return; // 阻止关闭
                        }
                        finalValue = val;
                        finalLabel = val + '轮(自定义)';
                    } else {
                        finalValue = selectedChip.dataset.value;
                        finalLabel = selectedChip.textContent;
                    }
                    
                    // 更新界面
                    if (currentFlightSetting === 'departure') {
                        departureItem.querySelector('.value').textContent = finalLabel;
                        // 可以在这里把 finalValue 存入 tempState 或 localStorage
                    } else if (currentFlightSetting === 'arrival') {
                        arrivalItem.querySelector('.value').textContent = finalLabel;
                     } else if (currentFlightSetting === 'train-validity') {
                        // 更新高铁有效期显示的文字
                        const el = document.getElementById('train-date-display');
                        if (el) el.textContent = finalLabel.replace('轮(自定义)', '轮');
                    
                    } else if (currentFlightSetting === 'train-duration') {
                        // 更新高铁时长显示的文字
                        const el = document.getElementById('train-time-display');
                        if (el) el.textContent = finalLabel.replace('轮(自定义)', '轮');
                    }
                    
                    showDynamicIsland('设置已保存', 'success');
                }
                flightModal.classList.remove('visible');
            });
        }
      // ==========================================
    // ▼▼▼ 【核心重写】机票购买与动画逻辑 ▼▼▼
    // ==========================================
    
    // 1. 获取元素
    const purchaseBtn = document.getElementById('flight-search-btn'); // 页面上的购买按钮
    const animationOverlay = document.getElementById('ticket-animation-overlay'); // 动画全屏遮罩
    const takeTicketBtn = document.getElementById('take-ticket-btn'); // 票上的“取票”按钮
    // ▼▼▼ 新增：获取取消按钮 ▼▼▼
    const cancelAnimBtn = document.getElementById('cancel-ticket-anim-btn');
    // ▼▼▼ 新增：取消按钮逻辑（关闭动画，回到表单） ▼▼▼
    if (cancelAnimBtn && animationOverlay) {
        cancelAnimBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止误触
            // 1. 先让它变透明 (触发 CSS 过渡动画)
            animationOverlay.classList.remove('visible'); 
            
            // 2. 等待 300毫秒（等动画播完），再彻底隐藏它，把空间还给下面的页面
            setTimeout(() => {
                animationOverlay.style.display = 'none';
            }, 300);
        });
    }

    // 2. 绑定购买点击事件
    if (purchaseBtn && animationOverlay) {
        // 先移除旧监听器，防止重复绑定造成的bug
        const newPurchaseBtn = purchaseBtn.cloneNode(true);
        purchaseBtn.parentNode.replaceChild(newPurchaseBtn, purchaseBtn);

        newPurchaseBtn.addEventListener('click', () => {
            // A. 获取用户输入的数据
            const fromVal = document.getElementById('flight-from-input').value.trim();
            const toVal = document.getElementById('flight-to-input').value.trim();
            
            // 获取显示的日期和时间文本 (注意：这里需要更加精确的选择器)
            const departureEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value');
            const arrivalEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value');
            
            const dateText = departureEl ? departureEl.textContent : 'Date';
            const arrivalText = arrivalEl ? arrivalEl.textContent : 'Time';

            // 简单验证
            if (!fromVal || !toVal) {
                showDynamicIsland('请填写出发地和目的地', 'error');
                return;
            }

            // B. 填充数据到机票 (HTML结构已更新)
            // 假设输入的是 "Beijing"，我们简单的取前3个字母大写作为代码 "BEI"
            const fromCode = fromVal.substring(0, 3).toUpperCase();
            const toCode = toVal.substring(0, 3).toUpperCase();

            document.getElementById('ticket-from-code').textContent = fromCode;
            document.getElementById('ticket-from-city').textContent = fromVal;
            
            document.getElementById('ticket-to-code').textContent = toCode;
            document.getElementById('ticket-to-city').textContent = toVal;

            // 乘客信息
            let passengerName = 'User';
            const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
            if(currentUser && currentUser.name) {
                passengerName = currentUser.name;
            }
            document.getElementById('ticket-passenger').textContent = passengerName;
            
            document.getElementById('ticket-date').textContent = dateText;
            document.getElementById('ticket-time').textContent = arrivalText;

            // C. 显示动画
            animationOverlay.style.display = 'flex';

            // 【新增修复】强制让取票按钮显示出来 (解决看不见的问题)
            if (takeTicketBtn) {
                takeTicketBtn.style.opacity = '1';     // 去掉透明度
                takeTicketBtn.style.zIndex = '10001';  // 层级提到最高，防止被遮挡
                takeTicketBtn.style.animation = 'none';// 关掉动画，直接显示
            }

            // 强制重绘，确保 transition 生效
            requestAnimationFrame(() => {
                animationOverlay.classList.add('visible');
            });

        });
    }

    // 3. 绑定“取票”点击事件 (清空与复原)
    if (takeTicketBtn && animationOverlay) {
        // ▼▼▼ 【修改】这里要把原来的 click 事件监听器完全替换掉 ▼▼▼
        takeTicketBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); // 防止冒泡

            // 1. 从机票动画上提取数据
          const ticketData = {
                // 原有数据
                from: document.getElementById('ticket-from-code').textContent,
                to: document.getElementById('ticket-to-code').textContent,
                flight: document.getElementById('ticket-flight').textContent,
                date: document.getElementById('ticket-date').textContent,
                time: document.getElementById('ticket-time').textContent,
                passenger: document.getElementById('ticket-passenger').textContent,
                passengerSeat: document.querySelector('.seat-badge').textContent,
                
                // 新增数据 (用于悬浮条)
                fromCity: document.getElementById('ticket-from-city').textContent,
                toCity: document.getElementById('ticket-to-city').textContent,
                gate: '01', // 动画票上没有，我们先写死一个
                class: 'Z' , // 动画票上没有，写死一个
           boardingTurns: parseInt(document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value').textContent) || 20, // 这是待机轮数
flightTurns: parseInt(document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value').textContent) || 15, // 这是飞行轮数

                isMeet: document.querySelector('#ride-tab-flight .meet-toggle-wrapper input')?.checked || false
            };
            const payment = await requestLookyPayment({
                amount: '1260',
                title: `机票 - ${ticketData.fromCity} 到 ${ticketData.toCity}`,
                scene: 'ride'
            });
            if (!payment) return;
            
            // 2. 隐藏动画
            animationOverlay.classList.remove('visible');
            setTimeout(() => {
                animationOverlay.style.display = 'none';
            }, 300);

            // 3. 调用我们新写的函数，发送电子登机牌！
            activateFlightState(ticketData);
            await recordLookyLedger({
                source: 'flight_self_pay',
                sourceId: `${tempState.currentChatId}_${ticketData.flight}_${Date.now()}`,
                type: 'expense',
                amount: '1260',
                category: '出行',
                title: `机票 - ${ticketData.fromCity} 到 ${ticketData.toCity}`,
                memo: `${ticketData.flight} · ${ticketData.date}`,
                char: tempState.currentChatId,
                paymentMethod: payment.displayName || '',
                paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                timestamp: Date.now(),
                isAuto: true
            });
 const isFlightShared = document.getElementById('flight-share-toggle')?.checked ?? true;
            if (isFlightShared) {
                const chatId = tempState.currentChatId;
                if (chatId) {
                    // 使用动态导入确保 chat-service 可用
                    import('./chat-service.js').then(module => {
                        module.addSystemEventMessage(chatId, '你已将行程共享给角色。', 'info');
                    });
                }
            }
            // 4. 清空输入框并提示用户
            document.getElementById('flight-from-input').value = '';
            document.getElementById('flight-to-input').value = '';
            const departureEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(1) .value');
            const arrivalEl = document.querySelector('#ride-tab-flight .flight-details-grid .detail-item:nth-child(2) .value');
            if(departureEl) departureEl.textContent = 'Select Date';
            if(arrivalEl) arrivalEl.textContent = '--:--';
            
            showDynamicIsland('登机牌已存入聊天记录', 'success');
        });
     
    }
    }

// 在所有代码都加载完后，执行初始化
document.addEventListener('DOMContentLoaded', () => {
    // 1. 【修复刷新Bug】从本地存储恢复行程数据到内存
    const savedRides = localStorage.getItem('active_rides_state');
    if (savedRides) {
        try {
            tempState.activeRides = JSON.parse(savedRides);
            console.log('[系统恢复] 已恢复行程数据:', tempState.activeRides);
              } catch (e) {
            console.error('行程数据解析失败', e);
        }
    }
    const savedGifts = localStorage.getItem('active_gifts_state');
    if (savedGifts) {
        try {
            tempState.activeGifts = JSON.parse(savedGifts);
            console.log('[系统恢复] 已恢复礼物物流数据:', tempState.activeGifts);
        } catch (e) { console.error(e); }
    }
     const savedTrains = localStorage.getItem('active_trains_state');

    if (savedTrains) {
        try {
            tempState.activeTrains = JSON.parse(savedTrains);
            console.log('[系统恢复] 已恢复高铁数据:', tempState.activeTrains);
        } catch (e) { console.error(e); }
    }
    // 2. 初始化页面交互
    initRideServicePage();
});
setInterval(() => {
    const currentId = tempState.currentChatId;
    const myTrain = tempState.activeTrains ? tempState.activeTrains[currentId] : null;
    const capsule = document.getElementById('ride-status-capsule');
    const arrivalCard = document.getElementById('arrival-invite-card'); // 获取到达卡片
    if (!capsule) return;

    // 1. 获取当前屏幕上的角色ID

    
    // 2. 尝试获取这个角色的行程数据
    const activeRides = tempState.activeRides || {};
    const myRide = activeRides[currentId];
    const myFlight = tempState.activeFlights ? tempState.activeFlights[currentId] : null;

    // 3. 默认先隐藏所有浮窗 (避免残留)
    capsule.style.display = 'none';
    if (arrivalCard) arrivalCard.style.display = 'none';
    if (!currentId || (!myRide && !myFlight && !myTrain)) {
        if (window.updateTrainCapsuleDisplay) {
            window.updateTrainCapsuleDisplay();
        }
        updateFlightCapsuleDisplay();
        return;
    }

     // 4. 如果当前角色有行程，则根据状态显示对应的 UI
    // 【新增】定义飞机数据变量
    if (currentId && myRide) { // 优先显示打车（如果同时存在的话）
        
        if (myRide.status === 'transit') {
            // --- 状态：路途中 -> 显示胶囊 ---
            capsule.style.display = 'block';

            // 刷新倒计时数字
            const timeEl = document.getElementById('capsule-time-left');
            if(timeEl) timeEl.textContent = myRide.remaining;
            
            // 刷新进度条
            const progressFill = capsule.querySelector('.progress-fill');
            if(progressFill) {
                 const percentage = ((myRide.total - myRide.remaining) / myRide.total) * 100;
                 progressFill.style.width = `${percentage}%`;
            }

            // 刷新车辆信息
            const infoEl = capsule.querySelector('#capsule-car-info');
            if(infoEl) infoEl.textContent = myRide.carInfo;

            // 刷新头像
            const avatarImg = document.getElementById('ride-capsule-avatar');
            if (avatarImg) {
                const char = AppState.characterProfiles.find(c => c.id === currentId);
                let finalAvatar = 'images/default-avatar.svg';
                if (char && char.chatOverrideUserAvatar) {
                    finalAvatar = char.chatOverrideUserAvatar;
                } else {
                    const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
                    if (currentUser && currentUser.avatar) finalAvatar = currentUser.avatar;
                }
                if (!avatarImg.src.includes(finalAvatar)) {
                    avatarImg.src = finalAvatar;
                }
            }

        } else if (myRide.status === 'arrived' && myRide.isMeet) {
            // --- 状态：已到达且要见面 -> 显示到达卡片 ---
            if (arrivalCard) {
                arrivalCard.style.display = 'flex';
                // 顺便刷新一下卡片上的名字，防止显示错人
                const nameDisplay = document.getElementById('arrival-char-name-display');
                const char = AppState.characterProfiles.find(c => c.id === currentId);
                if (nameDisplay && char) {
                    nameDisplay.textContent = char.chatOverrideName || char.name;
                }
            }
        }
    }
      else if (currentId && myFlight) {
        if (myFlight.status === 'flying') {
            capsule.style.display = 'block'; // 复用 ride-status-capsule
            
            // 更新文字：显示航班号
            const infoEl = capsule.querySelector('#capsule-car-info');
            if(infoEl) infoEl.textContent = `航班 · ${myFlight.flight}`;
            // 更新倒计时
            const timeEl = document.getElementById('capsule-time-left');
            if(timeEl) timeEl.textContent = myFlight.remaining;
            // 更新进度条
            const progressFill = capsule.querySelector('.progress-fill');
            if(progressFill) {
                 const total = myFlight.flightTurns || 15;
                 const percentage = ((total - myFlight.remaining) / total) * 100;
                 progressFill.style.width = `${percentage}%`;
            }
                    // 更新头像 (照抄打车悬浮条的逻辑)
            const avatarImg = document.getElementById('ride-capsule-avatar');
            if (avatarImg) {
                const char = AppState.characterProfiles.find(c => c.id === currentId);
                let finalAvatar = 'images/default-avatar.svg';
                if (char && char.chatOverrideUserAvatar) {
                    finalAvatar = char.chatOverrideUserAvatar;
                } else {
                    // 全局函数可能未定义，做一个兼容性处理
                    const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
                    if (currentUser && currentUser.avatar) finalAvatar = currentUser.avatar;
                }
                // 只有当头像URL不同时才更新，避免不必要的DOM重绘
                if (!avatarImg.src.includes(finalAvatar)) {
                    avatarImg.src = finalAvatar;
                }
            }

        } else if (myFlight.status === 'arrived' && myFlight.isMeet) {
            // 到达且见面 -> 显示邀请卡
            if (arrivalCard) {
                arrivalCard.style.display = 'flex';
                const nameDisplay = document.getElementById('arrival-char-name-display');
                const char = AppState.characterProfiles.find(c => c.id === currentId);
                if (nameDisplay && char) nameDisplay.textContent = char.chatOverrideName || char.name;
            }
        }
    }if (window.updateTrainCapsuleDisplay) {
        window.updateTrainCapsuleDisplay();
    }
    updateFlightCapsuleDisplay();
}, 1000); // 每1秒检查一次，降低高频 DOM 刷新造成的卡顿
    // --- 【新增】购物页面滑动监听 (实现顶栏变色) ---
    const shopPage = document.getElementById('page-life-shop');
    if (shopPage) {
        const shopContent = shopPage.querySelector('.shop-content-wrapper');
        const shopHeader = shopPage.querySelector('.shop-header');

        if (shopContent && shopHeader) {
            shopContent.addEventListener('scroll', () => {
                // 当滚动超过 50px 时，切换顶栏样式
                if (shopContent.scrollTop > 50) {
                    shopHeader.classList.add('scrolled');
                } else {
                    shopHeader.classList.remove('scrolled');
                }
            }, { passive: true });
        }
    }
     // ▼▼▼ 【新增】购物页面“添加”吊牌弹窗逻辑 ▼▼▼
    const shopCategoryPage = document.getElementById('page-life-shop-category');
    if (shopCategoryPage) {
        const initShopDataFromDB = async () => {
            const sidebar = shopCategoryPage.querySelector('.shop-sidebar');
            const rightContent = shopCategoryPage.querySelector('.shop-right-content');
            if(!sidebar || !rightContent) return;
            const allData = await db.shopCustomData.toArray();
            const groups = allData.filter(d => d.type === 'group');
            const products = allData.filter(d => d.type === 'product');
                       const RANDOM_POOL = [
                { name: "中古藤编椅", price: "850", img: "", sales: "200+" },
                { name: "极简落地灯", price: "320", img: "", sales: "1000+" },
                { name: "Louis Poulsen 吊灯", price: "4500", img: "", sales: "80+" },
                { name: "宜家 简约休闲椅", price: "299", img: "", sales: "5000+" },
                { name: "吱音 云朵茶几", price: "899", img: "", sales: "200+" },
                { name: "顾家家居 布艺沙发", price: "2699", img: "", sales: "1000+" },
                { name: "MUJI 无印良品豆袋", price: "900", img: "", sales: "3000+" },
                { name: "HAY 创意餐边柜", price: "3200", img: "", sales: "50+" },
                { name: "Xiaomi 智能吸顶灯", price: "399", img: "", sales: "1w+" },
                { name: "Seletti 创意霓虹灯", price: "580", img: "", sales: "300+" },
                { name: "天马 Tenma 抽屉盒", price: "128", img: "", sales: "1w+" },
                { name: "摩飞 多功能料理机", price: "699", img: "", sales: "2000+" },
                { name: "ZARA 法式碎花裙", price: "299", img: "", sales: "5000+" },
                { name: "优衣库 重磅T恤", price: "99", img: "", sales: "10w+" },
                { name: "匡威 1970s 帆布鞋", price: "549", img: "", sales: "5w+" },
                { name: "泡泡玛特 盲盒手办", price: "69", img: "", sales: "10w+" },
                { name: "索尼 降噪耳机", price: "2499", img: "", sales: "1000+" },
                { name: "Apple Watch Ultra", price: "6499", img: "", sales: "200+" }
            ];
            // 2. 随机打乱数组的辅助函数
            const shuffle = (array) => array.sort(() => 0.5 - Math.random());
            // 3. 定义填充函数
            const populateSpecialSection = (containerId, count) => {
                const container = document.getElementById(containerId);
                if (!container) return;
                
                // 随机取 count 个商品
                const items = shuffle([...RANDOM_POOL]).slice(0, count);
                
                container.innerHTML = items.map(item => `
                    <div class="cat-product-item" data-price="${item.price}" data-sales="${item.sales}">
                        <div class="img-box" style="background-color: #f0f0f0;"></div>
                        <span>${item.name}</span>
                        <div class="mini-price" style="font-size:10px; color:#000000; font-weight:700; margin-top:-4px;">¥${item.price}</div>
                    </div>
                `).join('');
            };
            // 4. 执行填充 (分别填充三个栏目)
            populateSpecialSection('cat-discount-grid', 5); // 限时特惠：5个
            populateSpecialSection('cat-new-grid', 4);      // 本季新品：4个
            populateSpecialSection('cat-like-grid', 9);     // 猜你喜欢：9个
            groups.forEach(g => {
                if (!document.querySelector(`[data-target="${g.catId}"]`)) {
                    const newItem = document.createElement('div');
                    newItem.className = 'sidebar-item';
                    newItem.setAttribute('data-target', g.catId);
                    newItem.textContent = g.cnName;
                    newItem.onclick = () => {
                        sidebar.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                        newItem.classList.add('active');
                        const targetEl = document.getElementById(g.catId);
                        if (targetEl) rightContent.scrollTo({ top: targetEl.offsetTop, behavior: 'smooth' });
                    };
                    sidebar.appendChild(newItem);
                    const titleDiv = document.createElement('div');
                    titleDiv.className = 'category-group-title';
                    titleDiv.id = g.catId;
                    titleDiv.textContent = `${g.cnName} ${g.enName || ''}`;
                    const gridDiv = document.createElement('div');
                    gridDiv.className = 'category-product-grid';
                    gridDiv.id = g.catId + '-grid';
                    rightContent.appendChild(titleDiv);
                    rightContent.appendChild(gridDiv);
                }
            });
            products.forEach(p => {
                const targetGrid = document.getElementById(p.catId + '-grid') || (document.getElementById(p.catId) ? document.getElementById(p.catId).nextElementSibling : null);
                if (targetGrid) {
                    const itemHtml = `<div class="cat-product-item" data-id="${p.id}" data-cat-id="${p.catId}" data-price="${p.price}" data-img="${p.imgSrc}" data-specs="${p.specs}" data-sales="${p.sales}">
                        <div class="img-box" style="background-image: url('${p.imgSrc}'); background-size: cover; background-position: center;"></div>
                        <span>${p.name}</span></div>`;
                    targetGrid.insertAdjacentHTML('beforeend', itemHtml);
                    const newItem = targetGrid.lastElementChild;
                    newItem.onclick = () => {
                         if (document.body.classList.contains('shop-delete-active')) return;
                        if (typeof openProductDetail === 'function') {
                            openProductDetail({ id: p.id, catId: p.catId, title: p.name, price: p.price, imgUrl: p.imgSrc, sales: p.sales, specs: p.specs }, 'page-life-shop-category');
                            setTimeout(() => {
                                const detailSalesEl = document.querySelector('#page-life-product-detail .sales');
                                if (detailSalesEl) detailSalesEl.textContent = `月销 ${p.sales}`;
                            }, 50);
                        }
                            };
                }
            });

            // 【修改4】同名覆盖机制：购物载入时，如果有改过图的新商品，隐藏旧的内置商品
            const customProductNames = products.map(p => p.name);
            const builtinItems = rightContent.querySelectorAll('.cat-product-item:not([data-id])');
            builtinItems.forEach(item => {
                const titleSpan = item.querySelector('span');
                if (titleSpan && customProductNames.includes(titleSpan.textContent)) {
                    item.style.display = 'none';
                }
            });

            const paddingDiv = rightContent.querySelector('div[style*="height: 80px"]');
            if (paddingDiv) rightContent.appendChild(paddingDiv);
        };

        initShopDataFromDB();
               const sidebarContainer = shopCategoryPage.querySelector('.shop-sidebar');
        const groupActionModal = document.getElementById('group-action-modal-overlay');
        let longPressTimer;
        let currentTargetGroup = null; // 存储当前长按的分组ID
        // 1. 长按检测逻辑 (Event Delegation)
        if (sidebarContainer) {
            sidebarContainer.addEventListener('touchstart', (e) => {
                const item = e.target.closest('.sidebar-item');
                // 排除 "推荐" 分组 (它通常是写死的 cat-recommend)
                if (!item || item.getAttribute('data-target') === 'cat-recommend') return;
                currentTargetGroup = {
                    id: item.getAttribute('data-target'),
                    name: item.textContent,
                    el: item
                };
                longPressTimer = setTimeout(() => {
                    // 长按触发：震动反馈并显示菜单
                    if (navigator.vibrate) navigator.vibrate(50);
                    if (groupActionModal) groupActionModal.classList.add('visible');
                }, 600); // 600毫秒视为长按
            });
            // 如果手指移动或松开，取消长按
            const cancelLongPress = () => clearTimeout(longPressTimer);
            sidebarContainer.addEventListener('touchmove', cancelLongPress);
            sidebarContainer.addEventListener('touchend', cancelLongPress);
            // 禁用右键菜单，方便在电脑上测试
            sidebarContainer.addEventListener('contextmenu', (e) => {
                const item = e.target.closest('.sidebar-item');
                if (item && item.getAttribute('data-target') !== 'cat-recommend') {
                    e.preventDefault();
                    currentTargetGroup = { id: item.getAttribute('data-target'), name: item.textContent, el: item };
                    if (groupActionModal) groupActionModal.classList.add('visible');
                }
            });
        }
        // 2. 关闭弹窗逻辑
        if (groupActionModal) {
            const closeBtn = document.getElementById('group-action-close-btn');
            const closeAction = () => groupActionModal.classList.remove('visible');
            if (closeBtn) closeBtn.addEventListener('click', closeAction);
            groupActionModal.addEventListener('click', (e) => { if (e.target === groupActionModal) closeAction(); });
            // 3. 【功能A】重命名分组
            const renameBtn = document.getElementById('btn-rename-group');
            if (renameBtn) {
                renameBtn.addEventListener('click', async () => {
                    closeAction(); // 先关菜单
                    if (!currentTargetGroup) return;
                    const newName = prompt('请输入新的分组名称', currentTargetGroup.name);
                    if (newName && newName.trim() !== '' && newName !== currentTargetGroup.name) {
                        try {
                            // 更新数据库：找到该分组并修改 cnName
                            // 注意：这里假设你的数据库结构是 { catId: '...', cnName: '...' }
                            const groupEntry = await db.shopCustomData.get({ catId: currentTargetGroup.id });
                            if (groupEntry) {
                                await db.shopCustomData.put({ ...groupEntry, cnName: newName.trim() });
                                
                                // 更新UI
                                currentTargetGroup.el.textContent = newName.trim();
                                const titleEl = document.getElementById(currentTargetGroup.id);
                                if (titleEl) titleEl.textContent = newName.trim();
                                
                                showDynamicIsland('重命名成功', 'success');
                            }
                        } catch (err) {
                            console.error(err);
                            showDynamicIsland('操作失败', 'error');
                        }
                    }
                });
            }
            // 4. 【功能B】删除分组 (带商品迁移)
            const deleteGroupBtn = document.getElementById('btn-delete-group-sidebar');
            if (deleteGroupBtn) {
                deleteGroupBtn.addEventListener('click', async () => {
                    closeAction();
                    if (!currentTargetGroup) return;
                    if (confirm(`确定要删除分组“${currentTargetGroup.name}”吗？\n该分组下的商品将自动移至“推荐”列表。`)) {
                        try {
                            // A. 迁移商品：把该分组下所有商品的 catId 改为 'cat-recommend'
                            // 先找出所有该组的商品
                            const productsToMove = await db.shopCustomData
                                .where('catId').equals(currentTargetGroup.id)
                                .and(item => item.type === 'product')
                                .toArray();
                            
                            // 逐个更新 (如果Dexie版本支持 bulkPut 更好，这里用循环保证兼容)
                            for (const p of productsToMove) {
                                await db.shopCustomData.put({ ...p, catId: 'cat-recommend' });
                            }
                            // B. 删除分组本身：找到 type='group' 且 catId 匹配的记录并删除
                            // 因为主键可能是 id (autoIncrement)，所以先查主键再删
                            const groupRecord = await db.shopCustomData
                                .where('catId').equals(currentTargetGroup.id)
                                .and(item => item.type === 'group')
                                .first();
                            
                            if (groupRecord) {
                                await db.shopCustomData.delete(groupRecord.id);
                            }
                            // C. 刷新页面或移除DOM
                            // 简单起见，移除侧边栏项和内容区
                            currentTargetGroup.el.remove();
                            const contentTitle = document.getElementById(currentTargetGroup.id);
                            const contentGrid = document.getElementById(currentTargetGroup.id + '-grid');
                            if (contentTitle) contentTitle.remove();
                            if (contentGrid) contentGrid.remove(); // 暂时移除，刷新后商品会在推荐里
                            // 切换回第一个分组（推荐）
                            const firstItem = sidebarContainer.querySelector('.sidebar-item');
                            if (firstItem) firstItem.click();
                            showDynamicIsland('分组已删除，商品已迁移', 'success');
                        } catch (err) {
                            console.error(err);
                            showDynamicIsland('删除失败', 'error');
                        }
                    }
                });
            }
        }
        const deleteModeBtn = document.getElementById('shop-category-delete-btn');
        const deleteBar = document.getElementById('shop-delete-bar');
        const deleteCancelBtn = document.getElementById('shop-delete-cancel-btn');
        const deleteConfirmBtn = document.getElementById('shop-delete-confirm-btn');
        const deleteCountSpan = document.getElementById('shop-delete-count');
        // 更新选中数量显示的辅助函数
        window.updateDeleteCount = () => {
            const selected = document.querySelectorAll('.cat-product-item.selected');
            if(deleteCountSpan) deleteCountSpan.textContent = selected.length > 0 ? `已选 ${selected.length} 项` : '选择商品';
        };
        // 1. 进入删除模式
        if (deleteModeBtn) {
            deleteModeBtn.addEventListener('click', () => {
                document.body.classList.add('shop-delete-active'); // 标记全局状态
                if(deleteBar) deleteBar.style.display = 'flex';
                // 给所有网格添加抖动动画类
                document.querySelectorAll('.category-product-grid').forEach(g => g.classList.add('edit-mode'));
                // 隐藏底部导航，避免遮挡
                const nav = document.querySelector('#page-life-shop-category .shop-bottom-nav');
                if(nav) nav.style.display = 'none';
            });
        }
        // 2. 退出删除模式
        const exitDeleteMode = () => {
            document.body.classList.remove('shop-delete-active');
            if(deleteBar) deleteBar.style.display = 'none';
            // 移除样式和选中态
            document.querySelectorAll('.category-product-grid').forEach(g => g.classList.remove('edit-mode'));
            document.querySelectorAll('.cat-product-item.selected').forEach(i => i.classList.remove('selected'));
            // 恢复底部导航
            const nav = document.querySelector('#page-life-shop-category .shop-bottom-nav');
            if(nav) nav.style.display = 'flex';
        };
        if (deleteCancelBtn) {
            deleteCancelBtn.addEventListener('click', exitDeleteMode);
        }
        // 3. 确认删除
        if (deleteConfirmBtn) {
            deleteConfirmBtn.addEventListener('click', async () => {
                const selectedItems = document.querySelectorAll('.cat-product-item.selected');
                if (selectedItems.length === 0) return exitDeleteMode();
                if (confirm(`确定要删除选中的 ${selectedItems.length} 件商品吗？`)) {
                    const idsToDelete = Array.from(selectedItems).map(item => Number(item.dataset.id)).filter(id => !isNaN(id));
                    
                    if (idsToDelete.length > 0) {
                        try {
                            // 从 IndexedDB 删除
                            await db.shopCustomData.bulkDelete(idsToDelete);
                            // 从 DOM 移除
                            selectedItems.forEach(item => item.remove());
                            showDynamicIsland('删除成功', 'success');
                        } catch (e) {
                            console.error(e);
                            showDynamicIsland('删除失败', 'error');
                        }
                    } else {
                        // 处理没有 ID 的默认商品（如果只允许删除自定义商品）
                        showDynamicIsland('无法删除默认预设商品', 'warning');
                    }
                    exitDeleteMode();
                }
            });
        }
        const addBtn = document.getElementById('shop-category-add-btn');
        const modal = document.getElementById('shop-add-modal-overlay');
        const closeBtn = document.getElementById('shop-add-close-btn');
        const confirmBtn = document.getElementById('shop-add-confirm-btn');
        const tabs = modal ? modal.querySelectorAll('.tag-tab') : [];
        const contents = modal ? modal.querySelectorAll('.tag-content') : [];
        const imgInput = document.getElementById('shop-add-img-input');
        const imgPreview = document.getElementById('shop-add-img-preview');
        const categorySelect = document.getElementById('shop-add-category-select');
        // 1. 打开弹窗
        // 1. 打开弹窗
        if (addBtn && modal) {
            addBtn.addEventListener('click', () => {
                modal.classList.add('visible');
                
                // 恢复为新增模式状态
                const productTabBtn = modal.querySelector('.tag-tab[data-target="tab-add-product"]');
                if (productTabBtn) productTabBtn.textContent = '添加商品';
                if (confirmBtn) {
                    confirmBtn.textContent = '发布上架';
                    delete confirmBtn.dataset.mode;
                    delete confirmBtn.dataset.editId;
                }
                document.getElementById('shop-add-name').value = '';
                document.getElementById('shop-add-price').value = '';
                document.getElementById('shop-add-sales').value = '';
                document.getElementById('shop-add-specs').value = '';
                if (imgPreview) {
                    imgPreview.src = '';
                    imgPreview.style.display = 'none';
                }
                const placeholder = modal.querySelector('.tag-upload-box .placeholder');
                if (placeholder) placeholder.style.display = 'flex';
                
                // 自动填充“所属分组”下拉框
                if (categorySelect) {
                    categorySelect.innerHTML = '';

                    const sidebarItems = shopCategoryPage.querySelectorAll('.shop-sidebar .sidebar-item');
                    sidebarItems.forEach(item => {
                        const val = item.getAttribute('data-target'); // 例如 cat-furniture
                        const text = item.textContent; // 例如 家具
                        if (val && text && text !== '推荐') { // 排除“推荐”
                            const option = document.createElement('option');
                            option.value = val;
                            option.textContent = text;
                            categorySelect.appendChild(option);
                        }
                    });
                }
            });
        }
        // 2. 关闭弹窗
        const closeModal = () => modal.classList.remove('visible');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (modal) modal.addEventListener('click', (e) => { if(e.target === modal) closeModal(); });
        // 3. 标签切换
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.target).classList.add('active');
            });
        });
        // 4. 图片预览
        if (imgInput) {
            imgInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                        imgPreview.src = evt.target.result;
                        imgPreview.style.display = 'block';
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
        // 5. 确认发布逻辑
              if (confirmBtn) {
            confirmBtn.addEventListener('click', async () => {
                const activeTabId = modal.querySelector('.tag-content.active').id;
                if (activeTabId === 'tab-add-group') {
                    // --- 添加分组逻辑 ---
                    const enName = document.getElementById('shop-add-group-en').value.trim();
                    const cnName = document.getElementById('shop-add-group-cn').value.trim();
                    if (!cnName) return showDynamicIsland('请输入分组名称', 'error');
                    const newId = 'cat-' + Date.now(); // 生成唯一ID
                    // A. 添加到左侧边栏
                    const sidebar = shopCategoryPage.querySelector('.shop-sidebar');
                    const newItem = document.createElement('div');
                    newItem.className = 'sidebar-item';
                    newItem.setAttribute('data-target', newId);
                    newItem.textContent = cnName;
                    
                    // 绑定点击事件(复用现有逻辑)
                    newItem.addEventListener('click', () => {
                        sidebar.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                        newItem.classList.add('active');
                        const targetEl = document.getElementById(newId);
                        const rightContent = shopCategoryPage.querySelector('.shop-right-content');
                        if (targetEl && rightContent) rightContent.scrollTo({ top: targetEl.offsetTop, behavior: 'smooth' });
                    });
                    sidebar.appendChild(newItem);
                    // B. 添加到右侧内容区
                    const rightContent = shopCategoryPage.querySelector('.shop-right-content');
                    // 创建标题
                    const titleDiv = document.createElement('div');
                    titleDiv.className = 'category-group-title';
                    titleDiv.id = newId;
                    titleDiv.textContent = `${cnName} ${enName}`;
                    // 创建商品网格容器
                    const gridDiv = document.createElement('div');
                    gridDiv.className = 'category-product-grid';
                    gridDiv.id = newId + '-grid'; // 给网格也加个ID方便查找
                    rightContent.appendChild(titleDiv);
                    rightContent.appendChild(gridDiv);
                    
                    // 底部垫高移动到最后
                    const paddingDiv = rightContent.querySelector('div[style*="height: 80px"]');
                    rightContent.appendChild(paddingDiv);
                           await db.shopCustomData.add({ type: 'group', catId: newId, cnName, enName });
                    showDynamicIsland('分组添加成功', 'success');

                } else {
                    // --- 添加商品/修改商品逻辑 ---
                    const name = document.getElementById('shop-add-name').value.trim();
                    const price = document.getElementById('shop-add-price').value;
                    const catId = document.getElementById('shop-add-category-select').value;
                    const imgSrc = imgPreview.src;
                    if (!name || !price) return showDynamicIsland('请完善商品信息', 'error');
                    
                    const specs = document.getElementById('shop-add-specs').value.trim(); 
                    const sales = document.getElementById('shop-add-sales').value.trim() || '0'; 
                    
                    const isEditMode = confirmBtn.dataset.mode === 'edit';
                    const editId = confirmBtn.dataset.editId ? Number(confirmBtn.dataset.editId) : null;

                    if (isEditMode && editId) {
                        // 执行覆盖逻辑 (Dexie 的 put 是基于主键的替换)
                        await db.shopCustomData.put({ id: editId, type: 'product', catId, name, price, imgSrc, specs, sales });
                        
                        // 直接更新 DOM，不刷新整个页面
                        const existingItem = document.querySelector(`.cat-product-item[data-id="${editId}"]`);
                        if (existingItem) {
                            existingItem.setAttribute('data-price', price);
                            existingItem.setAttribute('data-img', imgSrc);
                            existingItem.setAttribute('data-specs', specs);
                            existingItem.setAttribute('data-sales', sales);
                            existingItem.setAttribute('data-cat-id', catId);
                            existingItem.querySelector('span').textContent = name;
                            existingItem.querySelector('.img-box').style.backgroundImage = `url('${imgSrc}')`;
                            
                            // 如果修改了分类，动态移动 DOM 到新分类容器中
                            const newGrid = document.getElementById(catId + '-grid');
                            if (newGrid && existingItem.parentElement !== newGrid) {
                                newGrid.appendChild(existingItem);
                            }
                            
                            // 重新绑定点击事件，确保闭包数据是最新的
                            existingItem.onclick = () => {
                                 if (document.body.classList.contains('shop-delete-active')) return;
                                 if (typeof openProductDetail === 'function') {
                                     openProductDetail({ id: editId, catId: catId, title: name, price: price, imgUrl: imgSrc, sales: sales, specs: specs }, 'page-life-shop-category');
                                     setTimeout(() => {
                                         const detailSalesEl = document.querySelector('#page-life-product-detail .sales');
                                         if (detailSalesEl) detailSalesEl.textContent = `月销 ${sales}`;
                                     }, 50);
                                 }
                            };
                        }
                        
                        // 同时同步更新目前正打开着的详情页的UI展示
                        const detailPage = document.getElementById('page-life-product-detail');
                        if (detailPage && detailPage.classList.contains('active')) {
                            const titleEl = detailPage.querySelector('#shop-detail-title');
                            const priceEl = detailPage.querySelector('#shop-detail-price');
                            const imgEl = detailPage.querySelector('#shop-detail-img');
                            const salesEl = detailPage.querySelector('.sales');
                            if (titleEl) titleEl.textContent = name;
                            if (priceEl) priceEl.textContent = price;
                            if (imgEl) imgEl.style.backgroundImage = `url("${imgSrc}")`;
                            if (salesEl) salesEl.textContent = `月销 ${sales}`;
                            detailPage.dataset.currentSpecs = specs;
                            detailPage.dataset.catId = catId;
                            detailPage.dataset.sales = sales;
                        }
                        
                        showDynamicIsland('商品修改已保存', 'success');
                    } else {
                        // 执行新增逻辑
                        const titleEl = document.getElementById(catId);
                        let targetGrid = null;
                        if (titleEl) {
                            targetGrid = titleEl.nextElementSibling;
                        }
                        if (targetGrid) {
                            const newId = await db.shopCustomData.add({ type: 'product', catId, name, price, imgSrc, specs, sales });
                            const itemHtml = `
                                <div class="cat-product-item" data-id="${newId}" data-cat-id="${catId}" data-price="${price}" data-img="${imgSrc}" data-specs="${specs}" data-sales="${sales}">
                                    <div class="img-box" style="background-image: url('${imgSrc}'); background-size: cover; background-position: center;"></div>
                                    <span>${name}</span>
                                </div>
                            `;
                            targetGrid.insertAdjacentHTML('beforeend', itemHtml);
                            // 【修改5】添加新图后，当场把旧的重叠商品给隐藏掉
                            const builtinItems = document.querySelectorAll('.cat-product-item:not([data-id])');
                            builtinItems.forEach(item => {
                                const titleSpan = item.querySelector('span');
                                if (titleSpan && titleSpan.textContent === name) {
                                    item.style.display = 'none';
                                }
                            });
                            
                            // 【修复3】同步将购物首页“猜你喜欢”里的默认灰底图也换成你的新图
                            const recommendCards = document.querySelectorAll('.shop-recommend-section .product-card');
                            recommendCards.forEach(card => {
                                if (card.querySelector('h4').textContent === name) {
                                    const imgBox = card.querySelector('.product-img-placeholder');
                                    if (imgBox) {
                                        imgBox.style.backgroundImage = `url('${imgSrc}')`;
                                        imgBox.style.backgroundColor = 'transparent';
                                    }
                                }
                            });

                            const newItem = targetGrid.lastElementChild;

                            newItem.onclick = () => {
                                  if (document.body.classList.contains('shop-delete-active')) return;
                                if (typeof openProductDetail === 'function') {
                                     openProductDetail({ id: newId, catId: catId, title: name, price: price, imgUrl: imgSrc, sales: sales, specs: specs }, 'page-life-shop-category');
                                     setTimeout(() => {
                                         const detailSalesEl = document.querySelector('#page-life-product-detail .sales');
                                         if (detailSalesEl) detailSalesEl.textContent = `月销 ${sales}`;
                                     }, 50);
                                 }
                            };
                            showDynamicIsland('商品上架成功', 'success');
                        } else {
                            showDynamicIsland('找不到目标分组', 'error');
                            return;
                        }
                    }
                }
                // 清理并关闭

                closeModal();
                document.getElementById('shop-add-name').value = '';
                document.getElementById('shop-add-price').value = '';
                imgPreview.src = ''; imgPreview.style.display = 'none';
            });
        }
    }
    // --- 【新增】购物分类页面跳转逻辑 ---
    
    // 1. 在“购物主页”点击底部的“分类” -> 跳到分类页
    const shopPageNav = document.querySelector('#page-life-shop .shop-bottom-nav');
    if (shopPageNav) {
        // 找到第二个按钮（分类）
        const categoryBtn = shopPageNav.querySelectorAll('.nav-item')[1];
        if (categoryBtn) {
            categoryBtn.addEventListener('click', () => {
                if (typeof showPage === 'function') {
                    showPage('page-life-shop-category');
                }
            });
        }
    }
  const mainCategoryItems = document.querySelectorAll('#page-life-shop .category-item');
    mainCategoryItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetId = item.getAttribute('data-target');
            if (!targetId) return;
            // 1. 先跳转到分类页面
            if (typeof showPage === 'function') {
                showPage('page-life-shop-category');
            }
            // 2. 延迟一点点等待页面渲染，然后触发侧边栏点击
            setTimeout(() => {
                const sidebarItem = document.querySelector(`#page-life-shop-category .sidebar-item[data-target="${targetId}"]`);
                if (sidebarItem) sidebarItem.click();
            }, 100);
        });
    });
    // 2. 在“分类页”点击底部的“首页” -> 跳回购物主页
    const backHomeBtn = document.getElementById('shop-nav-home-from-cat');
    if (backHomeBtn) {
        backHomeBtn.addEventListener('click', () => {
            if (typeof showPage === 'function') {
                showPage('page-life-shop');
            }
        });
    }

    // 3. 左侧边栏点击切换效果
    const categoryPage = document.getElementById('page-life-shop-category');
    if (categoryPage) {
        const sidebarItems = categoryPage.querySelectorAll('.sidebar-item');
        const rightContent = categoryPage.querySelector('.shop-right-content'); // 获取右侧滚动容器
        
        sidebarItems.forEach(item => {
            item.addEventListener('click', () => {
                // 1. 切换按钮高亮样式
                sidebarItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                // 2. 【新增】获取目标 ID 并实现跳转
                const targetId = item.getAttribute('data-target');
                const targetEl = document.getElementById(targetId);
                        if (targetEl && rightContent) {
                    // 只让右侧的小框框自己滚动，不惊动外面的页面
                    rightContent.scrollTo({
                        top: targetEl.offsetTop, 
                        behavior: 'smooth'
                    });
                }
            });
        });
    }
    // --- 【新增】商品详情页逻辑 (Product Detail) ---
    // 1. 定义打开详情页的函数
   const openProductDetail = (data, backTarget = 'page-life-shop') => {
        // 获取页面元素
        const detailPage = document.getElementById('page-life-product-detail');
        if (!detailPage) return;
        
        // 【新增】找到返回按钮，并动态修改它的跳转目标
        const backBtn = detailPage.querySelector('.back-button');
        if (backBtn) {
            backBtn.setAttribute('data-target', backTarget);
        }
        
        // 填充数据
        const imgEl = detailPage.querySelector('#shop-detail-img');
        const titleEl = detailPage.querySelector('#shop-detail-title');
        const priceEl = detailPage.querySelector('#shop-detail-price');
        // ▼▼▼【修复】新增获取销量元素 ▼▼▼
        const salesEl = detailPage.querySelector('.product-main-info .sales'); 

        if (titleEl) titleEl.textContent = data.title;
        if (priceEl) priceEl.textContent = data.price;

        // ▼▼▼【修复】处理销量逻辑：如果有确定的销量就用，没有(自带商品)就随机生成 ▼▼▼
        let displaySales = data.sales;
        if (!displaySales || displaySales === '0') {
            // 随机生成 100 到 5000 之间的数字
            const randomSales = Math.floor(Math.random() * 4900) + 100;
            displaySales = `${randomSales}+`;
        }
        // 更新界面文字
        if (salesEl) salesEl.textContent = `月销 ${displaySales}`;
        // ▲▲▲ 修复结束 ▲▲▲

        // 将原始规格数据存入 dataset，方便后续解析
        detailPage.dataset.currentSpecs = data.specs || ''; 
        detailPage.dataset.productId = data.id || '';
        detailPage.dataset.catId = data.catId || '';
        detailPage.dataset.sales = displaySales; // 更新 dataset 里的值为最终显示的值
        
        // 优化图片显示逻辑
        if (imgEl) {
            imgEl.style.backgroundColor = 'transparent'; 
            if (data.imgUrl) {
                const finalImg = (data.imgUrl.startsWith('data:') || data.imgUrl.startsWith('http')) 
                    ? `url("${data.imgUrl}")` 
                    : data.imgUrl;
                imgEl.style.backgroundImage = finalImg;
                imgEl.style.backgroundSize = 'cover';
                imgEl.style.backgroundPosition = 'center';
            } else {
                imgEl.style.backgroundImage = '';
                imgEl.style.backgroundColor = '#e0e0e0'; 
            }
        }

        // 跳转页面
        if (typeof showPage === 'function') {
            showPage('page-life-product-detail');
        }
    };
    window.openProductDetail = openProductDetail;
    // 2. 绑定推荐列表的点击 (shop-recommend-section)
    const productList = document.querySelector('.shop-recommend-section .product-list');
    if (productList) {
        productList.addEventListener('click', (e) => {
            const card = e.target.closest('.product-card');
            if (card) {
                // 提取卡片信息
                const title = card.querySelector('h4').textContent;
                 const price = card.querySelector('.price').textContent.replace('¥', '');
                // 获取图片 (这里可能是背景色或占位)
                const imgPlaceholder = card.querySelector('.product-img-placeholder');
                // 获取原有的样式图
                const defaultImg = getComputedStyle(imgPlaceholder).backgroundImage !== 'none' ? getComputedStyle(imgPlaceholder).backgroundImage.slice(5, -2).replace(/['"]/g, "") : ''; 

                // 【修复2】点击首页推荐时，异步查询数据库，优先读取你保存的新图片
                db.shopCustomData.toArray().then(allData => {
                    const customProduct = allData.find(p => p.type === 'product' && p.name === title);
                    openProductDetail({ 
                        id: customProduct ? customProduct.id : '',
                        catId: customProduct ? customProduct.catId : '',
                        title: title, 
                        price: price, 
                        imgUrl: customProduct ? customProduct.imgSrc : defaultImg,
                        sales: customProduct ? customProduct.sales : '100+',
                        specs: customProduct ? customProduct.specs : ''
                    }, 'page-life-shop');
                });
            }
        });

    }


    // 3. 绑定分类页面的点击 (page-life-shop-category)
   const categoryPageContent = document.querySelector('.shop-right-content');
    if (categoryPageContent) {
        categoryPageContent.addEventListener('click', (e) => {
            const item = e.target.closest('.cat-product-item');
            if (item) {
                if (document.body.classList.contains('shop-delete-active')) {
                    e.preventDefault(); // 阻止默认行为
                    e.stopPropagation(); // 阻止冒泡
                    item.classList.toggle('selected');
                    updateDeleteCount();
                    return; // 【绝对关键】直接结束函数，不让它去打开详情页
                }
            const title = item.querySelector('span').textContent;

            // ▼▼▼ 【优化】自带商品真实价格表 (根据你的HTML内容整理) ▼▼▼
            const BUILT_IN_DB = {
                // --- 家具 ---
                "宜家 简约休闲椅": { price: "299", sales: "5000+" },
                "吱音 云朵茶几": { price: "899", sales: "200+" },
                "顾家家居 布艺沙发": { price: "2699", sales: "1000+" },
                "源氏木语 橡木柜": { price: "1580", sales: "800+" },
                "MUJI 无印良品豆袋": { price: "900", sales: "3000+" },
                "HAY 创意餐边柜": { price: "3200", sales: "50+" },
                "Herman Miller 办公椅": { price: "9800", sales: "100+" },
                "林氏木业 伸缩餐桌": { price: "1280", sales: "2000+" },
                "样子生活 衣帽架": { price: "199", sales: "500+" },
                "USM 模块化组合柜": { price: "8500", sales: "20+" },
                // --- 灯饰 ---
                "Louis Poulsen 吊灯": { price: "4500", sales: "80+" },
                "飞利浦 极简落地灯": { price: "329", sales: "1w+" },
                "松下 护眼台灯": { price: "159", sales: "5000+" },
                "昕诺飞 日落氛围灯": { price: "89", sales: "2w+" },
                "Xiaomi 智能吸顶灯": { price: "399", sales: "1w+" },
                "Yeelight 感应小夜灯": { price: "49", sales: "5w+" },
                "Seletti 创意霓虹灯": { price: "580", sales: "300+" },
                "欧普照明 户外射灯": { price: "128", sales: "800+" },
                "Artemide 经典工作灯": { price: "2800", sales: "100+" },
                "MUJI 香薰加湿灯": { price: "348", sales: "2000+" },
                // --- 收纳 ---
                "天马 Tenma 抽屉盒": { price: "128", sales: "1w+" },
                "太力 真空压缩袋": { price: "39", sales: "10w+" },
                "宜家 IKEA 洞洞板": { price: "99", sales: "5000+" },
                "霜山 内衣收纳盒": { price: "25", sales: "2000+" },
                "禧天龙 脏衣篮": { price: "58", sales: "1000+" },
                "山崎实业 缝隙收纳车": { price: "450", sales: "200+" },
                "无印良品 亚克力架": { price: "88", sales: "3000+" },
                "茶花 密封整理箱": { price: "69", sales: "5000+" },
                "慵懒居 书本收纳箱": { price: "45", sales: "800+" },
                "大创 桌面分层架": { price: "15", sales: "1w+" },
                // --- 餐厨 ---
                "特福 Tefal 不粘锅": { price: "299", sales: "3000+" },
                "酷彩 Le Creuset 碟": { price: "228", sales: "500+" },
                "星巴克 磨砂马克杯": { price: "129", sales: "8000+" },
                "德龙 意式咖啡机": { price: "1590", sales: "400+" },
                "摩飞 多功能料理机": { price: "699", sales: "2000+" },
                "双立人 厨用刀具": { price: "499", sales: "1000+" },
                "乐扣乐扣 保鲜盒": { price: "39", sales: "5w+" },
                "Balmuda 蒸汽烤箱": { price: "2199", sales: "100+" },
                "小熊 电动打蛋器": { price: "59", sales: "1w+" },
                "Joseph Joseph 厨具": { price: "399", sales: "300+" },
                // --- 女装 ---
                "ZARA 法式碎花裙": { price: "299", sales: "5000+" },
                "优衣库 羊绒针织衫": { price: "599", sales: "2000+" },
                "Theory 通勤西装": { price: "3200", sales: "100+" },
                "Brandy Melville 吊带": { price: "110", sales: "1w+" },
                "Lululemon 瑜伽裤": { price: "850", sales: "3000+" },
                "Snidel 蕾丝半身裙": { price: "980", sales: "500+" },
                "MO&Co. 连帽卫衣": { price: "699", sales: "1000+" },
                "AllSaints 皮夹克": { price: "3500", sales: "50+" },
                "Burberry 经典风衣": { price: "16900", sales: "10+" },
                "COS 极简连衣裙": { price: "790", sales: "600+" },
                // --- 男装 ---
                "优衣库 重磅T恤": { price: "99", sales: "10w+" },
                "Dickies 工装裤": { price: "399", sales: "2000+" },
                "Ralph Lauren 衬衫": { price: "1090", sales: "500+" },
                "Nike 运动夹克": { price: "599", sales: "3000+" },
                "始祖鸟 GORE-TEX": { price: "6000", sales: "200+" },
                "Levi's 原色牛仔裤": { price: "699", sales: "1500+" },
                "G2000 商务西裤": { price: "299", sales: "5000+" },
                "Champion 连帽衫": { price: "350", sales: "4000+" },
                "Barbour 涂蜡外套": { price: "2400", sales: "100+" },
                "Stone Island 夹克": { price: "4500", sales: "80+" },
                // --- 鞋子 ---
                "匡威 1970s 帆布鞋": { price: "549", sales: "5w+" },
                "New Balance 老爹鞋": { price: "899", sales: "8000+" },
                "Adidas Samba 德训鞋": { price: "799", sales: "1w+" },
                "GH Bass 乐福鞋": { price: "1200", sales: "300+" },
                "Dr. Martens 马丁靴": { price: "1499", sales: "2000+" },
                "Asics 亚瑟士跑鞋": { price: "690", sales: "3000+" },
                "Birkenstock 拖鞋": { price: "499", sales: "5000+" },
                "Clarks 商务皮鞋": { price: "899", sales: "1000+" },
                "Salomon 户外越野鞋": { price: "1298", sales: "500+" },
                "UGG 羊毛雪地靴": { price: "1399", sales: "2000+" },
                // --- 玩具 ---
                "泡泡玛特 盲盒手办": { price: "69", sales: "10w+" },
                "乐高 机械组赛车": { price: "2499", sales: "500+" },
                "Jellycat 邦尼兔": { price: "259", sales: "5000+" },
                "大疆 Tello 遥控机": { price: "699", sales: "1000+" },
                "任天堂 Switch 游戏": { price: "299", sales: "8000+" },
                "富士 Instax 拍立得": { price: "599", sales: "3000+" },
                "索尼 复古卡带机": { price: "3500", sales: "20+" },
                "Bearbrick 积木熊": { price: "4800", sales: "10+" },
                "KAWS 联名公仔": { price: "2800", sales: "50+" },
                "万代 RG 高达模型": { price: "350", sales: "2000+" },
                // --- 数码 ---
                "Keychron 机械键盘": { price: "468", sales: "1500+" },
                "罗技 MX 无线鼠标": { price: "599", sales: "3000+" },
                "索尼 降噪耳机": { price: "2499", sales: "1000+" },
                "马歇尔 便携音箱": { price: "1299", sales: "800+" },
                "Apple Watch Ultra": { price: "6499", sales: "200+" },
                "Wacom 专业数位板": { price: "2380", sales: "100+" },
                "安克 Anker 充电宝": { price: "199", sales: "5000+" },
                "极米 投影仪支架": { price: "299", sales: "800+" },
                "Xbox 精英手柄": { price: "1398", sales: "200+" },
                "贝尔金 桌面三合一": { price: "1098", sales: "100+" }
            };

            // 1. 获取自定义数据 (数据库里存的)
            const attrPrice = item.getAttribute('data-price');
            const storedSales = item.getAttribute('data-sales');

            // 2. 决定最终价格：有自定义用自定义，没有则查字典，再没有则随机生成(兜底)
            let finalPrice, finalSales;

            if (attrPrice) {
                // 如果是用户自己添加的商品
                finalPrice = attrPrice;
                finalSales = storedSales || '0';
            } else if (BUILT_IN_DB[title]) {
                // 如果是自带的预设商品
                finalPrice = BUILT_IN_DB[title].price;
                finalSales = BUILT_IN_DB[title].sales;
            } else {
                // 实在找不到的兜底逻辑 (避免显示为空)
                finalPrice = Math.floor(Math.random() * 800) + 99;
                finalSales = '100+';
            }
             const storedId = item.getAttribute('data-id') || '';
            let storedCatId = item.getAttribute('data-cat-id') || '';
            
            // 【修复】如果是内置自带商品，自动从它所在的网格容器提取真实的分类分组ID
            if (!storedCatId) {
                const parentGrid = item.closest('.category-product-grid');
                if (parentGrid && parentGrid.id) {
                    storedCatId = parentGrid.id.replace('-grid', ''); 
                }
            }
            
            const storedImg = item.getAttribute('data-img') || '';
            const storedSpecs = item.getAttribute('data-specs') || '';
            
            openProductDetail({ 

                id: storedId,
                catId: storedCatId,
                title: title, 
                price: finalPrice, 
                imgUrl: storedImg, 
                specs: storedSpecs, 
                sales: finalSales 
            }, 'page-life-shop-category');

}
        });
    }

    // 4. 详情页内部交互
    const detailPage = document.getElementById('page-life-product-detail');
    if (detailPage) {
        // 返回按钮

        // 按钮交互 (简单的灵动岛提示)
          const btnShare = detailPage.querySelector('#btn-shop-share');
 const btnEdit = detailPage.querySelector('#btn-shop-edit'); // 获取新加的按钮
        if (btnEdit) {
            btnEdit.addEventListener('click', () => {
                // 1. 获取当前页面显示的商品信息与隐藏数据
                const currentTitle = detailPage.querySelector('#shop-detail-title').textContent;
                const currentPrice = detailPage.querySelector('#shop-detail-price').textContent;
                const currentImgBg = detailPage.querySelector('#shop-detail-img').style.backgroundImage;
                const currentImgUrl = currentImgBg.slice(5, -2).replace(/['"]/g, "");
                const currentSpecs = detailPage.dataset.currentSpecs || '';
                const currentSales = detailPage.dataset.sales || '';
                const currentCatId = detailPage.dataset.catId || '';
                const currentProductId = detailPage.dataset.productId || '';
                
                // 2. 获取添加弹窗的相关元素
                const modal = document.getElementById('shop-add-modal-overlay');
                const nameInput = document.getElementById('shop-add-name');
                const priceInput = document.getElementById('shop-add-price');
                const salesInput = document.getElementById('shop-add-sales');
                const specsInput = document.getElementById('shop-add-specs');
                const catSelect = document.getElementById('shop-add-category-select');
                const imgPreview = document.getElementById('shop-add-img-preview');
                const productTab = modal ? modal.querySelector('[data-target="tab-add-product"]') : null;
                const saveBtn = document.getElementById('shop-add-confirm-btn');
                
                if (productTab) productTab.textContent = "编辑商品";
                if (saveBtn) {
                    saveBtn.textContent = "保存覆盖";
                    saveBtn.dataset.mode = "edit";
                    saveBtn.dataset.editId = currentProductId;
                }
                
                if (modal && nameInput && priceInput) {
                    // 3. 填充数据到弹窗
                    nameInput.value = currentTitle;
                    priceInput.value = currentPrice;
                    if (salesInput) salesInput.value = currentSales;
                    if (specsInput) specsInput.value = currentSpecs;
                    
                    // 自动填充下拉框并选中对应的分组
                    if (catSelect) {
                        catSelect.innerHTML = '';
                        const sidebarItems = document.querySelectorAll('#page-life-shop-category .shop-sidebar .sidebar-item');
                        sidebarItems.forEach(item => {
                            const val = item.getAttribute('data-target');
                            const text = item.textContent;
                            if (val && text && text !== '推荐') {
                                const option = document.createElement('option');
                                option.value = val;
                                option.textContent = text;
                                catSelect.appendChild(option);
                            }
                        });
                        if (currentCatId) catSelect.value = currentCatId;
                    }

                    if(imgPreview) {
                        imgPreview.src = currentImgUrl;
                        imgPreview.style.display = 'block';
                        const placeholder = modal.querySelector('.tag-upload-box .placeholder');
                        if (placeholder) placeholder.style.display = 'none';
                    }
                    
                    // 4. 切换到“添加商品”标签页
                    if(productTab) productTab.click();
                    // 5. 显示弹窗
                    modal.classList.add('visible');
                    
                    // 提示
                    if(typeof showDynamicIsland === 'function') {
                        showDynamicIsland('进入编辑模式', 'info');
                    }
                }
            });
        }
        const btnCartIcon = detailPage.querySelector('#btn-shop-cart');

        const btnPayFriend = detailPage.querySelector('#btn-shop-pay-friend');
        const btnBuyTa = detailPage.querySelector('#btn-shop-buy-ta');
        const btnBuySelf = detailPage.querySelector('#btn-shop-buy-self');
       const buyModal = document.getElementById('shop-buy-modal-overlay');
        const buyCloseBtn = document.getElementById('shop-buy-close-btn');
     // 修改处前两行：
        if(btnBuySelf && buyModal) {
            btnBuySelf.addEventListener('click', () => {
            // 每次打开弹窗，先把地址栏还原成默认的输入框，防止上次选择的角色残留
            const addressSec = document.querySelector('.shop-buy-card .buy-section.address-section');
            if(addressSec) {
                addressSec.innerHTML = `
                    <div class="section-label">收货地址</div>
                    <textarea id="buy-address-input" placeholder="请输入详细的收货地址..."></textarea>
                    <input type="tel" id="buy-phone-input" placeholder="联系电话">
                `;
            }

                // 1. 获取基础信息
                const title = document.getElementById('shop-detail-title').textContent;
                const price = document.getElementById('shop-detail-price').textContent;
                const imgBg = document.getElementById('shop-detail-img').style.backgroundImage;

                // 2. 填入基本信息
                document.getElementById('buy-mini-title').textContent = title;
                document.getElementById('buy-mini-price').textContent = price;
                document.getElementById('buy-total-price').textContent = price;
                document.getElementById('buy-mini-img').style.backgroundImage = imgBg;
                // 3. 【核心：动态生成规格按钮】
                const buySpecsContainer = document.getElementById('buy-specs-container');
                const currentSpecsStr = detailPage.dataset.currentSpecs || "";
                
                // === 修改开始：新建一个数组来统一存放规格数据 ===
                let specsData = []; 

                // A. 情况一：如果有自定义规格字符串 (用户自己添加的商品)
                if (currentSpecsStr.trim() !== '') {
                    const groups = currentSpecsStr.split(/[;；]/);
                    specsData = groups.map(g => {
                        const parts = g.split(/[:：]/);
                        return parts.length > 1 
                            ? { name: parts[0].trim(), opts: parts[1].split(/[,，]/).map(o => o.trim()) }
                            : { name: '规格', opts: g.split(/[,，]/).map(o => o.trim()) };
                    });
                } 
                // B. 情况二：如果是自带商品，去查数据库 (修复了自带商品不显示规格的Bug)
                else {
                    // 这里定义自带商品的规格库 (你可以把下面 btnCartIcon 里的那个巨大的 SPEC_DB 复制一份过来)
                    // 为了代码简洁，我这里写了通用的查找逻辑
                const SPEC_DB = {
                    "中古藤编椅": [
                        { name: '颜色', opts: ['复古黑', '原木色', '樱桃木色'] },
                        { name: '款式', opts: ['无扶手款', '带扶手款 (+¥80)'] }
                    ],
                    "极简落地灯": [
                        { name: '灯罩', opts: ['米白百褶', '纯白亚麻', '黑色丝绒'] },
                        { name: '光源', opts: ['暖光 (3000K)', '三色变光', '智能调光'] }
                    ],
                    "宜家 简约休闲椅": [
                        { name: '椅套颜色', opts: ['米黄色', '深灰色', '墨绿色'] },
                        { name: '填充', opts: ['标准海绵', '高回弹乳胶'] }
                    ],
                    "吱音 云朵茶几": [
                        { name: '尺寸', opts: ['小号 (80cm)', '大号 (100cm)'] },
                        { name: '台面', opts: ['纯白哑光', '浅粉烤漆'] }
                    ],
                    "顾家家居 布艺沙发": [
                        { name: '组合', opts: ['双人位', '三人位', '三人位+脚踏'] },
                        { name: '面料', opts: ['科技布', '仿棉麻', '天鹅绒'] }
                    ],
                    "源氏木语 橡木柜": [
                        { name: '规格', opts: ['两门 (0.8m)', '三门 (1.2m)', '四门 (1.6m)'] },
                        { name: '高度', opts: ['常规款', '加高款 (带抽屉)'] }
                    ],
                    "MUJI 无印良品豆袋": [
                        { name: '外套颜色', opts: ['牛仔蓝', '深褐色', '绯红色'] },
                        { name: '尺寸', opts: ['标准体 (65x65)', '加大体 (80x80)'] }
                    ],
                    "HAY 创意餐边柜": [
                        { name: '柜体颜色', opts: ['薄荷绿', '姜黄色', '米灰色'] },
                        { name: '腿部', opts: ['金属细腿', '实木圆腿'] }
                    ],
                    "Herman Miller 办公椅": [
                        { name: '配置', opts: ['标准版', '前倾功能版', '顶配全功能'] },
                        { name: '背网', opts: ['碳素黑', '矿石白'] }
                    ],
                    "林氏木业 伸缩餐桌": [
                        { name: '收缩长度', opts: ['1.2米 (展开1.5米)', '1.4米 (展开1.7米)'] },
                        { name: '桌面', opts: ['岩板台面', '实木贴皮'] }
                    ],
                    "样子生活 衣帽架": [
                        { name: '颜色', opts: ['极简黑', '纯净白'] },
                        { name: '底座', opts: ['大理石底座', '金属圆盘'] }
                    ],
                    "USM 模块化组合柜": [
                        { name: '颜色', opts: ['经典白', '克莱因蓝', '明亮黄'] },
                        { name: '层数', opts: ['两层 (2x1)', '三层 (2x2)', 'L型组合'] }
                    ],
                    "Louis Poulsen 吊灯": [
                        { name: '直径', opts: ['Mini (30cm)', 'Classic (50cm)'] },
                        { name: '颜色', opts: ['纯洁白', '淡玫瑰', '黄铜色'] },
                        { name: '光源', opts: ['无灯泡', '含LED暖光'] }
                    ],
                    "飞利浦 极简落地灯": [
                        { name: '灯体颜色', opts: ['钢琴黑', '磨砂白', '太空银'] },
                        { name: '色温', opts: ['3000K 暖光', '4000K 自然光', '6500K 冷白光'] },
                        { name: '控制方式', opts: ['脚踏开关', '米家App智能控制'] }
                    ],
                    "松下 护眼台灯": [
                        { name: '等级', opts: ['国AA级照度', '国AAA级专业版'] },
                        { name: '功能', opts: ['充插两用', '仅插电款'] },
                        { name: '颜色', opts: ['致炫白', '深空灰'] }
                    ],
                    "昕诺飞 日落氛围灯": [
                        { name: '光效', opts: ['经典日落红', '破晓彩虹', '极光蓝'] },
                        { name: '高度', opts: ['桌面款 (28cm)', '落地款 (1.2m)'] }
                    ],
                    "Xiaomi 智能吸顶灯": [
                        { name: '功率', opts: ['450W (卧室用)', '900W (客厅用)'] },
                        { name: '形状', opts: ['圆形纤薄', '长方形星轨'] },
                        { name: '安装', opts: ['自行安装', '包含上门安装服务'] }
                    ],
                    "Yeelight 感应小夜灯": [
                        { name: '套装', opts: ['单只装', '三只特惠装'] },
                        { name: '款式', opts: ['插电版 (常亮/感应)', '充电版 (超长续航)'] }
                    ],
                    "Seletti 创意霓虹灯": [
                        { name: '造型', opts: ['香蕉 (Banana)', '红唇 (Lips)', '闪电 (Thunder)'] },
                        { name: '灯光颜色', opts: ['暖黄', '玫红', '冰蓝'] }
                    ],
                    "欧普照明 户外射灯": [
                        { name: '防水等级', opts: ['IP65 (防雨)', 'IP67 (可浸水)'] },
                        { name: '光束角', opts: ['30度聚光', '60度泛光'] },
                        { name: '功率', opts: ['10W', '20W', '50W'] }
                    ],
                    "Artemide 经典工作灯": [
                        { name: '底座', opts: ['圆形底座', '桌边夹扣', '墙壁支架'] },
                        { name: '尺寸', opts: ['Tolomeo Micro', 'Tolomeo Mini', 'Tolomeo Classic'] },
                        { name: '材质', opts: ['铝合金原色', '黑色阳极氧化'] }
                    ],
                    "MUJI 香薰加湿灯": [
                        { name: '容量', opts: ['大号 (300ml)', '小号 (100ml)', '便携式'] },
                        { name: '精油套餐', opts: ['无精油', '含薰衣草精油', '含甜橙精油'] }
                    ],
                    "天马 Tenma 抽屉盒": [
                        { name: '尺寸', opts: ['面宽39cm (标准)', '面宽44cm (加宽)', '面宽30cm (窄款)'] },
                        { name: '高度', opts: ['18cm (内衣/袜)', '23cm (T恤/衬衫)', '30cm (毛衣/裤子)'] }
                    ],
                    "太力 真空压缩袋": [
                        { name: '套装', opts: ['特惠9件套 (4大4中1手泵)', '巨无霸3件套 (被褥专用)'] },
                        { name: '款式', opts: ['平面款 (普通)', '立体款 (加厚/可站立)'] }
                    ],
                    "宜家 IKEA 洞洞板": [
                        { name: '尺寸', opts: ['36x56cm (小号)', '56x56cm (中号)', '76x56cm (大号)'] },
                        { name: '颜色', opts: ['白色', '木色', '黑色'] },
                        { name: '配件', opts: ['仅板子', '含基础挂钩包'] }
                    ],
                    "霜山 内衣收纳盒": [
                        { name: '规格', opts: ['无格 (文胸)', '10格 (内裤)', '15格 (袜子)'] },
                        { name: '颜色', opts: ['磨砂透白', '杏色'] }
                    ],
                    "禧天龙 脏衣篮": [
                        { name: '层数', opts: ['双层 (分篮+顶板)', '三层 (双篮+顶板)'] },
                        { name: '颜色', opts: ['云雾白', '拿铁咖'] }
                    ],
                    "山崎实业 缝隙收纳车": [
                        { name: '宽度', opts: ['13cm (极窄)', '15cm (标准)', '20cm (宽缝)'] },
                        { name: '层数', opts: ['三层矮款', '四层高款'] }
                    ],
                    "无印良品 亚克力架": [
                        { name: '款式', opts: ['三层隔板架', '笔筒组合', '抽屉收纳盒'] },
                        { name: '尺寸', opts: ['约17.5x13cm', '约26x17.5cm'] }
                    ],
                    "茶花 密封整理箱": [
                        { name: '容量', opts: ['30L (杂物)', '55L (衣物)', '80L (棉被)'] },
                        { name: '颜色', opts: ['北欧蓝', '卡其色', '透明白'] }
                    ],
                    "慵懒居 书本收纳箱": [
                        { name: '规格', opts: ['小号 (约放15本)', '大号 (约放30本)'] },
                        { name: '款式', opts: ['透明可视款', '全封闭防尘款'] }
                    ],
                    "大创 桌面分层架": [
                        { name: '尺寸', opts: ['窄长款 (适合调料)', '宽阔款 (适合杯具)'] },
                        { name: '颜色', opts: ['纯白', '透明'] }
                    ],
                    "特福 Tefal 不粘锅": [
                        { name: '直径', opts: ['24cm (煎盘)', '28cm (炒锅)', '30cm (深炒锅)'] },
                        { name: '红点技术', opts: ['经典火红点', '新一代感温'] }
                    ],
                    "酷彩 Le Creuset 碟": [
                        { name: '颜色', opts: ['火焰橘', '樱桃红', '海岸蓝', '雪纺粉'] },
                        { name: '形状', opts: ['经典圆盘 (23cm)', '花形深盘 (20cm)'] }
                    ],
                    "星巴克 磨砂马克杯": [
                        { name: '容量', opts: ['中杯 (355ml)', '大杯 (473ml)'] },
                        { name: '款式', opts: ['经典墨绿', '磨砂黑', '纯白Logo'] },
                        { name: '配件', opts: ['单杯', '含盖+勺'] }
                    ],
                    "德龙 意式咖啡机": [
                        { name: '颜色', opts: ['复古绿 (Icona)', '奶油白', '海洋蓝'] },
                        { name: '类型', opts: ['半自动泵压', '全自动现磨'] }
                    ],
                    "摩飞 多功能料理机": [
                        { name: '标配', opts: ['深煮锅+牛扒盘', '深煮锅+蒸格'] },
                        { name: '颜色', opts: ['英伦红', '轻奢蓝', '椰奶白'] }
                    ],
                    "双立人 厨用刀具": [
                        { name: '刀型', opts: ['中式片刀', '三德刀', '多用刀套装'] },
                        { name: '系列', opts: ['红点系列', 'Pollux系列'] }
                    ],
                    "乐扣乐扣 保鲜盒": [
                        { name: '材质', opts: ['耐热玻璃', 'PP塑料 (BPA Free)'] },
                        { name: '形状', opts: ['长方形 (630ml)', '正方形 (500ml)', '圆形 (380ml)'] }
                    ],
                    "Balmuda 蒸汽烤箱": [
                        { name: '颜色', opts: ['经典黑', '极简白', '限定灰'] },
                        { name: '版本', opts: ['K01 标准版', 'K05 升级版'] }
                    ],
                    "小熊 电动打蛋器": [
                        { name: '供电', opts: ['插电大功率', '无线便携款'] },
                        { name: '档位', opts: ['5档调速', '10档调速'] }
                    ],
                    "Joseph Joseph 厨具": [
                        { name: '种类', opts: ['分类案板 (4件套)', '彩虹铲勺 (6件套)'] },
                        { name: '材质', opts: ['食品级塑料', '不锈钢'] }
                    ],
                    "ZARA 法式碎花裙": [
                        { name: '尺码', opts: ['XS (160/80A)', 'S (165/84A)', 'M (170/88A)', 'L (175/96A)'] },
                        { name: '花色', opts: ['复古红碎花', '清新蓝雏菊', '经典波点'] },
                        { name: '裙长', opts: ['短裙 (膝上)', '迷笛裙 (过膝)'] }
                    ],
                    "优衣库 羊绒针织衫": [
                        { name: '颜色', opts: ['09 Black', '31 Beige', '03 Gray', '12 Pink'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] },
                        { name: '领型', opts: ['圆领 (Crew Neck)', 'V领 (V Neck)', '高领 (Turtle Neck)'] }
                    ],
                    "Theory 通勤西装": [
                        { name: '尺码 (US)', opts: ['US 0 (155)', 'US 2 (160)', 'US 4 (165)', 'US 6 (170)'] },
                        { name: '版型', opts: ['修身版 (Slim)', '经典版 (Regular)'] },
                        { name: '颜色', opts: ['经典黑', '深藏青', '燕麦色'] }
                    ],
                    "Brandy Melville 吊带": [
                        { name: '尺码', opts: ['均码 (One Size)'] },
                        { name: '颜色', opts: ['纯白', '黑色', '婴儿蓝', '碎花款'] },
                        { name: '材质', opts: ['纯棉螺纹', '蕾丝拼接'] }
                    ],
                    "Lululemon 瑜伽裤": [
                        { name: '系列', opts: ['Align (裸感亲肤)', 'Wunder Train (速干支撑)'] },
                        { name: '裤长', opts: ['21" (七分)', '25" (九分)', '28" (长裤)'] },
                        { name: '尺码', opts: ['Size 2', 'Size 4', 'Size 6', 'Size 8'] }
                    ],
                    "Snidel 蕾丝半身裙": [
                        { name: '尺码', opts: ['0码 (S)', '1码 (M)'] },
                        { name: '颜色', opts: ['米白色 (OWHT)', '摩卡色 (MOC)', '薰衣草紫 (LAV)'] }
                    ],
                    "MO&Co. 连帽卫衣": [
                        { name: '尺码', opts: ['XS', 'S', 'M', 'L'] },
                        { name: '加绒', opts: ['常规薄款', '加绒加厚'] },
                        { name: '图案', opts: ['经典Logo印花', '联名卡通IP'] }
                    ],
                    "AllSaints 皮夹克": [
                        { name: '尺码 (UK)', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] },
                        { name: '款式', opts: ['Balfern (腰带款)', 'Dalby (极简款)'] },
                        { name: '皮质', opts: ['绵羊皮', '山羊皮麂皮'] }
                    ],
                    "Burberry 经典风衣": [
                        { name: '版型', opts: ['Chelsea (修身)', 'Kensington (现代)', 'Waterloo (宽松)'] },
                        { name: '颜色', opts: ['蜂蜜色 (Honey)', '黑色 (Black)', '午夜蓝'] },
                        { name: '尺码', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] }
                    ],
                    "COS 极简连衣裙": [
                        { name: '尺码 (EU)', opts: ['32', '34', '36', '38', '40'] },
                        { name: '颜色', opts: ['静谧黑', '奶油白', '海军蓝'] },
                        { name: '材质', opts: ['有机棉', '真丝混纺'] }
                    ],
                    // --- ▼▼▼ 新增：10个男装产品的定制规格 (硬核详细版) ▼▼▼ ---
                    "优衣库 重磅T恤": [
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['纯白 (White)', '碳黑 (Dark Gray)', '藏青 (Navy)', '大地色'] },
                        { name: '版型', opts: ['标准版 (Regular)', '宽松版 (Oversized)'] }
                    ],
                    "Dickies 工装裤": [
                        { name: '尺码 (腰围)', opts: ['28', '30', '32', '34', '36'] },
                        { name: '颜色', opts: ['卡其色 (Khaki)', '黑色 (Black)', '深蓝 (Dark Navy)'] },
                        { name: '裤长', opts: ['30 (常规)', '32 (加长)'] }
                    ],
                    "Ralph Lauren 衬衫": [
                        { name: '版型', opts: ['Classic Fit (宽松)', 'Custom Slim (修身)'] },
                        { name: '颜色', opts: ['经典白', '牛津蓝', '条纹款'] },
                        { name: '领型', opts: ['扣领 (Button Down)', '温莎领'] }
                    ],
                    "Nike 运动夹克": [
                        { name: '系列', opts: ['Windrunner (风行者)', 'Tech Fleece (科技棉)'] },
                        { name: '尺码', opts: ['M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['黑白熊猫', '荧光绿', '全黑'] }
                    ],
                    "始祖鸟 GORE-TEX": [
                        { name: '型号', opts: ['Alpha SV (向导级)', 'Beta LT (全能款)', 'Atom LT (棉服)'] },
                        { name: '颜色', opts: ['黑色 (Black)', '翠鸟绿 (Kingfisher)', '以太蓝'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] }
                    ],
                    "Levi's 原色牛仔裤": [
                        { name: '裤型', opts: ['501 (直筒纽扣)', '511 (修身拉链)', '502 (标准锥形)'] },
                        { name: '腰围', opts: ['W30', 'W31', 'W32', 'W33', 'W34'] },
                        { name: '裤长', opts: ['L30', 'L32', 'L34'] }
                    ],
                    "G2000 商务西裤": [
                        { name: '版型', opts: ['修身 (Slim)', '直筒 (Regular)'] },
                        { name: '面料', opts: ['四季羊毛', '抗皱免烫', '加绒厚款'] },
                        { name: '腰围', opts: ['76cm', '80cm', '84cm', '88cm'] }
                    ],
                    "Champion 连帽衫": [
                        { name: '工艺', opts: ['Reverse Weave (横纹编织)', 'Basic (基础款)'] },
                        { name: '颜色', opts: ['花灰 (Grey)', '藏青', '酒红'] },
                        { name: 'Logo', opts: ['小C标', '草写大Logo'] }
                    ],
                    "Barbour 涂蜡外套": [
                        { name: '型号', opts: ['Bedale (短款/马术)', 'Beaufort (长款/狩猎)', 'Ashby (修身)'] },
                        { name: '颜色', opts: ['Sage (鼠尾草绿)', 'Olive (橄榄褐)', 'Navy (蓝)'] },
                        { name: '尺码 (UK)', opts: ['36', '38', '40', '42'] }
                    ],
                    "Stone Island 夹克": [
                        { name: '材质', opts: ['Nylon Metal (金属尼龙)', 'Crinkle Reps (皱缩)', 'Soft Shell'] },
                        { name: '袖标', opts: ['经典黄绿标', '暗影全黑标 (Shadow)'] },
                        { name: '尺码', opts: ['L', 'XL', 'XXL', '3XL'] }
                    ],
                    // --- ▼▼▼ 新增：10款鞋子产品的定制规格 (专业尺码版) ▼▼▼ ---
                    "匡威 1970s 帆布鞋": [
                        { name: '款式', opts: ['高帮 (High)', '低帮 (Low)'] },
                        { name: '颜色', opts: ['经典黑', '米白色 (Parchment)', '向日葵黄'] },
                        { name: '尺码 (偏大)', opts: ['36.5', '37.5', '39', '41.5', '42.5', '44'] }
                    ],
                    "New Balance 老爹鞋": [
                        { name: '型号', opts: ['NB 990v6 (美产)', 'NB 2002R', 'NB 530 (复古)'] },
                        { name: '颜色', opts: ['元祖灰 (Grey)', '海军蓝 (Navy)', '海盐白'] },
                        { name: '鞋宽', opts: ['D (标准)', '2E (加宽)'] }
                    ],
                    "Adidas Samba 德训鞋": [
                        { name: '配色', opts: ['OG 黑白', 'OG 白黑', '纯白灰尾'] },
                        { name: '版本', opts: ['Classic (经典长舌)', 'OG (短舌)'] },
                        { name: '尺码', opts: ['UK 4 (36.5)', 'UK 5 (38)', 'UK 7 (40.5)', 'UK 9 (43.5)'] }
                    ],
                    "GH Bass 乐福鞋": [
                        { name: '皮质', opts: ['抛光牛皮 (Weejuns)', '荔枝纹软皮'] },
                        { name: '颜色', opts: ['酒红色 (Wine)', '黑色 (Black)', '黑白拼色'] },
                        { name: '尺码 (US)', opts: ['US 7', 'US 8', 'US 9', 'US 10'] }
                    ],
                    "Dr. Martens 马丁靴": [
                        { name: '孔数', opts: ['1460 (8孔经典)', '1461 (3孔低帮)', 'Jadon (厚底)'] },
                        { name: '皮质', opts: ['硬皮 (Smooth)', '软皮 (Nappa)', '荔枝皮'] },
                        { name: '尺码 (UK)', opts: ['UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7'] }
                    ],
                    "Asics 亚瑟士跑鞋": [
                        { name: '系列', opts: ['Kayano 14 (支撑)', 'Nimbus 25 (缓震)', 'GT-2000'] },
                        { name: '颜色', opts: ['金属银 (Silver)', '奶油白', '黑武士'] },
                        { name: '尺码', opts: ['39', '40.5', '41.5', '42.5', '43.5'] }
                    ],
                    "Birkenstock 拖鞋": [
                        { name: '款式', opts: ['Boston (包头)', 'Arizona (双带)'] },
                        { name: '材质', opts: ['翻毛皮 (Suede)', '油皮 (Oiled)', 'EVA (防水)'] },
                        { name: '颜色', opts: ['灰褐色 (Taupe)', '摩卡色', '黑色'] }
                    ],
                    "Clarks 商务皮鞋": [
                        { name: '款式', opts: ['Desert Boot (沙漠靴)', 'Wallabee (袋鼠鞋)'] },
                        { name: '皮质', opts: ['蜜蜡色油皮', '沙色反绒皮', '黑色光面'] },
                        { name: '尺码 (UK)', opts: ['UK 7', 'UK 8', 'UK 9', 'UK 9.5'] }
                    ],
                    "Salomon 户外越野鞋": [
                        { name: '型号', opts: ['XT-6 (潮流款)', 'ACS Pro (机能款)', 'Speedcross'] },
                        { name: '配色', opts: ['香草白', '火山黑', '冰川蓝'] },
                        { name: '尺码', opts: ['EUR 40', 'EUR 41', 'EUR 42', 'EUR 43'] }
                    ],
                    "UGG 羊毛雪地靴": [
                        { name: '筒高', opts: ['Ultra Mini (超低筒)', 'Mini (低筒)', 'Short (中筒)'] },
                        { name: '颜色', opts: ['栗色 (Chestnut)', '巧克力色', '黑色'] },
                        { name: '尺码 (US)', opts: ['US 6', 'US 7', 'US 8', 'US 9'] }
                    ],
                    "泡泡玛特 盲盒手办": [
                        { name: '款式', opts: ['单盒 (随机)', '整盒 (12个不重复)', '确认款 (指定角色)'] },
                        { name: 'IP系列', opts: ['Molly 周年庆', 'Dimoo 森林', 'Skullpanda 梦境'] }
                    ],
                    "乐高 机械组赛车": [
                        { name: '型号', opts: ['法拉利 Daytona (42143)', '迈凯伦 F1 (42141)', '保时捷 911 (42096)'] },
                        { name: '版本', opts: ['原盒未拆', '带展示盒版', '已拼装成品'] }
                    ],
                    "Jellycat 邦尼兔": [
                        { name: '尺寸', opts: ['小号 (18cm)', '中号 (31cm)', '大号 (36cm)', '超大 (51cm)'] },
                        { name: '颜色', opts: ['米色 (Beige)', '害羞粉 (Tulip)', '星空蓝', '薰衣草紫'] }
                    ],
                    "大疆 Tello 遥控机": [
                        { name: '套餐', opts: ['标配版 (单电)', '畅飞版 (三电+充电管家)'] },
                        { name: '配件', opts: ['仅机器', '含手柄控制器', '含编程扩展包'] }
                    ],
                    "任天堂 Switch 游戏": [
                        { name: '版本', opts: ['日版', '港版', '美版'] },
                        { name: '游戏名', opts: ['塞尔达: 王国之泪', '马力欧卡丁车8', '动森', '健身环'] },
                        { name: '类型', opts: ['全新卡带', '二手回血'] }
                    ],
                    "富士 Instax 拍立得": [
                        { name: '型号', opts: ['Mini 12 (入门)', 'Mini Evo (数模双模)', 'SQ1 (方形)'] },
                        { name: '颜色', opts: ['薄荷绿', '樱花粉', '复古棕', '极夜黑'] },
                        { name: '相纸套餐', opts: ['标配无纸', '含20张白边', '含50张白边'] }
                    ],
                    "索尼 复古卡带机": [
                        { name: '成色', opts: ['全新库存 (NOS)', '99新收藏级', '8成新战斗级'] },
                        { name: '型号', opts: ['TPS-L2 (初代)', 'WM-2 (红)', 'WM-D6C (专业)'] }
                    ],
                    "Bearbrick 积木熊": [
                        { name: '尺寸', opts: ['100% (7cm)', '400% (28cm)', '1000% (70cm)'] },
                        { name: '款式', opts: ['梵高星空', '招财猫金运', '大理石纹', '透明限定'] }
                    ],
                    "KAWS 联名公仔": [
                        { name: '姿势', opts: ['站姿 (Standing)', '坐姿 (Passing Through)', '躺姿 (Holiday)'] },
                        { name: '配色', opts: ['经典灰', '全黑', '解剖半透'] },
                        { name: '版本', opts: ['OPEN EDITION', '会场限定'] }
                    ],
                    "万代 RG 高达模型": [
                        { name: '机体', opts: ['牛高达 (Nu Gundam)', '沙扎比 (Sazabi)', '独角兽 (Unicorn)', '海牛 (Hi-Nu)'] },
                        { name: '比例', opts: ['RG 1/144', 'MG 1/100 (部分款)', 'PG 1/60'] },
                        { name: '版本', opts: ['普通版', '彩透限定', '钛电镀版'] }
                    ],
                    "Keychron 机械键盘": [
                        { name: '轴体', opts: ['G Pro 红轴 (线性)', 'G Pro 青轴 (段落)', 'G Pro 茶轴 (微段落)'] },
                        { name: '背光', opts: ['RGB 铝合金边框', '白光 塑料边框'] },
                        { name: '布局', opts: ['K2 (75%紧凑)', 'K8 (87键)', 'Q1 Pro (客制化)'] }
                    ],
                    "罗技 MX 无线鼠标": [
                        { name: '型号', opts: ['MX Master 3S (旗舰)', 'MX Anywhere 3 (便携)', 'Lift (垂直工学)'] },
                        { name: '颜色', opts: ['石墨黑 (Graphite)', '珍珠白 (Pale Grey)', '玫瑰粉'] },
                        { name: '套餐', opts: ['标准版', '含皮质收纳包'] }
                    ],
                    "索尼 降噪耳机": [
                        { name: '型号', opts: ['WH-1000XM5 (最新)', 'WH-1000XM4 (折叠)'] },
                        { name: '颜色', opts: ['铂金银', '黑色', '深夜蓝'] },
                        { name: '加购', opts: ['无', '加购2年延保'] }
                    ],
                    "马歇尔 便携音箱": [
                        { name: '型号', opts: ['Emberton II (便携防水)', 'Stockwell II (手提)', 'Middleton (大功率)'] },
                        { name: '配色', opts: ['经典黑金 (Black&Brass)', '奶油白 (Cream)', '森林绿'] }
                    ],
                    "Apple Watch Ultra": [
                        { name: '表带类型', opts: ['高山回环 (Alpine)', '野径回环 (Trail)', '海洋表带 (Ocean)'] },
                        { name: '表带颜色', opts: ['星光色', '绿色', '橙色', '午夜黑'] },
                        { name: 'AppleCare+', opts: ['不购买', '购买 (+¥799)'] }
                    ],
                    "Wacom 专业数位板": [
                        { name: '尺寸', opts: ['PTH-660 (中号 M)', 'PTH-860 (大号 L)'] },
                        { name: '版本', opts: ['标准版', 'Paper Edition (纸感)'] },
                        { name: '赠品', opts: ['官方笔芯套装', '专用防护包'] }
                    ],
                    "安克 Anker 充电宝": [
                        { name: '容量/功率', opts: ['10000mAh (30W)', '20000mAh (200W)', '24000mAh (140W)'] },
                        { name: '屏幕', opts: ['无屏幕', '智能数显屏 (Prime系列)'] },
                        { name: '颜色', opts: ['极光黑', '香槟金'] }
                    ],
                    "极米 投影仪支架": [
                        { name: '适用机型', opts: ['H系列/Z系列通用', 'RS Pro 专用'] },
                        { name: '款式', opts: ['桌面支架 (万向球头)', '落地支架 (金属加重)', '床头夹支架'] },
                        { name: '材质', opts: ['航空铝合金', '碳钢'] }
                    ],
                    "Xbox 精英手柄": [
                        { name: '版本', opts: ['精英2代 青春版 (白色)', '精英2代 完整版 (黑色)'] },
                        { name: '自定义', opts: ['标准配置', 'Design Lab 定制色'] },
                        { name: '配件', opts: ['单手柄', '含无线适配器'] }
                    ],
                    "贝尔金 桌面三合一": [
                        { name: 'MagSafe', opts: ['15W 官方认证快充', '7.5W 普通磁吸'] },
                        { name: '颜色', opts: ['纯白 (White)', '酷黑 (Black)'] },
                        { name: '插头规格', opts: ['国标两插', '美标', '英标'] }
                    ]

                };
                    // 1. 精确匹配
                    if (SPEC_DB[title]) {
                        specsData = SPEC_DB[title];
                    } 
                    // 2. 模糊匹配 (兜底逻辑，防止没写的商品显示空白)
                    else {
                        if (title.includes('灯')) specsData = [{ name: '光色', opts: ['暖光', '白光'] }, { name: '开关', opts: ['按钮', '遥控'] }];
                        else if (title.includes('椅') || title.includes('沙发')) specsData = [{ name: '颜色', opts: ['灰色', '米色', '蓝色'] }];
                        else if (title.includes('柜') || title.includes('桌')) specsData = [{ name: '材质', opts: ['实木', '人造板'] }];
                        else specsData = [{ name: '规格', opts: ['默认规格'] }];
                    }
                }

                // C. 统一渲染 HTML (将 specsData 数组转换成界面元素)
                buySpecsContainer.innerHTML = specsData.map(group => `
                    <div class="spec-group">
                        <div class="spec-title">${group.name}</div>
                        <div class="spec-tags">
                            ${group.opts.map((opt, i) => `<span class="spec-tag ${i===0?'active':''}">${opt}</span>`).join('')}
                        </div>
                    </div>
                `).join('');

                // D. 绑定点击事件 (点击变黑)
                const allSpecTags = buySpecsContainer.querySelectorAll('.spec-tag');
                allSpecTags.forEach(tag => {
                    tag.onclick = function() {
                        const siblings = this.parentElement.querySelectorAll('.spec-tag');
                        siblings.forEach(s => s.classList.remove('active'));
                        this.classList.add('active');
                    };
                });
                // === 修改结束 ===

                // 4. 显示弹窗
                buyModal.classList.add('visible');
                window.__pauseAutoTriggerCountdown?.();

            });
        }
   const btnBuyForChar = document.getElementById('buy-for-char-trigger');
        
        if (btnBuyForChar) {
            btnBuyForChar.addEventListener('click', async () => {
                // 1. 复用“给Ta买”的角色列表弹窗
                const giftOverlay = document.getElementById('gift-character-modal-overlay');
                const giftList = document.getElementById('gift-char-list');
                
                if (giftOverlay && giftList) {
                    // 显示弹窗
                    giftOverlay.classList.add('visible');
                    window.__pauseAutoTriggerCountdown?.();
                    giftList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                    // 2. 加载角色数据
                    try {
                        const chars = await getAllCharacters();
                        giftList.innerHTML = ''; // 清空
                        if (!chars || chars.length === 0) {
                            giftList.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友</div>';
                            return;
                        }
                        // 3. 渲染列表
                        chars.forEach(char => {
                            const item = document.createElement('div');
                            item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom:8px;';
                            item.innerHTML = `
                                <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                                <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                                <span style="margin-left: auto; color: #d93025; font-size: 12px;">选择 ›</span>
                            `;
                            // 4. 【核心】点击角色后的逻辑
                            item.addEventListener('click', () => {
                                // A. 生成随机电话号码 (13x-xxxx-xxxx)
                                const prefix = ['135','136','137','138','139','150','151','158','186','188'];
                                const randPrefix = prefix[Math.floor(Math.random() * prefix.length)];
                                const randSuffix = Math.floor(Math.random() * 90000000 + 10000000).toString();
                                const phoneNum = randPrefix + '****' + randSuffix.slice(-4);
                                // B. 找到购买弹窗里的“地址栏区域”
                                const addressSection = document.querySelector('.shop-buy-card .buy-section.address-section');
                                
                                // C. 替换 HTML 为角色头像样式
                                if (addressSection) {
                                    // 保留标题 "收货地址"
                                    addressSection.innerHTML = `
                                        <div class="section-label">收货地址</div>
                                        <div class="char-address-row">
                                            <img src="${char.avatar || 'images/default-avatar.svg'}" class="char-avatar">
                                            <div class="char-info">
                                                <span class="char-name">收件人：${char.name}</span>
                                                <span class="char-phone">${phoneNum}</span>
                                            </div>
                                        </div>
                                        <!-- 插入一个隐藏的 input 标记这是送给角色的，方便以后结算逻辑判断 -->
                                        <input type="hidden" id="is-gift-order" value="true">
                                        <input type="hidden" id="gift-target-id" value="${char.id}">
                                    `;
                                }
                                // D. 关闭选择弹窗
                                giftOverlay.classList.remove('visible');
                                window.__pauseAutoTriggerCountdown?.();
                                showDynamicIsland(`已选择 ${char.name} 作为收件人`, 'success');
                            });
                            giftList.appendChild(item);
                        });
                    } catch (e) {
                        console.error(e);
                        giftList.innerHTML = '加载失败';
                    }
                }
            });
        }
        // 4. 处理关闭逻辑
        if(buyCloseBtn) {
            buyCloseBtn.addEventListener('click', () => {
                buyModal.classList.remove('visible');
                window.__resumeAutoTriggerCountdown?.();
            });
        }
        // 5. 模拟提交订单
        const confirmPayBtn = document.getElementById('shop-confirm-pay-btn');
        if(confirmPayBtn) {
            // 先移除旧监听器（防止重复绑定），使用替换节点法
            const newConfirmBtn = confirmPayBtn.cloneNode(true);
            confirmPayBtn.parentNode.replaceChild(newConfirmBtn, confirmPayBtn);
            newConfirmBtn.addEventListener('click', async () => {
                // ▼▼▼ 【核心修改】智能获取地址和电话 ▼▼▼
                let addr = '';
                let phone = '';
                let isGift = false; // 标记是否是礼物
                
                // 【重点修复】仅在当前的 buyModal（购买弹窗）范围内查找元素，防止抓取到购物车页面的残留信息
                const addrInput = buyModal.querySelector('#buy-address-input');
                const phoneInput = buyModal.querySelector('#buy-phone-input');
                const charNameEl = buyModal.querySelector('.char-name');
                const charPhoneEl = buyModal.querySelector('.char-phone');

                if (charNameEl && charPhoneEl) {
                    // --- 情况A：这是给角色买的 ---
                    const rawName = charNameEl.textContent.replace('收件人：', '').trim();
                    addr = `${rawName} 的默认收货地址`;
                    phone = charPhoneEl.textContent.trim();
                    isGift = true;
                } else if (addrInput && phoneInput) {
                    // --- 情况B：这是给自己买的 ---
                    addr = addrInput.value.trim();
                    phone = phoneInput.value.trim();
                    isGift = false; // 确保是自购
                }
                
                // 验证必填项
                if (!addr) {
                    showDynamicIsland('请填写或选择收货信息', 'error');
                    return;
                }
                // 2. 获取配送时间
                const activeTimeChip = document.querySelector('.shop-buy-card .time-chip.active');
                let deliveryTime = "尽快送达";
                
                if (activeTimeChip) {
                    if (activeTimeChip.dataset.val === 'custom') {
                        const innerInput = activeTimeChip.querySelector('input');
                        if (innerInput && innerInput.value) {
                            deliveryTime = innerInput.value + ' 轮对话后';
                        } else {
                            showDynamicIsland('请输入自定义轮数', 'error');
                            return;
                        }
                    } else {
                        deliveryTime = activeTimeChip.textContent.trim() + ' 对话后';
                    }
                }
                // 3. 获取商品信息
                const title = document.getElementById('buy-mini-title').textContent;
                const imgBg = document.getElementById('buy-mini-img').style.backgroundImage;
                const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");
                const specTags = document.querySelectorAll('#buy-specs-container .spec-tag.active');
                let specsText = ''; 
                if (specTags.length > 0) {
                    specsText = Array.from(specTags).map(tag => tag.textContent.trim()).join(' / ');
                } else {
                    specsText = '标准规格'; 
                }
                // 4. 构造物流卡片消息
                const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
                
                // 如果是礼物，发给选定的角色；如果是自己买，发到当前聊天窗口
                // 这里为了简化体验，统一发到当前聊天窗口，但你可以根据 gift-target-id 隐藏域来改变 targetId
                let targetChatId = tempState.currentChatId;
                const giftTargetInput = document.getElementById('gift-target-id');
                if (isGift && giftTargetInput && giftTargetInput.value) {
                    targetChatId = giftTargetInput.value; 
                }
                // ▼▼▼ 购物车群聊物流拦截器 ▼▼▼
                const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                let displayTitle = title;
                if (isGift && currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                    const targetChar = AppState.characterProfiles.find(c => c.id === targetChatId);
                    if (targetChar) displayTitle = title + ` (@${targetChar.name})`;
                    targetChatId = tempState.currentChatId; // 强制截获发群里
                }
                // ▲▲▲ 拦截器结束 ▲▲▲
                const logisticsMessage = {
                    chatId: targetChatId,
                    timestamp: new Date(),
                    text: '[物流订单]',
                    type: 'sent',
                    contentType: 'logistics_card',
                    content: {
                        title: displayTitle, // <-- 【关键】这里将原先的 title 换成了我们处理过带名字的 displayTitle
                        img: imgUrl,

                        specs: specsText,
                        address: addr,
                        phone: phone,
                        deliveryTime: deliveryTime
                    },
                    avatarSrc: currentUser?.avatar || 'images/default-avatar.svg',
                    recalled: false
                };
                // 5. 发送消息
                try {
                     const price = document.getElementById('buy-total-price').textContent;
                    const payment = await requestLookyPayment({
                        amount: price,
                        title: isGift ? `送礼物 - ${title}` : `购物 - ${title}`,
                        scene: 'shop'
                    });
                    if (!payment) return;
                    const { db } = await import('../state.js'); 
                    const { createAndAppendMessage } = await import('./chat-ui.js');
                    const messageId = await db.chatMessages.add(logisticsMessage);
                    await recordLookyLedger({
                        source: 'shop_logistics',
                        sourceId: messageId,
                        type: 'expense',
                        amount: price,
                        category: '购物',
                        title: isGift ? `送礼物 - ${title}` : `购物 - ${title}`,
                        memo: specsText || '',
                        char: targetChatId,
                        paymentMethod: payment.displayName || '',
                        paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                        timestamp: Date.now(),
                        isAuto: true
                    });
                 const newOrder = {
                        id: Date.now(),
                        ledgerSynced: true,
                        shopName: 'Looky Selection',
                        status: '等待卖家发货',
                        items: [{
                            title: title, // title 变量在上面第3步已经获取了，这里可以直接用
                            specs: specsText, // specsText 也在上面获取了
                            price: price, // 现在 price 定义了，不会报错了
                            count: 1,
                            img: imgUrl // imgUrl 也在上面获取了
                        }],
                        total: price
                    };
                    let myOrders = JSON.parse(localStorage.getItem('my_shop_orders') || '[]');
                    myOrders.unshift(newOrder); 
                    if (myOrders.length > 10) myOrders = myOrders.slice(0, 10); 
                    localStorage.setItem('my_shop_orders', JSON.stringify(myOrders));
                    if (isGift && deliveryTime.includes('轮')) { 
                                  const initialTurns = parseInt(deliveryTime);
                        if (!isNaN(initialTurns)) {
                            if (!tempState.activeGifts) tempState.activeGifts = {};
                            if (!tempState.activeGifts[targetChatId]) tempState.activeGifts[targetChatId] = [];
                            
                            // 直接推入当前这一个商品的信息
               tempState.activeGifts[targetChatId].push({
                                msgId: messageId,      // 绑定的消息ID
                                remaining: initialTurns, // 剩余轮数
                                status: 'delivering',   // 状态
                                title: title,           // 详情页获取到的标题
                                img: imgUrl,            // 详情页获取到的图片
                                isFromAiPay: false      // 标记为用户购买
                            });
                            // 保存到本地存储
                            localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                        }
                    }
                    if (String(targetChatId) === String(tempState.currentChatId)) {

                        const newMessage = await db.chatMessages.get(messageId);
                        await createAndAppendMessage(newMessage);
                    }
                    
                    buyModal.classList.remove('visible');
                    window.__autoTriggerCountdown?.();
                    
                    if (isGift) {
                        showDynamicIsland('已为Ta下单成功', 'success');
                    } else {
                        showDynamicIsland('订单已提交', 'success');
                    }
                    
                    // 重置输入框 (如果存在)
                    if(addrInput) addrInput.value = '';
                    if(phoneInput) phoneInput.value = '';
                } catch (e) {
                    console.error("发送物流消息失败", e);
                    showDynamicIsland('发送失败', 'error');
                }
            });
        }

        // 6. 处理预计送达时间的标签切换 (终极版：内置输入框)
        const timeChips = document.querySelectorAll('.shop-buy-card .time-chip');

        timeChips.forEach(chip => {
            // 给整个标签添加点击事件
            chip.addEventListener('click', function(e) {
                // 1. 样式切换：排他
                timeChips.forEach(c => c.classList.remove('active'));
                this.classList.add('active');

                // 2. 如果点击的是自定义标签，自动让里面的输入框获得焦点
                const innerInput = this.querySelector('input');
                if (innerInput) {
                    innerInput.focus();
                }
            });
            
            // 给里面的输入框添加监听：防止点击输入框时冒泡导致的问题（虽然上面的 click 已经处理了，但这样更保险）
            const innerInput = chip.querySelector('input');
            if (innerInput) {
                innerInput.addEventListener('click', (e) => {
                    e.stopPropagation(); // 阻止冒泡，避免触发父级 click 两次
                    // 手动触发选中效果
                    timeChips.forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                });
                
                // 输入时，强制保持选中状态
                innerInput.addEventListener('input', () => {
                    timeChips.forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                });
            }
        });

        const cellRows = detailPage.querySelectorAll('.cell-row');
        cellRows.forEach(row => {
            row.addEventListener('click', () => {
                // 这里的逻辑很简单：你点这一行，我就帮你点一下下面的购物车按钮
                if(btnCartIcon) btnCartIcon.click(); 
            });
        });
       const shareModal = document.getElementById('shop-share-modal-overlay');
        const shareCancelBtn = document.getElementById('shop-share-cancel-btn');
        const shareCopyBtn = document.getElementById('share-action-copy');
        const shareForwardBtn = document.getElementById('share-action-forward');
        if (btnShare && shareModal) {
            // 1. 点击右上角分享按钮 -> 打开弹窗
            btnShare.addEventListener('click', () => {
                shareModal.classList.add('visible');
            });
            // 2. 关闭逻辑 (点击取消或遮罩)
            const closeShareModal = () => shareModal.classList.remove('visible');
            if (shareCancelBtn) shareCancelBtn.addEventListener('click', closeShareModal);
            shareModal.addEventListener('click', (e) => {
                if (e.target === shareModal) closeShareModal();
            });
            // 3. 点击“复制链接” (生成淘口令风格)
            if (shareCopyBtn) {
                shareCopyBtn.addEventListener('click', () => {
                    // 先关闭弹窗
                    closeShareModal();
                    
                    // A. 获取商品信息
                    const title = document.getElementById('shop-detail-title').textContent || '精选好物';
                    const price = document.getElementById('shop-detail-price').textContent || '--';
                    
                    // B. 生成随机口令 (模拟 8位 随机字符)
                    // Math.random() 生成随机数，toString(36) 转成36进制(包含字母)，截取中间一段并转大写
                    const randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();
                    const token = `￥${randomCode}￥`; // 前后加符号，更有那味儿
                    
                    // C. 组合成完整的分享文案
                    const shareText = `【${title}】\n福利价: ¥${price}\n复制此口令 ${token} 打开App直达详情`;

                    // D. 写入剪贴板
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(shareText).then(() => {
                            showDynamicIsland('口令已复制，快去分享吧', 'success');
                        }).catch(() => {
                            // 极少数情况复制失败的兜底
                            showDynamicIsland('复制失败，请重试', 'error');
                        });
                    } else {
                        // 兼容旧浏览器
                        const textarea = document.createElement('textarea');
                        textarea.value = shareText;
                        document.body.appendChild(textarea);
                        textarea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textarea);
                        showDynamicIsland('口令已复制', 'success');
                    }
                });
            }
            // 4. 点击“转发给好友” (弹出好友选择列表)
            if (shareForwardBtn) {
                shareForwardBtn.addEventListener('click', async () => {
                    // A. 关闭“分享”弹窗
                    closeShareModal();
                    
                    // B. 获取“转发”弹窗元素
                    const forwardModal = document.getElementById('shop-forward-modal-overlay');
                    const forwardList = document.getElementById('shop-forward-list');
                    const forwardCloseBtn = document.getElementById('shop-forward-close-btn');
                    // 1. 提前获取当前页面的商品数据
                    const currentTitle = document.getElementById('shop-detail-title').textContent;
                    const currentPrice = document.getElementById('shop-detail-price').textContent;
                    const bgStyle = document.getElementById('shop-detail-img').style.backgroundImage;
                    const currentImgUrl = bgStyle.slice(5, -2).replace(/['"]/g, ""); 
                    const currentSales = document.querySelector('#page-life-product-detail').dataset.sales || '';
                    const currentSpecs = document.querySelector('#page-life-product-detail').dataset.currentSpecs || '';
                    
                    if (!forwardModal || !forwardList) return;
                    
                    // C. 打开新弹窗并显示加载状态
                    forwardModal.classList.add('visible');
                    // ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
                    // 【关键修复】在此处定义 closeForwardModal 函数
                    // 必须定义在这里，下面的 item.addEventListener 才能调用它
                    const closeForwardModal = () => forwardModal.classList.remove('visible');
                    // 顺便绑定关闭按钮和遮罩层的关闭事件
                    if (forwardCloseBtn) forwardCloseBtn.onclick = closeForwardModal;
                    forwardModal.onclick = (e) => {
                        if (e.target === forwardModal) closeForwardModal();
                    };
                    // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                    try {
                        
                        const { db, tempState } = await import('../state.js'); 
                        const { createAndAppendMessage, getCurrentChatIdentity } = await import('./chat-ui.js');
                        const chars = await getAllCharacters();
                        forwardList.innerHTML = ''; 
                        
                        if (!chars || chars.length === 0) {
                            forwardList.innerHTML = '<div class="loading-placeholder">暂无好友，快去添加吧</div>';
                            return;
                        }
                        // G. 渲染列表
                        chars.forEach(char => {
                            const item = document.createElement('div');
                            item.className = 'forward-item';
                            item.innerHTML = `
                                <img src="${char.avatar || 'images/default-avatar.svg'}">
                                <span class="name">${char.name}</span>
                                <button class="send-btn">发送</button>
                            `;
                            
                            // 绑定点击事件：发送给该好友
                            item.addEventListener('click', async () => {
                                // 构造商品数据对象
                                const shareData = {
                                    title: currentTitle,
                                    price: currentPrice,
                                    imgUrl: currentImgUrl,
                                    sales: currentSales,
                                    specs: currentSpecs,
                                    shopName: 'Looky Selection'
                                };
                                // 构造消息对象
                                const currentUser = getCurrentChatIdentity();
                                const messageToSave = {
                                    chatId: char.id,
                                    timestamp: new Date(),
                                    text: `[分享商品] ${currentTitle}`,
                                    type: 'sent',
                                    contentType: 'product_share',
                                    content: shareData,
                                    avatarSrc: currentUser?.avatar || 'images/default-avatar.svg',
                                    recalled: false
                                };
                                try {
                                    const messageId = await db.chatMessages.add(messageToSave);
                                    
                                    // 这里调用刚才定义的函数，现在它存在了，就不会报错了
                                    closeForwardModal();
                                    
                                    showDynamicIsland(`已分享给 ${char.name}`, 'success');
                                    if (String(char.id) === String(tempState.currentChatId)) {
                                        const newMessage = await db.chatMessages.get(messageId);
                                        await createAndAppendMessage(newMessage);
                                    }
                                } catch (err) {
                                    console.error("分享失败", err);
                                    showDynamicIsland('分享失败', 'error');
                                }
                            });
                            forwardList.appendChild(item);
                        });
                    } catch (e) {
                        console.error(e);
                        forwardList.innerHTML = '<div class="loading-placeholder">加载失败，请重试</div>';
                    }
                });
            }
        }
        // 获取新弹窗元素
        const shopSpecsOverlay = document.getElementById('shop-specs-modal-overlay');
        const shopSpecsClose = document.getElementById('shop-specs-close-btn');
        const shopSpecsConfirm = document.getElementById('shop-specs-confirm-btn');
        const shopSpecsContainer = document.getElementById('shop-specs-container');
        
        // 数量控制元素
        const btnMinus = document.getElementById('shop-specs-minus');
        const btnPlus = document.getElementById('shop-specs-plus');
        const countDisplay = document.getElementById('shop-specs-count');
        let currentShopCount = 1;
        if(btnCartIcon && shopSpecsOverlay) {
            // A. 点击购物车图标 -> 打开弹窗
            btnCartIcon.addEventListener('click', () => {
                // 1. 获取当前商品信息
                const title = document.getElementById('shop-detail-title').textContent;
                const price = document.getElementById('shop-detail-price').textContent;
                const imgBg = document.getElementById('shop-detail-img').style.backgroundImage;
                // 清理图片url格式
                const imgUrl = imgBg.replace(/^url\(['"](.+)['"]\)/, '$1');
                // 2. 填充弹窗头部信息
                document.getElementById('shop-specs-price').textContent = price;
                document.getElementById('shop-specs-img').style.backgroundImage = `url('${imgUrl}')`;
            currentShopCount = 1;
if(countDisplay) countDisplay.textContent = currentShopCount;
             
let specs = [];
                const customSpecsStr = document.getElementById('page-life-product-detail').dataset.currentSpecs;
                if (customSpecsStr && customSpecsStr.trim() !== '') {
                    // 【优化】支持更细致的解析：按分号分隔组，按冒号分隔标题
                    // 例如输入 "颜色:红,白;尺寸:S,M"
                    const groups = customSpecsStr.split(/[;；]/);
                    specs = groups.map(g => {
                        const parts = g.split(/[:：]/);
                        if (parts.length > 1) {
                            return { 
                                name: parts[0].trim(), 
                                opts: parts[1].split(/[,，]/).map(o => o.trim()) 
                            };
                        } else {
                            return { 
                                name: '选择规格', 
                                opts: g.split(/[,，]/).map(o => o.trim()) 
                            };
                        }
                    });
                } else {

                const SPEC_DB = {
                    "中古藤编椅": [
                        { name: '颜色', opts: ['复古黑', '原木色', '樱桃木色'] },
                        { name: '款式', opts: ['无扶手款', '带扶手款 (+¥80)'] }
                    ],
                    "极简落地灯": [
                        { name: '灯罩', opts: ['米白百褶', '纯白亚麻', '黑色丝绒'] },
                        { name: '光源', opts: ['暖光 (3000K)', '三色变光', '智能调光'] }
                    ],
                    "宜家 简约休闲椅": [
                        { name: '椅套颜色', opts: ['米黄色', '深灰色', '墨绿色'] },
                        { name: '填充', opts: ['标准海绵', '高回弹乳胶'] }
                    ],
                    "吱音 云朵茶几": [
                        { name: '尺寸', opts: ['小号 (80cm)', '大号 (100cm)'] },
                        { name: '台面', opts: ['纯白哑光', '浅粉烤漆'] }
                    ],
                    "顾家家居 布艺沙发": [
                        { name: '组合', opts: ['双人位', '三人位', '三人位+脚踏'] },
                        { name: '面料', opts: ['科技布', '仿棉麻', '天鹅绒'] }
                    ],
                    "源氏木语 橡木柜": [
                        { name: '规格', opts: ['两门 (0.8m)', '三门 (1.2m)', '四门 (1.6m)'] },
                        { name: '高度', opts: ['常规款', '加高款 (带抽屉)'] }
                    ],
                    "MUJI 无印良品豆袋": [
                        { name: '外套颜色', opts: ['牛仔蓝', '深褐色', '绯红色'] },
                        { name: '尺寸', opts: ['标准体 (65x65)', '加大体 (80x80)'] }
                    ],
                    "HAY 创意餐边柜": [
                        { name: '柜体颜色', opts: ['薄荷绿', '姜黄色', '米灰色'] },
                        { name: '腿部', opts: ['金属细腿', '实木圆腿'] }
                    ],
                    "Herman Miller 办公椅": [
                        { name: '配置', opts: ['标准版', '前倾功能版', '顶配全功能'] },
                        { name: '背网', opts: ['碳素黑', '矿石白'] }
                    ],
                    "林氏木业 伸缩餐桌": [
                        { name: '收缩长度', opts: ['1.2米 (展开1.5米)', '1.4米 (展开1.7米)'] },
                        { name: '桌面', opts: ['岩板台面', '实木贴皮'] }
                    ],
                    "样子生活 衣帽架": [
                        { name: '颜色', opts: ['极简黑', '纯净白'] },
                        { name: '底座', opts: ['大理石底座', '金属圆盘'] }
                    ],
                    "USM 模块化组合柜": [
                        { name: '颜色', opts: ['经典白', '克莱因蓝', '明亮黄'] },
                        { name: '层数', opts: ['两层 (2x1)', '三层 (2x2)', 'L型组合'] }
                    ],
                    "Louis Poulsen 吊灯": [
                        { name: '直径', opts: ['Mini (30cm)', 'Classic (50cm)'] },
                        { name: '颜色', opts: ['纯洁白', '淡玫瑰', '黄铜色'] },
                        { name: '光源', opts: ['无灯泡', '含LED暖光'] }
                    ],
                    "飞利浦 极简落地灯": [
                        { name: '灯体颜色', opts: ['钢琴黑', '磨砂白', '太空银'] },
                        { name: '色温', opts: ['3000K 暖光', '4000K 自然光', '6500K 冷白光'] },
                        { name: '控制方式', opts: ['脚踏开关', '米家App智能控制'] }
                    ],
                    "松下 护眼台灯": [
                        { name: '等级', opts: ['国AA级照度', '国AAA级专业版'] },
                        { name: '功能', opts: ['充插两用', '仅插电款'] },
                        { name: '颜色', opts: ['致炫白', '深空灰'] }
                    ],
                    "昕诺飞 日落氛围灯": [
                        { name: '光效', opts: ['经典日落红', '破晓彩虹', '极光蓝'] },
                        { name: '高度', opts: ['桌面款 (28cm)', '落地款 (1.2m)'] }
                    ],
                    "Xiaomi 智能吸顶灯": [
                        { name: '功率', opts: ['450W (卧室用)', '900W (客厅用)'] },
                        { name: '形状', opts: ['圆形纤薄', '长方形星轨'] },
                        { name: '安装', opts: ['自行安装', '包含上门安装服务'] }
                    ],
                    "Yeelight 感应小夜灯": [
                        { name: '套装', opts: ['单只装', '三只特惠装'] },
                        { name: '款式', opts: ['插电版 (常亮/感应)', '充电版 (超长续航)'] }
                    ],
                    "Seletti 创意霓虹灯": [
                        { name: '造型', opts: ['香蕉 (Banana)', '红唇 (Lips)', '闪电 (Thunder)'] },
                        { name: '灯光颜色', opts: ['暖黄', '玫红', '冰蓝'] }
                    ],
                    "欧普照明 户外射灯": [
                        { name: '防水等级', opts: ['IP65 (防雨)', 'IP67 (可浸水)'] },
                        { name: '光束角', opts: ['30度聚光', '60度泛光'] },
                        { name: '功率', opts: ['10W', '20W', '50W'] }
                    ],
                    "Artemide 经典工作灯": [
                        { name: '底座', opts: ['圆形底座', '桌边夹扣', '墙壁支架'] },
                        { name: '尺寸', opts: ['Tolomeo Micro', 'Tolomeo Mini', 'Tolomeo Classic'] },
                        { name: '材质', opts: ['铝合金原色', '黑色阳极氧化'] }
                    ],
                    "MUJI 香薰加湿灯": [
                        { name: '容量', opts: ['大号 (300ml)', '小号 (100ml)', '便携式'] },
                        { name: '精油套餐', opts: ['无精油', '含薰衣草精油', '含甜橙精油'] }
                    ],
                    "天马 Tenma 抽屉盒": [
                        { name: '尺寸', opts: ['面宽39cm (标准)', '面宽44cm (加宽)', '面宽30cm (窄款)'] },
                        { name: '高度', opts: ['18cm (内衣/袜)', '23cm (T恤/衬衫)', '30cm (毛衣/裤子)'] }
                    ],
                    "太力 真空压缩袋": [
                        { name: '套装', opts: ['特惠9件套 (4大4中1手泵)', '巨无霸3件套 (被褥专用)'] },
                        { name: '款式', opts: ['平面款 (普通)', '立体款 (加厚/可站立)'] }
                    ],
                    "宜家 IKEA 洞洞板": [
                        { name: '尺寸', opts: ['36x56cm (小号)', '56x56cm (中号)', '76x56cm (大号)'] },
                        { name: '颜色', opts: ['白色', '木色', '黑色'] },
                        { name: '配件', opts: ['仅板子', '含基础挂钩包'] }
                    ],
                    "霜山 内衣收纳盒": [
                        { name: '规格', opts: ['无格 (文胸)', '10格 (内裤)', '15格 (袜子)'] },
                        { name: '颜色', opts: ['磨砂透白', '杏色'] }
                    ],
                    "禧天龙 脏衣篮": [
                        { name: '层数', opts: ['双层 (分篮+顶板)', '三层 (双篮+顶板)'] },
                        { name: '颜色', opts: ['云雾白', '拿铁咖'] }
                    ],
                    "山崎实业 缝隙收纳车": [
                        { name: '宽度', opts: ['13cm (极窄)', '15cm (标准)', '20cm (宽缝)'] },
                        { name: '层数', opts: ['三层矮款', '四层高款'] }
                    ],
                    "无印良品 亚克力架": [
                        { name: '款式', opts: ['三层隔板架', '笔筒组合', '抽屉收纳盒'] },
                        { name: '尺寸', opts: ['约17.5x13cm', '约26x17.5cm'] }
                    ],
                    "茶花 密封整理箱": [
                        { name: '容量', opts: ['30L (杂物)', '55L (衣物)', '80L (棉被)'] },
                        { name: '颜色', opts: ['北欧蓝', '卡其色', '透明白'] }
                    ],
                    "慵懒居 书本收纳箱": [
                        { name: '规格', opts: ['小号 (约放15本)', '大号 (约放30本)'] },
                        { name: '款式', opts: ['透明可视款', '全封闭防尘款'] }
                    ],
                    "大创 桌面分层架": [
                        { name: '尺寸', opts: ['窄长款 (适合调料)', '宽阔款 (适合杯具)'] },
                        { name: '颜色', opts: ['纯白', '透明'] }
                    ],
                    "特福 Tefal 不粘锅": [
                        { name: '直径', opts: ['24cm (煎盘)', '28cm (炒锅)', '30cm (深炒锅)'] },
                        { name: '红点技术', opts: ['经典火红点', '新一代感温'] }
                    ],
                    "酷彩 Le Creuset 碟": [
                        { name: '颜色', opts: ['火焰橘', '樱桃红', '海岸蓝', '雪纺粉'] },
                        { name: '形状', opts: ['经典圆盘 (23cm)', '花形深盘 (20cm)'] }
                    ],
                    "星巴克 磨砂马克杯": [
                        { name: '容量', opts: ['中杯 (355ml)', '大杯 (473ml)'] },
                        { name: '款式', opts: ['经典墨绿', '磨砂黑', '纯白Logo'] },
                        { name: '配件', opts: ['单杯', '含盖+勺'] }
                    ],
                    "德龙 意式咖啡机": [
                        { name: '颜色', opts: ['复古绿 (Icona)', '奶油白', '海洋蓝'] },
                        { name: '类型', opts: ['半自动泵压', '全自动现磨'] }
                    ],
                    "摩飞 多功能料理机": [
                        { name: '标配', opts: ['深煮锅+牛扒盘', '深煮锅+蒸格'] },
                        { name: '颜色', opts: ['英伦红', '轻奢蓝', '椰奶白'] }
                    ],
                    "双立人 厨用刀具": [
                        { name: '刀型', opts: ['中式片刀', '三德刀', '多用刀套装'] },
                        { name: '系列', opts: ['红点系列', 'Pollux系列'] }
                    ],
                    "乐扣乐扣 保鲜盒": [
                        { name: '材质', opts: ['耐热玻璃', 'PP塑料 (BPA Free)'] },
                        { name: '形状', opts: ['长方形 (630ml)', '正方形 (500ml)', '圆形 (380ml)'] }
                    ],
                    "Balmuda 蒸汽烤箱": [
                        { name: '颜色', opts: ['经典黑', '极简白', '限定灰'] },
                        { name: '版本', opts: ['K01 标准版', 'K05 升级版'] }
                    ],
                    "小熊 电动打蛋器": [
                        { name: '供电', opts: ['插电大功率', '无线便携款'] },
                        { name: '档位', opts: ['5档调速', '10档调速'] }
                    ],
                    "Joseph Joseph 厨具": [
                        { name: '种类', opts: ['分类案板 (4件套)', '彩虹铲勺 (6件套)'] },
                        { name: '材质', opts: ['食品级塑料', '不锈钢'] }
                    ],
                    "ZARA 法式碎花裙": [
                        { name: '尺码', opts: ['XS (160/80A)', 'S (165/84A)', 'M (170/88A)', 'L (175/96A)'] },
                        { name: '花色', opts: ['复古红碎花', '清新蓝雏菊', '经典波点'] },
                        { name: '裙长', opts: ['短裙 (膝上)', '迷笛裙 (过膝)'] }
                    ],
                    "优衣库 羊绒针织衫": [
                        { name: '颜色', opts: ['09 Black', '31 Beige', '03 Gray', '12 Pink'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] },
                        { name: '领型', opts: ['圆领 (Crew Neck)', 'V领 (V Neck)', '高领 (Turtle Neck)'] }
                    ],
                    "Theory 通勤西装": [
                        { name: '尺码 (US)', opts: ['US 0 (155)', 'US 2 (160)', 'US 4 (165)', 'US 6 (170)'] },
                        { name: '版型', opts: ['修身版 (Slim)', '经典版 (Regular)'] },
                        { name: '颜色', opts: ['经典黑', '深藏青', '燕麦色'] }
                    ],
                    "Brandy Melville 吊带": [
                        { name: '尺码', opts: ['均码 (One Size)'] },
                        { name: '颜色', opts: ['纯白', '黑色', '婴儿蓝', '碎花款'] },
                        { name: '材质', opts: ['纯棉螺纹', '蕾丝拼接'] }
                    ],
                    "Lululemon 瑜伽裤": [
                        { name: '系列', opts: ['Align (裸感亲肤)', 'Wunder Train (速干支撑)'] },
                        { name: '裤长', opts: ['21" (七分)', '25" (九分)', '28" (长裤)'] },
                        { name: '尺码', opts: ['Size 2', 'Size 4', 'Size 6', 'Size 8'] }
                    ],
                    "Snidel 蕾丝半身裙": [
                        { name: '尺码', opts: ['0码 (S)', '1码 (M)'] },
                        { name: '颜色', opts: ['米白色 (OWHT)', '摩卡色 (MOC)', '薰衣草紫 (LAV)'] }
                    ],
                    "MO&Co. 连帽卫衣": [
                        { name: '尺码', opts: ['XS', 'S', 'M', 'L'] },
                        { name: '加绒', opts: ['常规薄款', '加绒加厚'] },
                        { name: '图案', opts: ['经典Logo印花', '联名卡通IP'] }
                    ],
                    "AllSaints 皮夹克": [
                        { name: '尺码 (UK)', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] },
                        { name: '款式', opts: ['Balfern (腰带款)', 'Dalby (极简款)'] },
                        { name: '皮质', opts: ['绵羊皮', '山羊皮麂皮'] }
                    ],
                    "Burberry 经典风衣": [
                        { name: '版型', opts: ['Chelsea (修身)', 'Kensington (现代)', 'Waterloo (宽松)'] },
                        { name: '颜色', opts: ['蜂蜜色 (Honey)', '黑色 (Black)', '午夜蓝'] },
                        { name: '尺码', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] }
                    ],
                    "COS 极简连衣裙": [
                        { name: '尺码 (EU)', opts: ['32', '34', '36', '38', '40'] },
                        { name: '颜色', opts: ['静谧黑', '奶油白', '海军蓝'] },
                        { name: '材质', opts: ['有机棉', '真丝混纺'] }
                    ],
                    // --- ▼▼▼ 新增：10个男装产品的定制规格 (硬核详细版) ▼▼▼ ---
                    "优衣库 重磅T恤": [
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['纯白 (White)', '碳黑 (Dark Gray)', '藏青 (Navy)', '大地色'] },
                        { name: '版型', opts: ['标准版 (Regular)', '宽松版 (Oversized)'] }
                    ],
                    "Dickies 工装裤": [
                        { name: '尺码 (腰围)', opts: ['28', '30', '32', '34', '36'] },
                        { name: '颜色', opts: ['卡其色 (Khaki)', '黑色 (Black)', '深蓝 (Dark Navy)'] },
                        { name: '裤长', opts: ['30 (常规)', '32 (加长)'] }
                    ],
                    "Ralph Lauren 衬衫": [
                        { name: '版型', opts: ['Classic Fit (宽松)', 'Custom Slim (修身)'] },
                        { name: '颜色', opts: ['经典白', '牛津蓝', '条纹款'] },
                        { name: '领型', opts: ['扣领 (Button Down)', '温莎领'] }
                    ],
                    "Nike 运动夹克": [
                        { name: '系列', opts: ['Windrunner (风行者)', 'Tech Fleece (科技棉)'] },
                        { name: '尺码', opts: ['M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['黑白熊猫', '荧光绿', '全黑'] }
                    ],
                    "始祖鸟 GORE-TEX": [
                        { name: '型号', opts: ['Alpha SV (向导级)', 'Beta LT (全能款)', 'Atom LT (棉服)'] },
                        { name: '颜色', opts: ['黑色 (Black)', '翠鸟绿 (Kingfisher)', '以太蓝'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] }
                    ],
                    "Levi's 原色牛仔裤": [
                        { name: '裤型', opts: ['501 (直筒纽扣)', '511 (修身拉链)', '502 (标准锥形)'] },
                        { name: '腰围', opts: ['W30', 'W31', 'W32', 'W33', 'W34'] },
                        { name: '裤长', opts: ['L30', 'L32', 'L34'] }
                    ],
                    "G2000 商务西裤": [
                        { name: '版型', opts: ['修身 (Slim)', '直筒 (Regular)'] },
                        { name: '面料', opts: ['四季羊毛', '抗皱免烫', '加绒厚款'] },
                        { name: '腰围', opts: ['76cm', '80cm', '84cm', '88cm'] }
                    ],
                    "Champion 连帽衫": [
                        { name: '工艺', opts: ['Reverse Weave (横纹编织)', 'Basic (基础款)'] },
                        { name: '颜色', opts: ['花灰 (Grey)', '藏青', '酒红'] },
                        { name: 'Logo', opts: ['小C标', '草写大Logo'] }
                    ],
                    "Barbour 涂蜡外套": [
                        { name: '型号', opts: ['Bedale (短款/马术)', 'Beaufort (长款/狩猎)', 'Ashby (修身)'] },
                        { name: '颜色', opts: ['Sage (鼠尾草绿)', 'Olive (橄榄褐)', 'Navy (蓝)'] },
                        { name: '尺码 (UK)', opts: ['36', '38', '40', '42'] }
                    ],
                    "Stone Island 夹克": [
                        { name: '材质', opts: ['Nylon Metal (金属尼龙)', 'Crinkle Reps (皱缩)', 'Soft Shell'] },
                        { name: '袖标', opts: ['经典黄绿标', '暗影全黑标 (Shadow)'] },
                        { name: '尺码', opts: ['L', 'XL', 'XXL', '3XL'] }
                    ],
                    // --- ▼▼▼ 新增：10款鞋子产品的定制规格 (专业尺码版) ▼▼▼ ---
                    "匡威 1970s 帆布鞋": [
                        { name: '款式', opts: ['高帮 (High)', '低帮 (Low)'] },
                        { name: '颜色', opts: ['经典黑', '米白色 (Parchment)', '向日葵黄'] },
                        { name: '尺码 (偏大)', opts: ['36.5', '37.5', '39', '41.5', '42.5', '44'] }
                    ],
                    "New Balance 老爹鞋": [
                        { name: '型号', opts: ['NB 990v6 (美产)', 'NB 2002R', 'NB 530 (复古)'] },
                        { name: '颜色', opts: ['元祖灰 (Grey)', '海军蓝 (Navy)', '海盐白'] },
                        { name: '鞋宽', opts: ['D (标准)', '2E (加宽)'] }
                    ],
                    "Adidas Samba 德训鞋": [
                        { name: '配色', opts: ['OG 黑白', 'OG 白黑', '纯白灰尾'] },
                        { name: '版本', opts: ['Classic (经典长舌)', 'OG (短舌)'] },
                        { name: '尺码', opts: ['UK 4 (36.5)', 'UK 5 (38)', 'UK 7 (40.5)', 'UK 9 (43.5)'] }
                    ],
                    "GH Bass 乐福鞋": [
                        { name: '皮质', opts: ['抛光牛皮 (Weejuns)', '荔枝纹软皮'] },
                        { name: '颜色', opts: ['酒红色 (Wine)', '黑色 (Black)', '黑白拼色'] },
                        { name: '尺码 (US)', opts: ['US 7', 'US 8', 'US 9', 'US 10'] }
                    ],
                    "Dr. Martens 马丁靴": [
                        { name: '孔数', opts: ['1460 (8孔经典)', '1461 (3孔低帮)', 'Jadon (厚底)'] },
                        { name: '皮质', opts: ['硬皮 (Smooth)', '软皮 (Nappa)', '荔枝皮'] },
                        { name: '尺码 (UK)', opts: ['UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7'] }
                    ],
                    "Asics 亚瑟士跑鞋": [
                        { name: '系列', opts: ['Kayano 14 (支撑)', 'Nimbus 25 (缓震)', 'GT-2000'] },
                        { name: '颜色', opts: ['金属银 (Silver)', '奶油白', '黑武士'] },
                        { name: '尺码', opts: ['39', '40.5', '41.5', '42.5', '43.5'] }
                    ],
                    "Birkenstock 拖鞋": [
                        { name: '款式', opts: ['Boston (包头)', 'Arizona (双带)'] },
                        { name: '材质', opts: ['翻毛皮 (Suede)', '油皮 (Oiled)', 'EVA (防水)'] },
                        { name: '颜色', opts: ['灰褐色 (Taupe)', '摩卡色', '黑色'] }
                    ],
                    "Clarks 商务皮鞋": [
                        { name: '款式', opts: ['Desert Boot (沙漠靴)', 'Wallabee (袋鼠鞋)'] },
                        { name: '皮质', opts: ['蜜蜡色油皮', '沙色反绒皮', '黑色光面'] },
                        { name: '尺码 (UK)', opts: ['UK 7', 'UK 8', 'UK 9', 'UK 9.5'] }
                    ],
                    "Salomon 户外越野鞋": [
                        { name: '型号', opts: ['XT-6 (潮流款)', 'ACS Pro (机能款)', 'Speedcross'] },
                        { name: '配色', opts: ['香草白', '火山黑', '冰川蓝'] },
                        { name: '尺码', opts: ['EUR 40', 'EUR 41', 'EUR 42', 'EUR 43'] }
                    ],
                    "UGG 羊毛雪地靴": [
                        { name: '筒高', opts: ['Ultra Mini (超低筒)', 'Mini (低筒)', 'Short (中筒)'] },
                        { name: '颜色', opts: ['栗色 (Chestnut)', '巧克力色', '黑色'] },
                        { name: '尺码 (US)', opts: ['US 6', 'US 7', 'US 8', 'US 9'] }
                    ],
                    "泡泡玛特 盲盒手办": [
                        { name: '款式', opts: ['单盒 (随机)', '整盒 (12个不重复)', '确认款 (指定角色)'] },
                        { name: 'IP系列', opts: ['Molly 周年庆', 'Dimoo 森林', 'Skullpanda 梦境'] }
                    ],
                    "乐高 机械组赛车": [
                        { name: '型号', opts: ['法拉利 Daytona (42143)', '迈凯伦 F1 (42141)', '保时捷 911 (42096)'] },
                        { name: '版本', opts: ['原盒未拆', '带展示盒版', '已拼装成品'] }
                    ],
                    "Jellycat 邦尼兔": [
                        { name: '尺寸', opts: ['小号 (18cm)', '中号 (31cm)', '大号 (36cm)', '超大 (51cm)'] },
                        { name: '颜色', opts: ['米色 (Beige)', '害羞粉 (Tulip)', '星空蓝', '薰衣草紫'] }
                    ],
                    "大疆 Tello 遥控机": [
                        { name: '套餐', opts: ['标配版 (单电)', '畅飞版 (三电+充电管家)'] },
                        { name: '配件', opts: ['仅机器', '含手柄控制器', '含编程扩展包'] }
                    ],
                    "任天堂 Switch 游戏": [
                        { name: '版本', opts: ['日版', '港版', '美版'] },
                        { name: '游戏名', opts: ['塞尔达: 王国之泪', '马力欧卡丁车8', '动森', '健身环'] },
                        { name: '类型', opts: ['全新卡带', '二手回血'] }
                    ],
                    "富士 Instax 拍立得": [
                        { name: '型号', opts: ['Mini 12 (入门)', 'Mini Evo (数模双模)', 'SQ1 (方形)'] },
                        { name: '颜色', opts: ['薄荷绿', '樱花粉', '复古棕', '极夜黑'] },
                        { name: '相纸套餐', opts: ['标配无纸', '含20张白边', '含50张白边'] }
                    ],
                    "索尼 复古卡带机": [
                        { name: '成色', opts: ['全新库存 (NOS)', '99新收藏级', '8成新战斗级'] },
                        { name: '型号', opts: ['TPS-L2 (初代)', 'WM-2 (红)', 'WM-D6C (专业)'] }
                    ],
                    "Bearbrick 积木熊": [
                        { name: '尺寸', opts: ['100% (7cm)', '400% (28cm)', '1000% (70cm)'] },
                        { name: '款式', opts: ['梵高星空', '招财猫金运', '大理石纹', '透明限定'] }
                    ],
                    "KAWS 联名公仔": [
                        { name: '姿势', opts: ['站姿 (Standing)', '坐姿 (Passing Through)', '躺姿 (Holiday)'] },
                        { name: '配色', opts: ['经典灰', '全黑', '解剖半透'] },
                        { name: '版本', opts: ['OPEN EDITION', '会场限定'] }
                    ],
                    "万代 RG 高达模型": [
                        { name: '机体', opts: ['牛高达 (Nu Gundam)', '沙扎比 (Sazabi)', '独角兽 (Unicorn)', '海牛 (Hi-Nu)'] },
                        { name: '比例', opts: ['RG 1/144', 'MG 1/100 (部分款)', 'PG 1/60'] },
                        { name: '版本', opts: ['普通版', '彩透限定', '钛电镀版'] }
                    ],
                    "Keychron 机械键盘": [
                        { name: '轴体', opts: ['G Pro 红轴 (线性)', 'G Pro 青轴 (段落)', 'G Pro 茶轴 (微段落)'] },
                        { name: '背光', opts: ['RGB 铝合金边框', '白光 塑料边框'] },
                        { name: '布局', opts: ['K2 (75%紧凑)', 'K8 (87键)', 'Q1 Pro (客制化)'] }
                    ],
                    "罗技 MX 无线鼠标": [
                        { name: '型号', opts: ['MX Master 3S (旗舰)', 'MX Anywhere 3 (便携)', 'Lift (垂直工学)'] },
                        { name: '颜色', opts: ['石墨黑 (Graphite)', '珍珠白 (Pale Grey)', '玫瑰粉'] },
                        { name: '套餐', opts: ['标准版', '含皮质收纳包'] }
                    ],
                    "索尼 降噪耳机": [
                        { name: '型号', opts: ['WH-1000XM5 (最新)', 'WH-1000XM4 (折叠)'] },
                        { name: '颜色', opts: ['铂金银', '黑色', '深夜蓝'] },
                        { name: '加购', opts: ['无', '加购2年延保'] }
                    ],
                    "马歇尔 便携音箱": [
                        { name: '型号', opts: ['Emberton II (便携防水)', 'Stockwell II (手提)', 'Middleton (大功率)'] },
                        { name: '配色', opts: ['经典黑金 (Black&Brass)', '奶油白 (Cream)', '森林绿'] }
                    ],
                    "Apple Watch Ultra": [
                        { name: '表带类型', opts: ['高山回环 (Alpine)', '野径回环 (Trail)', '海洋表带 (Ocean)'] },
                        { name: '表带颜色', opts: ['星光色', '绿色', '橙色', '午夜黑'] },
                        { name: 'AppleCare+', opts: ['不购买', '购买 (+¥799)'] }
                    ],
                    "Wacom 专业数位板": [
                        { name: '尺寸', opts: ['PTH-660 (中号 M)', 'PTH-860 (大号 L)'] },
                        { name: '版本', opts: ['标准版', 'Paper Edition (纸感)'] },
                        { name: '赠品', opts: ['官方笔芯套装', '专用防护包'] }
                    ],
                    "安克 Anker 充电宝": [
                        { name: '容量/功率', opts: ['10000mAh (30W)', '20000mAh (200W)', '24000mAh (140W)'] },
                        { name: '屏幕', opts: ['无屏幕', '智能数显屏 (Prime系列)'] },
                        { name: '颜色', opts: ['极光黑', '香槟金'] }
                    ],
                    "极米 投影仪支架": [
                        { name: '适用机型', opts: ['H系列/Z系列通用', 'RS Pro 专用'] },
                        { name: '款式', opts: ['桌面支架 (万向球头)', '落地支架 (金属加重)', '床头夹支架'] },
                        { name: '材质', opts: ['航空铝合金', '碳钢'] }
                    ],
                    "Xbox 精英手柄": [
                        { name: '版本', opts: ['精英2代 青春版 (白色)', '精英2代 完整版 (黑色)'] },
                        { name: '自定义', opts: ['标准配置', 'Design Lab 定制色'] },
                        { name: '配件', opts: ['单手柄', '含无线适配器'] }
                    ],
                    "贝尔金 桌面三合一": [
                        { name: 'MagSafe', opts: ['15W 官方认证快充', '7.5W 普通磁吸'] },
                        { name: '颜色', opts: ['纯白 (White)', '酷黑 (Black)'] },
                        { name: '插头规格', opts: ['国标两插', '美标', '英标'] }
                    ]

                };

              if (specs.length === 0) { // 只有当上面没生成 specs 时，才去查库
    if (SPEC_DB[title]) {
        specs = SPEC_DB[title];
    } 
                // 如果没有精确匹配，则进行模糊匹配（兜底逻辑）
                else if (title.includes('灯')) {
                    specs = [{ name: '光色', opts: ['暖光', '白光'] }, { name: '开关', opts: ['按钮开关', '遥控开关'] }];
                } else if (title.includes('椅') || title.includes('沙发')) {
                    specs = [{ name: '颜色', opts: ['灰色', '米色', '蓝色'] }, { name: '材质', opts: ['布艺', '真皮'] }];
                } else if (title.includes('柜') || title.includes('桌')) {
                    specs = [{ name: '尺寸', opts: ['1.2m', '1.5m'] }, { name: '材质', opts: ['橡木', '胡桃木'] }];
                } else {
                    // 万能默认
                    specs = [{ name: '颜色', opts: ['默认', '黑色', '白色'] }, { name: '规格', opts: ['标准版', '升级版'] }];
                }
            }
        }
                // 生成HTML
                shopSpecsContainer.innerHTML = specs.map(group => `
                    <div class="shop-spec-group">
                        <div class="shop-spec-title">${group.name}</div>
                        <div class="shop-spec-options">
                            ${group.opts.map((opt, i) => 
                                `<div class="shop-spec-opt ${i===0?'active':''}">${opt}</div>`
                            ).join('')}
                        </div>
                    </div>
                `).join('');
                // 4. 绑定选项点击事件 (点击切换 active)
                const options = shopSpecsContainer.querySelectorAll('.shop-spec-opt');
                options.forEach(opt => {
                    opt.addEventListener('click', function() {
                        const siblings = this.parentElement.children;
                        for(let s of siblings) s.classList.remove('active');
                        this.classList.add('active');
                        updateSelectedText(); // 更新显示的文字
                    });
                });
                updateSelectedText(); // 初始化显示
                shopSpecsOverlay.classList.add('visible'); // 显示弹窗
            });
        }
        // 辅助函数：更新 "已选: xxx" 文字
        function updateSelectedText() {
            const actives = shopSpecsContainer.querySelectorAll('.shop-spec-opt.active');
            const text = Array.from(actives).map(el => el.textContent).join(' / ');
            const textEl = document.getElementById('shop-specs-selected-text');
            if(textEl) textEl.textContent = text;
        }
        // B. 数量加减逻辑
        if(btnMinus && btnPlus) {
            btnMinus.onclick = () => {
                if(currentShopCount > 1) {
                    currentShopCount--;
                    countDisplay.textContent = currentShopCount;
                }
            };
            btnPlus.onclick = () => {
                currentShopCount++;
                countDisplay.textContent = currentShopCount;
            };
        }
        // C. 关闭按钮逻辑
        if(shopSpecsClose) {
            shopSpecsClose.onclick = () => shopSpecsOverlay.classList.remove('visible');
        }
        if(shopSpecsOverlay) {
            shopSpecsOverlay.onclick = (e) => {
                if(e.target === shopSpecsOverlay) shopSpecsOverlay.classList.remove('visible');
            };
        }
        // D. 【核心】确认加入购物车
        if(shopSpecsConfirm) {
            shopSpecsConfirm.onclick = () => {
                // 1. 获取基础信息
                const title = document.getElementById('shop-detail-title').textContent;
                const price = document.getElementById('shop-specs-price').textContent.replace('¥', '').trim();
                const selectedText = document.getElementById('shop-specs-selected-text').textContent.replace('已选: ', '');
                
                // 2. 获取图片链接 (处理 url("...") 格式)
                const imgBg = document.getElementById('shop-specs-img').style.backgroundImage;
                const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");

                // 3. 获取数量 (使用之前定义的 currentShopCount 变量)
                const quantity = currentShopCount || 1;

                // 4. 构建商品对象
                const cartItem = {
                    id: Date.now(), // 生成一个唯一ID
                    title: title,
                    price: parseFloat(price),
                    specs: selectedText,
                    img: imgUrl,
                    count: quantity,
                    checked: true // 默认勾选
                };

                // 5. 保存到 LocalStorage (存入专门的 'my_shop_cart' 仓库)
                const existingCart = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                existingCart.push(cartItem);
                localStorage.setItem('my_shop_cart', JSON.stringify(existingCart));

                // 6. 界面反馈
                shopSpecsOverlay.classList.remove('visible');
                showDynamicIsland(`已将 ${quantity} 件商品加入购物车`, 'success');
                
                // 如果购物车页面已经加载过，尝试刷新它 (通过触发自定义事件或直接调用)
                if (window.renderMyShopCart) window.renderMyShopCart();
            };
        }
// 修改处前两行：找到代付按钮监听器
        if(btnPayFriend) {
            btnPayFriend.addEventListener('click', () => {
                const payFriendFillModal = document.getElementById('shop-pay-friend-fill-modal-overlay');
                if(!payFriendFillModal) return;

                const title = document.getElementById('shop-detail-title').textContent;
                const price = document.getElementById('shop-detail-price').textContent;
                const imgBg = document.getElementById('shop-detail-img').style.backgroundImage;

                document.getElementById('pay-friend-mini-title').textContent = title;
                document.getElementById('pay-friend-mini-price').textContent = price;
                document.getElementById('pay-friend-total-price').textContent = price;
                document.getElementById('pay-friend-mini-img').style.backgroundImage = imgBg;

                // --- 【核心修改】从 SPEC_DB 读取并渲染规格 ---
                const buySpecsContainer = document.getElementById('pay-friend-specs-container');
                const currentSpecsStr = detailPage.dataset.currentSpecs || "";
                let specsData = []; 


                const SPEC_DB = {
                    "中古藤编椅": [
                        { name: '颜色', opts: ['复古黑', '原木色', '樱桃木色'] },
                        { name: '款式', opts: ['无扶手款', '带扶手款 (+¥80)'] }
                    ],
                    "极简落地灯": [
                        { name: '灯罩', opts: ['米白百褶', '纯白亚麻', '黑色丝绒'] },
                        { name: '光源', opts: ['暖光 (3000K)', '三色变光', '智能调光'] }
                    ],
                    "宜家 简约休闲椅": [
                        { name: '椅套颜色', opts: ['米黄色', '深灰色', '墨绿色'] },
                        { name: '填充', opts: ['标准海绵', '高回弹乳胶'] }
                    ],
                    "吱音 云朵茶几": [
                        { name: '尺寸', opts: ['小号 (80cm)', '大号 (100cm)'] },
                        { name: '台面', opts: ['纯白哑光', '浅粉烤漆'] }
                    ],
                    "顾家家居 布艺沙发": [
                        { name: '组合', opts: ['双人位', '三人位', '三人位+脚踏'] },
                        { name: '面料', opts: ['科技布', '仿棉麻', '天鹅绒'] }
                    ],
                    "源氏木语 橡木柜": [
                        { name: '规格', opts: ['两门 (0.8m)', '三门 (1.2m)', '四门 (1.6m)'] },
                        { name: '高度', opts: ['常规款', '加高款 (带抽屉)'] }
                    ],
                    "MUJI 无印良品豆袋": [
                        { name: '外套颜色', opts: ['牛仔蓝', '深褐色', '绯红色'] },
                        { name: '尺寸', opts: ['标准体 (65x65)', '加大体 (80x80)'] }
                    ],
                    "HAY 创意餐边柜": [
                        { name: '柜体颜色', opts: ['薄荷绿', '姜黄色', '米灰色'] },
                        { name: '腿部', opts: ['金属细腿', '实木圆腿'] }
                    ],
                    "Herman Miller 办公椅": [
                        { name: '配置', opts: ['标准版', '前倾功能版', '顶配全功能'] },
                        { name: '背网', opts: ['碳素黑', '矿石白'] }
                    ],
                    "林氏木业 伸缩餐桌": [
                        { name: '收缩长度', opts: ['1.2米 (展开1.5米)', '1.4米 (展开1.7米)'] },
                        { name: '桌面', opts: ['岩板台面', '实木贴皮'] }
                    ],
                    "样子生活 衣帽架": [
                        { name: '颜色', opts: ['极简黑', '纯净白'] },
                        { name: '底座', opts: ['大理石底座', '金属圆盘'] }
                    ],
                    "USM 模块化组合柜": [
                        { name: '颜色', opts: ['经典白', '克莱因蓝', '明亮黄'] },
                        { name: '层数', opts: ['两层 (2x1)', '三层 (2x2)', 'L型组合'] }
                    ],
                    "Louis Poulsen 吊灯": [
                        { name: '直径', opts: ['Mini (30cm)', 'Classic (50cm)'] },
                        { name: '颜色', opts: ['纯洁白', '淡玫瑰', '黄铜色'] },
                        { name: '光源', opts: ['无灯泡', '含LED暖光'] }
                    ],
                    "飞利浦 极简落地灯": [
                        { name: '灯体颜色', opts: ['钢琴黑', '磨砂白', '太空银'] },
                        { name: '色温', opts: ['3000K 暖光', '4000K 自然光', '6500K 冷白光'] },
                        { name: '控制方式', opts: ['脚踏开关', '米家App智能控制'] }
                    ],
                    "松下 护眼台灯": [
                        { name: '等级', opts: ['国AA级照度', '国AAA级专业版'] },
                        { name: '功能', opts: ['充插两用', '仅插电款'] },
                        { name: '颜色', opts: ['致炫白', '深空灰'] }
                    ],
                    "昕诺飞 日落氛围灯": [
                        { name: '光效', opts: ['经典日落红', '破晓彩虹', '极光蓝'] },
                        { name: '高度', opts: ['桌面款 (28cm)', '落地款 (1.2m)'] }
                    ],
                    "Xiaomi 智能吸顶灯": [
                        { name: '功率', opts: ['450W (卧室用)', '900W (客厅用)'] },
                        { name: '形状', opts: ['圆形纤薄', '长方形星轨'] },
                        { name: '安装', opts: ['自行安装', '包含上门安装服务'] }
                    ],
                    "Yeelight 感应小夜灯": [
                        { name: '套装', opts: ['单只装', '三只特惠装'] },
                        { name: '款式', opts: ['插电版 (常亮/感应)', '充电版 (超长续航)'] }
                    ],
                    "Seletti 创意霓虹灯": [
                        { name: '造型', opts: ['香蕉 (Banana)', '红唇 (Lips)', '闪电 (Thunder)'] },
                        { name: '灯光颜色', opts: ['暖黄', '玫红', '冰蓝'] }
                    ],
                    "欧普照明 户外射灯": [
                        { name: '防水等级', opts: ['IP65 (防雨)', 'IP67 (可浸水)'] },
                        { name: '光束角', opts: ['30度聚光', '60度泛光'] },
                        { name: '功率', opts: ['10W', '20W', '50W'] }
                    ],
                    "Artemide 经典工作灯": [
                        { name: '底座', opts: ['圆形底座', '桌边夹扣', '墙壁支架'] },
                        { name: '尺寸', opts: ['Tolomeo Micro', 'Tolomeo Mini', 'Tolomeo Classic'] },
                        { name: '材质', opts: ['铝合金原色', '黑色阳极氧化'] }
                    ],
                    "MUJI 香薰加湿灯": [
                        { name: '容量', opts: ['大号 (300ml)', '小号 (100ml)', '便携式'] },
                        { name: '精油套餐', opts: ['无精油', '含薰衣草精油', '含甜橙精油'] }
                    ],
                    "天马 Tenma 抽屉盒": [
                        { name: '尺寸', opts: ['面宽39cm (标准)', '面宽44cm (加宽)', '面宽30cm (窄款)'] },
                        { name: '高度', opts: ['18cm (内衣/袜)', '23cm (T恤/衬衫)', '30cm (毛衣/裤子)'] }
                    ],
                    "太力 真空压缩袋": [
                        { name: '套装', opts: ['特惠9件套 (4大4中1手泵)', '巨无霸3件套 (被褥专用)'] },
                        { name: '款式', opts: ['平面款 (普通)', '立体款 (加厚/可站立)'] }
                    ],
                    "宜家 IKEA 洞洞板": [
                        { name: '尺寸', opts: ['36x56cm (小号)', '56x56cm (中号)', '76x56cm (大号)'] },
                        { name: '颜色', opts: ['白色', '木色', '黑色'] },
                        { name: '配件', opts: ['仅板子', '含基础挂钩包'] }
                    ],
                    "霜山 内衣收纳盒": [
                        { name: '规格', opts: ['无格 (文胸)', '10格 (内裤)', '15格 (袜子)'] },
                        { name: '颜色', opts: ['磨砂透白', '杏色'] }
                    ],
                    "禧天龙 脏衣篮": [
                        { name: '层数', opts: ['双层 (分篮+顶板)', '三层 (双篮+顶板)'] },
                        { name: '颜色', opts: ['云雾白', '拿铁咖'] }
                    ],
                    "山崎实业 缝隙收纳车": [
                        { name: '宽度', opts: ['13cm (极窄)', '15cm (标准)', '20cm (宽缝)'] },
                        { name: '层数', opts: ['三层矮款', '四层高款'] }
                    ],
                    "无印良品 亚克力架": [
                        { name: '款式', opts: ['三层隔板架', '笔筒组合', '抽屉收纳盒'] },
                        { name: '尺寸', opts: ['约17.5x13cm', '约26x17.5cm'] }
                    ],
                    "茶花 密封整理箱": [
                        { name: '容量', opts: ['30L (杂物)', '55L (衣物)', '80L (棉被)'] },
                        { name: '颜色', opts: ['北欧蓝', '卡其色', '透明白'] }
                    ],
                    "慵懒居 书本收纳箱": [
                        { name: '规格', opts: ['小号 (约放15本)', '大号 (约放30本)'] },
                        { name: '款式', opts: ['透明可视款', '全封闭防尘款'] }
                    ],
                    "大创 桌面分层架": [
                        { name: '尺寸', opts: ['窄长款 (适合调料)', '宽阔款 (适合杯具)'] },
                        { name: '颜色', opts: ['纯白', '透明'] }
                    ],
                    "特福 Tefal 不粘锅": [
                        { name: '直径', opts: ['24cm (煎盘)', '28cm (炒锅)', '30cm (深炒锅)'] },
                        { name: '红点技术', opts: ['经典火红点', '新一代感温'] }
                    ],
                    "酷彩 Le Creuset 碟": [
                        { name: '颜色', opts: ['火焰橘', '樱桃红', '海岸蓝', '雪纺粉'] },
                        { name: '形状', opts: ['经典圆盘 (23cm)', '花形深盘 (20cm)'] }
                    ],
                    "星巴克 磨砂马克杯": [
                        { name: '容量', opts: ['中杯 (355ml)', '大杯 (473ml)'] },
                        { name: '款式', opts: ['经典墨绿', '磨砂黑', '纯白Logo'] },
                        { name: '配件', opts: ['单杯', '含盖+勺'] }
                    ],
                    "德龙 意式咖啡机": [
                        { name: '颜色', opts: ['复古绿 (Icona)', '奶油白', '海洋蓝'] },
                        { name: '类型', opts: ['半自动泵压', '全自动现磨'] }
                    ],
                    "摩飞 多功能料理机": [
                        { name: '标配', opts: ['深煮锅+牛扒盘', '深煮锅+蒸格'] },
                        { name: '颜色', opts: ['英伦红', '轻奢蓝', '椰奶白'] }
                    ],
                    "双立人 厨用刀具": [
                        { name: '刀型', opts: ['中式片刀', '三德刀', '多用刀套装'] },
                        { name: '系列', opts: ['红点系列', 'Pollux系列'] }
                    ],
                    "乐扣乐扣 保鲜盒": [
                        { name: '材质', opts: ['耐热玻璃', 'PP塑料 (BPA Free)'] },
                        { name: '形状', opts: ['长方形 (630ml)', '正方形 (500ml)', '圆形 (380ml)'] }
                    ],
                    "Balmuda 蒸汽烤箱": [
                        { name: '颜色', opts: ['经典黑', '极简白', '限定灰'] },
                        { name: '版本', opts: ['K01 标准版', 'K05 升级版'] }
                    ],
                    "小熊 电动打蛋器": [
                        { name: '供电', opts: ['插电大功率', '无线便携款'] },
                        { name: '档位', opts: ['5档调速', '10档调速'] }
                    ],
                    "Joseph Joseph 厨具": [
                        { name: '种类', opts: ['分类案板 (4件套)', '彩虹铲勺 (6件套)'] },
                        { name: '材质', opts: ['食品级塑料', '不锈钢'] }
                    ],
                    "ZARA 法式碎花裙": [
                        { name: '尺码', opts: ['XS (160/80A)', 'S (165/84A)', 'M (170/88A)', 'L (175/96A)'] },
                        { name: '花色', opts: ['复古红碎花', '清新蓝雏菊', '经典波点'] },
                        { name: '裙长', opts: ['短裙 (膝上)', '迷笛裙 (过膝)'] }
                    ],
                    "优衣库 羊绒针织衫": [
                        { name: '颜色', opts: ['09 Black', '31 Beige', '03 Gray', '12 Pink'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] },
                        { name: '领型', opts: ['圆领 (Crew Neck)', 'V领 (V Neck)', '高领 (Turtle Neck)'] }
                    ],
                    "Theory 通勤西装": [
                        { name: '尺码 (US)', opts: ['US 0 (155)', 'US 2 (160)', 'US 4 (165)', 'US 6 (170)'] },
                        { name: '版型', opts: ['修身版 (Slim)', '经典版 (Regular)'] },
                        { name: '颜色', opts: ['经典黑', '深藏青', '燕麦色'] }
                    ],
                    "Brandy Melville 吊带": [
                        { name: '尺码', opts: ['均码 (One Size)'] },
                        { name: '颜色', opts: ['纯白', '黑色', '婴儿蓝', '碎花款'] },
                        { name: '材质', opts: ['纯棉螺纹', '蕾丝拼接'] }
                    ],
                    "Lululemon 瑜伽裤": [
                        { name: '系列', opts: ['Align (裸感亲肤)', 'Wunder Train (速干支撑)'] },
                        { name: '裤长', opts: ['21" (七分)', '25" (九分)', '28" (长裤)'] },
                        { name: '尺码', opts: ['Size 2', 'Size 4', 'Size 6', 'Size 8'] }
                    ],
                    "Snidel 蕾丝半身裙": [
                        { name: '尺码', opts: ['0码 (S)', '1码 (M)'] },
                        { name: '颜色', opts: ['米白色 (OWHT)', '摩卡色 (MOC)', '薰衣草紫 (LAV)'] }
                    ],
                    "MO&Co. 连帽卫衣": [
                        { name: '尺码', opts: ['XS', 'S', 'M', 'L'] },
                        { name: '加绒', opts: ['常规薄款', '加绒加厚'] },
                        { name: '图案', opts: ['经典Logo印花', '联名卡通IP'] }
                    ],
                    "AllSaints 皮夹克": [
                        { name: '尺码 (UK)', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] },
                        { name: '款式', opts: ['Balfern (腰带款)', 'Dalby (极简款)'] },
                        { name: '皮质', opts: ['绵羊皮', '山羊皮麂皮'] }
                    ],
                    "Burberry 经典风衣": [
                        { name: '版型', opts: ['Chelsea (修身)', 'Kensington (现代)', 'Waterloo (宽松)'] },
                        { name: '颜色', opts: ['蜂蜜色 (Honey)', '黑色 (Black)', '午夜蓝'] },
                        { name: '尺码', opts: ['UK 4', 'UK 6', 'UK 8', 'UK 10'] }
                    ],
                    "COS 极简连衣裙": [
                        { name: '尺码 (EU)', opts: ['32', '34', '36', '38', '40'] },
                        { name: '颜色', opts: ['静谧黑', '奶油白', '海军蓝'] },
                        { name: '材质', opts: ['有机棉', '真丝混纺'] }
                    ],
                    // --- ▼▼▼ 新增：10个男装产品的定制规格 (硬核详细版) ▼▼▼ ---
                    "优衣库 重磅T恤": [
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['纯白 (White)', '碳黑 (Dark Gray)', '藏青 (Navy)', '大地色'] },
                        { name: '版型', opts: ['标准版 (Regular)', '宽松版 (Oversized)'] }
                    ],
                    "Dickies 工装裤": [
                        { name: '尺码 (腰围)', opts: ['28', '30', '32', '34', '36'] },
                        { name: '颜色', opts: ['卡其色 (Khaki)', '黑色 (Black)', '深蓝 (Dark Navy)'] },
                        { name: '裤长', opts: ['30 (常规)', '32 (加长)'] }
                    ],
                    "Ralph Lauren 衬衫": [
                        { name: '版型', opts: ['Classic Fit (宽松)', 'Custom Slim (修身)'] },
                        { name: '颜色', opts: ['经典白', '牛津蓝', '条纹款'] },
                        { name: '领型', opts: ['扣领 (Button Down)', '温莎领'] }
                    ],
                    "Nike 运动夹克": [
                        { name: '系列', opts: ['Windrunner (风行者)', 'Tech Fleece (科技棉)'] },
                        { name: '尺码', opts: ['M', 'L', 'XL', 'XXL'] },
                        { name: '颜色', opts: ['黑白熊猫', '荧光绿', '全黑'] }
                    ],
                    "始祖鸟 GORE-TEX": [
                        { name: '型号', opts: ['Alpha SV (向导级)', 'Beta LT (全能款)', 'Atom LT (棉服)'] },
                        { name: '颜色', opts: ['黑色 (Black)', '翠鸟绿 (Kingfisher)', '以太蓝'] },
                        { name: '尺码', opts: ['S', 'M', 'L', 'XL'] }
                    ],
                    "Levi's 原色牛仔裤": [
                        { name: '裤型', opts: ['501 (直筒纽扣)', '511 (修身拉链)', '502 (标准锥形)'] },
                        { name: '腰围', opts: ['W30', 'W31', 'W32', 'W33', 'W34'] },
                        { name: '裤长', opts: ['L30', 'L32', 'L34'] }
                    ],
                    "G2000 商务西裤": [
                        { name: '版型', opts: ['修身 (Slim)', '直筒 (Regular)'] },
                        { name: '面料', opts: ['四季羊毛', '抗皱免烫', '加绒厚款'] },
                        { name: '腰围', opts: ['76cm', '80cm', '84cm', '88cm'] }
                    ],
                    "Champion 连帽衫": [
                        { name: '工艺', opts: ['Reverse Weave (横纹编织)', 'Basic (基础款)'] },
                        { name: '颜色', opts: ['花灰 (Grey)', '藏青', '酒红'] },
                        { name: 'Logo', opts: ['小C标', '草写大Logo'] }
                    ],
                    "Barbour 涂蜡外套": [
                        { name: '型号', opts: ['Bedale (短款/马术)', 'Beaufort (长款/狩猎)', 'Ashby (修身)'] },
                        { name: '颜色', opts: ['Sage (鼠尾草绿)', 'Olive (橄榄褐)', 'Navy (蓝)'] },
                        { name: '尺码 (UK)', opts: ['36', '38', '40', '42'] }
                    ],
                    "Stone Island 夹克": [
                        { name: '材质', opts: ['Nylon Metal (金属尼龙)', 'Crinkle Reps (皱缩)', 'Soft Shell'] },
                        { name: '袖标', opts: ['经典黄绿标', '暗影全黑标 (Shadow)'] },
                        { name: '尺码', opts: ['L', 'XL', 'XXL', '3XL'] }
                    ],
                    // --- ▼▼▼ 新增：10款鞋子产品的定制规格 (专业尺码版) ▼▼▼ ---
                    "匡威 1970s 帆布鞋": [
                        { name: '款式', opts: ['高帮 (High)', '低帮 (Low)'] },
                        { name: '颜色', opts: ['经典黑', '米白色 (Parchment)', '向日葵黄'] },
                        { name: '尺码 (偏大)', opts: ['36.5', '37.5', '39', '41.5', '42.5', '44'] }
                    ],
                    "New Balance 老爹鞋": [
                        { name: '型号', opts: ['NB 990v6 (美产)', 'NB 2002R', 'NB 530 (复古)'] },
                        { name: '颜色', opts: ['元祖灰 (Grey)', '海军蓝 (Navy)', '海盐白'] },
                        { name: '鞋宽', opts: ['D (标准)', '2E (加宽)'] }
                    ],
                    "Adidas Samba 德训鞋": [
                        { name: '配色', opts: ['OG 黑白', 'OG 白黑', '纯白灰尾'] },
                        { name: '版本', opts: ['Classic (经典长舌)', 'OG (短舌)'] },
                        { name: '尺码', opts: ['UK 4 (36.5)', 'UK 5 (38)', 'UK 7 (40.5)', 'UK 9 (43.5)'] }
                    ],
                    "GH Bass 乐福鞋": [
                        { name: '皮质', opts: ['抛光牛皮 (Weejuns)', '荔枝纹软皮'] },
                        { name: '颜色', opts: ['酒红色 (Wine)', '黑色 (Black)', '黑白拼色'] },
                        { name: '尺码 (US)', opts: ['US 7', 'US 8', 'US 9', 'US 10'] }
                    ],
                    "Dr. Martens 马丁靴": [
                        { name: '孔数', opts: ['1460 (8孔经典)', '1461 (3孔低帮)', 'Jadon (厚底)'] },
                        { name: '皮质', opts: ['硬皮 (Smooth)', '软皮 (Nappa)', '荔枝皮'] },
                        { name: '尺码 (UK)', opts: ['UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7'] }
                    ],
                    "Asics 亚瑟士跑鞋": [
                        { name: '系列', opts: ['Kayano 14 (支撑)', 'Nimbus 25 (缓震)', 'GT-2000'] },
                        { name: '颜色', opts: ['金属银 (Silver)', '奶油白', '黑武士'] },
                        { name: '尺码', opts: ['39', '40.5', '41.5', '42.5', '43.5'] }
                    ],
                    "Birkenstock 拖鞋": [
                        { name: '款式', opts: ['Boston (包头)', 'Arizona (双带)'] },
                        { name: '材质', opts: ['翻毛皮 (Suede)', '油皮 (Oiled)', 'EVA (防水)'] },
                        { name: '颜色', opts: ['灰褐色 (Taupe)', '摩卡色', '黑色'] }
                    ],
                    "Clarks 商务皮鞋": [
                        { name: '款式', opts: ['Desert Boot (沙漠靴)', 'Wallabee (袋鼠鞋)'] },
                        { name: '皮质', opts: ['蜜蜡色油皮', '沙色反绒皮', '黑色光面'] },
                        { name: '尺码 (UK)', opts: ['UK 7', 'UK 8', 'UK 9', 'UK 9.5'] }
                    ],
                    "Salomon 户外越野鞋": [
                        { name: '型号', opts: ['XT-6 (潮流款)', 'ACS Pro (机能款)', 'Speedcross'] },
                        { name: '配色', opts: ['香草白', '火山黑', '冰川蓝'] },
                        { name: '尺码', opts: ['EUR 40', 'EUR 41', 'EUR 42', 'EUR 43'] }
                    ],
                    "UGG 羊毛雪地靴": [
                        { name: '筒高', opts: ['Ultra Mini (超低筒)', 'Mini (低筒)', 'Short (中筒)'] },
                        { name: '颜色', opts: ['栗色 (Chestnut)', '巧克力色', '黑色'] },
                        { name: '尺码 (US)', opts: ['US 6', 'US 7', 'US 8', 'US 9'] }
                    ],
                    "泡泡玛特 盲盒手办": [
                        { name: '款式', opts: ['单盒 (随机)', '整盒 (12个不重复)', '确认款 (指定角色)'] },
                        { name: 'IP系列', opts: ['Molly 周年庆', 'Dimoo 森林', 'Skullpanda 梦境'] }
                    ],
                    "乐高 机械组赛车": [
                        { name: '型号', opts: ['法拉利 Daytona (42143)', '迈凯伦 F1 (42141)', '保时捷 911 (42096)'] },
                        { name: '版本', opts: ['原盒未拆', '带展示盒版', '已拼装成品'] }
                    ],
                    "Jellycat 邦尼兔": [
                        { name: '尺寸', opts: ['小号 (18cm)', '中号 (31cm)', '大号 (36cm)', '超大 (51cm)'] },
                        { name: '颜色', opts: ['米色 (Beige)', '害羞粉 (Tulip)', '星空蓝', '薰衣草紫'] }
                    ],
                    "大疆 Tello 遥控机": [
                        { name: '套餐', opts: ['标配版 (单电)', '畅飞版 (三电+充电管家)'] },
                        { name: '配件', opts: ['仅机器', '含手柄控制器', '含编程扩展包'] }
                    ],
                    "任天堂 Switch 游戏": [
                        { name: '版本', opts: ['日版', '港版', '美版'] },
                        { name: '游戏名', opts: ['塞尔达: 王国之泪', '马力欧卡丁车8', '动森', '健身环'] },
                        { name: '类型', opts: ['全新卡带', '二手回血'] }
                    ],
                    "富士 Instax 拍立得": [
                        { name: '型号', opts: ['Mini 12 (入门)', 'Mini Evo (数模双模)', 'SQ1 (方形)'] },
                        { name: '颜色', opts: ['薄荷绿', '樱花粉', '复古棕', '极夜黑'] },
                        { name: '相纸套餐', opts: ['标配无纸', '含20张白边', '含50张白边'] }
                    ],
                    "索尼 复古卡带机": [
                        { name: '成色', opts: ['全新库存 (NOS)', '99新收藏级', '8成新战斗级'] },
                        { name: '型号', opts: ['TPS-L2 (初代)', 'WM-2 (红)', 'WM-D6C (专业)'] }
                    ],
                    "Bearbrick 积木熊": [
                        { name: '尺寸', opts: ['100% (7cm)', '400% (28cm)', '1000% (70cm)'] },
                        { name: '款式', opts: ['梵高星空', '招财猫金运', '大理石纹', '透明限定'] }
                    ],
                    "KAWS 联名公仔": [
                        { name: '姿势', opts: ['站姿 (Standing)', '坐姿 (Passing Through)', '躺姿 (Holiday)'] },
                        { name: '配色', opts: ['经典灰', '全黑', '解剖半透'] },
                        { name: '版本', opts: ['OPEN EDITION', '会场限定'] }
                    ],
                    "万代 RG 高达模型": [
                        { name: '机体', opts: ['牛高达 (Nu Gundam)', '沙扎比 (Sazabi)', '独角兽 (Unicorn)', '海牛 (Hi-Nu)'] },
                        { name: '比例', opts: ['RG 1/144', 'MG 1/100 (部分款)', 'PG 1/60'] },
                        { name: '版本', opts: ['普通版', '彩透限定', '钛电镀版'] }
                    ],
                    "Keychron 机械键盘": [
                        { name: '轴体', opts: ['G Pro 红轴 (线性)', 'G Pro 青轴 (段落)', 'G Pro 茶轴 (微段落)'] },
                        { name: '背光', opts: ['RGB 铝合金边框', '白光 塑料边框'] },
                        { name: '布局', opts: ['K2 (75%紧凑)', 'K8 (87键)', 'Q1 Pro (客制化)'] }
                    ],
                    "罗技 MX 无线鼠标": [
                        { name: '型号', opts: ['MX Master 3S (旗舰)', 'MX Anywhere 3 (便携)', 'Lift (垂直工学)'] },
                        { name: '颜色', opts: ['石墨黑 (Graphite)', '珍珠白 (Pale Grey)', '玫瑰粉'] },
                        { name: '套餐', opts: ['标准版', '含皮质收纳包'] }
                    ],
                    "索尼 降噪耳机": [
                        { name: '型号', opts: ['WH-1000XM5 (最新)', 'WH-1000XM4 (折叠)'] },
                        { name: '颜色', opts: ['铂金银', '黑色', '深夜蓝'] },
                        { name: '加购', opts: ['无', '加购2年延保'] }
                    ],
                    "马歇尔 便携音箱": [
                        { name: '型号', opts: ['Emberton II (便携防水)', 'Stockwell II (手提)', 'Middleton (大功率)'] },
                        { name: '配色', opts: ['经典黑金 (Black&Brass)', '奶油白 (Cream)', '森林绿'] }
                    ],
                    "Apple Watch Ultra": [
                        { name: '表带类型', opts: ['高山回环 (Alpine)', '野径回环 (Trail)', '海洋表带 (Ocean)'] },
                        { name: '表带颜色', opts: ['星光色', '绿色', '橙色', '午夜黑'] },
                        { name: 'AppleCare+', opts: ['不购买', '购买 (+¥799)'] }
                    ],
                    "Wacom 专业数位板": [
                        { name: '尺寸', opts: ['PTH-660 (中号 M)', 'PTH-860 (大号 L)'] },
                        { name: '版本', opts: ['标准版', 'Paper Edition (纸感)'] },
                        { name: '赠品', opts: ['官方笔芯套装', '专用防护包'] }
                    ],
                    "安克 Anker 充电宝": [
                        { name: '容量/功率', opts: ['10000mAh (30W)', '20000mAh (200W)', '24000mAh (140W)'] },
                        { name: '屏幕', opts: ['无屏幕', '智能数显屏 (Prime系列)'] },
                        { name: '颜色', opts: ['极光黑', '香槟金'] }
                    ],
                    "极米 投影仪支架": [
                        { name: '适用机型', opts: ['H系列/Z系列通用', 'RS Pro 专用'] },
                        { name: '款式', opts: ['桌面支架 (万向球头)', '落地支架 (金属加重)', '床头夹支架'] },
                        { name: '材质', opts: ['航空铝合金', '碳钢'] }
                    ],
                    "Xbox 精英手柄": [
                        { name: '版本', opts: ['精英2代 青春版 (白色)', '精英2代 完整版 (黑色)'] },
                        { name: '自定义', opts: ['标准配置', 'Design Lab 定制色'] },
                        { name: '配件', opts: ['单手柄', '含无线适配器'] }
                    ],
                    "贝尔金 桌面三合一": [
                        { name: 'MagSafe', opts: ['15W 官方认证快充', '7.5W 普通磁吸'] },
                        { name: '颜色', opts: ['纯白 (White)', '酷黑 (Black)'] },
                        { name: '插头规格', opts: ['国标两插', '美标', '英标'] }
                    ]

                };

                // 逻辑：优先读用户自定义规格，没有则查库
                if (currentSpecsStr.trim() !== '') {
                    const groups = currentSpecsStr.split(/[;；]/);
                    specsData = groups.map(g => {
                        const parts = g.split(/[:：]/);
                        return parts.length > 1 ? { name: parts[0].trim(), opts: parts[1].split(/[,，]/).map(o => o.trim()) } : { name: '规格', opts: g.split(/[,，]/).map(o => o.trim()) };
                    });
                } else {
                    specsData = SPEC_DB[title] || [{ name: '规格', opts: ['默认规格'] }];
                }

                // 渲染 HTML
                buySpecsContainer.innerHTML = specsData.map(group => `
                    <div class="spec-group">
                        <div class="spec-title">${group.name}</div>
                        <div class="spec-tags">
                            ${group.opts.map((opt, i) => `<span class="spec-tag ${i===0?'active':''}">${opt}</span>`).join('')}
                        </div>
                    </div>
                `).join('');

                // 绑定点击变黑逻辑
                const allSpecTags = buySpecsContainer.querySelectorAll('.spec-tag');
                allSpecTags.forEach(tag => {
                    tag.onclick = function() {
                        const siblings = this.parentElement.querySelectorAll('.spec-tag');
                        siblings.forEach(s => s.classList.remove('active'));
                        this.classList.add('active');
                    };
                });

                payFriendFillModal.classList.add('visible');
            });
        }
        const payFriendCloseBtn = document.getElementById('shop-pay-friend-fill-close-btn');
        if (payFriendCloseBtn) {
            payFriendCloseBtn.onclick = () => {
                const modal = document.getElementById('shop-pay-friend-fill-modal-overlay');
                if (modal) modal.classList.remove('visible');
            };
        }
                const payFriendOverlay = document.getElementById('shop-pay-friend-fill-modal-overlay');
        if (payFriendOverlay) {
            payFriendOverlay.addEventListener('click', (e) => {
                if (e.target === payFriendOverlay) {
                    payFriendOverlay.classList.remove('visible');
                }
            });
        }
        const payFriendTimeChips = document.querySelectorAll('#pay-friend-time-chips .time-chip');
        payFriendTimeChips.forEach(chip => {
            chip.addEventListener('click', function() {
                payFriendTimeChips.forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                const innerInput = this.querySelector('input');
                if (innerInput) innerInput.focus();
            });
        });
        // 新增：代付弹窗点击“ta代付”按钮后的逻辑
        // [life.js] 这里的代码用于处理“购物填单弹窗”点击“Ta代付”后的逻辑
        const payFriendConfirmBtn = document.getElementById('shop-pay-friend-confirm-btn');
        if(payFriendConfirmBtn) {
        payFriendConfirmBtn.onclick = async () => {
                const addr = document.getElementById('pay-friend-address-input').value.trim();
                if(!addr) {
                    if(typeof showDynamicIsland === 'function') showDynamicIsland('请填写收货地址', 'error');
                    return;
                }
                // --- 【新增】获取配送时间/轮数逻辑 ---
                const activeTimeChip = document.querySelector('#pay-friend-time-chips .time-chip.active');
                let deliveryTime = "尽快送达";
                if (activeTimeChip) {
                    if (activeTimeChip.dataset.val === 'custom') {
                        const val = activeTimeChip.querySelector('input').value;
                        if (val) deliveryTime = val + ' 轮对话后';
                    } else {
                        deliveryTime = activeTimeChip.textContent.trim() + ' 对话后';
                    }
                }
                // 1. 直接获取当前弹窗内的商品数据
                const title = document.getElementById('pay-friend-mini-title').textContent;
                const price = document.getElementById('pay-friend-total-price').textContent;
                // 获取背景图 URL
                const imgBg = document.getElementById('pay-friend-mini-img').style.backgroundImage;
                const imgUrl = imgBg.slice(5, -2).replace(/['"]/g, "");
                
                // 获取选中的规格
                const activeSpecs = document.querySelectorAll('#pay-friend-specs-container .spec-tag.active');
                const specsText = Array.from(activeSpecs).map(el => el.textContent).join(' / ') || '标准规格';
                // 2. 关闭当前的“填单弹窗”
                document.getElementById('shop-pay-friend-fill-modal-overlay').classList.remove('visible');
                
                // 3. 打开“选择好友”弹窗 (自给自足，不依赖外部函数)
                const overlay = document.getElementById('pay-for-friend-modal-overlay');
                const list = document.getElementById('pay-for-friend-char-list');
                const closeBtn = document.getElementById('pay-for-friend-close-btn');
                
                if (overlay && list) {
                    overlay.classList.add('visible');
                    list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                    
                    // 绑定关闭按钮（防止之前未绑定）
                    const closeOverlay = () => overlay.classList.remove('visible');
                    if(closeBtn) closeBtn.onclick = closeOverlay;
                    overlay.onclick = (e) => { if(e.target === overlay) closeOverlay(); };

                    try {
                        // 动态导入需要的模块，确保变量可用
                        
                        const { sendPayRequestMessage } = await import('./chat-ui.js');
                        const { showDynamicIsland } = await import('../ui.js');

                        const chars = await getAllCharacters();
                        list.innerHTML = ''; 

                        if (!chars || chars.length === 0) {
                            list.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友可选</div>';
                            return;
                        }

                        // 渲染好友列表
                        chars.forEach(char => {
                            const item = document.createElement('div');
                            item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom: 8px;';
                            item.innerHTML = `
                                <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                                <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                                <span style="margin-left: auto; color: #000; font-size: 13px; font-weight:600;">发送请求 ›</span>
                            `;
                            
                            // 点击发送逻辑
                            item.addEventListener('click', async () => {
                                // 构造发送给 chat-ui.js 的数据
                                 let targetChatId = char.id;
                                let displayName = title;
                                let displaySpecs = specsText;
                                const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                                if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                                    displaySpecs = (specsText ? specsText + ' ' : '') + `(请 @${char.name} 代付)`;
                                    targetChatId = tempState.currentChatId;
                                }
                                
                                const requestData = {
                                    type: 'shop_pay', // 【关键】标记这是购物代付
                                    name: displayName,
                                    price: price,

                                    deliveryTime: deliveryTime,
                                    specs: displaySpecs,
                                      imageUrl: imgUrl
                                };

                                // 发送消息
                                await sendPayRequestMessage(targetChatId, requestData);

                                overlay.classList.remove('visible');
                                showDynamicIsland(`已向 ${char.name} 发起代付申请`, 'success');
                            });
                            
                            list.appendChild(item);
                        });
                    } catch (e) {
                        console.error("加载好友列表失败:", e);
                        list.innerHTML = '加载失败';
                    }
                }
            };
        }

        if(btnBuyTa) {
            btnBuyTa.addEventListener('click', () => {
                showDynamicIsland('已添加到送给Ta的清单', 'success');
            });
        }
    }

    // --- 【新增】购物车页面交互逻辑 ---

    // 1. 【通用】导航栏跳转逻辑 (绑定所有页面底部的购物车按钮)
    // 找到所有页面底部的“购物车”按钮 (nav-item index 2)
    const allShopNavs = document.querySelectorAll('.shop-bottom-nav');
    allShopNavs.forEach(nav => {
        const cartBtn = nav.querySelectorAll('.nav-item')[2]; // 第三个是购物车
        if (cartBtn) {
            cartBtn.addEventListener('click', () => {
                if (typeof showPage === 'function') {
                    showPage('page-life-shop-cart');
                }
            });
        }
    });

    // 2. 【购物车页】内部逻辑
    const cartPage = document.getElementById('page-life-shop-cart');
    if (cartPage) {
             // --- 【新增】定义渲染“我的物品”购物车的函数 ---
        window.renderMyShopCart = () => {
            const container = document.getElementById('cart-view-me');
            const totalEl = document.getElementById('cart-total-price');
            const checkoutBtn = document.querySelector('.cart-checkout-bar .btn-checkout');
            if (!container) return;

            // 1. 读取数据
            let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
            
            // 2. 如果为空
            if (cartData.length === 0) {
                container.innerHTML = '<div class="empty-state-placeholder"><p style="color:#999;padding-top:50px;text-align:center;">购物车空空如也</p></div>';
                if(totalEl) totalEl.textContent = '0.00';
                if(checkoutBtn) checkoutBtn.textContent = '去结算 (0)';
                
                // ▼▼▼ 【修复】同步清空页面底部的合计金额和全选状态 ▼▼▼
                const pageBarPrice = document.querySelector('#page-life-shop-cart .cart-checkout-bar .total-price');
                const pageSelectAll = document.querySelector('#page-life-shop-cart .cart-checkout-bar .select-all .check-circle');
                
                if (pageBarPrice) pageBarPrice.textContent = '¥0.00';
                if (pageSelectAll) pageSelectAll.classList.remove('active');
                
                return;
            }

            // 3. 生成 HTML
            container.innerHTML = '';
            let totalPrice = 0;
            let totalCount = 0;

            cartData.forEach((item, index) => {
                if (item.checked) {
                    totalPrice += item.price * item.count;
                    totalCount += item.count;
                }

                const html = `
                    <div class="cart-product-row" data-index="${index}">
                        <div class="check-circle ${item.checked ? 'active' : ''}" onclick="window.toggleShopItem(${index})"></div>
                        <div class="cp-img" style="background-image: url('${item.img}');"></div>
                        <div class="cp-info">
                            <div class="cp-title">${item.title}</div>
                            <div class="cp-specs">${item.specs}</div>
                            <div class="cp-bottom">
                                <span class="cp-price">¥${item.price}</span>
                                <div class="cp-stepper">
                                    <button onclick="window.updateShopItemCount(${index}, -1)">-</button>
                                    <span>${item.count}</span>
                                    <button onclick="window.updateShopItemCount(${index}, 1)">+</button>
                                </div>
                            </div>
                        </div>
                        <button onclick="window.removeShopItem(${index})" style="margin-left:10px;border:none;background:transparent;color:#ccc;">×</button>
                    </div>
                `;
                container.insertAdjacentHTML('beforeend', html);
            });
            // 4. 更新底部合计
            if(totalEl) totalEl.textContent = totalPrice.toFixed(2);
            if(checkoutBtn) checkoutBtn.textContent = `去结算 (${totalCount})`;

            // ▼▼▼ 【新增】同步更新页面底部的结算栏 (Taobao逻辑) ▼▼▼
            const pageBarPrice = document.querySelector('#page-life-shop-cart .cart-checkout-bar .total-price');
            const pageBarBtn = document.querySelector('#page-life-shop-cart .cart-checkout-bar .btn-checkout');
            const pageSelectAll = document.querySelector('#page-life-shop-cart .cart-checkout-bar .select-all .check-circle');
            
            // 1. 更新价格
            if (pageBarPrice) pageBarPrice.textContent = '¥' + totalPrice.toFixed(2);
            // 2. 更新按钮文字
            if (pageBarBtn) pageBarBtn.textContent = `去结算 (${totalCount})`;
            // 3. 更新全选按钮状态 (如果购物车不为空，且所有商品都选中了，全选亮起)
            if (pageSelectAll) {
                const isAllChecked = cartData.length > 0 && cartData.every(item => item.checked);
                if (isAllChecked) pageSelectAll.classList.add('active');
                else pageSelectAll.classList.remove('active');
            }
            // ▲▲▲ 新增结束 ▲▲▲
        };


        // --- 【新增】挂载全局操作函数 (供HTML直接调用) ---
        window.toggleShopItem = (index) => {
            let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
            if(cartData[index]) {
                cartData[index].checked = !cartData[index].checked;
                localStorage.setItem('my_shop_cart', JSON.stringify(cartData));
                window.renderMyShopCart();
            }
        };
        window.updateShopItemCount = (index, change) => {
            let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
            if(cartData[index]) {
                cartData[index].count += change;
                if(cartData[index].count <= 0) cartData[index].count = 1; // 最小为1
                localStorage.setItem('my_shop_cart', JSON.stringify(cartData));
                window.renderMyShopCart();
            }
        };
        window.removeShopItem = (index) => {
            if(!confirm('确定删除这个商品吗？')) return;
            let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
            cartData.splice(index, 1);
            localStorage.setItem('my_shop_cart', JSON.stringify(cartData));
            window.renderMyShopCart();
        };
      const pageSelectAllBtn = document.querySelector('#page-life-shop-cart .cart-checkout-bar .select-all');
        if (pageSelectAllBtn) {
            // 克隆节点以防止重复绑定监听器
            const newSelectAllBtn = pageSelectAllBtn.cloneNode(true);
            pageSelectAllBtn.parentNode.replaceChild(newSelectAllBtn, pageSelectAllBtn);
            newSelectAllBtn.addEventListener('click', () => {
                let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                // 判断当前是否已经是全选状态
                const isAllChecked = cartData.length > 0 && cartData.every(item => item.checked);
                
                // 如果全是选中的，点击就变成全不选；否则全选
                cartData.forEach(item => item.checked = !isAllChecked);
                
                localStorage.setItem('my_shop_cart', JSON.stringify(cartData));
                window.renderMyShopCart(); // 重新渲染界面
            });
        }
        // --- 初始化时渲染一次 ---
        renderMyShopCart();

        // --- 监听清空按钮 ---
        const clearBtn = document.getElementById('clear-cart-btn');
        if (clearBtn) {
            // 移除旧监听防止重复 (克隆节点法)
            const newBtn = clearBtn.cloneNode(true);
            clearBtn.parentNode.replaceChild(newBtn, clearBtn);
            newBtn.addEventListener('click', () => {
                if(confirm('确定清空购物车吗？')) {
                    localStorage.removeItem('my_shop_cart');
                    renderMyShopCart();
                }
            });
        }
         // --- 交互：购物车结算弹窗逻辑 (严谨版) ---
        const shopCheckoutBtn = document.querySelector('#page-life-shop-cart .cart-checkout-bar .btn-checkout');
        const shopCheckoutModal = document.getElementById('shop-checkout-modal-overlay');
        const shopCheckoutClose = document.getElementById('shop-checkout-close-btn');
        if (shopCheckoutBtn && shopCheckoutModal) {
            
            // 1. 点击“去结算”按钮
            // 使用 replaceChild 克隆节点法，防止重复绑定事件导致点一次弹好几次
            const newCheckoutBtn = shopCheckoutBtn.cloneNode(true);
            shopCheckoutBtn.parentNode.replaceChild(newCheckoutBtn, shopCheckoutBtn);
            newCheckoutBtn.addEventListener('click', () => {
                // [严谨检查 1] 读取购物车数据
                const rawCart = localStorage.getItem('my_shop_cart');
                const cartData = rawCart ? JSON.parse(rawCart) : [];
                // [严谨检查 2] 检查是否有数据
                if (cartData.length === 0) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('购物车是空的', 'error');
                    return;
                }
                // [严谨检查 3] 检查是否有“被勾选”的商品 (some方法：只要有一个checked为true就返回true)
                const hasCheckedItems = cartData.some(item => item.checked);
                if (!hasCheckedItems) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('请先勾选要结算的商品', 'error');
                    return;
                }
                // 验证通过，显示底部弹窗
                shopCheckoutModal.classList.add('visible');
            });
            // 2. 关闭弹窗逻辑
            const closeShopCheckout = () => shopCheckoutModal.classList.remove('visible');
            
            if (shopCheckoutClose) shopCheckoutClose.addEventListener('click', closeShopCheckout);
            
            // 点击遮罩层空白处关闭
            shopCheckoutModal.addEventListener('click', (e) => {
                if (e.target === shopCheckoutModal) closeShopCheckout();
            });
            // 3. 绑定三个选项的点击事件
            const btnSelf = document.getElementById('shop-checkout-self');
            const btnGift = document.getElementById('shop-checkout-gift');
            const btnAsk = document.getElementById('shop-checkout-ask');
            // 选项 1：给自己买
            // 选项 1：给自己买 (Cart Checkout Logic)
            if (btnSelf) {
                btnSelf.onclick = () => {
                    // 1. 关闭选择方式的弹窗
                    closeShopCheckout();

                    // 2. 获取购物车数据
                    let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                    // 筛选出被勾选的商品
                    const selectedItems = cartData.filter(item => item.checked);

                    if (selectedItems.length === 0) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('未选择任何商品', 'error');
                        return;
                    }

                    // 3. 获取新弹窗元素
                    const fillModal = document.getElementById('shop-cart-fill-modal-overlay');
                    const listContainer = document.getElementById('cart-checkout-list');
                    const totalPriceEl = document.getElementById('cart-final-total-price');
                    
                    if (!fillModal || !listContainer) return;
  const addressSection = fillModal.querySelector('.buy-section.address-section');
                    if (addressSection) {
                        addressSection.innerHTML = `
                            <div class="section-label">收货地址</div>
                            <textarea id="cart-address-input" placeholder="请输入详细的收货地址..."></textarea>
                            <input type="tel" id="cart-phone-input" placeholder="联系电话">
                        `;
                    }
                    // 4. 渲染商品列表 (Taobao Style)
                    listContainer.innerHTML = ''; // 清空
                    let total = 0;

                    selectedItems.forEach(item => {
                        const itemTotal = item.price * item.count;
                        total += itemTotal;

                        const div = document.createElement('div');
                        div.className = 'checkout-product-item';
                        div.innerHTML = `
                            <div class="thumb" style="background-image: url('${item.img}');"></div>
                            <div class="info">
                                <div class="title">${item.title}</div>
                                <div class="specs">${item.specs || '标准规格'}</div>
                                <div class="price-row">
                                    <span class="price">¥${item.price}</span>
                                    <span class="count">x${item.count}</span>
                                </div>
                            </div>
                        `;
                        listContainer.appendChild(div);
                    });

                    // 5. 更新总价
                    if (totalPriceEl) totalPriceEl.textContent = total.toFixed(2);

                    // 6. 显示弹窗
                    fillModal.classList.add('visible');
                };
            }

            // 选项 2：送给朋友 (Cart Checkout Logic - Gift Mode)
            if (btnGift) {
                btnGift.onclick = () => {
                    // 1. 关闭选择方式的弹窗
                    closeShopCheckout();

                    // 2. 获取购物车数据
                    let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                    const selectedItems = cartData.filter(item => item.checked);

                    if (selectedItems.length === 0) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('未选择任何商品', 'error');
                        return;
                    }

                    // 3. 获取填单弹窗元素
                    const fillModal = document.getElementById('shop-cart-fill-modal-overlay');
                    const listContainer = document.getElementById('cart-checkout-list');
                    const totalPriceEl = document.getElementById('cart-final-total-price');
                    
                    if (!fillModal || !listContainer) return;

                    // 4. 【核心修改】改造“收货地址”区域为“选择角色”
                    const addressSection = fillModal.querySelector('.buy-section.address-section');
                    if (addressSection) {
                        addressSection.innerHTML = `
                            <div class="section-label">收货对象</div>
                            <!-- 这是一个模拟的按钮，点击触发选择 -->
                            <div id="cart-gift-trigger" class="buy-for-char-btn" style="margin:0;">
                                <div class="left">
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                                    <span id="cart-gift-name-display" style="color:#d93025;">点击选择 Ta</span>
                                </div>
                                <div class="right">›</div>
                            </div>
                            <!-- 隐藏域：用于存储选中的角色ID -->
                            <input type="hidden" id="cart-is-gift-order" value="true">
                            <input type="hidden" id="cart-gift-target-id" value="">
                        `;

                        // 绑定点击事件：打开角色选择列表
                        document.getElementById('cart-gift-trigger').addEventListener('click', async () => {
                            const giftOverlay = document.getElementById('gift-character-modal-overlay');
                            const giftList = document.getElementById('gift-char-list');
                            
                            if (giftOverlay && giftList) {
                                giftOverlay.classList.add('visible');
                                    giftList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                                
                                try {
                                    // 删除了 import，直接使用顶部重写过的 getAllCharacters
                                    const chars = await getAllCharacters();
                                    giftList.innerHTML = '';

                                    if (!chars || chars.length === 0) {
                                        giftList.innerHTML = '<div style="text-align: center; color: #ccc;">暂无好友</div>';
                                        return;
                                    }

                                    chars.forEach(char => {
                                        const item = document.createElement('div');
                                        item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; transition: background 0.2s; margin-bottom:8px;';
                                        item.innerHTML = `
                                            <img src="${char.avatar || 'images/default-avatar.svg'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 12px;">
                                            <span style="font-size: 15px; font-weight: 500; color: #333;">${char.name}</span>
                                            <span style="margin-left: auto; color: #d93025; font-size: 12px;">选择 ›</span>
                                        `;
                                        
                                        // 点击角色：回填信息到购物车弹窗
                                        item.addEventListener('click', () => {
                                            // 生成虚拟电话
                                            const prefix = ['135','138','139','150','158','186'];
                                            const phoneNum = prefix[Math.floor(Math.random()*prefix.length)] + '****' + Math.floor(Math.random()*9000+1000);
                                            
                                            // 替换地址栏区域的内容为“角色信息卡片”
                                            addressSection.innerHTML = `
                                                <div class="section-label">收货对象</div>
                                                <div class="char-address-row">
                                                    <img src="${char.avatar || 'images/default-avatar.svg'}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.05);">
                                                    <div class="char-info" style="display:flex;flex-direction:column;justify-content:center;margin-left:12px;">
                                                        <span class="char-name" style="font-size:16px;font-weight:600;color:#000;margin-bottom:3px;">收件人：${char.name}</span>
                                                        <span class="char-phone" style="font-size:13px;color:#888;font-family:monospace;">${phoneNum}</span>
                                                    </div>
                                                </div>
                                                <!-- 重新写入隐藏域，防止被innerHTML清空 -->
                                                <input type="hidden" id="cart-is-gift-order" value="true">
                                                <input type="hidden" id="cart-gift-target-id" value="${char.id}">
                                                <input type="hidden" id="cart-gift-target-name" value="${char.name}">
                                            `;
                                            
                                            giftOverlay.classList.remove('visible');
                                        });
                                        giftList.appendChild(item);
                                    });
                                } catch (e) {
                                    console.error(e);
                                    giftList.innerHTML = '加载失败';
                                }
                            }
                        });
                    }

                    // 5. 渲染商品列表 (同自己买)
                    listContainer.innerHTML = '';
                    let total = 0;
                    selectedItems.forEach(item => {
                        const itemTotal = item.price * item.count;
                        total += itemTotal;
                        const div = document.createElement('div');
                        div.className = 'checkout-product-item';
                        div.innerHTML = `
                            <div class="thumb" style="background-image: url('${item.img}');"></div>
                            <div class="info">
                                <div class="title">${item.title}</div>
                                <div class="specs">${item.specs || '标准规格'}</div>
                                <div class="price-row"><span class="price">¥${item.price}</span><span class="count">x${item.count}</span></div>
                            </div>
                        `;
                        listContainer.appendChild(div);
                    });

                    // 6. 更新总价并显示
                    if (totalPriceEl) totalPriceEl.textContent = total.toFixed(2);
                    fillModal.classList.add('visible');
                };
            }

            // 选项 3：找人代付
            if (btnAsk) {
                btnAsk.onclick = () => {
                    // 1. 关闭结算方式选择弹窗
                    closeShopCheckout();

                    // 2. 获取购物车勾选的数据
                    let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                    const selectedItems = cartData.filter(item => item.checked);

                    if (selectedItems.length === 0) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('未选择任何商品', 'error');
                        return;
                    }

                    // 3. 获取新弹窗元素
                    const payModal = document.getElementById('shop-cart-pay-friend-modal-overlay');
                    const listContainer = document.getElementById('cart-pay-friend-list');
                    const totalPriceEl = document.getElementById('cart-pay-friend-final-price');
                    
                    if (!payModal || !listContainer) return;

                    // 4. 渲染商品预览列表
                    listContainer.innerHTML = '';
                    let total = 0;
                    selectedItems.forEach(item => {
                        total += item.price * item.count;
                        const div = document.createElement('div');
                        div.className = 'checkout-product-item';
                        div.innerHTML = `
                            <div class="thumb" style="background-image: url('${item.img}');"></div>
                            <div class="info">
                                <div class="title">${item.title}</div>
                                <div class="price-row"><span class="price">¥${item.price}</span><span class="count">x${item.count}</span></div>
                            </div>
                        `;
                        listContainer.appendChild(div);
                    });

                    if (totalPriceEl) totalPriceEl.textContent = total.toFixed(2);
                    
                    // 5. 显示弹窗
                    payModal.classList.add('visible');
                };

            }
                    // --- 找人代付填单弹窗的内部交互 ---
        const cartPayFriendModal = document.getElementById('shop-cart-pay-friend-modal-overlay');
        const cartPayFriendClose = document.getElementById('shop-cart-pay-friend-close-btn');
        const cartPayFriendConfirm = document.getElementById('cart-pay-friend-confirm-btn');

        // 关闭逻辑
        if (cartPayFriendClose && cartPayFriendModal) {
            cartPayFriendClose.onclick = () => cartPayFriendModal.classList.remove('visible');
            cartPayFriendModal.addEventListener('click', (e) => {
                if (e.target === cartPayFriendModal) cartPayFriendModal.classList.remove('visible');
            });
        }

        // 点击“找ta代付”：打开好友选择列表
        if (cartPayFriendConfirm) {
            cartPayFriendConfirm.onclick = async () => {
                // 1. 获取地址和电话
                const addr = document.getElementById('cart-pay-friend-address-input').value.trim();
                const phone = document.getElementById('cart-pay-friend-phone-input').value.trim();
                
                if (!addr) {
                    showDynamicIsland('请填写收货地址', 'error');
                    return;
                }

                // 2. 获取配送时间
                const activeTimeChip = document.querySelector('#cart-pay-friend-time-chips .time-chip.active');
                let deliveryTime = "尽快送达";
                if (activeTimeChip) {
                    if (activeTimeChip.dataset.val === 'custom') {
                        const val = activeTimeChip.querySelector('input').value;
                        if (val) deliveryTime = val + ' 轮对话后';
                    } else {
                        deliveryTime = activeTimeChip.textContent.trim() + ' 对话后';
                    }
                }

                const total = document.getElementById('cart-pay-friend-final-price').textContent;
                
                // 3. 获取完整的商品列表 (用于生成小票)
                const cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                const selectedItems = cartData.filter(item => item.checked);
                
                // 简化数据结构，只存必要的字段
                const cleanItems = selectedItems.map(i => ({
                    name: i.title,
                    price: i.price,
                    count: i.count,
                    specs: i.specs,
                    img: i.img
                }));

                // 暂时关闭当前弹窗
                cartPayFriendModal.classList.remove('visible');

                // 复用好友选择弹窗
                const overlay = document.getElementById('pay-for-friend-modal-overlay');
                const list = document.getElementById('pay-for-friend-char-list');
                
                if (overlay && list) {
                    overlay.classList.add('visible');
                    list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">加载好友中...</div>';
                     try {
                        // 删除了 getAllCharacters 的 import
                        const { sendPayRequestMessage } = await import('./chat-ui.js');
                        const chars = await getAllCharacters();
                        list.innerHTML = '';

                        chars.forEach(char => {

                            const item = document.createElement('div');
                            item.style.cssText = 'display: flex; align-items: center; padding: 12px; background: #f9f9f9; border-radius: 12px; cursor: pointer; margin-bottom: 8px;';
                            // 这里的 img 样式已经修复了压扁问题
                            item.innerHTML = `<img src="${char.avatar || 'images/default-avatar.svg'}" style="width:40px;height:40px;border-radius:50%;margin-right:12px;object-fit:cover;flex-shrink:0;"><span style="font-weight:500;">${char.name}</span><span style="margin-left:auto;color:#007aff;">选择 ›</span>`;
                             item.addEventListener('click', async () => {
                                            let targetChatId = char.id;
                                let displayName = `购物车多件商品`;
                                let displaySpecs = `共 ${cleanItems.length} 件商品`;
                                const currChat = AppState.characterProfiles.find(c => c.id === tempState.currentChatId);
                                if (currChat && currChat.isGroup && String(targetChatId) !== String(tempState.currentChatId)) {
                                    displaySpecs = displaySpecs + ` (请 @${char.name} 代付)`;
                                    targetChatId = tempState.currentChatId;
                                }

                                const requestData = {
                                    type: 'shop_pay',
                                    name: displayName,

                                    price: total,
                                    // 存入所有必要信息
                                    items: cleanItems,
                                    address: addr,
                                    phone: phone,
                                    deliveryTime: deliveryTime,
                                    // 预览图只取第一张
                                    imageUrl: cleanItems[0]?.img || 'https://cdn-icons-png.flaticon.com/512/3081/3081840.png',
                                     specs: displaySpecs
                                };

                                await sendPayRequestMessage(targetChatId, requestData);

                                const remainingItems = cartData.filter(item => !item.checked);
                                localStorage.setItem('my_shop_cart', JSON.stringify(remainingItems));
                                if (window.renderMyShopCart) window.renderMyShopCart();
                          
                                overlay.classList.remove('visible');
                                showDynamicIsland(`已向 ${char.name} 发起代付请求`, 'success');
                            });
                            list.appendChild(item);
                        });
                    } catch (e) { list.innerHTML = '加载失败'; }
                }
            };

        }

        }
                // ==========================================
        // ▼▼▼ 【新增】购物车填写单弹窗交互逻辑 ▼▼▼
        // ==========================================
        
        const cartFillModal = document.getElementById('shop-cart-fill-modal-overlay');
        const cartFillCloseBtn = document.getElementById('shop-cart-fill-close-btn');
        const cartConfirmPayBtn = document.getElementById('cart-confirm-pay-btn');
        const cartTimeChips = document.querySelectorAll('#cart-time-chips .time-chip');

        // 1. 关闭逻辑
        if (cartFillModal) {
            const closeFillModal = () => cartFillModal.classList.remove('visible');
            if (cartFillCloseBtn) cartFillCloseBtn.addEventListener('click', closeFillModal);
            cartFillModal.addEventListener('click', (e) => {
                if (e.target === cartFillModal) closeFillModal();
            });
        }

        // 2. 时间标签切换逻辑
        if (cartTimeChips.length > 0) {
            cartTimeChips.forEach(chip => {
                chip.addEventListener('click', function(e) {
                    cartTimeChips.forEach(c => c.classList.remove('active'));
                    this.classList.add('active');
                    const innerInput = this.querySelector('input');
                    if (innerInput) innerInput.focus();
                });
                const innerInput = chip.querySelector('input');
                if (innerInput) {
                    innerInput.addEventListener('input', () => {
                        cartTimeChips.forEach(c => c.classList.remove('active'));
                        chip.classList.add('active');
                    });
                }
            });
        }

        // 3. 确认支付逻辑
        if (cartConfirmPayBtn) {
            // 防止重复绑定
            const newPayBtn = cartConfirmPayBtn.cloneNode(true);
            cartConfirmPayBtn.parentNode.replaceChild(newPayBtn, cartConfirmPayBtn);

            newPayBtn.addEventListener('click', async () => {
                // ▼▼▼ 【修改开始】智能判断是自购还是送礼 ▼▼▼
                let addr = '';
                let phone = '';
                let targetId = tempState.currentChatId; // 默认发给当前聊天窗口
                let isGift = false;

                // 检查是否有送礼标记
                const isGiftInput = document.getElementById('cart-is-gift-order');
                
                if (isGiftInput && isGiftInput.value === 'true') {
                    // --- 送给朋友模式 ---
                    const giftTargetId = document.getElementById('cart-gift-target-id').value;
                    const giftTargetName = document.getElementById('cart-gift-target-name')?.value || 'Ta';
                    
                    if (!giftTargetId) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('请选择收货对象', 'error');
                        return;
                    }
                    
                    targetId = giftTargetId;
                    addr = `${giftTargetName} 的默认收货地址`;
                    phone = document.querySelector('.char-address-row .char-phone')?.textContent || '138****8888';
                    isGift = true;
                } else {
                    // --- 给自己买模式 ---
                    // 必须把地址栏还原回来 (如果之前是送礼模式切回来的话)
                    const addrInput = document.getElementById('cart-address-input');
                    const phoneInput = document.getElementById('cart-phone-input');
                    
                    // 如果找不到输入框（可能被替换了），说明逻辑错乱，刷新下页面重试
                    if (!addrInput || !phoneInput) {
                        // 简单处理：如果是默认给自己买，应该是有输入框的。
                        // 如果因为刚才点了送人把输入框弄没了，这里做个兜底校验
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('请填写收货地址', 'error');
                        return;
                    }

                    addr = addrInput.value.trim();
                    phone = phoneInput.value.trim();

                    if (!addr) {
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('请填写收货地址', 'error');
                        return;
                    }
                }
                // ▲▲▲ 修改结束 ▲▲▲

                // 获取配送时间
                const activeTimeChip = document.querySelector('#cart-time-chips .time-chip.active');
                let deliveryTime = "尽快送达";
                if (activeTimeChip) {
                    if (activeTimeChip.dataset.val === 'custom') {
                        const val = activeTimeChip.querySelector('input').value;
                        if (!val) {
                            if (typeof showDynamicIsland === 'function') showDynamicIsland('请输入轮数', 'error');
                            return;
                        }
                        deliveryTime = val + ' 轮对话后';
                    } else {
                        deliveryTime = activeTimeChip.textContent.trim() + ' 对话后';
                    }
                }

                // 获取购物车中选中的商品
                let cartData = JSON.parse(localStorage.getItem('my_shop_cart') || '[]');
                const selectedItems = cartData.filter(item => item.checked);
                const remainingItems = cartData.filter(item => !item.checked); // 没买的留下

                // 计算总价和小票折扣
                let subtotal = 0;
                selectedItems.forEach(item => subtotal += item.price * item.count);
                const discount = subtotal * 0.1; // 模拟折扣
                const finalTotal = subtotal - discount - 2;

                // 构造小票数据 (receiptData)
                const receiptData = {
                    items: selectedItems.map(item => ({
                        name: item.title,
                        price: item.price,
                        count: item.count,
                        specs: item.specs,
                        img: item.img
                    })),
                    total: finalTotal > 0 ? finalTotal : 0,
                    discounts: [
                     { name: '店铺满减', amount: -discount },
                    { name: 'VIP运费', amount: -2.00 }
                ],
                payMethod: isGift ? '为Ta免单' : '余额支付',
                deliveryInfo: { address: addr, phone: phone, time: deliveryTime }
            };
            const finalPayAmount = finalTotal > 0 ? finalTotal : 0;
            const payment = await requestLookyPayment({
                amount: finalPayAmount,
                title: isGift ? '购物车送礼' : '购物车结算',
                scene: 'shop'
            });
            if (!payment) return;

            // 发送小票消息

                if (targetId) {
     try {
                        const { sendReceiptMessage } = await import('./chat-ui.js');
                        // 记录返回的 messageId
                        const msgId = await sendReceiptMessage(targetId, receiptData);
                                               const newOrder = {
                            id: Date.now(),
                            ledgerSynced: true,
                            shopName: 'Looky Selection',
                            status: '等待卖家发货',
                            items: selectedItems.map(item => ({
                                title: item.title,
                                specs: item.specs || '标准规格',
                                price: item.price,
                                count: item.count,
                                img: item.img
                            })),
                            total: finalTotal > 0 ? finalTotal.toFixed(2) : '0.00'
                        };
                        let myOrders = JSON.parse(localStorage.getItem('my_shop_orders') || '[]');
                        myOrders.unshift(newOrder); // 放到最前面
                        if (myOrders.length > 10) myOrders = myOrders.slice(0, 10); // 只保留10条
                        localStorage.setItem('my_shop_orders', JSON.stringify(myOrders));
                        // 【核心分流逻辑】
                        // 只有当“配送时间包含轮数”且“不是给自己买（isGift为true）”时，才注册监听
                        if (isGift && deliveryTime.includes('轮')) {
                            const initialTurns = parseInt(deliveryTime);
                            if (!isNaN(initialTurns)) {
                                if (!tempState.activeGifts) tempState.activeGifts = {};
                                const actualChatId = tempState.currentChatId; // 强制将包裹挂载在当前聊天室(群聊/单聊)
                                if (!tempState.activeGifts[actualChatId]) tempState.activeGifts[actualChatId] = [];
                                
                                // 注册到全局监听，注意这里 isFromAiPay 设为 false，确保没有结束动画
                                tempState.activeGifts[actualChatId].push({
                                    msgId: msgId, 

                                    remaining: initialTurns,
                                    status: 'delivering',
                                    title: selectedItems[0]?.title || '多件商品',
                                    img: selectedItems[0]?.img || '',
                                    isFromAiPay: false // 用户买给角色的，不触发开箱动画
                                });
                                localStorage.setItem('active_gifts_state', JSON.stringify(tempState.activeGifts));
                            }
                        }
                    } catch (e) {
                        console.error("支付发送失败", e);
                    }
                }

                // 更新购物车数据 (只保留未买的)
                localStorage.setItem('my_shop_cart', JSON.stringify(remainingItems));
                
                // 刷新购物车界面
                if (window.renderMyShopCart) window.renderMyShopCart();

                // 关闭弹窗并提示
                cartFillModal.classList.remove('visible');
                
                if (isGift) {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('已为Ta下单成功', 'success');
                } else {
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('支付成功，正在安排发货', 'success');
                }
                
                // 清空输入 (如果是输入框模式)
                const addrInput = document.getElementById('cart-address-input');
                if (addrInput) addrInput.value = '';
            });

        }

        // A. 顶部双页切换 (我的 / Ta的)
        const switcherItems = cartPage.querySelectorAll('.switch-item');
        const sections = {
            'cart-me': document.getElementById('cart-view-me'),
            'cart-char': document.getElementById('cart-view-char')
        };

        switcherItems.forEach(item => {
            item.addEventListener('click', () => {
                // 1. 切换按钮样式
                switcherItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                // 2. 切换显示内容
                const targetId = item.getAttribute('data-target');
                
                // 隐藏所有
                Object.values(sections).forEach(sec => {
                    if(sec) sec.style.display = 'none';
                });
                
                // 显示目标
                if (sections[targetId]) {
                    sections[targetId].style.display = 'block';
                    // 如果是 fade 动画，可以加在这里
                }
            });
        });

        // B. 底部导航跳转 (跳回首页/分类)
        const homeBtn = document.getElementById('shop-nav-home-from-cart');
        const catBtn = document.getElementById('shop-nav-cat-from-cart');

        if(homeBtn) {
            homeBtn.addEventListener('click', () => showPage('page-life-shop'));
        }
        if(catBtn) {
            catBtn.addEventListener('click', () => showPage('page-life-shop-category'));
        }
    }
    // --- 【新增】“我的”页面交互逻辑 ---

    // 1. 【通用】绑定所有页面底部的“我的”按钮
    // 找到所有页面底部的“我的”按钮 (nav-item index 3, 也就是最后一个)
    const allProfileNavs = document.querySelectorAll('.shop-bottom-nav');
    allProfileNavs.forEach(nav => {
        const profileBtn = nav.querySelectorAll('.nav-item')[3]; // 第四个是“我的”
        if (profileBtn) {
            profileBtn.addEventListener('click', () => {
                
                // --- 核心：在跳转前，自动读取并更新用户信息 ---
                const profilePage = document.getElementById('page-life-shop-profile');
                if (profilePage) {
                    const avatarImg = profilePage.querySelector('#shop-profile-avatar');
                    const nameTxt = profilePage.querySelector('#shop-profile-name');
                    
                    // 获取当前聊天中的用户身份 (利用 window.getCurrentChatIdentity 全局函数)
                    const currentUser = window.getCurrentChatIdentity ? window.getCurrentChatIdentity() : null;
                    
                    if (currentUser) {
                        if (avatarImg) avatarImg.src = currentUser.avatar || 'images/default-avatar.svg';
                        if (nameTxt) nameTxt.textContent = currentUser.name || 'User';
                    }
                          const ordersListContainer = profilePage.querySelector('.my-orders-list');
                    if (ordersListContainer) {
                        let myOrders = JSON.parse(localStorage.getItem('my_shop_orders') || '[]');
                        let html = '<h3>最近订单</h3>';
                        
                        if (myOrders.length === 0) {
                            html += '<div style="text-align:center; padding: 50px 0; color: #999; font-size: 13px;">暂无订单记录，快去逛逛吧~</div>';
                        } else {
                            myOrders.forEach(order => {
                                // 取订单里的第一个商品作为封面
                                const firstItem = order.items[0];
                                // 如果购物车买了多件，就在标题后面加提示
                                const moreText = order.items.length > 1 ? `<span style="font-size: 11px; color: #999; margin-left: 4px;">等 ${order.items.length} 件商品</span>` : '';
                                
                                html += `
                                <div class="order-card">
                                    <div class="order-header">
                                        <span class="shop-title">${order.shopName}</span>
                                        <span class="status-text blue">${order.status}</span>
                                    </div>
                                    <div class="order-body">
                                        <div class="product-thumb" style="background-image: url('${firstItem.img}');"></div>
                                        <div class="product-detail">
                                            <div class="name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${firstItem.title} ${moreText}</div>
                                            <div class="spec">${firstItem.specs}</div>
                                        </div>
                                        <div class="price-col">
                                            <div class="price">¥${firstItem.price}</div>
                                            <div class="count">x${firstItem.count}</div>
                                        </div>
                                    </div>
                                    <div class="order-footer">
                                        <span class="total">实付 ¥${order.total}</span>
                                        <div class="btn-group">
                                            <button class="btn small">联系卖家</button>
                                            <button class="btn small primary">催发货</button>
                                        </div>
                                    </div>
                                </div>
                                `;
                            });
                        }
                        // 把拼接好的真实数据写入页面，覆盖掉原本 HTML 里的假订单
                        ordersListContainer.innerHTML = html;
                    }
                }

                // 跳转页面
                if (typeof showPage === 'function') {
                    showPage('page-life-shop-profile');
                }
            });
        }
    });

    // 2. 【我的页面】底部导航跳转回其他页面
    const profilePageElement = document.getElementById('page-life-shop-profile');
    if (profilePageElement) {
        const homeBtn = document.getElementById('shop-nav-home-from-profile');
        const catBtn = document.getElementById('shop-nav-cat-from-profile');
        const cartBtn = document.getElementById('shop-nav-cart-from-profile');

        if(homeBtn) homeBtn.addEventListener('click', () => showPage('page-life-shop'));
        if(catBtn) catBtn.addEventListener('click', () => showPage('page-life-shop-category'));
        if(cartBtn) cartBtn.addEventListener('click', () => showPage('page-life-shop-cart'));
    }
// ... (上面是原有的代码)

/**
 * 【新增】响应 AI 的 "clear_cart" 指令：帮用户清空购物车
 * 生成 3D 购物清单卡片 (receipt-card-3d)
 */
export async function triggerAiClearCart(chatId) {
    // 1. 读取购物车数据
    const rawCart = localStorage.getItem('my_shop_cart');
    const cartData = rawCart ? JSON.parse(rawCart) : [];
    
    // 如果购物车是空的，就不执行了
    if (cartData.length === 0) return;

    console.log(`[霸总模式] 角色 ${chatId} 正在清空用户的购物车...`);

    // 2. 转换数据格式
    const items = cartData.map(item => ({
        name: item.title,
        price: item.price,
        count: item.count,
        specs: item.specs,
        img: item.img
    }));

    // 3. 构造包裹数据
    // 【关键修改】：mode 设为 'shop'，这样 createAiPackageMessage 就会生成 receipt-card-3d
    const packageData = {
        mode: 'shop', 
        items: items,
        turns: 3,     // 默认3轮对话后送达
        imgUrl: items[0].img // 用第一张图做封面
    };

    // 4. 动态导入并发送消息
    const { createAiPackageMessage } = await import('./chat-ui.js');
    await createAiPackageMessage(chatId, packageData);

    // 5. 【核心】物理清空购物车缓存
    localStorage.removeItem('my_shop_cart');
    
    // 6. 如果用户正开着购物车页面，实时刷新一下让它变空
    if (window.renderMyShopCart) window.renderMyShopCart();
    
    // 7. 给个系统提示
    if (typeof showDynamicIsland === 'function') {
        showDynamicIsland('Ta帮你清空了购物车！', 'success');
    }
}
