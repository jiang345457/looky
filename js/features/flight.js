import { tempState, db, AppState } from '../state.js';
import { showDynamicIsland } from '../ui.js';
import { addSystemEventMessage } from './chat-service.js';

/**
 * 激活飞行状态 (点击取票后调用)
 * @param {object} ticketData - 机票数据
 */
export function activateFlightState(ticketData) {
    const chatId = tempState.currentChatId;
    if (!chatId) return;

    if (!tempState.activeFlights) {
        tempState.activeFlights = {};
    }

tempState.activeFlights[chatId] = {
        ...ticketData,
        status: 'waiting', // 状态：候机中
        turnsPassed: 0,    // 【新增】初始化已过轮数为0
        timestamp: Date.now()
    };
    localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
    // 尝试更新显示
    updateFlightCapsuleDisplay();
}
/**
 * 激活高铁状态 (点击高铁取票后调用)
 */
export function activateTrainState(ticketData) {
    const chatId = tempState.currentChatId;
    if (!chatId) return;
    if (!tempState.activeTrains) {
        tempState.activeTrains = {};
    }
    tempState.activeTrains[chatId] = {
        ...ticketData,
        status: 'waiting', // 状态：候车中
        turnsPassed: 0,
        timestamp: Date.now()
    };
    localStorage.setItem('active_trains_state', JSON.stringify(tempState.activeTrains));
    updateTrainCapsuleDisplay();
}
/**
 * 辅助函数：安全设置文本
 * 防止因为 HTML 元素不存在而导致的报错
 */
function safeSetText(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = text;
    } 
    // 如果找不到元素，什么也不做，不再报错
}

/**
 * 【核心修复】防御性更新函数
 */
export function updateFlightCapsuleDisplay() {
    const capsule = document.getElementById('flight-status-capsule');
    
    // 1. 如果连最外层容器都找不到，直接退出（防止报错）
    if (!capsule) return;

    const currentId = tempState.currentChatId;
    const flightData = tempState.activeFlights ? tempState.activeFlights[currentId] : null;

    // 2. 如果没有数据或不是候机状态，隐藏容器
    if (!currentId || !flightData || flightData.status !== 'waiting') {
        capsule.style.display = 'none';
        return;
    }

    // 3. 显示容器
    capsule.style.display = 'flex';
    
    // 4. 安全地填充数据 (使用 helper 函数，找不到元素也不会报错)
    // 主票根部分
    const remainingTurns = (flightData.maxTurns || 20) - (flightData.turnsPassed || 0);
    safeSetText('flight-capsule-time', `${remainingTurns}轮后起飞`);
    safeSetText('flight-capsule-time', flightData.time || '15:30');
    safeSetText('flight-capsule-to-city', flightData.toCity || '美国纽约');
    safeSetText('flight-capsule-gate', flightData.gate || '01');
    safeSetText('flight-capsule-flight-s', flightData.flight || 'NL5213');
    safeSetText('flight-capsule-class', flightData.class || 'Z');
    safeSetText('flight-capsule-name', flightData.passenger || 'User');
    safeSetText('flight-capsule-seat', flightData.passengerSeat || '10A');
    safeSetText('flight-capsule-date', flightData.date || '13JU');

    // 存根部分
    safeSetText('stub-flight', flightData.flight || 'NL5213');
    safeSetText('stub-seat', flightData.passengerSeat || '10A');
    safeSetText('stub-dest', flightData.toCity || '美国纽约');
    safeSetText('stub-name', flightData.passenger || 'User');
}
/**
 * 更新高铁票显示
 */
export function updateTrainCapsuleDisplay() {
    const capsule = document.getElementById('train-status-capsule');
    if (!capsule) return;
    const currentId = tempState.currentChatId;
    const trainData = tempState.activeTrains ? tempState.activeTrains[currentId] : null;
    // 如果没有数据或不是候车状态，隐藏
    if (!currentId || !trainData || trainData.status !== 'waiting') {
        capsule.style.display = 'none';
        return;
    }
    capsule.style.display = 'flex';
    
    // 填充数据
    safeSetText('train-capsule-time', trainData.time || '09:00');
    safeSetText('train-capsule-to-city', trainData.toCity || '上海');
    safeSetText('train-capsule-gate', '12B'); // 模拟检票口
    safeSetText('train-capsule-no', trainData.trainNo || 'G1024');
    safeSetText('train-capsule-seat-type', trainData.seatName || '二等座');
    safeSetText('train-capsule-name', trainData.passenger || 'User');
    safeSetText('train-capsule-seat-no', trainData.seatNo || '08A');
    safeSetText('train-capsule-date', trainData.date || 'Today');
    safeSetText('train-capsule-station', (trainData.fromCity || '北京') + '站');
    // 存根
    safeSetText('train-stub-no', trainData.trainNo);
    safeSetText('train-stub-seat', trainData.seatNo);
    safeSetText('train-stub-dest', trainData.toCity);
    
    // 更新检票按钮文字：显示剩余轮数
    const btn = document.getElementById('train-capsule-board-btn');
    const remaining = (trainData.maxTurns || 20) - (trainData.turnsPassed || 0);
    if(btn) btn.textContent = `检票 (${remaining}轮)`;
}
/**
 * 处理登机点击事件
 */
