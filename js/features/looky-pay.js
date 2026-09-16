import { showDynamicIsland, showPage } from '../ui.js';
import { escapeHTML } from '../utils.js';
import { AppState, tempState, db, DEFAULT_AVATAR_SRC } from '../state.js';

const LP_TX_STORAGE_KEY = 'lp_transactions';
const LP_LEDGER_EVENT = 'looky:ledger-updated';
const LP_BALANCE_EVENT = 'looky:balance-updated';
const LP_VAULT_EVENT = 'looky:vault-updated';
const LP_LEDGER_INITIAL_RENDER_LIMIT = 20;
const LP_LEDGER_RENDER_STEP = 40;
const LP_BANK_STATE_KEY = 'looky_pay_bank_state';
const LP_LEGACY_LEDGER_MIGRATED_KEY = 'lp_legacy_ledger_migrated_v1';
const LP_LEGACY_SHOP_MIGRATED_KEY = 'lp_legacy_shop_orders_migrated_v1';
const LP_VIRTUAL_NOTICE_SEEN_KEY = 'lp_virtual_notice_seen_v1';
const DEFAULT_BANK_STATE = {
    walletBalance: 1314,
    cards: [],
    sceneDefaults: {},
    biometricEnabled: false,
    paymentAuthMode: 'password',
    balancePwd: '',
    bankOpenedOnce: false,
    migratedFromLocalStorage: false
};
let bankStateCache = JSON.parse(JSON.stringify(DEFAULT_BANK_STATE));
let bankStateReadyPromise = null;

function cloneBankState(state = bankStateCache) {
    return {
        ...DEFAULT_BANK_STATE,
        ...state,
        sceneDefaults: { ...(state.sceneDefaults || {}) },
        cards: Array.isArray(state.cards) ? state.cards.map(card => ({ ...card })) : []
    };
}

async function saveBankState() {
    await db.appData.put({ key: LP_BANK_STATE_KEY, value: cloneBankState() });
}

async function ensureBankStateReady() {
    if (bankStateReadyPromise) return bankStateReadyPromise;
    bankStateReadyPromise = (async () => {
        const record = await db.appData.get(LP_BANK_STATE_KEY);
        if (record?.value) {
            bankStateCache = cloneBankState(record.value);
            if (record.value.bankOpenedOnce === undefined && (hasBalancePassword() || bankStateCache.cards.length > 0)) {
                bankStateCache.bankOpenedOnce = true;
                await saveBankState();
            }
            return bankStateCache;
        }

        const migrated = cloneBankState();
        migrated.walletBalance = parseLookyMoney(localStorage.getItem('lp_wallet_balance') || DEFAULT_BANK_STATE.walletBalance);
        try {
            const cards = JSON.parse(localStorage.getItem('lp_custom_cards') || '[]');
            migrated.cards = Array.isArray(cards) ? cards : [];
        } catch (e) {
            migrated.cards = [];
        }
        try {
            const defaults = JSON.parse(localStorage.getItem('lp_scene_payment_defaults') || '{}');
            migrated.sceneDefaults = defaults && typeof defaults === 'object' ? defaults : {};
        } catch (e) {
            migrated.sceneDefaults = {};
        }
        migrated.biometricEnabled = localStorage.getItem('lp_biometric_enabled') === 'true';
        migrated.migratedFromLocalStorage = true;
        bankStateCache = migrated;
        await saveBankState();
        return bankStateCache;
    })();
    return bankStateReadyPromise;
}

function readLegacyLookyLedger() {
    try {
        const data = JSON.parse(localStorage.getItem(LP_TX_STORAGE_KEY) || '[]');
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('读取 Looky 账单失败，已使用空列表兜底', e);
        return [];
    }
}

function normalizeLedgerAmount(amount) {
    const num = parseFloat(String(amount).replace(/[^\d.-]/g, ''));
    return Number.isFinite(num) ? Math.abs(num) : 0;
}

function parseLookyMoney(value) {
    const num = parseFloat(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(num) ? num : 0;
}

function formatLookyMoney(value) {
    return parseLookyMoney(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showLookyModal(modal) {
    if (!modal) return;
    modal.classList.add('visible');
    modal.style.display = 'flex';
    modal.style.opacity = '1';
}

function hideLookyModal(modal) {
    if (!modal) return;
    modal.classList.remove('visible');
    modal.style.opacity = '0';
    modal.style.display = 'none';
}

function readLookyCards() {
    return bankStateCache.cards.map(card => ({ ...card }));
}

function saveLookyCards(cards) {
    bankStateCache.cards = Array.isArray(cards) ? cards.map(card => ({ ...card })) : [];
    saveBankState().catch(e => console.error('保存 Looky 卡片失败', e));
}

function getLookyWalletBalance() {
    return parseLookyMoney(bankStateCache.walletBalance);
}

function setLookyWalletBalance(amount) {
    bankStateCache.walletBalance = parseLookyMoney(amount);
    saveBankState().catch(e => console.error('保存 Looky 余额失败', e));
}

export async function creditLookyWallet(amount) {
    await ensureBankStateReady();
    const addAmount = normalizeLedgerAmount(amount);
    if (!addAmount) return getLookyWalletBalance();
    const nextBalance = getLookyWalletBalance() + addAmount;
    setLookyWalletBalance(nextBalance);
    window.dispatchEvent(new CustomEvent(LP_BALANCE_EVENT, { detail: { type: 'wallet_income', amount: addAmount } }));
    return nextBalance;
}

function readSceneDefaults() {
    return { ...(bankStateCache.sceneDefaults || {}) };
}

function saveSceneDefaults(defaults) {
    bankStateCache.sceneDefaults = defaults && typeof defaults === 'object' ? { ...defaults } : {};
    saveBankState().catch(e => console.error('保存 Looky 场景支付设置失败', e));
}

function isBiometricEnabled() {
    return bankStateCache.biometricEnabled === true;
}

function setBiometricEnabled(enabled) {
    bankStateCache.biometricEnabled = enabled === true;
    saveBankState().catch(e => console.error('保存 Looky 指纹设置失败', e));
}

function getPaymentAuthMode() {
    return bankStateCache.paymentAuthMode === 'fingerprint' && isBiometricEnabled() ? 'fingerprint' : 'password';
}

function setPaymentAuthMode(mode) {
    bankStateCache.paymentAuthMode = mode === 'fingerprint' && isBiometricEnabled() ? 'fingerprint' : 'password';
    saveBankState().catch(e => console.error('保存 Looky 支付验证方式失败', e));
}

function hasBalancePassword() {
    return /^\d{6}$/.test(String(bankStateCache.balancePwd || ''));
}

function hasOpenedBankOnce() {
    return bankStateCache.bankOpenedOnce === true;
}

function markBankOpenedOnce() {
    if (hasOpenedBankOnce()) return;
    bankStateCache.bankOpenedOnce = true;
    saveBankState().catch(e => console.error('[LookyPay] failed to save bank open state', e));
}

function setBalancePassword(pwd) {
    bankStateCache.balancePwd = String(pwd || '');
    saveBankState().catch(e => console.error('保存 Looky 余额密码失败', e));
}

function formatVaultPaymentCardId(vaultCharId) {
    return `vault:${String(vaultCharId)}`;
}

function parsePaymentMethodForCharge(paymentInfo = {}) {
    const rawCardId = String(paymentInfo.paymentCardId || '');
    if (paymentInfo.type === 'vault' || rawCardId.startsWith('vault:')) {
        const vaultCharId = String(paymentInfo.id || rawCardId.replace(/^vault:/, ''));
        return { type: 'vault', id: vaultCharId };
    }
    if (paymentInfo.type === 'card' || rawCardId.startsWith('card:')) {
        return {
            type: 'card',
            id: String(paymentInfo.id || rawCardId.replace(/^card:/, ''))
        };
    }
    if (paymentInfo.type === 'balance' || rawCardId === 'balance' || !rawCardId) {
        return { type: 'balance', id: 'balance' };
    }
    return {
        type: 'card',
        id: String(paymentInfo.id || rawCardId)
    };
}

async function getUnlockedVaultPaymentMethods(options = {}) {
    const includeEmpty = options.includeEmpty === true;
    const chars = AppState.characterProfiles.filter(char => !char.isGroup);
    const results = await Promise.all(chars.map(async (char) => {
        const vault = await getLookyVault(char.id);
        if (!vault || vault.status !== 'unlocked') return null;
        const balance = parseLookyMoney(vault.balance);
        if (!includeEmpty && balance <= 0) return null;
        return {
            type: 'vault',
            id: String(char.id),
            label: `情侣金库 - ${char.chatOverrideName || char.name || '角色'} (¥${formatLookyMoney(balance)})`,
            amount: balance,
            pwd: '',
            vaultCharId: String(char.id),
            vaultCharName: char.chatOverrideName || char.name || '角色'
        };
    }));
    return results.filter(Boolean);
}

export async function getLookyReceiveTargets(preferredCharId = '') {
    const walletBalance = getLookyWalletBalance();
    const vaultTargets = await getUnlockedVaultPaymentMethods({ includeEmpty: true });
    const targets = [
        {
            type: 'balance',
            id: 'balance',
            value: 'balance',
            title: '零钱',
            desc: `钱包余额 ¥${formatLookyMoney(walletBalance)}`,
            icon: '¥'
        },
        ...vaultTargets.map(method => ({
            type: 'vault',
            id: method.vaultCharId || method.id,
            value: formatVaultPaymentCardId(method.vaultCharId || method.id),
            title: `${method.vaultCharName} 的情侣金库`,
            desc: `金库余额 ¥${formatLookyMoney(method.amount)}`,
            icon: '♡'
        }))
    ];
    if (!preferredCharId) return targets;
    const preferredValue = formatVaultPaymentCardId(preferredCharId);
    const preferredIndex = targets.findIndex(target => target.value === preferredValue);
    if (preferredIndex <= 1) return targets;
    const [preferred] = targets.splice(preferredIndex, 1);
    targets.splice(1, 0, preferred);
    return targets;
}

export async function receiveLookyTransferFunds(options = {}) {
    const amount = normalizeLedgerAmount(options.amount);
    if (!amount) throw new Error('转账金额无效');
    const targetValue = String(options.targetValue || 'balance');
    const sourceId = options.sourceId || `${Date.now()}`;
    const payerName = options.payerName || '对方';
    const chatId = options.chatId || 'global';
    const remark = options.remark || '';

    if (targetValue.startsWith('vault:')) {
        const vaultCharId = targetValue.replace(/^vault:/, '');
        await depositToLookyVault(vaultCharId, amount, {
            source: 'transfer_accept_to_vault',
            sourceId,
            memo: remark || `来自 ${payerName} 的转账`
        });
        return { type: 'vault', id: vaultCharId, paymentCardId: targetValue };
    }

    await creditLookyWallet(amount);
    await recordLookyLedger({
        source: 'transfer_accept',
        sourceId,
        type: 'income',
        amount,
        category: '转账',
        title: `收转账 - ${payerName}`,
        memo: remark,
        char: chatId,
        paymentCardId: 'balance',
        timestamp: Date.now(),
        isAuto: true
    });
    return { type: 'balance', id: 'balance', paymentCardId: 'balance' };
}

function getPaymentMethodsBase(scene = 'general') {
    const cards = readLookyCards();
    const walletBalance = getLookyWalletBalance();
    const methods = [
        {
            type: 'balance',
            id: 'balance',
            label: `钱包余额 (¥${formatLookyMoney(walletBalance)})`,
            amount: walletBalance,
            pwd: ''
        },
        ...cards.map(card => ({
            type: 'card',
            id: String(card.id),
            label: `${card.bankName || '数字卡片'} (尾号${card.last4 || '0000'}) - ¥${formatLookyMoney(card.balanceStr)}`,
            amount: parseLookyMoney(card.balanceStr),
            pwd: String(card.pwd || '')
        }))
    ];
    const defaults = readSceneDefaults();
    const defaultMethod = defaults[scene];
    if (!defaultMethod) return methods;
    const index = methods.findIndex(m => m.type === defaultMethod.type && String(m.id) === String(defaultMethod.id));
    if (index <= 0) return methods;
    const [matched] = methods.splice(index, 1);
    return [matched, ...methods];
}

async function getPaymentMethods(scene = 'general') {
    const methods = [...getPaymentMethodsBase(scene)];
    const vaultMethods = await getUnlockedVaultPaymentMethods();
    methods.push(...vaultMethods);
    const defaults = readSceneDefaults();
    const defaultMethod = defaults[scene];
    if (!defaultMethod) return methods;
    const index = methods.findIndex(m => m.type === defaultMethod.type && String(m.id) === String(defaultMethod.id));
    if (index <= 0) return methods;
    const [matched] = methods.splice(index, 1);
    return [matched, ...methods];
}

function updateLookyMethodBalance(method, amount) {
    const payAmount = normalizeLedgerAmount(amount);
    if (!payAmount) return;

    if (method.type === 'balance') {
        const walletBalance = getLookyWalletBalance();
        if (walletBalance < payAmount) throw new Error('钱包余额不足');
        setLookyWalletBalance(walletBalance - payAmount);
    } else {
        const cards = readLookyCards();
        const card = cards.find(c => String(c.id) === String(method.id));
        if (!card) throw new Error('没有找到这张卡片');
        const cardBalance = parseLookyMoney(card.balanceStr);
        if (cardBalance < payAmount) throw new Error('卡片余额不足');
        card.balanceStr = formatLookyMoney(cardBalance - payAmount);
        saveLookyCards(cards);
    }

    window.dispatchEvent(new CustomEvent(LP_BALANCE_EVENT, { detail: { method, amount: payAmount } }));
}

export async function chargeLookyPaymentMethod(paymentInfo = {}, amount) {
    await ensureBankStateReady();
    const method = parsePaymentMethodForCharge(paymentInfo);
    if (method.type === 'vault') {
        await spendLookyVault(method.id, amount, {
            source: 'vault_payment',
            reason: paymentInfo.reason || '虚拟支付',
            insertChatContext: true
        });
        return;
    }
    updateLookyMethodBalance(method, amount);
}

export async function requestLookyPayment(options = {}) {
    await ensureBankStateReady();
    const amount = normalizeLedgerAmount(options.amount);
    const title = options.title || '虚拟付款';
      const scene = options.scene || 'general';
    const shouldCharge = options.charge !== false;

    return new Promise(async (resolve) => {
        const modal = document.getElementById('lp-payment-modal');
        const methodSelect = document.getElementById('lp-payment-method');
        const authSwitch = document.getElementById('lp-payment-auth-switch');
        const passwordBlock = document.getElementById('lp-payment-password-block');
        const passwordInput = document.getElementById('lp-payment-password');
        const noPasswordBtn = document.getElementById('lp-payment-no-password');
        const vaultFreepayBtn = document.getElementById('lp-payment-vault-freepay');
        const titleEl = document.getElementById('lp-payment-title');
        const amountEl = document.getElementById('lp-payment-amount');
        const confirmBtn = document.getElementById('lp-payment-confirm');
        const fingerprintBtn = document.getElementById('lp-payment-fingerprint');
        const cancelBtns = [
            document.getElementById('lp-payment-cancel'),
            document.getElementById('lp-payment-cancel-2')
        ].filter(Boolean);

        if (!amount || !modal || !methodSelect || !passwordInput || !confirmBtn) {
            resolve(null);
            return;
        }

        if (modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
        modal.style.position = 'fixed';
        modal.style.zIndex = '30000';
        const methods = await getPaymentMethods(scene);
        methodSelect.innerHTML = methods.map(method => `<option value="${method.type}:${method.id}">${escapeHTML(method.label)}</option>`).join('');
        if (titleEl) titleEl.textContent = title;
        if (amountEl) amountEl.textContent = formatLookyMoney(amount);
        passwordInput.value = '';
        let authMode = getPaymentAuthMode();
        let selectedMethodType = methods[0]?.type || 'balance';
        let selectedMethodId = methods[0]?.id || 'balance';
        const canUseNoPassword = () => selectedMethodType === 'balance' && String(selectedMethodId) === 'balance' && !hasOpenedBankOnce() && !hasBalancePassword();
        const applyAuthMode = (mode, shouldSave = false) => {
            authMode = mode === 'fingerprint' && isBiometricEnabled() ? 'fingerprint' : 'password';
            if (shouldSave) setPaymentAuthMode(authMode);
            if (authSwitch) {
                authSwitch.style.display = canUseNoPassword() ? 'none' : (isBiometricEnabled() ? 'flex' : 'none');
                authSwitch.querySelectorAll('button[data-auth-mode]').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.authMode === authMode);
                });
            }
            const isVault = selectedMethodType === 'vault';
            const isNoPassword = canUseNoPassword();
            if (passwordBlock) passwordBlock.style.display = (isVault || isNoPassword) ? 'none' : (authMode === 'password' ? 'block' : 'none');
            if (noPasswordBtn) noPasswordBtn.style.display = isNoPassword ? 'flex' : 'none';
            if (vaultFreepayBtn) vaultFreepayBtn.style.display = isVault ? 'flex' : 'none';
            if (confirmBtn) confirmBtn.style.display = (isVault || isNoPassword) ? 'none' : (authMode === 'password' ? '' : 'none');
            if (fingerprintBtn) fingerprintBtn.style.display = (isVault || isNoPassword) ? 'none' : (authMode === 'fingerprint' ? 'flex' : 'none');
        };
        applyAuthMode(authMode);
        methodSelect.onchange = () => {
            const selectedValue = methodSelect.value;
            const selectedMethod = methods.find(m => `${m.type}:${m.id}` === selectedValue);
            selectedMethodType = selectedMethod?.type || 'balance';
            selectedMethodId = selectedMethod?.id || 'balance';
            if (selectedMethodType === 'vault') {
                if (authSwitch) authSwitch.style.display = 'none';
                if (passwordBlock) passwordBlock.style.display = 'none';
                if (noPasswordBtn) noPasswordBtn.style.display = 'none';
                if (fingerprintBtn) fingerprintBtn.style.display = 'none';
                if (vaultFreepayBtn) vaultFreepayBtn.style.display = 'flex';
                if (confirmBtn) confirmBtn.style.display = 'none';
            } else {
                applyAuthMode(authMode);
            }
        };
        if (fingerprintBtn) {
            fingerprintBtn.classList.remove('holding');
            const fingerprintText = fingerprintBtn.querySelector('.lp-fingerprint-text');
            if (fingerprintText) fingerprintText.textContent = '长按识别指纹验证';
        }
        showLookyModal(modal);
        setTimeout(() => {
            if (authMode === 'password' && !canUseNoPassword()) passwordInput.focus();
        }, 50);

        let fingerprintTimer = null;
        let fingerprintDone = false;
        const finishPayment = async (method) => {
            if (shouldCharge) {
                try {
                    if (method.type === 'vault') {
                        const vaultCharId = method.vaultCharId || method.id;
                        const vault = await getLookyVault(vaultCharId);
                        if (!vault || vault.status !== 'unlocked') throw new Error('情侣金库未开启');
                        if (parseLookyMoney(vault.balance) < amount) throw new Error('情侣金库余额不足');
                        await spendLookyVault(vaultCharId, amount, { source: 'vault_payment', reason: title, insertChatContext: true });
                    } else {
                        updateLookyMethodBalance(method, amount);
                    }
                } catch (e) {
                    alert(e.message || '虚拟付款失败，请稍后再试。');
                    return false;
                }
            }
            cleanup({
                ...method,
                amount,
                charged: shouldCharge,
                displayName: method.label,
                paymentCardId: method.type === 'vault' ? formatVaultPaymentCardId(method.vaultCharId || method.id) : (method.type === 'card' ? method.id : 'balance')
            });
            return true;
        };
        const getSelectedMethod = () => {
            const selectedValue = methodSelect.value;
            return methods.find(m => `${m.type}:${m.id}` === selectedValue);
        };
        const clearFingerprintTimer = () => {
            clearTimeout(fingerprintTimer);
            fingerprintTimer = null;
            if (fingerprintBtn && !fingerprintDone) {
                fingerprintBtn.classList.remove('holding');
                const fingerprintText = fingerprintBtn.querySelector('.lp-fingerprint-text');
                if (fingerprintText) fingerprintText.textContent = '长按识别指纹验证';
            }
        };
        const cleanup = (result = null) => {
            hideLookyModal(modal);
            clearFingerprintTimer();
            methodSelect.onchange = null;
            confirmBtn.onclick = null;
            if (noPasswordBtn) noPasswordBtn.onclick = null;
            if (authSwitch) authSwitch.querySelectorAll('button[data-auth-mode]').forEach(btn => { btn.onclick = null; });
            if (vaultFreepayBtn) vaultFreepayBtn.onclick = null;
            if (fingerprintBtn) {
                fingerprintBtn.onpointerdown = null;
                fingerprintBtn.onpointerup = null;
                fingerprintBtn.onpointerleave = null;
                fingerprintBtn.onpointercancel = null;
            }
            cancelBtns.forEach(btn => { btn.onclick = null; });
            resolve(result);
        };

        cancelBtns.forEach(btn => {
            btn.onclick = () => cleanup(null);
        });

        if (authSwitch) {
            authSwitch.querySelectorAll('button[data-auth-mode]').forEach(btn => {
                btn.onclick = () => applyAuthMode(btn.dataset.authMode, true);
            });
        }

        if (noPasswordBtn) {
            noPasswordBtn.onclick = async () => {
                const method = getSelectedMethod();
                if (!method || method.type !== 'balance' || !canUseNoPassword()) return;
                await finishPayment(method);
            };
        }

        confirmBtn.onclick = () => {
            const method = getSelectedMethod();
            if (method?.type === 'vault') return;
            const password = passwordInput.value.trim();
            const passwordMatched = method?.type === 'balance'
                ? String(bankStateCache.balancePwd || '') === password
                : String(method?.pwd || '') === password;

            if (!method) {
                alert('请选择虚拟支付方式。');
                return;
            }
            if (!/^\d{6}$/.test(password)) {
                alert('请输入6位虚拟支付密码。');
                return;
            }
            if (!passwordMatched) {
                alert(method.type === 'balance' ? '虚拟余额支付密码不正确。' : '虚拟卡片支付密码不正确。');
                return;
            }
            finishPayment(method);
        };

        if (fingerprintBtn) {
            fingerprintBtn.onpointerdown = (e) => {
                if (!isBiometricEnabled()) return;
                e.preventDefault();
                const method = getSelectedMethod();
                if (!method) {
                    alert('请选择虚拟支付方式。');
                    return;
                }
                fingerprintDone = false;
                fingerprintBtn.classList.add('holding');
                const fingerprintText = fingerprintBtn.querySelector('.lp-fingerprint-text');
                if (fingerprintText) fingerprintText.textContent = '验证中...请继续按住';
                clearTimeout(fingerprintTimer);
                fingerprintTimer = setTimeout(() => {
                    fingerprintDone = true;
                    if (fingerprintText) fingerprintText.textContent = '验证通过';
                    finishPayment(method);
                }, 850);
            };
            fingerprintBtn.onpointerup = clearFingerprintTimer;
            fingerprintBtn.onpointerleave = clearFingerprintTimer;
            fingerprintBtn.onpointercancel = clearFingerprintTimer;
        }
        if (vaultFreepayBtn) {
            vaultFreepayBtn.onclick = async () => {
                const method = getSelectedMethod();
                if (!method || method.type !== 'vault') return;
                await finishPayment(method);
            };
        }
    });
}

const CHARACTER_PHONE_WALLET_PREFIX = 'virtual_phone_wallet_';
const CHARACTER_PHONE_WALLET_LEGACY_PREFIX = 'virtual_phone_wallet_state_';
const DEFAULT_CHARACTER_PHONE_CARD_BALANCES = [3000, 2000];

function getCharacterPhoneWalletKey(charId) {
    return `${CHARACTER_PHONE_WALLET_PREFIX}${charId}`;
}

function getLegacyCharacterPhoneWalletKey(charId) {
    return `${CHARACTER_PHONE_WALLET_LEGACY_PREFIX}${charId}`;
}

function normalizeCharacterPhoneCard(card = {}, index = 0) {
    const balance = parseLookyMoney(card.balance ?? card.balanceStr ?? card.availableBalance ?? 0);
    return {
        id: String(card.id || `character-card-${index + 1}`),
        bankName: card.bankName || card.name || `角色银行卡 ${index + 1}`,
        last4: String(card.last4 || String(1001 + index).slice(-4)),
        balance
    };
}

function getCharacterPhoneCardBalance(records = []) {
    const total = (Array.isArray(records) ? records : []).reduce((sum, day) => {
        const dayTotal = (Array.isArray(day?.records) ? day.records : []).reduce(
            (daySum, record) => daySum + parseLookyMoney(record?.amount),
            0
        );
        return sum + dayTotal;
    }, 0);
    return Math.max(0, Number(total.toFixed(2)));
}

export async function ensureCharacterPhoneWallet(charId, walletData = null) {
    const key = getCharacterPhoneWalletKey(charId);
    const saved = await db.appData.get(key);
    const legacy = await db.appData.get(getLegacyCharacterPhoneWalletKey(charId));
    const savedValue = saved?.value && (!saved.value.charId || String(saved.value.charId) === String(charId))
        ? saved.value
        : null;
    const legacyValue = legacy?.value && (!legacy.value.charId || String(legacy.value.charId) === String(charId))
        ? legacy.value
        : null;

    const baseWallet = walletData && typeof walletData === 'object'
        ? { ...walletData }
        : { ...(savedValue || legacyValue || {}) };
    const hasSavedLedger = wallet => wallet && (wallet.summary || Array.isArray(wallet.card1) || Array.isArray(wallet.card2));
    const canReuseSavedCards = wallet => hasSavedLedger(wallet)
        && Array.isArray(wallet?.cards)
        && wallet.cards.length
        && (!walletData || wallet.phoneWalletSource !== 'default' || wallet.phoneWalletHasUserTransaction);
    const existingCards = canReuseSavedCards(savedValue)
        ? savedValue.cards
        : (canReuseSavedCards(legacyValue) ? legacyValue.cards : null);
    const income = parseLookyMoney(baseWallet?.summary?.income || 0);
    const expense = parseLookyMoney(baseWallet?.summary?.expense || 0);
    const derivedBalance = Math.max(0, income - expense);
    const sourceCards = existingCards
        ? existingCards.map(card => ({ ...card }))
        : (Array.isArray(baseWallet?.cards) && baseWallet.cards.length
            ? baseWallet.cards.map(card => ({ ...card }))
            : [
                { id: 'card1', bankName: '日常账户', last4: '0001', balance: getCharacterPhoneCardBalance(baseWallet?.card1) },
                { id: 'card2', bankName: '储蓄账户', last4: '0002', balance: getCharacterPhoneCardBalance(baseWallet?.card2) }
            ]);
    const hadPersistedCardState = existingCards && existingCards.length > 0
        && (savedValue?.phoneWalletInitialized === true || legacyValue?.phoneWalletInitialized === true);
    if (!hadPersistedCardState && !sourceCards.some(card => parseLookyMoney(card?.balance) > 0) && derivedBalance > 0) {
        sourceCards[0].balance = derivedBalance;
    }
    if (!hadPersistedCardState && !sourceCards.some(card => parseLookyMoney(card?.balance) > 0)) {
        sourceCards.forEach((card, index) => {
            card.balance = DEFAULT_CHARACTER_PHONE_CARD_BALANCES[index] ?? 0;
        });
        baseWallet.summary = {
            ...(baseWallet.summary || {}),
            expense: baseWallet.summary?.expense || '0.00',
            income: baseWallet.summary?.income || String(DEFAULT_CHARACTER_PHONE_CARD_BALANCES.reduce((sum, amount) => sum + amount, 0).toFixed(2))
        };
        baseWallet.phoneWalletSource = 'default';
    }
    const state = {
        ...baseWallet,
        charId: String(charId),
        cards: sourceCards.map((card, index) => normalizeCharacterPhoneCard(card, index)),
        phoneWalletSource: baseWallet.phoneWalletSource || (walletData ? 'generated' : 'saved'),
        phoneWalletInitialized: true,
        updatedAt: Date.now()
    };
    await db.appData.put({ key, value: state });
    await db.appData.put({ key: getLegacyCharacterPhoneWalletKey(charId), value: state });
    return state;
}

export async function requestCharacterPhonePayment(charId, options = {}) {
    const amount = parseLookyMoney(options.amount);
    if (!amount) return null;
    const walletRecord = await db.appData.get(`virtual_phone_wallet_${charId}`);
    const state = await ensureCharacterPhoneWallet(charId, walletRecord?.value || null);
    const overlay = document.createElement('div');
    overlay.className = 'cp-character-payment-overlay';
    overlay.innerHTML = `
        <div class="cp-character-payment-card" role="dialog" aria-modal="true">
            <div class="cp-character-payment-head">
                <div><span>CHARACTER PAYMENT</span><strong>${escapeHTML(options.title || '角色账户付款')}</strong></div>
                <button type="button" data-action="cancel" aria-label="关闭">×</button>
            </div>
            <div class="cp-character-payment-amount">¥${formatLookyMoney(amount)}</div>
            <p class="cp-character-payment-hint">请选择角色要扣款的银行卡</p>
            <div class="cp-character-payment-list">
                ${state.cards.map((card, index) => `
                    <button type="button" class="cp-character-payment-option ${index === 0 ? 'active' : ''}" data-card-id="${escapeHTML(card.id)}">
                        <span><strong>${escapeHTML(card.bankName)}</strong><small>尾号 ${escapeHTML(card.last4)}</small></span>
                        <b>¥${formatLookyMoney(card.balance)}</b>
                    </button>
                `).join('')}
            </div>
            <p class="cp-character-payment-error" data-role="error"></p>
            <button type="button" class="cp-character-payment-confirm" data-action="confirm">确认扣款</button>
        </div>
    `;
    document.body.appendChild(overlay);

    return new Promise(resolve => {
        const cleanup = (result = null) => {
            overlay.remove();
            resolve(result);
        };
        const errorEl = overlay.querySelector('[data-role="error"]');
        const getSelectedCard = () => {
            const id = overlay.querySelector('.cp-character-payment-option.active')?.dataset.cardId;
            return state.cards.find(card => String(card.id) === String(id));
        };
        overlay.querySelectorAll('.cp-character-payment-option').forEach(option => {
            option.addEventListener('click', () => {
                overlay.querySelectorAll('.cp-character-payment-option').forEach(item => item.classList.remove('active'));
                option.classList.add('active');
                if (errorEl) errorEl.textContent = '';
            });
        });
        overlay.addEventListener('click', async event => {
            if (event.target === overlay || event.target.closest('[data-action="cancel"]')) {
                cleanup();
                return;
            }
            if (!event.target.closest('[data-action="confirm"]')) return;
            const card = getSelectedCard();
            if (!card) return;
            if (card.balance < amount) {
                if (errorEl) errorEl.textContent = '这张卡余额不足，请选择其他银行卡';
                return;
            }
            card.balance = Number((card.balance - amount).toFixed(2));
            state.updatedAt = Date.now();
            state.phoneWalletHasUserTransaction = true;
            state.phoneWalletSource = 'user';
            await db.appData.put({ key: getCharacterPhoneWalletKey(charId), value: state });
            await db.appData.put({ key: getLegacyCharacterPhoneWalletKey(charId), value: state });
            cleanup({ type: 'card', id: card.id, paymentCardId: card.id, displayName: `${card.bankName} (尾号${card.last4})` });
        });
    });
}

function bindBalancePasswordSetup() {
    const modal = document.getElementById('lp-balance-password-modal');
    const firstInput = document.getElementById('lp-balance-password-new');
    const repeatInput = document.getElementById('lp-balance-password-repeat');
    const saveBtn = document.getElementById('lp-balance-password-save');
    if (!modal || !firstInput || !repeatInput || !saveBtn || saveBtn.dataset.bound === 'true') return;
    saveBtn.dataset.bound = 'true';
    saveBtn.addEventListener('click', () => {
        const pwd = firstInput.value.trim();
        const repeat = repeatInput.value.trim();
        if (!/^\d{6}$/.test(pwd)) {
            alert('请设置6位数字虚拟余额支付密码。');
            return;
        }
        if (pwd !== repeat) {
            alert('两次输入的密码不一致。');
            return;
        }
        setBalancePassword(pwd);
        hideLookyModal(modal);
        showDynamicIsland('虚拟余额支付密码已设置', 'success');
    });
}

function showBalancePasswordSetupIfNeeded() {
    bindBalancePasswordSetup();
    if (hasBalancePassword()) return;
    markBankOpenedOnce();
    const modal = document.getElementById('lp-balance-password-modal');
    const firstInput = document.getElementById('lp-balance-password-new');
    const repeatInput = document.getElementById('lp-balance-password-repeat');
    if (!modal) return;
    if (firstInput) firstInput.value = '';
    if (repeatInput) repeatInput.value = '';
    showLookyModal(modal);
    setTimeout(() => firstInput?.focus(), 50);
}

function ensureBalancePasswordOnBankPage() {
    const pageLookyPay = document.getElementById('page-looky-pay');
    if (!pageLookyPay || pageLookyPay.style.display === 'none') return;
    if (hasBalancePassword()) return;
    showBalancePasswordSetupIfNeeded();
}

export async function recordLookyLedger(record, options = {}) {
    const amount = normalizeLedgerAmount(record?.amount);
    if (!amount) return null;

    const source = record.source || 'manual';
    const sourceId = record.sourceId || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const tx = {
        id: record.id || `${source}_${sourceId}`,
        type: record.type === 'income' ? 'income' : 'expense',
        amount,
        category: record.category || '其它',
        title: record.title || record.category || '账单记录',
        memo: record.memo || '',
        char: record.char || record.charId || 'global',
        paymentMethod: record.paymentMethod || '',
        paymentCardId: record.paymentCardId || '',
        source,
        sourceId,
        timestamp: record.timestamp ? Number(record.timestamp) : Date.now(),
        isAuto: record.isAuto !== false
    };

    try {
        await db.lookyLedger.put(tx);
    } catch (e) {
        console.error('保存 Looky 账单失败', e);
        return null;
    }

    if (!options.silent) {
        window.dispatchEvent(new CustomEvent(LP_LEDGER_EVENT, { detail: tx }));
    }
    return tx;
}

async function readLookyLedger() {
    try {
        return await db.lookyLedger.orderBy('timestamp').reverse().toArray();
    } catch (e) {
        console.error('读取 Looky 账单失败', e);
        return [];
    }
}

function makeDefaultVault(charId) {
    return {
        charId: String(charId),
        status: 'locked',
        balance: 0,
        openedAt: null,
        updatedAt: Date.now(),
        inviteDirection: '',
        lastInviteAt: 0
    };
}

export async function getLookyVault(charId) {
    if (!charId) return null;
    const key = String(charId);
    const saved = await db.lookyVaults.get(key);
    return saved ? { ...makeDefaultVault(key), ...saved, balance: parseLookyMoney(saved.balance) } : makeDefaultVault(key);
}

async function saveLookyVault(vault) {
    const nextVault = {
        ...makeDefaultVault(vault.charId),
        ...vault,
        charId: String(vault.charId),
        balance: parseLookyMoney(vault.balance),
        updatedAt: Date.now()
    };
    await db.lookyVaults.put(nextVault);
    window.dispatchEvent(new CustomEvent(LP_VAULT_EVENT, { detail: nextVault }));
    return nextVault;
}

async function saveLookyVaultWithLog(vault, log) {
    const nextVault = {
        ...makeDefaultVault(vault.charId),
        ...vault,
        charId: String(vault.charId),
        balance: parseLookyMoney(vault.balance),
        updatedAt: Date.now()
    };
    await db.transaction('rw', db.lookyVaults, db.lookyVaultLogs, async () => {
        await db.lookyVaults.put(nextVault);
        await db.lookyVaultLogs.add({
            charId: String(nextVault.charId),
            sourceId: '',
            memo: '',
            timestamp: Date.now(),
            ...log
        });
    });
    window.dispatchEvent(new CustomEvent(LP_VAULT_EVENT, { detail: { ...nextVault, ledgerUpdated: true } }));
    return nextVault;
}

export async function openLookyVault(charId, inviteDirection = 'user_accept') {
    if (!charId) return null;
    const vault = await getLookyVault(charId);
    const opened = await saveLookyVault({
        ...vault,
        status: 'unlocked',
        openedAt: vault.openedAt || Date.now(),
        inviteDirection
    });
    await db.lookyVaultLogs.add({
        charId: String(charId),
        type: 'open',
        amount: 0,
        source: inviteDirection,
        timestamp: Date.now()
    });
    return opened;
}

export async function markLookyVaultInvited(charId, inviteDirection = 'user_to_ai') {
    if (!charId) return null;
    const vault = await getLookyVault(charId);
    return saveLookyVault({
        ...vault,
        inviteDirection,
        lastInviteAt: Date.now()
    });
}

export async function depositToLookyVault(charId, amount, options = {}) {
    if (!charId) throw new Error('没有选中角色');
    const depositAmount = normalizeLedgerAmount(amount);
    if (!depositAmount) throw new Error('请输入有效金额');

    const vault = await getLookyVault(charId);
    if (vault.status !== 'unlocked') throw new Error('这个小金库还没有开启');

    const nextVault = await saveLookyVaultWithLog({
        ...vault,
        balance: parseLookyMoney(vault.balance) + depositAmount
    }, {
        charId: String(charId),
        type: 'deposit',
        amount: depositAmount,
        source: options.source || 'manual',
        sourceId: options.sourceId || '',
        memo: options.memo || '',
        timestamp: Date.now()
    });

    return nextVault;
}

export async function spendLookyVault(charId, amount, options = {}) {
    if (!charId) throw new Error('没有选中角色');
    const spendAmount = normalizeLedgerAmount(amount);
    if (!spendAmount) throw new Error('请输入有效金额');
    const vault = await getLookyVault(charId);
    if (vault.status !== 'unlocked') throw new Error('这个小金库还没有开启');
    if (parseLookyMoney(vault.balance) < spendAmount) throw new Error('小金库余额不足');

    const nextVault = await saveLookyVaultWithLog({
        ...vault,
        balance: parseLookyMoney(vault.balance) - spendAmount
    }, {
        charId: String(charId),
        type: 'spend',
        amount: spendAmount,
        source: options.source || 'vault_spend',
        sourceId: options.sourceId || '',
        memo: options.memo || options.reason || '',
        timestamp: Date.now()
    });

    if (options.insertChatContext !== false) {
        const reason = options.reason ? `，用途是${options.reason}` : '';
        await db.chatMessages.add({
            chatId: String(charId),
            timestamp: new Date(),
            text: `[系统隐式提示] 用户刚刚使用你们的共同小金库支出了 ¥${formatLookyMoney(spendAmount)}${reason}。你只需要知道这是一笔共同资金支出，不要追问具体花给了谁，也不要说得太细。`,
            type: 'system',
            contentType: 'system_event',
            eventType: 'info',
            uiVisible: false,
            aiVisible: true,
            recalled: false
        });
    }

    return nextVault;
}

async function readBondStats(charId) {
    if (!charId) return { userSpent: 0, charSpent: 0 };
    const rows = await db.lookyLedger.where('char').equals(String(charId)).toArray();
    return rows.reduce((acc, item) => {
        if (item.source && String(item.source).startsWith('vault_')) return acc;
        if (item.category === '金库') return acc;
        const amount = normalizeLedgerAmount(item.amount);
        if (item.type === 'income') acc.charSpent += amount;
        else acc.userSpent += amount;
        return acc;
    }, { userSpent: 0, charSpent: 0 });
}

async function migrateLegacyLookyLedgerToDb() {
    if (localStorage.getItem(LP_LEGACY_LEDGER_MIGRATED_KEY) === 'true') return;
    const oldTxs = readLegacyLookyLedger();
    if (!oldTxs.length) {
        localStorage.setItem(LP_LEGACY_LEDGER_MIGRATED_KEY, 'true');
        return;
    }

    for (const tx of oldTxs) {
        await recordLookyLedger({
            ...tx,
            source: tx.source || 'legacy_lp_transactions',
            sourceId: tx.sourceId || tx.id || `${tx.timestamp}_${tx.amount}_${tx.title || tx.category || ''}`,
            isAuto: tx.isAuto !== false
        }, { silent: true });
    }
    localStorage.setItem(LP_LEGACY_LEDGER_MIGRATED_KEY, 'true');
}

async function migrateLegacyShopOrdersToLedger() {
    if (localStorage.getItem(LP_LEGACY_SHOP_MIGRATED_KEY) === 'true') return;
    const orders = JSON.parse(localStorage.getItem('my_shop_orders') || '[]');
    if (!Array.isArray(orders) || orders.length === 0) {
        localStorage.setItem(LP_LEGACY_SHOP_MIGRATED_KEY, 'true');
        return;
    }

    for (const order of orders) {
        if (order.ledgerSynced) continue;
        const total = order.total ?? order.price;
        const firstItem = Array.isArray(order.items) ? order.items[0] : null;
        await recordLookyLedger({
            source: 'legacy_shop_order',
            sourceId: order.id || `${order.shopName || 'shop'}_${order.total || order.price || ''}`,
            type: 'expense',
            amount: total,
            category: '购物',
            title: firstItem?.title || order.title || order.shopName || '购物订单',
            memo: '历史订单同步',
            char: 'global',
            timestamp: order.time || order.id || Date.now(),
            isAuto: true
        }, { silent: true });
        order.ledgerSynced = true;
    }
    localStorage.setItem('my_shop_orders', JSON.stringify(orders));
    localStorage.setItem(LP_LEGACY_SHOP_MIGRATED_KEY, 'true');
}

export const LookyPay = {
    async init() {
        await ensureBankStateReady();
        const lookyPayIcon = document.getElementById('looky-pay-icon');
        const pageLookyPay = document.getElementById('page-looky-pay');
        if (!pageLookyPay) return;
        if (pageLookyPay.dataset.lookyPayInitialized === 'true') return;
        pageLookyPay.dataset.lookyPayInitialized = 'true';
        bindBalancePasswordSetup();
        window.addEventListener('looky:page-opened', ensureBalancePasswordOnBankPage);
        
        const faceMask = document.getElementById('lp-face-id-mask');
        const virtualNoticeModal = document.getElementById('lp-virtual-notice-modal');
        const virtualNoticeConfirm = document.getElementById('lp-virtual-notice-confirm');
        const navItems = document.querySelectorAll('.lp-nav-item');
        const tabViews = document.querySelectorAll('.lp-tab-view');
        const btnRecharge = document.getElementById('lp-btn-recharge');
        const btnTransferOut = document.getElementById('lp-btn-transfer-out');
        const balanceDisplay = document.getElementById('lp-total-balance');
        const transferOutModal = document.getElementById('lp-transfer-out-modal');
        const transferOutAmount = document.getElementById('lp-transfer-out-amount');
        const transferOutTarget = document.getElementById('lp-transfer-out-target');
        const transferOutCancel = document.getElementById('lp-transfer-out-cancel');
        const transferOutConfirm = document.getElementById('lp-transfer-out-confirm');
        const walletPreviewAmount = document.getElementById('lp-wallet-preview-amount');
        const cardPreviewAmount = document.getElementById('lp-card-preview-amount');
        const walletPreviewBar = document.getElementById('lp-wallet-preview-bar');
              /* ▼▼▼ 新增获取：记账元素 ▼▼▼ */
        const recordFab = document.getElementById('lp-fab-record');
        const recordModal = document.getElementById('lp-record-modal');
        const txListContainer = document.getElementById('lp-tx-list-container');
        // 去掉了已删除的 recordCharSelect
        const filterBtns = document.querySelectorAll('.lp-filter-btn');
        const cardPreviewBar = document.getElementById('lp-card-preview-bar');
        const vaultCharScroll = pageLookyPay.querySelector('.lp-vault-char-scroll');
        const vaultFundCard = pageLookyPay.querySelector('.lp-vault-fund-card');
        const vaultQuickBtns = pageLookyPay.querySelectorAll('.vault-action-btn');
        const vaultBondStats = pageLookyPay.querySelector('.lp-vault-bond-stats');
        const vaultTxListContainer = document.getElementById('lp-vault-tx-list-container');
        const vaultLedgerModeBtns = pageLookyPay.querySelectorAll('[data-vault-ledger-mode]');
        let activeVaultCharId = null;
        
        // ▼▼▼ 新增：日历与视图模式变量 ▼▼▼
        let currentLedgerDate = new Date(); 
        let currentViewMode = 'day'; // 默认看当天，避免账单页一打开就渲染整月大量记录
        let isCalendarOpen = false;
        let ledgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
        let vaultLedgerMode = 'day';
        let vaultLedgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;

        const showVirtualNoticeOnce = () => {
            if (!virtualNoticeModal || localStorage.getItem(LP_VIRTUAL_NOTICE_SEEN_KEY) === 'true') return;
            showLookyModal(virtualNoticeModal);
            setTimeout(() => virtualNoticeConfirm?.focus(), 30);
        };
        virtualNoticeConfirm?.addEventListener('click', () => {
            localStorage.setItem(LP_VIRTUAL_NOTICE_SEEN_KEY, 'true');
            hideLookyModal(virtualNoticeModal);
        });
        virtualNoticeModal?.addEventListener('click', (e) => {
            if (e.target !== virtualNoticeModal) return;
            localStorage.setItem(LP_VIRTUAL_NOTICE_SEEN_KEY, 'true');
            hideLookyModal(virtualNoticeModal);
        });
        window.addEventListener('looky:page-opened', (event) => {
            if (event.detail?.pageId !== 'page-looky-pay') return;
            setTimeout(showVirtualNoticeOnce, 80);
        });

        const getVaultCharacters = () => AppState.characterProfiles.filter(char => !char.isGroup);
        const getCharDisplayName = (char) => char?.chatOverrideName || char?.name || '角色';
        const getCharAvatar = (char) => {
            const src = char?.chatOverrideAvatar || char?.avatar || DEFAULT_AVATAR_SRC;
            return src || DEFAULT_AVATAR_SRC;
        };

        async function renderVaultCharStrip() {
            if (!vaultCharScroll) return;
            const chars = getVaultCharacters();
            if (!chars.length) {
                vaultCharScroll.innerHTML = '<div class="lp-vault-empty">先创建一个角色，才可以开启专属金库</div>';
                activeVaultCharId = null;
                await renderVaultPanel();
                return;
            }
            if (!activeVaultCharId || !chars.some(char => String(char.id) === String(activeVaultCharId))) {
                activeVaultCharId = String(chars[0].id);
            }
            vaultCharScroll.innerHTML = chars.map(char => `
                <button class="vault-char-item ${String(char.id) === String(activeVaultCharId) ? 'active' : ''}" data-char-id="${escapeHTML(String(char.id))}" type="button">
                    <img src="${escapeHTML(getCharAvatar(char))}" alt="">
                    <span>${escapeHTML(getCharDisplayName(char))}</span>
                </button>
            `).join('');
        }

        function showVaultAmountInput(title, confirmText = '确认') {
            return new Promise(resolve => {
                const modal = document.createElement('div');
                modal.className = 'lp-vault-amount-modal';
                modal.innerHTML = `
                    <div class="lp-vault-amount-card">
                        <div class="lp-vault-amount-title">${escapeHTML(title)}</div>
                        <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="输入金额">
                        <div class="lp-vault-amount-actions">
                            <button type="button" class="secondary">取消</button>
                            <button type="button" class="primary">${escapeHTML(confirmText)}</button>
                        </div>
                    </div>
                `;
                pageLookyPay.appendChild(modal);
                const input = modal.querySelector('input');
                const close = (value = null) => {
                    modal.remove();
                    resolve(value);
                };
                modal.querySelector('.secondary').onclick = () => close(null);
                modal.addEventListener('click', e => { if (e.target === modal) close(null); });
                modal.querySelector('.primary').onclick = () => {
                    const amount = normalizeLedgerAmount(input.value);
                    if (!amount) {
                        alert('请输入有效金额。');
                        return;
                    }
                    close(amount);
                };
                setTimeout(() => input.focus(), 30);
            });
        }

        function fillChatInput(text) {
            const input = document.getElementById('chat-input-field');
            if (!input) return false;
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            return true;
        }

        async function goChatWithVaultDraft(text) {
            if (!activeVaultCharId) return;
            const { handleFriendClick } = await import('./chat.js');
            await handleFriendClick(activeVaultCharId);
            setTimeout(() => {
                fillChatInput(text);
                showDynamicIsland('已放入聊天输入框，点发送后才会发给 Ta', 'success');
            }, 180);
        }

        async function appendVaultChatCard(messageData, successText) {
            if (!activeVaultCharId) return;
            const { handleFriendClick } = await import('./chat.js');
            const { createAndAppendMessage, getCurrentChatIdentity } = await import('./chat-ui.js');
            await handleFriendClick(activeVaultCharId);
            setTimeout(async () => {
                const currentUser = getCurrentChatIdentity(activeVaultCharId);
                const messageId = await db.chatMessages.add({
                    chatId: String(activeVaultCharId),
                    timestamp: new Date(),
                    type: 'sent',
                    avatarSrc: currentUser?.avatar,
                    recalled: false,
                    replyToMessageId: null,
                    aiVisible: true,
                    ...messageData
                });
                const newMessage = await db.chatMessages.get(messageId);
                await createAndAppendMessage(newMessage);
                if (successText) showDynamicIsland(successText, 'success');
            }, 180);
        }

        async function sendVaultInviteCard() {
            if (!activeVaultCharId) return;
            await markLookyVaultInvited(activeVaultCharId, 'user_to_ai');
            await appendVaultChatCard({
                text: '我想和你开启共同小金库。这个基金只属于我们两个人，你愿意一起开启吗？',
                contentType: 'joint_fund_invite',
                inviteStatus: 'pending'
            }, '小金库邀请卡片已发送');
        }

        async function sendVaultTransferToChat(amount) {
            if (!activeVaultCharId) return;
            const vault = await getLookyVault(activeVaultCharId);
            if (vault.status !== 'unlocked') {
                showDynamicIsland('请先邀请 Ta 开启小金库', 'warning');
                return;
            }
            if (parseLookyMoney(vault.balance) < amount) {
                alert('小金库余额不足。');
                return;
            }
            const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
            await appendVaultChatCard({
                text: `[转账] ${amount.toFixed(2)}元`,
                contentType: 'transfer',
                transferInfo: {
                    amount: amount.toFixed(2),
                    remark: '来自共同小金库',
                    status: 'pending',
                    targetId: String(activeVaultCharId),
                    targetName: getCharDisplayName(char),
                    sourceFund: 'vault'
                },
                vaultCardInfo: {
                    amount: amount.toFixed(2),
                    targetName: getCharDisplayName(char),
                    sourceFund: 'vault'
                }
            }, '已发送金库转账卡片');
        }

        async function sendVaultRequestCard() {
            if (!activeVaultCharId) return;
            const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
            await appendVaultChatCard({
                text: '我想把这笔钱存入我们的共同小金库，收到后请优先放进共同金库。',
                contentType: 'vault_request_card',
                vaultCardInfo: {
                    targetName: getCharDisplayName(char),
                    depositTarget: 'vault'
                }
            }, '已发送金库收款卡片');
        }

        async function renderVaultPanel() {
            if (!vaultFundCard) return;
            const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
            if (!char) {
                vaultFundCard.innerHTML = '<div class="lp-vault-empty-card">请选择一个角色</div>';
                if (vaultBondStats) vaultBondStats.style.display = 'none';
                return;
            }

            const vault = await getLookyVault(activeVaultCharId);
            const isUnlocked = vault.status === 'unlocked';
            if (!isUnlocked) {
                vaultFundCard.classList.add('is-locked');
                vaultFundCard.innerHTML = `
                    <div class="fund-header">
                        <span class="title">Love Fund / 未解锁</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                    </div>
                    <div class="lp-vault-locked-body">
                        <strong>还没有和 ${escapeHTML(getCharDisplayName(char))} 开启共同小金库</strong>
                        <p>邀请发送后会先放进聊天输入框，仍然由你手动点击发送。</p>
                    </div>
                    <div class="fund-actions">
                        <button class="fund-btn-invite" type="button">邀请Ta开启</button>
                    </div>
                `;
                if (vaultBondStats) vaultBondStats.style.display = 'none';
                return;
            }
            vaultFundCard.classList.remove('is-locked');
            vaultFundCard.innerHTML = `
                <div class="fund-header">
                    <span class="title">Love Fund / ${escapeHTML(getCharDisplayName(char))}</span>
                 
                    <button class="fund-btn-unbind" style="background: transparent; border: none; color: #E28F8F; font-size: 11px; cursor: pointer; padding: 4px 8px; border-radius: 12px; border: 1px solid rgba(226,143,143,0.3);">解绑金库</button>

                </div>
                <h1 class="fund-amount">¥ <span>${formatLookyMoney(vault.balance)}</span></h1>
                <div class="fund-actions">
                    <button class="fund-btn-deposit" type="button">存入金库</button>
                </div>
            `;
            if (vaultBondStats) {
                vaultBondStats.style.display = '';
                const stats = await readBondStats(activeVaultCharId);
                const total = stats.userSpent + stats.charSpent;
                const userPct = total > 0 ? Math.round((stats.userSpent / total) * 100) : 50;
                const charPct = 100 - userPct;
                const leftStrong = vaultBondStats.querySelector('.info-left strong');
                const rightStrong = vaultBondStats.querySelector('.info-right strong');
                const leftBar = vaultBondStats.querySelector('.compare-fill-left');
                const rightBar = vaultBondStats.querySelector('.compare-fill-right');
                if (leftStrong) leftStrong.textContent = `¥ ${formatLookyMoney(stats.userSpent)}`;
                if (rightStrong) rightStrong.textContent = `¥ ${formatLookyMoney(stats.charSpent)}`;
                if (leftBar) leftBar.style.width = `${userPct}%`;
                if (rightBar) rightBar.style.width = `${charPct}%`;
            }
        }

        function formatVaultLedgerTime(ts) {
            const d = new Date(ts);
            return `${d.getMonth() + 1}-${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }

        const getVaultLedgerSvg = (type) => {
            if (type === 'deposit') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"></path><polyline points="5 12 12 5 19 12"></polyline></svg>';
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"></path><polyline points="19 12 12 19 5 12"></polyline></svg>';
        };

        async function renderVaultLedgerList() {
            if (!vaultTxListContainer) return;
            const charId = String(activeVaultCharId || '');
            if (!charId) {
                vaultTxListContainer.innerHTML = '<div style="text-align:center;color:#999;padding:20px;font-size:13px;">请选择一个角色</div>';
                return;
            }
            const vault = await getLookyVault(charId);
            const mode = vaultLedgerMode === 'month' ? 'month' : 'day';
            const logs = (await db.lookyVaultLogs.where('charId').equals(String(charId)).toArray())
                .filter(item => item.type === 'deposit' || item.type === 'spend');
            const activeDate = currentLedgerDate || new Date();
            const filtered = logs.filter(item => {
                const d = new Date(item.timestamp);
                if (mode === 'month') {
                    return d.getFullYear() === activeDate.getFullYear() && d.getMonth() === activeDate.getMonth();
                }
                return d.getFullYear() === activeDate.getFullYear() && d.getMonth() === activeDate.getMonth() && d.getDate() === activeDate.getDate();
            }).sort((a, b) => b.timestamp - a.timestamp);

            const depositTotal = filtered.filter(item => item.type === 'deposit').reduce((sum, item) => sum + parseLookyMoney(item.amount), 0);
            const spendTotal = filtered.filter(item => item.type === 'spend').reduce((sum, item) => sum + parseLookyMoney(item.amount), 0);
            const visibleLogs = filtered.slice(0, vaultLedgerExpandedLimit);
            const hiddenCount = filtered.length - visibleLogs.length;

            const titleLabel = document.getElementById('lp-vault-ledger-date-label');
            if (titleLabel) {
                if (mode === 'month') {
                    titleLabel.innerHTML = `${activeDate.getMonth() + 1}月金库 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Monthly</small>`;
                } else {
                    titleLabel.innerHTML = `${activeDate.getMonth() + 1}月${activeDate.getDate()}日金库 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Daily</small>`;
                }
            }
            const expenseEl = document.getElementById('lp-vault-ledger-expense');
            const incomeEl = document.getElementById('lp-vault-ledger-income');
            const depositBar = document.getElementById('lp-vault-bar-deposit');
            const spendBar = document.getElementById('lp-vault-bar-spend');
            if (expenseEl) expenseEl.textContent = formatLookyMoney(spendTotal);
            if (incomeEl) incomeEl.textContent = `+${formatLookyMoney(depositTotal)}`;
            const total = depositTotal + spendTotal;
            if (depositBar) depositBar.style.width = total > 0 ? `${Math.max((depositTotal / total) * 100, depositTotal > 0 ? 8 : 0)}%` : '0%';
            if (spendBar) spendBar.style.width = total > 0 ? `${Math.max((spendTotal / total) * 100, spendTotal > 0 ? 8 : 0)}%` : '0%';

            if (!filtered.length) {
                vaultTxListContainer.innerHTML = '<div style="text-align:center;color:#999;padding:20px;font-size:13px;">暂无记录</div>';
                return;
            }

            const listHtml = visibleLogs.map(item => {
                const isDeposit = item.type === 'deposit';
                const amountText = isDeposit ? `+${formatLookyMoney(item.amount)}` : `-${formatLookyMoney(item.amount)}`;
                const amountClass = isDeposit ? 'plus' : 'minus';
                const title = isDeposit ? '金库存入' : '金库支出';
                return `
                    <div class="lp-tx-item-crypto">
                        <div class="tx-left">
                            <div class="tx-icon">${getVaultLedgerSvg(item.type)}</div>
                            <div class="tx-info">
                                <span class="title">${escapeHTML(title)}</span>
                                <span class="time">${formatVaultLedgerTime(item.timestamp)} ${item.memo ? `<span style="opacity:0.6;">/ ${escapeHTML(item.memo)}</span>` : ''}</span>
                            </div>
                        </div>
                        <div class="tx-right">
                            <span class="tx-amount ${amountClass}">${amountText}</span>
                        </div>
                    </div>`;
            }).join('');

            const actionHtml = hiddenCount > 0
                ? `<button type="button" class="lp-ledger-more-btn" data-vault-action="more">展开更多 ${Math.min(LP_LEDGER_RENDER_STEP, hiddenCount)} 条</button>`
                : (filtered.length > LP_LEDGER_INITIAL_RENDER_LIMIT ? '<button type="button" class="lp-ledger-more-btn secondary" data-vault-action="collapse">收起旧记录</button>' : '');
            vaultTxListContainer.innerHTML = listHtml + actionHtml;
        }

        async function refreshVaultView() {
            await renderVaultCharStrip();
            await renderVaultPanel();
            vaultLedgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
            await renderVaultLedgerList();
        }

        function renderLpCalendar() {
            const grid = document.getElementById('lp-cal-days-grid');
            const monthDisplay = document.getElementById('lp-cal-month-display');
            if (!grid || !monthDisplay) return;
            
            const year = currentLedgerDate.getFullYear();
            const month = currentLedgerDate.getMonth();
            monthDisplay.textContent = `${year}年${month + 1}月`;
            
            grid.innerHTML = '';
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const today = new Date();
            
            for(let i=0; i<firstDay; i++) {
                grid.innerHTML += `<div></div>`;
            }
            for(let i=1; i<=daysInMonth; i++) {
                const isSelected = currentViewMode === 'day' && i === currentLedgerDate.getDate() && month === currentLedgerDate.getMonth() && year === currentLedgerDate.getFullYear();
                const isToday = i === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                
                const style = isSelected ? 'background:#111; color:#fff; border-radius:8px;' : (isToday ? 'color:#111; text-decoration: underline;' : 'color:#555;');
                
                const dayEl = document.createElement('div');
                dayEl.style.cssText = `padding: 6px 0; cursor: pointer; transition: 0.2s; ${style}`;
                dayEl.textContent = i;
                dayEl.onclick = (e) => {
                    e.stopPropagation();
                    currentLedgerDate = new Date(year, month, i);
                    currentViewMode = 'day'; // 切换到按天查看
                    ledgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                    renderLpCalendar();
                    document.getElementById('lp-calendar-modal').style.display = 'none';
                    isCalendarOpen = false;
                    
                    const activeFilter = document.querySelector('.lp-filter-btn.active');
                    renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                    const vaultView = document.getElementById('lp-view-vault');
                    if (vaultView?.classList.contains('active')) renderVaultLedgerList();
                };
                grid.appendChild(dayEl);
            }
        }
        // ▲▲▲ 新增结束 ▲▲▲

        let maskTimer1 = null;
        let maskTimer2 = null;
        let walletBalance = getLookyWalletBalance(); // 钱包可用余额
        const syncWalletBalance = () => {
            walletBalance = getLookyWalletBalance();
        };
        // 核心逻辑：总资产 = 钱包余额 + 所有卡片余额之和
        function refreshTotalAsset() {
            syncWalletBalance();
            const savedCards = readLookyCards();
            let cardsSum = 0;
            savedCards.forEach(c => {
                cardsSum += (parseFloat(String(c.balanceStr).replace(/,/g, '')) || 0);
            });
            let totalAsset = walletBalance + cardsSum;
            if (balanceDisplay) {
                balanceDisplay.innerText = totalAsset.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
           // 动态重写顶部的余额预览区域，让每一张卡的余额独立显示
            const previewContainer = document.getElementById('lp-balance-preview');
            if (previewContainer) {
                let html = '';
                // 1. 优先生成钱包可用余额
                const wPct = totalAsset > 0 ? Math.max((walletBalance / totalAsset) * 100, walletBalance > 0 ? 6 : 0) : 0;
                html += `
                <div class="lp-preview-item">
                  <div class="lp-preview-label">钱包可用</div>
                  <div class="lp-preview-bar"><span style="width: ${wPct}%; background: linear-gradient(90deg, #111, #5c5c5c);"></span></div>
                  <div class="lp-preview-amount">¥${walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                </div>`;
                // 2. 遍历单独显示每一张卡
                const barColors = [
                    'linear-gradient(90deg, #A5D2C1, #5B8C7A)',
                    'linear-gradient(90deg, #D0D4D7, #888888)',
                    'linear-gradient(90deg, #ff9a9e, #fecfef)',
                    'linear-gradient(90deg, #a18cd1, #fbc2eb)'
                ];
                savedCards.forEach((c, index) => {
                    const cAmt = parseFloat(String(c.balanceStr).replace(/,/g, '')) || 0;
                    const cPct = totalAsset > 0 ? Math.max((cAmt / totalAsset) * 100, cAmt > 0 ? 6 : 0) : 0;
                    const cColor = barColors[index % barColors.length]; // 循环分配不同的进度条颜色
                    
                    html += `
                    <div class="lp-preview-item">
                      <div class="lp-preview-label" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${c.bankName}">${c.bankName}</div>
                      <div class="lp-preview-bar"><span style="width: ${cPct}%; background: ${cColor};"></span></div>
                      <div class="lp-preview-amount">¥${cAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>`;
                });
                
                // 重新注入 HTML
                previewContainer.innerHTML = html;
            }
        }
        // 初始化时计算一次总资产
        refreshTotalAsset();
        const cardStack = document.getElementById('lp-card-stack');
        const assetList = pageLookyPay.querySelector('.lp-asset-list-modern');
        // 初始清空HTML里写死的预设卡片，替换为半透明空状态提示
        if (cardStack) {
            cardStack.innerHTML = `<div class="lp-empty-card" style="width: 100%; height: 180px; border-radius: 20px; border: 2px dashed rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; color: #999; font-size: 14px; font-weight: bold; background: rgba(0,0,0,0.02);">暂无虚拟卡片</div>`;
        }
        if (assetList) {
            assetList.innerHTML = `<div class="lp-empty-asset" style="text-align: center; padding: 20px; color: #999; font-size: 13px;">尚未添加任何卡片资产</div>`;
        }
        const themes = ['theme-mint', 'theme-silver', 'theme-black'];
        let themeIndex = 0; // 用于循环分配符合系统的色系
        let savedForTheme = readLookyCards();
        themeIndex = savedForTheme.length; // 根据已有卡片数量决定下一个颜色，避免刷新后又从绿色开始
        // 重新计算卡片层级
        function lpRestackCards() {
            if (!cardStack) return;
            const cards = Array.from(cardStack.querySelectorAll('.lp-bank-card'));
            
            // 如果有真实卡片，移除空状态提示
            const emptyHint = cardStack.querySelector('.lp-empty-card');
            if (cards.length > 0 && emptyHint) {
                emptyHint.remove();
            } else if (cards.length === 0 && !emptyHint) {
                cardStack.innerHTML = `<div class="lp-empty-card" style="width: 100%; height: 180px; border-radius: 20px; border: 2px dashed rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; color: #999; font-size: 14px; font-weight: bold; background: rgba(0,0,0,0.02);">暂无虚拟卡片</div>`;
            }
            const n = cards.length;
            cards.forEach((card, index) => {
                const fromTop = n - 1 - index; // 0 代表最顶层
                card.classList.remove('stack-card-1', 'stack-card-2', 'stack-card-3');
                if (fromTop === 0) { card.classList.add('stack-card-1'); card.style.opacity = '1'; card.style.zIndex = '3'; }
                else if (fromTop === 1) { card.classList.add('stack-card-2'); card.style.opacity = '1'; card.style.zIndex = '2'; }
                else if (fromTop === 2) { card.classList.add('stack-card-3'); card.style.opacity = '1'; card.style.zIndex = '1'; }
                else { card.classList.add('stack-card-3'); card.style.opacity = '0'; card.style.zIndex = '0'; } // 第4张及以后藏在最底层
            });
                    
            // 动态计算堆叠区的高度，避免卡片少时下方留白太大
            if (n <= 1) {
                cardStack.style.height = '180px'; // 0~1张卡，刚好是一张卡的高度
            } else if (n === 2) {
                cardStack.style.height = '210px'; // 2张卡，底部多漏出30px
            } else {
                cardStack.style.height = '240px'; // 3张卡及以上，底部多漏出60px
            }
        }
        function refreshRenderedCardBalances() {
            syncWalletBalance();
            const cards = readLookyCards();
            cards.forEach(card => {
                const balanceStr = formatLookyMoney(card.balanceStr);
                const assetEl = pageLookyPay.querySelector(`.lp-asset-item-modern[data-card-id="${card.id}"] .asset-amount`);
                const cardEl = pageLookyPay.querySelector(`.lp-bank-card[data-card-id="${card.id}"] .card-bottom strong`);
                if (assetEl) assetEl.innerText = balanceStr;
                if (cardEl) cardEl.innerText = `¥ ${balanceStr}`;
            });
            refreshTotalAsset();
        }
        window.addEventListener(LP_BALANCE_EVENT, refreshRenderedCardBalances);
        if (cardStack) {
            cardStack.addEventListener('click', () => {
                const cards = Array.from(cardStack.querySelectorAll('.lp-bank-card'));
                if (cards.length <= 1) return;
                // 把当前顶层卡片(最后一个)移到最前面(变成最底层)，实现循环切换
                cardStack.insertBefore(cards[cards.length - 1], cards[0]);
                lpRestackCards();
            });
        }
        // 辅助函数：更新钱包可用余额并刷新总资产
        function addWalletBalance(amount) {
            syncWalletBalance();
            walletBalance += amount;
            setLookyWalletBalance(walletBalance);
            refreshTotalAsset();
            window.dispatchEvent(new CustomEvent(LP_BALANCE_EVENT));
        }
        if (btnTransferOut) {
            btnTransferOut.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!transferOutModal) return;
                const savedCards = readLookyCards();
                if (!savedCards.length) {
                    alert('请先添加一张虚拟卡。');
                    return;
                }
                let optionsHtml = '';
                savedCards.forEach(c => {
                    const cardAmount = parseFloat(String(c.balanceStr).replace(/,/g, '')) || 0;
                    optionsHtml += `<option value="${c.id}">${c.bankName} (尾号${c.last4}) - ¥${cardAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</option>`;
                });
                if (transferOutTarget) transferOutTarget.innerHTML = optionsHtml;
                if (transferOutAmount) {
                    transferOutAmount.max = String(walletBalance);
                    transferOutAmount.value = walletBalance > 0 ? walletBalance.toFixed(2) : '';
                }
                showLookyModal(transferOutModal);
            });
        }
        if (transferOutCancel && transferOutModal) {
            transferOutCancel.addEventListener('click', () => {
                hideLookyModal(transferOutModal);
            });
        }
        if (transferOutConfirm && transferOutModal) {
            transferOutConfirm.addEventListener('click', () => {
                syncWalletBalance();
                const amt = parseFloat(transferOutAmount ? transferOutAmount.value : '');
                const targetCardId = transferOutTarget ? transferOutTarget.value : '';
                if (isNaN(amt) || amt <= 0) {
                    alert('请输入有效的转出金额。');
                    return;
                }
                if (amt > walletBalance) {
                    alert('转出金额不能超过钱包可用余额。');
                    return;
                }
                if (!targetCardId) {
                    alert('请选择要转入的卡片。');
                    return;
                }
                let sCards = readLookyCards();
                const targetCard = sCards.find(c => String(c.id) === String(targetCardId));
                if (!targetCard) {
                    alert('没有找到选中的卡片，请刷新页面后再试。');
                    return;
                }
                const oldBal = parseFloat(String(targetCard.balanceStr).replace(/,/g, '')) || 0;
                targetCard.balanceStr = (oldBal + amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                walletBalance -= amt;
                setLookyWalletBalance(walletBalance);
                saveLookyCards(sCards);
                hideLookyModal(transferOutModal);
                const assetEl = pageLookyPay.querySelector(`.lp-asset-item-modern[data-card-id="${targetCardId}"] .asset-amount`);
                if (assetEl) assetEl.innerText = targetCard.balanceStr;
                refreshTotalAsset();
                window.dispatchEvent(new CustomEvent(LP_BALANCE_EVENT));
                if (typeof showDynamicIsland === 'function') {
                    showDynamicIsland(`已转出 ¥${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 'success');
                }
            });
        }
        // 1. 点击桌面图标进入应用
        if (lookyPayIcon) {
            lookyPayIcon.addEventListener('click', (e) => {
                if (typeof showPage === 'function') showPage('page-looky-pay');
                requestAnimationFrame(() => {
                    ensureBalancePasswordOnBankPage();
                });
                // 每次进入强制启动 FaceID 动画
                if (faceMask) {
                    // 清理残留计时器
                    clearTimeout(maskTimer1);
                    clearTimeout(maskTimer2);

                    if (isBiometricEnabled()) {
                        faceMask.style.display = 'flex';
                        faceMask.style.opacity = '1';
                        
                        maskTimer1 = setTimeout(() => {
                            faceMask.style.opacity = '0';
                            maskTimer2 = setTimeout(() => faceMask.style.display = 'none', 400);
                        }, 1200);
                    } else {
                        faceMask.style.display = 'none';
                        faceMask.style.opacity = '0';
                    }
                }
            });
        }

        // 2. 底部 Tab 切换逻辑
        navItems.forEach(btn => {
            btn.addEventListener('click', () => {
                navItems.forEach(n => n.classList.remove('active'));
                tabViews.forEach(v => v.classList.remove('active'));
                
                btn.classList.add('active');
                const targetId = btn.getAttribute('data-target');
                const targetView = document.getElementById(targetId);
                if (targetView) targetView.classList.add('active');
                if (targetId === 'lp-view-ledger') {
                    const activeFilter = document.querySelector('.lp-filter-btn.active');
                    renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                } else if (targetId === 'lp-view-vault') {
                    refreshVaultView();
                } else if (txListContainer) {
                    txListContainer.innerHTML = '';
                }
            });
        });

        if (vaultCharScroll && !vaultCharScroll.dataset.bound) {
            vaultCharScroll.dataset.bound = 'true';
            vaultCharScroll.addEventListener('click', async (e) => {
                const item = e.target.closest('.vault-char-item[data-char-id]');
                if (!item) return;
                activeVaultCharId = item.dataset.charId;
                await refreshVaultView();
            });
        }
        if (vaultFundCard && !vaultFundCard.dataset.bound) {
            vaultFundCard.dataset.bound = 'true';
            vaultFundCard.addEventListener('click', async (e) => {
                // ▼▼▼ 新增：处理点击“解绑金库”的逻辑 ▼▼▼
                if (e.target.closest('.fund-btn-unbind')) {
                    if (!activeVaultCharId) return;
                    if (confirm('确定要解绑共同小金库吗？解绑后资金将全部清零（相当于各自拿回剩余资金）。此操作不可逆！')) {
                        const vault = await getLookyVault(activeVaultCharId);
                        const refundAmount = parseLookyMoney(vault.balance);
                        const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
                        // 清零资金，锁回金库
                        await db.lookyVaults.put({
                            ...vault,
                            status: 'locked',
                            balance: 0, 
                            inviteDirection: '',
                            updatedAt: Date.now()
                        });
                        if (refundAmount > 0) {
                            await creditLookyWallet(refundAmount);
                            await recordLookyLedger({
                                source: 'vault_unbind_refund',
                                sourceId: `${activeVaultCharId}_${Date.now()}`,
                                type: 'income',
                                amount: refundAmount,
                                category: '金库',
                                title: `解除共同小金库退款 - ${getCharDisplayName(char)}`,
                                memo: '解绑后剩余资金退回钱包',
                                char: activeVaultCharId,
                                timestamp: Date.now(),
                                isAuto: true
                            });
                        }
                        // 插入一条隐形系统消息，让AI知道金库解散了
                        await db.chatMessages.add({
                            chatId: String(activeVaultCharId),
                            timestamp: new Date(),
                            text: `[系统提示] 用户刚刚解除了你们的共同小金库绑定，剩余资金已平分退回各自账户。`,
                            type: 'system', contentType: 'system_event', eventType: 'info', uiVisible: false, aiVisible: true, recalled: false
                        });
                        await renderVaultPanel(); // 刷新卡片 UI 变回未解锁状态
                        if (typeof showDynamicIsland === 'function') showDynamicIsland('金库已解绑并清零', 'success');
                    }
                    return;
                }
                // ▲▲▲ 新增结束 ▲▲▲

                if (e.target.closest('.fund-btn-invite')) {
                    if (!activeVaultCharId) return;
                    const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
                    await sendVaultInviteCard();
                    if (char) console.log(`[LookyVault] 已为 ${char.name} 发送开启邀请卡片`);
                    return;
                }

                if (e.target.closest('.fund-btn-deposit')) {
                    if (!activeVaultCharId) return;
                    const amount = await showVaultAmountInput('存入共同小金库', '去虚拟支付');
                    if (!amount) return;
                    const char = AppState.characterProfiles.find(c => String(c.id) === String(activeVaultCharId));
                    const payment = await requestLookyPayment({
                        amount,
                        title: `存入 ${getCharDisplayName(char)} 的金库`,
                        scene: 'general'
                    });
                    if (!payment) return;
                    await depositToLookyVault(activeVaultCharId, amount, {
                        source: 'manual_deposit',
                        memo: payment.displayName || ''
                    });
                    await recordLookyLedger({
                        source: 'vault_deposit',
                        sourceId: `${activeVaultCharId}_${Date.now()}`,
                        type: 'expense',
                        amount,
                        category: '金库',
                        title: `存入共同小金库 - ${getCharDisplayName(char)}`,
                        char: activeVaultCharId,
                        paymentMethod: payment.displayName || '',
                        paymentCardId: payment.paymentCardId || (payment.type === 'card' ? payment.id : 'balance'),
                        timestamp: Date.now(),
                        isAuto: true
                    }, { silent: true });
                    await renderVaultPanel();
                    await renderVaultLedgerList();
                    showDynamicIsland('已存入金库', 'success');
                }
            });
        }

        if (vaultQuickBtns && vaultQuickBtns.length && !pageLookyPay.dataset.vaultQuickBound) {
            pageLookyPay.dataset.vaultQuickBound = 'true';
            vaultQuickBtns.forEach((btn, index) => {
                btn.addEventListener('click', async () => {
                    if (!activeVaultCharId) return;
                    const vault = await getLookyVault(activeVaultCharId);
                    if (vault.status !== 'unlocked') {
                        showDynamicIsland('请先邀请 Ta 开启小金库', 'warning');
                        return;
                    }
                    if (index === 0) {
                        const amount = await showVaultAmountInput('从共同小金库向Ta转账', '生成转账');
                        if (amount) await sendVaultTransferToChat(amount);
                    } else {
                        await sendVaultRequestCard();
                    }
                });
            });
        }

        if (vaultLedgerModeBtns && vaultLedgerModeBtns.length && !pageLookyPay.dataset.vaultLedgerModeBound) {
            pageLookyPay.dataset.vaultLedgerModeBound = 'true';
            vaultLedgerModeBtns.forEach(btn => {
                btn.addEventListener('click', async () => {
                    vaultLedgerModeBtns.forEach(item => item.classList.remove('active'));
                    btn.classList.add('active');
                    vaultLedgerMode = btn.dataset.vaultLedgerMode === 'month' ? 'month' : 'day';
                    vaultLedgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                    await renderVaultLedgerList();
                });
            });
        }

        if (vaultTxListContainer && !vaultTxListContainer.dataset.bound) {
            vaultTxListContainer.dataset.bound = 'true';
            vaultTxListContainer.addEventListener('click', async (e) => {
                const moreBtn = e.target.closest('.lp-ledger-more-btn');
                if (!moreBtn) return;
                if (moreBtn.dataset.vaultAction === 'collapse') {
                    vaultLedgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                } else {
                    vaultLedgerExpandedLimit += LP_LEDGER_RENDER_STEP;
                }
                await renderVaultLedgerList();
            });
        }

        window.addEventListener(LP_LEDGER_EVENT, () => {
            const vaultView = document.getElementById('lp-view-vault');
            if (vaultView?.classList.contains('active')) {
                renderVaultPanel();
                renderVaultLedgerList();
            }
        });
        window.addEventListener(LP_VAULT_EVENT, (e) => {
            const vaultView = document.getElementById('lp-view-vault');
            if (!vaultView?.classList.contains('active')) return;
            if (!e.detail?.charId || String(e.detail.charId) === String(activeVaultCharId)) {
                renderVaultPanel();
                if (e.detail?.ledgerUpdated) renderVaultLedgerList();
            }
        });

        // 3. 模拟充值交互
        if (btnRecharge && balanceDisplay) {
            btnRecharge.addEventListener('click', () => {
                // 【安全修复】防止连续点击导致弹出多个充值窗口卡死页面
                if (document.getElementById('lp-custom-recharge-modal')) return;
                const savedCards = readLookyCards();
                let cardOptions = `<option value="balance">钱包可用余额 (¥${walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</option>`;
                savedCards.forEach(c => {
                    cardOptions += `<option value="${c.id}">${c.bankName} (尾号${c.last4})</option>`;
                });
                const modalHtml = `
                <div id="lp-custom-recharge-modal" style="position: absolute; inset: 0; z-index: 2000; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);">
                    <div style="background: #fff; width: 80%; border-radius: 20px; padding: 24px; box-sizing: border-box;">
                        <h3 style="margin: 0 0 15px; text-align: center; font-size: 18px; color: #111;">充值系统</h3>
                        <div style="margin-bottom: 15px;">
                            <label style="font-size: 12px; color: #888; margin-bottom: 5px; display: block;">充值金额 (¥)</label>
                            <input type="number" id="lp-recharge-amount" placeholder="输入金额" style="width: 100%; border: 1px solid #ddd; padding: 10px; border-radius: 8px; box-sizing: border-box; font-size: 16px; outline: none;">
                        </div>
                        <div style="margin-bottom: 20px;">
                            <label style="font-size: 12px; color: #888; margin-bottom: 5px; display: block;">充入账户</label>
                            <select id="lp-recharge-target" style="width: 100%; border: 1px solid #ddd; padding: 10px; border-radius: 8px; box-sizing: border-box; font-size: 14px; outline: none; background: #fafafa;">
                                ${cardOptions}
                            </select>
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button id="lp-recharge-cancel" style="flex: 1; padding: 12px; background: #f2f2f2; border: none; border-radius: 10px; color: #666; font-weight: bold; cursor: pointer;">取消</button>
                            <button id="lp-recharge-confirm" style="flex: 1; padding: 12px; background: #111; border: none; border-radius: 10px; color: #fff; font-weight: bold; cursor: pointer;">确认充值</button>
                        </div>
                    </div>
                </div>`;
                pageLookyPay.insertAdjacentHTML('beforeend', modalHtml);
                const modal = document.getElementById('lp-custom-recharge-modal');
                document.getElementById('lp-recharge-cancel').onclick = () => modal.remove();
                document.getElementById('lp-recharge-confirm').onclick = () => {
                const amt = parseFloat(document.getElementById('lp-recharge-amount').value);
                const target = document.getElementById('lp-recharge-target').value;
                syncWalletBalance();
                if (isNaN(amt) || amt <= 0) {
                        alert("请输入有效金额！");
                        return;
                    }
                   if (target === 'balance') {
                        addWalletBalance(amt);
                        if (typeof showDynamicIsland === 'function') showDynamicIsland(`钱包余额充值成功: ¥${amt}`, 'success');
                    } else {
                        // 充值到指定卡片
                        let sCards = readLookyCards();
                        let card = sCards.find(c => c.id === target);
                        if (card) {
                            let oldBal = parseFloat(String(card.balanceStr).replace(/,/g, '')) || 0;
                            card.balanceStr = (oldBal + amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            saveLookyCards(sCards);
                            
                            const assetEl = pageLookyPay.querySelector(`.lp-asset-item-modern[data-card-id="${target}"] .asset-amount`);
                            if (assetEl) assetEl.innerText = card.balanceStr;
                            
                            refreshTotalAsset(); // 刷新顶部的总资产
                            if (typeof showDynamicIsland === 'function') showDynamicIsland(`卡片充值成功: ¥${amt}`, 'success');
                        }
                    }
                    modal.remove();
                };
            });
        }

        /* ▼▼▼ 从这里开始，粘贴下面这一整段新功能代码 ▼▼▼ */
        // === 4. 添加虚拟卡片功能 ===
        const addCardBtn = pageLookyPay.querySelector('.lp-section-header .lp-btn-icon');
        const addCardModal = document.getElementById('lp-add-card-modal');
        const newBankName = document.getElementById('lp-new-bank-name');
        const newCardNumber = document.getElementById('lp-new-card-number');
        const newCardBalance = document.getElementById('lp-new-card-balance');
        const newCardPwd = document.getElementById('lp-new-card-pwd');
        const newCardBgInput = document.getElementById('lp-new-card-bg');
        const cardBgPreview = document.getElementById('lp-card-bg-preview');
        const addCardCancel = document.getElementById('lp-add-card-cancel');
        const addCardConfirm = document.getElementById('lp-add-card-confirm');
        let newCardBgData = ''; // 存储上传的背景图
        // ▼▼▼ 新增：封装卡片渲染、加载和移除逻辑 ▼▼▼
       const renderCardDOM = (id, bankName, last4, pwd, balanceStr, bgData, themeClass) => {
            const card = document.createElement('div');
            card.className = `lp-bank-card ${themeClass || 'theme-black'}`;
            card.dataset.password = pwd;
            card.dataset.cardId = id; // 给卡片贴上唯一身份证号
            if (bgData) {
                card.style.background = `linear-gradient(rgba(0,0,0,0.25), rgba(0,0,0,0.5)), url(${bgData}) center/cover`;
            } else if (!themeClass) {
                card.style.background = 'linear-gradient(135deg, #3a3a3a 0%, #111 100%)';
            }
            card.style.color = '#fff';
            card.innerHTML = `
                <div class="card-top">
                  <div class="card-chip"></div>
                  <div class="card-logo">${bankName}</div>
                </div>
                <div class="card-number">**** **** **** ${last4}</div>
                <div class="card-bottom">
                  <div>余额 Balance<br><strong style="font-size:14px; letter-spacing: 1px;">¥ ${balanceStr}</strong></div>
                  <div style="text-align: right; font-size: 14px; font-weight: bold; font-style: italic;">UNION PAY</div>
                  </div>`;
            if (cardStack) {
                const emptyHint = cardStack.querySelector('.lp-empty-card');
                if (emptyHint) emptyHint.remove();
                cardStack.appendChild(card);
                lpRestackCards();
            }
            if (assetList) {
                const emptyAssetHint = assetList.querySelector('.lp-empty-asset');
                if (emptyAssetHint) emptyAssetHint.remove();
                const assetItem = document.createElement('div');
                assetItem.className = `lp-asset-item-modern ${themeClass || 'theme-black'}`;
                assetItem.dataset.cardId = id; // 资产项也贴上同一个身份证号
                assetItem.innerHTML = `
                    <div class="asset-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg></div>
                    <div class="asset-info">
                        <div class="asset-name">${bankName}</div>
                        <div class="asset-desc">虚拟卡 / ${last4}</div>
                    </div>
                    <div class="asset-amount-group">
                        <div class="asset-amount">${balanceStr}</div>
                       <div class="asset-trend plus">↗\uFE0E 0.0%</div>
                    </div>
                    <div class="asset-action-btn" title="移除虚拟卡片"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="5 12 19 12"></polyline><polyline points="12 5 19 12 12 19"></polyline></svg></div>`;
                assetList.appendChild(assetItem);
            }
        };
        // 移除虚拟卡片流程动画 (每步专属小动画 · 放大流畅版)
        const runCancellationFlow = (bankName, onComplete) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:absolute; inset:0; z-index:1002; background:rgba(18,18,20,0.95); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; padding:0 30px; box-sizing:border-box; overflow:hidden;';

            // 专属动画的 CSS，随弹窗注入，关闭时一起消失，不污染全局
            overlay.innerHTML = `
            <style>
                @keyframes lpcScan { 0% { transform: translateY(-38px); } 50% { transform: translateY(38px); } 100% { transform: translateY(-38px); } }
                @keyframes lpcRoll { 0% { transform: translateY(0); } 100% { transform: translateY(-117px); } }
                @keyframes lpcCrack { 0%,40% { transform:rotate(0) scale(1); opacity:1; } 60% { transform:rotate(-4deg) scale(1.05); } 100% { transform:rotate(8deg) scale(0.9) translateY(20px); opacity:0; } }
                @keyframes lpcStamp { 0% { transform:scale(2.4) rotate(-15deg); opacity:0; } 60% { transform:scale(0.9) rotate(0); opacity:1; } 75% { transform:scale(1.05) rotate(0); } 100% { transform:scale(1) rotate(0); opacity:1; } }
                @keyframes lpcFade { from { opacity:0; transform:translateY(14px);} to { opacity:1; transform:translateY(0);} }
                @keyframes lpcGlow { 0%,100% { opacity:0.35; } 50% { opacity:1; } }
                .lpc-stage { display:none; flex-direction:column; align-items:center; }
                .lpc-stage.active { display:flex; animation: lpcFade 0.45s ease; }
                .lpc-title { margin-top:34px; font-size:19px; letter-spacing:1px; font-weight:600; }
                .lpc-sub { margin-top:10px; font-size:13px; color:rgba(255,255,255,0.55); }
                .lpc-dots { display:flex; gap:10px; margin-top:44px; }
                .lpc-dots span { width:8px; height:8px; border-radius:50%; background:rgba(255,255,255,0.2); transition:0.3s; }
                .lpc-dots span.on { background:#ff453a; width:24px; border-radius:4px; }
                .lpc-anim { will-change: transform, opacity; }
            </style>

            <!-- 步骤1：核验虚拟身份 (扫描) -->
            <div class="lpc-stage" data-stage="0">
                <div style="position:relative; width:130px; height:130px; border-radius:24px; border:2px solid rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center; overflow:hidden;">
                    <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="1.6"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"></path></svg>
                    <div class="lpc-anim" style="position:absolute; left:10px; right:10px; top:50%; height:2px; background:linear-gradient(90deg, transparent, #34c759, transparent); box-shadow:0 0 10px #34c759; animation:lpcScan 1.8s ease-in-out infinite;"></div>
                </div>
                <div class="lpc-title">核验虚拟身份</div>
                <div class="lpc-sub">Checking Virtual Profile...</div>
            </div>

            <!-- 步骤2：整理虚拟余额 (数字归零) -->
            <div class="lpc-stage" data-stage="1">
                <div style="display:flex; align-items:center; gap:8px; color:#fff;">
                    <span style="font-size:48px; font-weight:700;">¥</span>
                    <div style="height:58px; overflow:hidden; display:flex; gap:3px;">
                        <div class="lpc-anim" style="height:58px; line-height:58px; font-size:52px; font-weight:700; animation:lpcRoll 1.4s steps(9) infinite;">9<br>8<br>7<br>6<br>5<br>4<br>3<br>2<br>1<br>0</div>
                        <div class="lpc-anim" style="height:58px; line-height:58px; font-size:52px; font-weight:700; animation:lpcRoll 1.0s steps(9) infinite;">9<br>8<br>7<br>6<br>5<br>4<br>3<br>2<br>1<br>0</div>
                        <div class="lpc-anim" style="height:58px; line-height:58px; font-size:52px; font-weight:700; animation:lpcRoll 0.7s steps(9) infinite;">9<br>8<br>7<br>6<br>5<br>4<br>3<br>2<br>1<br>0</div>
                    </div>
                    <span style="font-size:28px; font-weight:600; margin-left:6px;">.00</span>
                </div>
                <div class="lpc-title">整理虚拟余额</div>
                <div class="lpc-sub">Updating Virtual Balance...</div>
            </div>

            <!-- 步骤3：移除虚拟卡片信息 (碎裂) -->
            <div class="lpc-stage" data-stage="2">
                <div class="lpc-anim" style="position:relative; width:150px; height:96px; border-radius:14px; background:linear-gradient(135deg, #3a3a3a, #111); border:1px solid rgba(255,255,255,0.15); animation:lpcCrack 1.8s ease-in-out infinite; display:flex; align-items:center; justify-content:center;">
                    <div class="lpc-anim" style="width:36px; height:28px; border-radius:5px; background:linear-gradient(135deg,#e0e0e0,#888); box-shadow:0 0 12px rgba(255,69,58,0.6); animation:lpcGlow 0.7s ease-in-out infinite;"></div>
                </div>
                <div class="lpc-title">移除虚拟卡片信息</div>
                <div class="lpc-sub">Removing Virtual Card Data...</div>
            </div>

            <!-- 步骤4：完成移除 (盖章) -->
            <div class="lpc-stage" data-stage="3">
                <div style="position:relative; width:130px; height:130px; display:flex; align-items:center; justify-content:center;">
                    <div class="lpc-anim" style="position:absolute; inset:0; border:4px solid #ff453a; border-radius:50%; display:flex; align-items:center; justify-content:center; animation:lpcStamp 0.7s cubic-bezier(0.175,0.885,0.32,1.275) forwards;">
                        <svg viewBox="0 0 24 24" width="58" height="58" fill="none" stroke="#ff453a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                </div>
                <div class="lpc-title" id="lpc-final-title">虚拟卡片已移除</div>
                <div class="lpc-sub">${bankName} 已从虚拟卡包移除</div>
            </div>

            <!-- 底部步骤指示点 -->
            <div class="lpc-dots">
                <span data-dot="0"></span><span data-dot="1"></span><span data-dot="2"></span><span data-dot="3"></span>
            </div>
            `;
            pageLookyPay.appendChild(overlay);

            const stages = overlay.querySelectorAll('.lpc-stage');
            const dots = overlay.querySelectorAll('.lpc-dots span');

            const showStage = (i) => {
                stages.forEach(s => s.classList.remove('active'));
                dots.forEach(d => d.classList.remove('on'));
                if (stages[i]) stages[i].classList.add('active');
                if (dots[i]) dots[i].classList.add('on');
            };

            let idx = 0;
            showStage(0);

            const timer = setInterval(() => {
                idx++;
                if (idx < stages.length) {
                    showStage(idx);
                    // 走到最后一步时执行删除逻辑
                    if (idx === stages.length - 1) {
                        if (typeof onComplete === 'function') onComplete();
                    }
                } else {
                    clearInterval(timer);
                    setTimeout(() => overlay.remove(), 1300);
                }
            }, 1500);
        };
        if (assetList) {
            // 1. 初始化时加载数据库里的卡片
           const savedCards = readLookyCards();
            savedCards.forEach(c => renderCardDOM(c.id, c.bankName, c.last4, c.pwd, c.balanceStr, c.bgData, c.theme));
            // 2. 利用事件委托监听移除按钮
            assetList.addEventListener('click', (e) => {
                const actionBtn = e.target.closest('.asset-action-btn');
                if (!actionBtn) return;
                const assetItem = actionBtn.closest('.lp-asset-item-modern');
                const cardId = assetItem.dataset.cardId;
                if (!cardId) {
                    alert('该卡片为系统预设卡片，暂不支持移除。');
                    return;
                }
                if (!confirm('确定要移除这张虚拟卡片吗？移除后将无法恢复。')) return;
                runCancellationFlow(assetItem.querySelector('.asset-name').innerText, () => {
                   assetItem.remove();
                    if (cardStack) {
                        const target = cardStack.querySelector(`.lp-bank-card[data-card-id="${cardId}"]`);
                        if (target) target.remove();
                        lpRestackCards();
                    }
                    let sCards = readLookyCards();
                    
                    // 将卡里的钱退回钱包可用余额
                    const cardToDel = sCards.find(c => String(c.id) === String(cardId));
                    if (cardToDel) {
                        const refundAmt = parseFloat(String(cardToDel.balanceStr).replace(/,/g, '')) || 0;
                        addWalletBalance(refundAmt); 
                    }
                    sCards = sCards.filter(c => String(c.id) !== String(cardId));
                    saveLookyCards(sCards);
                    refreshTotalAsset(); // 刷新总资产
                    // 当全部删完时，恢复空状态提示文字
                    if (sCards.length === 0 && assetList) {
                        assetList.innerHTML = `<div class="lp-empty-asset" style="text-align: center; padding: 20px; color: #999; font-size: 13px;">尚未添加任何卡片资产</div>`;
                    }
                });
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        if (addCardBtn && addCardModal) {
            // 打开弹窗(并清空上次内容)
            addCardBtn.addEventListener('click', () => {
                // 限制最多只能有 5 张卡片
                const savedCardsCheck = readLookyCards();
                if (savedCardsCheck.length >= 5) {
                    alert('卡包容量已满，最多只能添加 5 张虚拟卡片。如需添加新卡，请先在下方移除部分旧卡。');
                    return;
                }
                
                newBankName.value = '';
                newCardNumber.value = '';
                newCardBalance.value = '';
                 newCardPwd.value = '';
                newCardBgData = '';
                cardBgPreview.style.backgroundImage = '';
                cardBgPreview.textContent = '点击上传卡片背景';
                showLookyModal(addCardModal);
            });

            // 取消关闭
            addCardCancel.addEventListener('click', () => { hideLookyModal(addCardModal); });

            // 上传背景图预览
            newCardBgInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    newCardBgData = ev.target.result;
                    cardBgPreview.style.backgroundImage = `url(${newCardBgData})`;
                    cardBgPreview.textContent = '';
                };
                reader.readAsDataURL(file);
            });

           // 确认添加
            addCardConfirm.addEventListener('click', () => {
                const bankName = newBankName.value.trim();
                const last4 = newCardNumber.value.trim() || '0000';
                const pwd = newCardPwd.value.trim();
                const balanceNum = parseFloat(newCardBalance.value) || 0;
                const balanceStr = balanceNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                syncWalletBalance();
                // 校验
                if (!bankName) { alert('请输入虚拟机构名称'); return; }
                if (pwd.length !== 6 || !/^\d{6}$/.test(pwd)) { alert('请设置6位纯数字取款密码'); return; }
                // 【安全修复】拦截负数金额，防止利用负数漏洞“反向刷钱”
                if (balanceNum < 0) { 
                    alert('虚拟卡片初始金额不能为负数！'); 
                    return; 
                }
              // 校验钱包可用余额是否够扣
                if (balanceNum > walletBalance) {
                    alert(`钱包可用余额不足！当前可用余额: ¥${walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
                    return;
                }
                
                // 真正生成卡片的函数(动画结束后调用)
                const doCreateCard = () => {
                    const newId = 'card_' + Date.now();
                    const currentTheme = themes[themeIndex % themes.length];
                    themeIndex++;
                       
                    // 核心资金流转：先在后台生成好卡片，再从钱包扣款。确保顶部总资产计算时一分钱都不会少！
                    let savedCards = readLookyCards();
                    savedCards.push({ id: newId, bankName, last4, pwd, balanceStr, bgData: newCardBgData, theme: currentTheme });
                    saveLookyCards(savedCards);
                    
                    renderCardDOM(newId, bankName, last4, pwd, balanceStr, newCardBgData, currentTheme);
                    addWalletBalance(-balanceNum); // 扣除钱包可用余额 (内部会自动触发总资产和柱状图的完美刷新)
                    if (typeof showDynamicIsland === 'function') {
                        showDynamicIsland(`已创建虚拟卡片 ${bankName}`, 'success');
                    }
                };
                // 先关闭表单弹窗，启动虚拟卡片创建动画
                hideLookyModal(addCardModal);
                const progressModal = document.getElementById('lp-card-progress-modal');
                const progressText = document.getElementById('lp-progress-text');
                const progressBar = document.getElementById('lp-progress-bar');
                const progressSpinner = document.getElementById('lp-progress-spinner');
                const progressCheck = document.getElementById('lp-progress-check');
                if (!progressModal) { doCreateCard(); return; } // 兜底:没有动画层就直接生成
                // 重置动画状态
                showLookyModal(progressModal);
                progressSpinner.style.display = 'block';
                progressCheck.style.display = 'none';
                progressBar.style.width = '0%';
                const steps = [
                    { text: '正在生成虚拟资料...', bar: 25 },
                    { text: '虚拟系统处理中...', bar: 50 },
                    { text: '正在生成虚拟卡片视效...', bar: 75 },
                    { text: '正在保存虚拟安全码...', bar: 95 }
                ];
                let stepIndex = 0;
                progressText.textContent = steps[0].text;
                progressBar.style.width = steps[0].bar + '%';
                const stepTimer = setInterval(() => {
                    stepIndex++;
                    if (stepIndex < steps.length) {
                        progressText.textContent = steps[stepIndex].text;
                        progressBar.style.width = steps[stepIndex].bar + '%';
                    } else {
                        // 全部完成，显示成功
                        clearInterval(stepTimer);
                        progressBar.style.width = '100%';
                        progressSpinner.style.display = 'none';
                        progressCheck.style.display = 'flex';
                        progressText.textContent = '虚拟卡片已创建 ✓';
                        // 真正生成卡片
                        doCreateCard();
                        // 1.2秒后关闭动画层
                        setTimeout(() => { hideLookyModal(progressModal); }, 1200);
                    }
                }, 900); // 每步停留 0.9 秒
            });
        }
        /* ▲▲▲ 新增结束 ▲▲▲ */
        // === 个人主页子页面：卡片密码、安全验证、场景默认虚拟支付 ===
        const closeSheet = (modal) => {
            hideLookyModal(modal);
        };
        const openSheet = (modal) => {
            showLookyModal(modal);
        };
        const buildPaymentOptions = (selected = '') => {
            const cards = readLookyCards();
            let html = `<option value="balance"${selected === 'balance' ? ' selected' : ''}>钱包余额 (¥${formatLookyMoney(getLookyWalletBalance())})</option>`;
            cards.forEach(card => {
                const value = `card:${card.id}`;
                html += `<option value="${value}"${selected === value ? ' selected' : ''}>${escapeHTML(card.bankName || '数字卡片')} (尾号${escapeHTML(card.last4 || '0000')})</option>`;
            });
            return html;
        };

        const passwordSetting = document.getElementById('lp-card-password-setting');
        const passwordModal = document.getElementById('lp-password-modal');
        const passwordCard = document.getElementById('lp-password-card');
        const passwordOld = document.getElementById('lp-password-old');
        const passwordNew = document.getElementById('lp-password-new');
        const passwordSave = document.getElementById('lp-password-save');
        const passwordForgot = document.getElementById('lp-password-forgot');
        const passwordCloseBtns = [
            document.getElementById('lp-password-close'),
            document.getElementById('lp-password-cancel')
        ].filter(Boolean);
        let passwordForgotMode = false;
        const refreshForgotMode = () => {
            if (passwordOld) {
                passwordOld.disabled = passwordForgotMode;
                passwordOld.placeholder = passwordForgotMode ? '忘记密码模式：不用输入旧密码' : '原虚拟支付密码';
            }
            if (passwordForgot) passwordForgot.textContent = passwordForgotMode ? '返回原密码修改' : '忘记密码？直接重设';
        };

        if (passwordSetting && passwordModal) {
            passwordSetting.addEventListener('click', () => {
                const cards = readLookyCards();
                passwordCard.innerHTML = [
                    `<option value="balance">钱包余额</option>`,
                    ...cards.map(card => `<option value="card:${card.id}">${escapeHTML(card.bankName || '数字卡片')} (尾号${escapeHTML(card.last4 || '0000')})</option>`)
                ].join('');
                passwordOld.value = '';
                passwordNew.value = '';
                passwordForgotMode = false;
                refreshForgotMode();
                openSheet(passwordModal);
            });
            passwordCloseBtns.forEach(btn => btn.addEventListener('click', () => closeSheet(passwordModal)));
            passwordForgot?.addEventListener('click', () => {
                passwordForgotMode = !passwordForgotMode;
                passwordOld.value = '';
                refreshForgotMode();
            });
            passwordSave?.addEventListener('click', () => {
                const selectedValue = passwordCard.value;
                const oldPwd = passwordOld.value.trim();
                const newPwd = passwordNew.value.trim();
                if (!/^\d{6}$/.test(newPwd)) { alert('新虚拟支付密码必须是6位数字。'); return; }
                if (selectedValue === 'balance') {
                    if (!passwordForgotMode && String(bankStateCache.balancePwd || '') !== oldPwd) { alert('原虚拟支付密码不正确。'); return; }
                    setBalancePassword(newPwd);
                } else {
                    const cardId = selectedValue.replace(/^card:/, '');
                    const cards = readLookyCards();
                    const card = cards.find(c => String(c.id) === String(cardId));
                    if (!card) { alert('没有找到这张卡片。'); return; }
                    if (!passwordForgotMode && String(card.pwd || '') !== oldPwd) { alert('原虚拟支付密码不正确。'); return; }
                    card.pwd = newPwd;
                    saveLookyCards(cards);
                    const domCard = pageLookyPay.querySelector(`.lp-bank-card[data-card-id="${cardId}"]`);
                    if (domCard) domCard.dataset.password = newPwd;
                }
                closeSheet(passwordModal);
                showDynamicIsland('虚拟支付密码已更新', 'success');
            });
        }

        const biometricSetting = document.getElementById('lp-biometric-setting');
        const biometricModal = document.getElementById('lp-biometric-modal');
        const biometricToggle = document.getElementById('lp-biometric-toggle');
        const biometricClose = document.getElementById('lp-biometric-close');
        const refreshBiometricText = () => {
            const right = biometricSetting?.querySelector('.right span');
            if (right) right.textContent = isBiometricEnabled() ? '已启用' : '未启用';
        };
        refreshBiometricText();
        if (biometricSetting && biometricModal && biometricToggle) {
            biometricSetting.addEventListener('click', () => {
                biometricToggle.checked = isBiometricEnabled();
                openSheet(biometricModal);
            });
            biometricToggle.addEventListener('change', () => {
                setBiometricEnabled(biometricToggle.checked);
                refreshBiometricText();
                showDynamicIsland(biometricToggle.checked ? '指纹解锁已启用' : '指纹解锁已关闭', 'success');
            });
            biometricClose?.addEventListener('click', () => closeSheet(biometricModal));
        }

        const sceneSetting = document.getElementById('lp-scene-card-setting');
        const sceneModal = document.getElementById('lp-scene-modal');
        const sceneList = document.getElementById('lp-scene-list');
        const sceneSave = document.getElementById('lp-scene-save');
        const sceneCloseBtns = [
            document.getElementById('lp-scene-close'),
            document.getElementById('lp-scene-cancel')
        ].filter(Boolean);
        const scenes = [
            { key: 'food', name: '外卖', desc: '生活服务/外卖订单' },
            { key: 'ride', name: '出行', desc: '打车/机票/高铁' },
            { key: 'shop', name: '购物', desc: '商城立即购买/购物车' },
            { key: 'transfer', name: '转账', desc: '聊天转账' },
            { key: 'general', name: '通用', desc: '手动记账等其它虚拟付款' }
        ];
        const refreshSceneSubtitle = () => {
            const defaults = readSceneDefaults();
            const right = sceneSetting?.querySelector('.right span:first-child');
            if (!right) return;
            const savedCount = scenes.filter(scene => defaults[scene.key]).length;
            right.textContent = savedCount ? `已绑定 ${savedCount} 个场景` : '外卖/出行/购物';
        };
        refreshSceneSubtitle();
        if (sceneSetting && sceneModal && sceneList) {
            sceneSetting.addEventListener('click', () => {
                const defaults = readSceneDefaults();
                sceneList.innerHTML = scenes.map(scene => {
                    const saved = defaults[scene.key];
                    const selected = saved ? (saved.type === 'balance' ? 'balance' : `${saved.type}:${saved.id}`) : '';
                    return `
                    <div class="lp-scene-row">
                        <div>
                            <strong>${scene.name}</strong>
                            <span>${scene.desc}</span>
                        </div>
                        <select data-scene="${scene.key}">
                            ${buildPaymentOptions(selected || 'balance')}
                        </select>
                    </div>`;
                }).join('');
                openSheet(sceneModal);
            });
            sceneCloseBtns.forEach(btn => btn.addEventListener('click', () => closeSheet(sceneModal)));
            sceneSave?.addEventListener('click', () => {
                const defaults = {};
                sceneList.querySelectorAll('select[data-scene]').forEach(select => {
                    const [type, id = 'balance'] = select.value.split(':');
                    defaults[select.dataset.scene] = { type, id };
                });
                saveSceneDefaults(defaults);
                refreshSceneSubtitle();
                closeSheet(sceneModal);
                showDynamicIsland('默认虚拟支付方式已保存', 'success');
            });
        }

         /* ▼▼▼ 新增：列表渲染、删除与自动记账引擎 ▼▼▼ */
        function formatLpTime(ts) {
            const d = new Date(ts);
            return `${d.getMonth()+1}-${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        }

        // 改为极简纯色线条 SVG 图标
        const getLpSvg = (cat) => {
            switch(cat) {
                case '餐饮': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"></path><path d="M4 14v2a8 8 0 0 0 16 0v-2H4z"></path><path d="M12 2v6"></path></svg>';
                case '购物': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 6V4a4 4 0 0 0-8 0v2H4v16h16V6h-4zm-6-2a2 2 0 0 1 4 0v2h-4V4z"></path></svg>';
                case '出行': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"></path><circle cx="7" cy="17" r="2"></circle><circle cx="17" cy="17" r="2"></circle></svg>';
                case '娱乐': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"></rect><path d="M6 12h4m-2-2v4m8-2h.01M16 10h.01"></path></svg>';
                case '转账': return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>';
                default: return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
            }
        };
        // 渲染引擎：增加 filterType 支持 (all, expense, income)
        async function renderLpTransactions(filterType = 'all') {
            if(!txListContainer) return;
            let txs = await readLookyLedger();
            ledgerExpandedLimit = Math.max(ledgerExpandedLimit, LP_LEDGER_INITIAL_RENDER_LIMIT);
            
                      // ▼▼▼ 修改：根据视图模式过滤记录 ▼▼▼
            txs = txs.filter(t => {
                const d = new Date(t.timestamp);
                if (currentViewMode === 'day') {
                    return d.getFullYear() === currentLedgerDate.getFullYear() && 
                           d.getMonth() === currentLedgerDate.getMonth() && 
                           d.getDate() === currentLedgerDate.getDate();
                } else {
                    return d.getFullYear() === currentLedgerDate.getFullYear() && 
                           d.getMonth() === currentLedgerDate.getMonth();
                }
            });
            // ▲▲▲ 修改结束 ▲▲▲

            txs.sort((a, b) => b.timestamp - a.timestamp);

            let expenseTotal = 0; let incomeTotal = 0;
            let catTotal = { '餐饮': 0, '购物': 0, '出行': 0, '其它': 0 };

            // ▼▼▼ 新增：更新标题指示器 ▼▼▼
            const dateLabel = document.getElementById('lp-current-date-label');
            if (dateLabel) {
                if (currentViewMode === 'month') {
                    const today = new Date();
                    const isThisMonth = currentLedgerDate.getMonth() === today.getMonth() && currentLedgerDate.getFullYear() === today.getFullYear();
                    dateLabel.innerHTML = isThisMonth ? '本月概览 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Monthly</small>' : `${currentLedgerDate.getMonth()+1}月概览 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Monthly</small>`;
                } else {
                    const today = new Date();
                    const isToday = currentLedgerDate.getDate() === today.getDate() && currentLedgerDate.getMonth() === today.getMonth() && currentLedgerDate.getFullYear() === today.getFullYear();
                    dateLabel.innerHTML = isToday ? '今日概览 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Today</small>' : `${currentLedgerDate.getMonth()+1}月${currentLedgerDate.getDate()}日 <small style="font-size:10px; color:#5B7569; margin-left:4px;">Daily</small>`;
                }
            }
            // ▲▲▲ 新增结束 ▲▲▲
            // 第一遍循环：计算总计（不受过滤器影响，总计永远显示真实的整月数据）
            txs.forEach(t => {
                if(t.type === 'income') {
                    incomeTotal += parseFloat(t.amount);
                } else {
                    expenseTotal += parseFloat(t.amount);
                    if(catTotal[t.category] !== undefined) catTotal[t.category] += parseFloat(t.amount);
                    else catTotal['其它'] += parseFloat(t.amount);
                }
            });

            // 根据过滤器过滤要展示的列表
            let filteredTxs = txs;
            if (filterType !== 'all') {
                filteredTxs = txs.filter(t => t.type === filterType);
            }
            if(filteredTxs.length === 0) {
                txListContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px; font-size: 13px;">暂无记录</div>';
            } else {
                let listHtml = ''; // 准备一个空车
                const visibleTxs = filteredTxs.slice(0, ledgerExpandedLimit);
                visibleTxs.forEach(t => {
                    const isIncome = t.type === 'income';
                    const amtText = isIncome ? `+${parseFloat(t.amount).toFixed(2)}` : `-${parseFloat(t.amount).toFixed(2)}`;
                    const amtClass = isIncome ? 'plus' : 'minus';

                    // 列表HTML，纯色极简风格，把积木装进车里
                    listHtml += `
                    <div class="lp-tx-item-crypto">
                        <div class="tx-left">
                            <div class="tx-icon">${getLpSvg(t.category)}</div>
                            <div class="tx-info">
                                <span class="title">${escapeHTML(t.title || t.category)}</span>
                                <span class="time">${formatLpTime(t.timestamp)} ${t.memo ? `<span style="opacity:0.5;">/ ${escapeHTML(t.memo)}</span>` : ''}</span>
                            </div>
                        </div>
                        <div class="tx-right">
                            <span class="tx-amount ${amtClass}">${amtText}</span>
                            <button class="tx-delete-btn" data-id="${t.id}" data-auto="${t.isAuto ? 'true' : 'false'}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                    </div>`;
                });
                // 一次性把整车内容倒进页面，极大提升性能
                const hiddenCount = filteredTxs.length - visibleTxs.length;
                const actionHtml = hiddenCount > 0
                    ? `<button type="button" class="lp-ledger-more-btn" data-action="more">展开更多 ${Math.min(LP_LEDGER_RENDER_STEP, hiddenCount)} 条</button>`
                    : (filteredTxs.length > LP_LEDGER_INITIAL_RENDER_LIMIT ? '<button type="button" class="lp-ledger-more-btn secondary" data-action="collapse">收起旧记录</button>' : '');
                txListContainer.innerHTML = listHtml + actionHtml;
            }

            // 更新面板数值
            if(document.getElementById('lp-total-expense')) document.getElementById('lp-total-expense').innerText = expenseTotal.toFixed(2);
            if(document.getElementById('lp-total-income')) document.getElementById('lp-total-income').innerText = '+' + incomeTotal.toFixed(2);

            // 更新进度条
            if (expenseTotal > 0) {
                if(document.getElementById('lp-bar-dining')) document.getElementById('lp-bar-dining').style.width = ((catTotal['餐饮'] / expenseTotal) * 100) + '%';
                if(document.getElementById('lp-bar-shopping')) document.getElementById('lp-bar-shopping').style.width = ((catTotal['购物'] / expenseTotal) * 100) + '%';
                if(document.getElementById('lp-bar-transport')) document.getElementById('lp-bar-transport').style.width = ((catTotal['出行'] / expenseTotal) * 100) + '%';
            }
        }

        // 初始化渲染
        Promise.all([migrateLegacyLookyLedgerToDb(), migrateLegacyShopOrdersToLedger()])
            .finally(() => {
                const ledgerView = document.getElementById('lp-view-ledger');
                if (ledgerView?.classList.contains('active')) renderLpTransactions('all');
            });
        if (!window._lookyLedgerRenderBound) {
            window._lookyLedgerRenderBound = true;
            let renderTimer = null;
            window.addEventListener(LP_LEDGER_EVENT, () => {
                clearTimeout(renderTimer);
                renderTimer = setTimeout(() => {
                    const ledgerView = document.getElementById('lp-view-ledger');
                    if (!ledgerView?.classList.contains('active')) return;
                    const activeFilter = document.querySelector('.lp-filter-btn.active');
                    renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                }, 80);
            });
        }

        // 【新增修复】给过滤器按钮绑定点击事件
        if(filterBtns) {
            filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    // 切换高亮状态
                    filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    // 重新渲染列表
                    ledgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                    const filterType = btn.dataset.filter;
                    renderLpTransactions(filterType);
                });
            });
        }

        // 事件委托：处理删除逻辑
        if(txListContainer && !txListContainer.dataset.bound) {
            txListContainer.dataset.bound = 'true';
            txListContainer.addEventListener('click', async (e) => {
                const moreBtn = e.target.closest('.lp-ledger-more-btn');
                if (moreBtn) {
                    const activeFilter = document.querySelector('.lp-filter-btn.active');
                    if (moreBtn.dataset.action === 'collapse') {
                        ledgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                    } else {
                        ledgerExpandedLimit += LP_LEDGER_RENDER_STEP;
                    }
                    renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                    return;
                }
                const btn = e.target.closest('.tx-delete-btn');
                if(!btn) return;
                
                const id = btn.dataset.id;
                const isAuto = btn.dataset.auto === 'true';
                if(isAuto) {
                    alert('自动抓取的流水不能在这里删除，请前往来源应用删除。');
                    return;
                }
                
                if(confirm('确认删除这条记录吗？如果是支出，金额将退回钱包。')) {
                    let txs = await readLookyLedger();
                    const targetTx = txs.find(t => String(t.id) === String(id));
                    
                    if(targetTx) {
                        // 如果是支出被删除，钱加回来；收入被删除，钱扣除
                        if(targetTx.type === 'expense') {
                            addWalletBalance(parseFloat(targetTx.amount));
                        } else {
                            addWalletBalance(-parseFloat(targetTx.amount));
                        }
                        await db.lookyLedger.delete(id);
                        
                        // 重新渲染当前选中的过滤状态
                        const activeFilter = document.querySelector('.lp-filter-btn.active');
                        renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                    }
                }
            });
        }
       // 记账面板相关操作
        if (recordFab && recordModal) {
            recordFab.addEventListener('click', () => {
                if (document.getElementById('lp-record-amount')) document.getElementById('lp-record-amount').value = '';
                if (document.getElementById('lp-record-category')) document.getElementById('lp-record-category').value = '';
                if (document.getElementById('lp-record-memo')) document.getElementById('lp-record-memo').value = '';
                showLookyModal(recordModal);
            });
            document.getElementById('lp-record-cancel').addEventListener('click', () => {
                hideLookyModal(recordModal);
            });

        document.getElementById('lp-record-confirm').addEventListener('click', async () => {
                const type = document.querySelector('input[name="lp-record-type"]:checked').value;
                const amount = parseFloat(document.getElementById('lp-record-amount').value);
                const category = document.getElementById('lp-record-category').value || '其他';
                const memoEl = document.getElementById('lp-record-memo');
                const memo = memoEl ? memoEl.value : '';
                if(isNaN(amount) || amount <= 0) {
                    alert('请输入有效金额！'); return;
                }
                let payment = null;
                if (type === 'expense') {
                    payment = await requestLookyPayment({
                        amount,
                        title: category,
                        scene: 'general'
                    });
                    if (!payment) return;
                }
                
                // ▼ 根据当前日历时间构造记账时间戳
                const now = new Date();
                let recordTimestamp = now.getTime();
                if (currentViewMode === 'day') {
                    // 如果在看某一天，就把钱记在那一天
                    const targetDate = new Date(currentLedgerDate.getFullYear(), currentLedgerDate.getMonth(), currentLedgerDate.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
                    recordTimestamp = targetDate.getTime();
                } else {
                    // 如果在看整月，且不是当前真实月份，把钱记到那个月1号
                    if (currentLedgerDate.getMonth() !== now.getMonth() || currentLedgerDate.getFullYear() !== now.getFullYear()) {
                         const targetDate = new Date(currentLedgerDate.getFullYear(), currentLedgerDate.getMonth(), 1, 12, 0, 0);
                         recordTimestamp = targetDate.getTime();
                    }
                }

                await recordLookyLedger({
                    source: 'manual',
                    sourceId: Date.now(),
                    type,
                    amount,
                    category,
                    title: category,
                    char: 'global', // 固定全局，不再选择角色
                    memo,
                    paymentMethod: payment?.displayName || '',
                    paymentCardId: payment?.paymentCardId || (payment ? (payment.type === 'card' ? payment.id : 'balance') : ''),
                    timestamp: recordTimestamp,
                    isAuto: false
                });

                if (type === 'income') addWalletBalance(amount);

                hideLookyModal(recordModal);
                
                // 记账后跳转回"全部"标签以查看最新流水
                if(filterBtns) {
                    filterBtns.forEach(b => b.classList.remove('active'));
                    document.querySelector('.lp-filter-btn[data-filter="all"]').classList.add('active');
                }
                renderLpTransactions('all');
                 if (typeof showDynamicIsland === 'function') showDynamicIsland('记账成功', 'success');
            });
        }
        
        // ▼▼▼ 新增：绑定日历弹窗事件 ▼▼▼
        const calTrigger = document.getElementById('lp-calendar-trigger');
        const calModal = document.getElementById('lp-calendar-modal');
        const calPrev = document.getElementById('lp-cal-prev-btn');
        const calNext = document.getElementById('lp-cal-next-btn');

        if (calTrigger && calModal) {
            calTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                isCalendarOpen = !isCalendarOpen;
                calModal.style.display = isCalendarOpen ? 'block' : 'none';
                if (isCalendarOpen) renderLpCalendar();
            });
            
            // 点击外部关闭日历
            document.addEventListener('click', (e) => {
                if (isCalendarOpen && !calModal.contains(e.target) && !calTrigger.contains(e.target)) {
                    isCalendarOpen = false;
                    calModal.style.display = 'none';
                }
            });
        }
        
        if (calPrev) {
            calPrev.addEventListener('click', (e) => {
                e.stopPropagation();
                currentLedgerDate.setMonth(currentLedgerDate.getMonth() - 1);
                renderLpCalendar();
            });
        }
               if (calNext) {
            calNext.addEventListener('click', (e) => {
                e.stopPropagation();
                currentLedgerDate.setMonth(currentLedgerDate.getMonth() + 1);
                renderLpCalendar();
            });
        }
        
        // ▼▼▼ 新增：查看本月全部按钮 ▼▼▼
       const calViewMonthBtn = document.getElementById('lp-cal-view-month-btn');
        if (calViewMonthBtn) {
            calViewMonthBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                currentViewMode = 'month'; // 恢复月视图
                ledgerExpandedLimit = LP_LEDGER_INITIAL_RENDER_LIMIT;
                document.getElementById('lp-calendar-modal').style.display = 'none';
                isCalendarOpen = false;
                const activeFilter = document.querySelector('.lp-filter-btn.active');
                renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                const vaultView = document.getElementById('lp-view-vault');
                if (vaultView?.classList.contains('active')) renderVaultLedgerList();
            });
        }
        // ▼▼▼ 新增：保存个人主页昵称和引言 & 清空钱包流水逻辑 ▼▼▼
        const profileNameEl = document.getElementById('lp-profile-name');
        const profileTitleEl = document.getElementById('lp-profile-title');
        
        if (profileNameEl) {
            const savedName = localStorage.getItem('lp_profile_name');
            if (savedName) profileNameEl.textContent = savedName;
            profileNameEl.addEventListener('blur', () => {
                localStorage.setItem('lp_profile_name', profileNameEl.textContent);
            });
        }
        if (profileTitleEl) {
            const savedTitle = localStorage.getItem('lp_profile_title');
            if (savedTitle) profileTitleEl.textContent = savedTitle;
            profileTitleEl.addEventListener('blur', () => {
                localStorage.setItem('lp_profile_title', profileTitleEl.textContent);
            });
        }
        const clearLedgerSetting = document.getElementById('lp-clear-ledger-setting');
        if (clearLedgerSetting) {
            clearLedgerSetting.addEventListener('click', async () => {
                if (confirm('确认清空所有钱包流水记录吗？此操作不可恢复。')) {
                    await db.lookyLedger.clear();
                    const activeFilter = document.querySelector('.lp-filter-btn.active');
                    renderLpTransactions(activeFilter ? activeFilter.dataset.filter : 'all');
                    if (typeof showDynamicIsland === 'function') showDynamicIsland('流水已清空', 'success');
                }
            });
        }
        // ▲▲▲ 新增结束 ▲▲▲
        // ▲▲▲ 新增结束 ▲▲▲
        /* ▲▲▲ 新增结束 ▲▲▲ */
    }
};