async function handleBoarding() {
    const chatId = tempState.currentChatId;
    if (!chatId || !tempState.activeFlights[chatId]) return;

    const flight = tempState.activeFlights[chatId];

   if(!confirm(`确认在 [${flight.fromCity}] 登机前往 [${flight.toCity}] 吗？`)) return;
    // 1. 修改状态为飞行中，并重置剩余轮数(复用maxTurns)
    flight.status = 'flying';
  flight.remaining = flight.flightTurns || 15;

    
    // 2. 保存并更新
    localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
    updateFlightCapsuleDisplay(); // 这会隐藏登机牌(因为状态不是waiting了)
    await addSystemEventMessage(chatId, `用户已登机航班 ${flight.flight}，正在前往 ${flight.toCity}。`, 'info');
    showDynamicIsland(`欢迎登机！正在飞往 ${flight.toCity}...`, 'success');
}

// flight.js

/**
 * 初始化系统
 */
export function initFlightSystem() {
    try {
        const saved = localStorage.getItem('active_flights_state');
        if (saved) {
            tempState.activeFlights = JSON.parse(saved);
            console.log('✈️ 恢复航班数据:', tempState.activeFlights);
        }
    } catch (e) {
        console.error('航班数据恢复失败', e);
    }

    const boardBtn = document.getElementById('flight-capsule-board-btn');
    if (boardBtn) {
        // 防止重复绑定
        const newBtn = boardBtn.cloneNode(true);
        boardBtn.parentNode.replaceChild(newBtn, boardBtn);
        newBtn.addEventListener('click', handleBoarding);
    }
    // 【修改开始】绑定取消按钮的逻辑
    const cancelBtn = document.getElementById('flight-cancel-btn'); // ★ 改了这里，去掉 capsule 中间词
    if (cancelBtn) {
        // 防止重复绑定

        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        
        newCancelBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止点穿
            
            const chatId = tempState.currentChatId;
            if (chatId && tempState.activeFlights && tempState.activeFlights[chatId]) {
                if(confirm('确定要取消本次航班行程吗？')) {
                    // 1. 删除数据
                    delete tempState.activeFlights[chatId];
                    localStorage.setItem('active_flights_state', JSON.stringify(tempState.activeFlights));
                    
                    // 2. 隐藏胶囊
                    updateFlightCapsuleDisplay();
                    
                    // 3. 提示用户
                    showDynamicIsland('航班行程已取消', 'info');
                }
            }
        });
    }
   // --- 高铁检票按钮 ---
    const trainBoardBtn = document.getElementById('train-capsule-board-btn');
    if (trainBoardBtn) {
        const newBtn = trainBoardBtn.cloneNode(true);
        trainBoardBtn.parentNode.replaceChild(newBtn, trainBoardBtn);
        newBtn.addEventListener('click', async () => {
            const chatId = tempState.currentChatId;
            if (!chatId || !tempState.activeTrains[chatId]) return;
            const train = tempState.activeTrains[chatId];
            if(!confirm(`确认检票进站 G${train.trainNo} 吗？`)) return;
            // 变为“旅途中”状态
            train.status = 'transit'; 
            // 复用 activeRides 的逻辑来显示顶部小胶囊，或者创建新的逻辑
            // 这里为了简单，我们让它直接变成“行程进行中”的逻辑
            if (!tempState.activeRides) tempState.activeRides = {};
            tempState.activeRides[chatId] = {
                destination: train.toCity,
                 fromCity: train.fromCity,
                carInfo: `高铁 · ${train.trainNo}`,
                isMeet: train.isMeet,
                isShared: train.isShared, 
                mode: 'turn',
                remaining: train.durationTurns || 15,
                total: train.durationTurns || 15,
                status: 'transit'
            };
            
            // 清理高铁候车状态
            delete tempState.activeTrains[chatId];
            
            // 保存
            localStorage.setItem('active_trains_state', JSON.stringify(tempState.activeTrains));
            localStorage.setItem('active_rides_state', JSON.stringify(tempState.activeRides));
            
            updateTrainCapsuleDisplay(); // 隐藏票
            
            // 提示
            await addSystemEventMessage(chatId, `用户已检票乘坐 ${train.trainNo} 前往 ${train.toCity}。`, 'info');
            showDynamicIsland(`检票成功！列车正在驶向 ${train.toCity}`, 'success');
        });
    }
    // --- 高铁取消按钮 ---
    const trainCancelBtn = document.getElementById('train-cancel-btn');
    if (trainCancelBtn) {
        const newCancelBtn = trainCancelBtn.cloneNode(true);
        trainCancelBtn.parentNode.replaceChild(newCancelBtn, trainCancelBtn);
        newCancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const chatId = tempState.currentChatId;
            if (chatId && tempState.activeTrains && tempState.activeTrains[chatId]) {
                if(confirm('确定要退票取消行程吗？')) {
                    delete tempState.activeTrains[chatId];
                    localStorage.setItem('active_trains_state', JSON.stringify(tempState.activeTrains));
                    updateTrainCapsuleDisplay();
                    showDynamicIsland('高铁票已退订', 'info');
                }
            }
        });
    }
}

// --- 仅用于控制台调试 ---
window.activateFlightState = activateFlightState;
window.updateFlightCapsuleDisplay = updateFlightCapsuleDisplay;
window.handleBoarding = handleBoarding; // 将内部函数也暴露出来
window.activateTrainState = activateTrainState;
window.updateTrainCapsuleDisplay = updateTrainCapsuleDisplay;