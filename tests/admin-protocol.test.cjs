const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const adminPage = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.html'), 'utf8');
const adminScript = adminPage.match(/<script>([\s\S]*?)<\/script>/)[1];
const panelIds = Array.from(adminPage.matchAll(/<div id="([^"]+)" class="panel(?: active)?">/g), match => match[1]);
const account = 'test-admin';
const password = 'fixture-value';
const digest = value => createHash('sha256').update(value).digest('hex');
const initialQueries = ['get-all-accounts', 'get-all-rooms', 'get-rooms-status'];

function mockSocket() {
    const inbound = new Map();
    const outbound = [];
    const socket = {
        active: false,
        connected: false,
        id: undefined,
        outbound,
        sendBuffer: [],
        on(event, handler) {
            const listeners = inbound.get(event) || [];
            listeners.push(handler);
            inbound.set(event, listeners);
            return socket;
        },
        off(event, handler) {
            if (!event) inbound.clear();
            else if (!handler) inbound.delete(event);
            else inbound.set(event, (inbound.get(event) || []).filter(listener => listener !== handler));
            return socket;
        },
        connect() {
            socket.active = true;
            return socket;
        },
        disconnect() {
            socket.active = false;
            if (socket.connected) receiveDisconnect('io client disconnect');
            return socket;
        },
        emit(event, message) {
            assert.equal(event, 'message');
            outbound.push({ id: socket.id, message: structuredClone(message) });
            return socket;
        },
        receiveConnect(id) {
            socket.active = true;
            socket.id = id;
            socket.connected = true;
            notify('connect');
        },
        receiveDisconnect,
        receiveMessage(message) { notify('message', message); }
    };
    function notify(event, ...args) {
        for (const handler of [...(inbound.get(event) || [])]) handler(...args);
    }
    function receiveDisconnect(reason = 'transport close') {
        socket.connected = false;
        socket.id = undefined;
        notify('disconnect', reason);
    }
    return socket;
}

function mockElement(id = '') {
    const classes = new Set(id === 'main-container' ? ['hidden'] : []);
    const descendants = new Map();
    let html = '';
    let content = '';
    const node = {
        id, value: '', style: {}, checked: false, children: [],
        classList: {
            add: value => classes.add(value),
            remove: value => classes.delete(value),
            contains: value => classes.has(value)
        },
        get innerHTML() { return html; },
        set innerHTML(value) {
            node.children.length = 0;
            descendants.clear();
            html = value;
            content = '';
        },
        get textContent() { return content; },
        set textContent(value) {
            node.innerHTML = '';
            content = value;
        },
        addEventListener() {},
        appendChild(child) { node.children.push(child); },
        querySelector(selector) {
            if (!descendants.has(selector)) {
                const markup = selector.startsWith('#') ? `id="${selector.slice(1)}"` : `<${selector}`;
                assert.ok(html.includes(markup), selector);
                descendants.set(selector, mockElement());
            }
            return descendants.get(selector);
        }
    };
    return node;
}

function adminBrowser() {
    const sockets = [];
    const elements = new Map();
    const readers = [];
    function mockStorage() {
        const saved = new Map();
        return {
            getItem: key => saved.get(key) ?? null,
            setItem: (key, value) => saved.set(key, String(value)),
            removeItem: key => saved.delete(key)
        };
    }
    const element = id => {
        if (!elements.has(id)) elements.set(id, mockElement(id));
        return elements.get(id);
    };
    const context = vm.createContext({
        io() {
            const socket = mockSocket();
            sockets.push(socket);
            return socket;
        },
        document: {
            getElementById: element,
            createElement() { return mockElement(); },
            querySelectorAll(selector) {
                assert.equal(selector, '.panel');
                return panelIds.map(element);
            }
        },
        window: {},
        console: { log() {}, error() {}, warn() {} },
        localStorage: mockStorage(),
        sessionStorage: mockStorage(),
        crypto: webcrypto,
        CryptoJS: { SHA256: digest },
        FileReader: class {
            readAsDataURL() { readers.push(this); }
        },
        setTimeout() { return 1; },
        clearTimeout() {},
        alert() {},
        confirm() { return true; }
    });
    const evaluate = code => vm.runInContext(code, context);
    evaluate(adminScript);
    element('admin-login-account').value = account;
    element('admin-login-password').value = password;
    return {
        sockets, readers, element, evaluate,
        login() {
            evaluate('adminLogin()');
            assert.equal(sockets.length, 1);
            return sockets[0];
        },
        mainVisible() { return !element('main-container').classList.contains('hidden'); },
        loginVisible() { return !element('login-container').classList.contains('hidden'); }
    };
}

function checkChallenge(socket, id, key) {
    assert.deepEqual(socket.outbound.at(-1), {
        id, message: { type: 'login', accountId: account, isAdminLogin: true }
    });
    socket.receiveMessage({ type: 'login-key', key });
    assert.deepEqual(socket.outbound.at(-1), {
        id, message: { type: 'login', accountId: account, isAdminLogin: true, key, password: digest(password + key) }
    });
}

function authorize(socket) {
    socket.receiveMessage({ type: 'login-success', accountId: account, isAdmin: true });
}

function startAdminSession(browser) {
    const socket = browser.login();
    socket.receiveConnect('first');
    checkChallenge(socket, 'first', 'first-key');
    authorize(socket);
    return socket;
}

function checkInitialQueries(socket, id) {
    const commands = socket.outbound
        .filter(item => item.id === id && item.message.type !== 'login')
        .map(item => item.message.type);
    for (const query of initialQueries) assert.ok(commands.includes(query), query);
}

test('登录挑战和管理查询使用同一连接，认证前不发送管理请求', () => {
    const browser = adminBrowser();
    const socket = browser.login();
    socket.receiveConnect('first');
    checkChallenge(socket, 'first', 'first-key');

    browser.evaluate('refreshRoomsStatus(); loadVersions();');
    assert.deepEqual(socket.outbound.map(item => item.message.type), ['login', 'login']);
    assert.equal(browser.mainVisible(), false);
    assert.equal(browser.loginVisible(), true);

    authorize(socket);
    assert.equal(browser.sockets.length, 1);
    assert.equal(browser.mainVisible(), true);
    assert.equal(browser.loginVisible(), false);
    checkInitialQueries(socket, 'first');
    browser.evaluate('loadVersions()');
    assert.deepEqual(socket.outbound.at(-1), { id: 'first', message: { type: 'get-versions' } });
});

test('断线隐藏管理页，同一 Socket 新连接重新认证后刷新状态', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);

    socket.sendBuffer.push({ data: ['message', { type: 'update-versions' }] });
    socket.receiveDisconnect();
    assert.equal(socket.sendBuffer.length, 0);
    assert.equal(browser.mainVisible(), false);
    assert.equal(browser.loginVisible(), true);
    assert.match(browser.element('admin-login-error').textContent, /断开|重连|恢复/);
    const beforeReconnect = socket.outbound.length;
    browser.evaluate('refreshRoomsStatus()');
    assert.equal(socket.outbound.length, beforeReconnect);

    socket.receiveConnect('reconnected');
    checkChallenge(socket, 'reconnected', 'next-key');
    socket.receiveMessage({ type: 'versions-result', data: { clientVersion: 'stale', groupPurchasingVersion: 'stale' } });
    assert.notEqual(browser.element('current-client-version').textContent, 'stale');
    browser.evaluate('loadVersions()');
    assert.deepEqual(socket.outbound.slice(beforeReconnect).map(item => item.message.type), ['login', 'login']);
    assert.equal(browser.mainVisible(), false);

    authorize(socket);
    assert.equal(browser.sockets.length, 1);
    assert.equal(browser.mainVisible(), true);
    assert.equal(browser.loginVisible(), false);
    checkInitialQueries(socket, 'reconnected');
});

test('新连接未应答登录挑战时，旧认证结果不能恢复管理页', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    socket.receiveDisconnect();
    const beforeReconnect = socket.outbound.length;
    socket.receiveConnect('reconnected');
    authorize(socket);

    assert.equal(browser.mainVisible(), false);
    assert.equal(browser.loginVisible(), true);
    assert.deepEqual(socket.outbound.slice(beforeReconnect).map(item => item.message.type), ['login']);
});

for (const [label, reply] of [
    ['普通账号', { accountId: account, isAdmin: false }],
    ['管理员字段不是布尔值', { accountId: account, isAdmin: 'true' }],
    ['账号不匹配', { accountId: 'another-account', isAdmin: true }],
    ['缺少账号', { isAdmin: true }]
]) {
    test(`拒绝恢复管理页：${label}`, () => {
        const browser = adminBrowser();
        const socket = startAdminSession(browser);
        socket.receiveDisconnect();
        const beforeReconnect = socket.outbound.length;
        socket.receiveConnect('reconnected');
        checkChallenge(socket, 'reconnected', 'next-key');
        socket.receiveMessage({ type: 'login-success', ...reply });

        browser.evaluate('refreshRoomsStatus()');
        assert.equal(browser.mainVisible(), false);
        assert.deepEqual(socket.outbound.slice(beforeReconnect).map(item => item.message.type), ['login', 'login']);
    });
}

test('主动退出后不接受旧 Socket 的迟到连接和管理员认证结果', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    browser.evaluate('logout()');
    assert.equal(socket.connected, false);
    const sentBefore = socket.outbound.length;

    socket.receiveConnect('stale');
    socket.receiveMessage({ type: 'login-key', key: 'stale-key' });
    authorize(socket);
    browser.evaluate('refreshRoomsStatus()');
    assert.equal(browser.mainVisible(), false);
    assert.equal(browser.loginVisible(), true);
    assert.equal(socket.outbound.length, sentBefore);
});

test('断线前开始读取的上传分片不会在重新认证后进入新连接', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    browser.evaluate("const testUpload = {name:'mojang.zip', size:1, slice:()=>({})}; uploadFile(testUpload, 'upload-client-package', () => {});");
    assert.equal(browser.readers.length, 1);
    const finishOldRead = browser.readers[0].onload;

    socket.receiveDisconnect();
    socket.receiveConnect('reconnected');
    checkChallenge(socket, 'reconnected', 'next-key');
    authorize(socket);
    browser.evaluate("uploadFile(testUpload, 'upload-client-package', () => {});");
    assert.equal(browser.readers.length, 2);
    const fileResult = { target: { result: 'data:application/zip;base64,QQ==' } };
    finishOldRead(fileResult);
    assert.equal(socket.outbound.some(item => item.message.type === 'upload-client-package'), false);
    browser.readers[1].onload(fileResult);
    const parts = socket.outbound.filter(item => item.message.type === 'upload-client-package');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].id, 'reconnected');
    assert.equal(parts[0].message.isFirstChunk, true);
});

test('房间用户按当前房间显示，强制下线回执刷新房间与概览', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    const roomSelect = browser.element('admin-room-select');
    const properties = browser.element('room-properties-output');
    const users = browser.element('room-users-output');
    const roster = roomName => ({
        type: 'room-users',
        roomProperties: { name: roomName, mode: 'random', count: 2 },
        users: [{ accountId: 'test-member', username: '队员', uid: '100000001', online: true }]
    });
    roomSelect.value = 'room-A';
    browser.evaluate('loadRoomUsers()');
    roomSelect.value = 'room-B';
    browser.evaluate('loadRoomUsers()');
    socket.receiveMessage(roster('room-A'));
    assert.match(properties.textContent, /正在加载/);
    assert.equal(users.children.length, 0);

    socket.receiveMessage(roster('room-B'));
    assert.match(properties.innerHTML, /room-B/);
    assert.equal(users.children.length, 1);
    users.children[0].querySelector('button').onclick();
    assert.deepEqual(socket.outbound.at(-1).message, {
        type: 'toggle-user-status', uid: '100000001', roomName: 'room-B'
    });

    const sentBefore = socket.outbound.length;
    socket.receiveMessage({ type: 'user-offline-success', data: { room: 'room-B', uid: '100000001' } });
    assert.deepEqual(socket.outbound.slice(sentBefore).map(item => item.message), [
        { type: 'get-rooms-status' },
        { type: 'get-room-users', roomName: 'room-B' }
    ]);
});

test('切换账号后忽略旧账号详情和权限确认，当前账号仍能更新房权', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    const userSelect = browser.element('admin-user-select');
    const details = browser.element('user-info-output');
    const permissions = browser.element('room-permissions-output');
    const userInfo = (accountId, room) => ({ type: 'user-info', data: { account: accountId, rooms: [room] } });
    const rooms = { type: 'all-rooms', data: ['room-A', 'room-B'] };
    const permissionRow = () => permissions.children[0].children[0].children[0];

    userSelect.value = 'user-A';
    browser.evaluate('loadUserInfo()');
    socket.receiveMessage(userInfo('user-A', 'room-A'));
    socket.receiveMessage(rooms);
    assert.match(permissionRow().innerHTML, /room-A/);
    permissionRow().querySelector('button').onclick();
    assert.equal(browser.element('custom-modal').style.display, 'flex');
    userSelect.value = 'user-B';
    browser.evaluate('loadUserInfo()');
    const beforeOldReplies = socket.outbound.length;
    browser.evaluate('closeCustomModal(true)');
    socket.receiveMessage(userInfo('user-A', 'room-A'));
    socket.receiveMessage(rooms);
    assert.equal(socket.outbound.length, beforeOldReplies);
    assert.match(details.textContent, /正在加载/);
    assert.equal(permissions.children.length, 0);

    socket.receiveMessage(userInfo('user-B', 'room-B'));
    socket.receiveMessage(rooms);
    assert.match(details.innerHTML, /user-B/);
    assert.match(permissionRow().innerHTML, /room-B/);
    permissionRow().querySelector('button').onclick();
    browser.evaluate('closeCustomModal(true)');
    assert.deepEqual(socket.outbound.at(-1).message, {
        type: 'update-room-permission', accountId: 'user-B', room: 'room-B', isGranted: false
    });
});

test('信任和冻结传递明确状态，调分重试保留编号并按回执清理', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    const accountId = 'test-member';
    const selectUser = () => {
        browser.element('admin-user-select').value = accountId;
        browser.evaluate('loadUserInfo()');
    };
    const receiveUser = value => socket.receiveMessage({
        type: 'user-info', data: { account: accountId, safe: value, isFrozen: value }
    });
    const editPoints = value => {
        browser.element('edit-points-input').value = String(value);
        browser.element('user-info-output').querySelector('button').onclick();
        browser.evaluate('closeCustomModal(true)');
        const { message } = socket.outbound.at(-1);
        assert.deepEqual(message, {
            type: 'edit-user-points', accountId, pointsChange: value, operationId: message.operationId
        });
        assert.match(message.operationId, /^[a-f0-9]{32}$/);
        return message.operationId;
    };
    const ack = operationId => socket.receiveMessage({ type: 'success', operationId, message: '积分已更新' });

    selectUser();
    for (const value of [false, true]) {
        receiveUser(value);
        browser.element('safe-user-btn').onclick();
        assert.deepEqual(socket.outbound.at(-1).message, { type: 'toggle-safe-user', accountId, safe: !value });
        browser.element('freeze-user-btn').onclick();
        assert.deepEqual(socket.outbound.at(-1).message, { type: 'toggle-freeze-user', accountId, isFrozen: !value });
    }
    const firstId = editPoints(5);
    const otherId = editPoints(-1);
    assert.notEqual(firstId, otherId);

    socket.receiveDisconnect();
    socket.receiveConnect('reconnected');
    checkChallenge(socket, 'reconnected', 'next-key');
    authorize(socket);
    selectUser();
    receiveUser(false);
    assert.equal(editPoints(5), firstId);
    ack(otherId);
    receiveUser(false);
    assert.equal(editPoints(5), firstId);
    ack(firstId);
    receiveUser(false);
    assert.notEqual(editPoints(5), firstId);
});

test('总控页签位于管理导航，冻结切换需要确认和本次回执', () => {
    const navigation = adminPage.match(/<div class="flex-row admin-nav"[^>]*>([\s\S]*?)<\/div>/)[1];
    const tabs = Array.from(navigation.matchAll(/onclick="(switchTo\w+)\(\)"/g), match => match[1]);
    const tabIndex = tabs.indexOf('switchToServerControl');
    assert.ok(tabIndex > 0);
    assert.equal(tabs[tabIndex - 1], 'switchToGainRecords');
    assert.equal(tabs[tabIndex + 1], 'switchToRoomManagement');
    assert.ok(panelIds.includes('server-control-panel'));

    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    const freeze = browser.element('group-purchasing-freeze-btn');
    const status = browser.element('group-purchasing-status');
    const reply = (requestType, groupPurchasingFrozen) => socket.receiveMessage({
        type: 'server-control-status', requestType, groupPurchasingFrozen
    });
    const broadcast = groupPurchasingFrozen => socket.receiveMessage({ type: 'server-control-status', groupPurchasingFrozen });
    const sentBefore = socket.outbound.length;
    browser.evaluate('switchToServerControl(); refreshServerControl(); confirmGroupPurchasingFreeze()');
    assert.equal(browser.element('server-control-panel').classList.contains('active'), true);
    assert.equal(browser.element('rooms-status-panel').classList.contains('active'), false);
    assert.equal(freeze.disabled, true);
    assert.deepEqual(socket.outbound.slice(sentBefore).map(item => item.message), [{ type: 'get-server-control' }]);

    reply('get-server-control', false);
    assert.match(status.textContent, /已开放/);
    assert.match(freeze.textContent, /^冻结/);
    const beforeConfirm = socket.outbound.length;
    browser.evaluate('confirmGroupPurchasingFreeze()');
    assert.equal(browser.element('custom-modal').style.display, 'flex');
    assert.equal(socket.outbound.length, beforeConfirm);
    browser.evaluate('closeCustomModal(false)');
    assert.equal(socket.outbound.length, beforeConfirm);

    browser.evaluate('confirmGroupPurchasingFreeze(); closeCustomModal(true); confirmGroupPurchasingFreeze(); closeCustomModal(true)');
    assert.deepEqual(socket.outbound.slice(beforeConfirm).map(item => item.message), [
        { type: 'set-group-purchasing-frozen', frozen: true }
    ]);
    broadcast(true);
    assert.match(status.textContent, /已冻结/);
    assert.equal(freeze.disabled, true);
    reply('set-group-purchasing-frozen', true);
    assert.equal(freeze.disabled, false);
    assert.match(freeze.textContent, /^解冻/);

    browser.evaluate('confirmGroupPurchasingFreeze(); closeCustomModal(true)');
    assert.deepEqual(socket.outbound.at(-1).message, { type: 'set-group-purchasing-frozen', frozen: false });
    reply('set-group-purchasing-frozen', false);
    assert.match(status.textContent, /已开放/);
    broadcast(true);
    assert.match(status.textContent, /已冻结/);
    assert.equal(freeze.disabled, false);
});

test('全体解冻与重启分别等待回执，重复确认和无关错误不会再提交', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    browser.evaluate('switchToServerControl()');
    socket.receiveMessage({
        type: 'server-control-status', requestType: 'get-server-control', groupPurchasingFrozen: true
    });
    const unfreeze = browser.element('unfreeze-all-users-btn');
    const restart = browser.element('restart-server-btn');
    const notice = browser.element('server-control-notice');
    const sentBefore = socket.outbound.length;
    browser.evaluate('confirmUnfreezeAllUsers()');
    assert.equal(socket.outbound.length, sentBefore);
    browser.evaluate('closeCustomModal(true); confirmUnfreezeAllUsers(); closeCustomModal(true)');
    assert.equal(unfreeze.disabled, true);
    assert.equal(restart.disabled, true);
    assert.deepEqual(socket.outbound.slice(sentBefore).map(item => item.message), [{ type: 'unfreeze-all-users' }]);
    socket.receiveMessage({ type: 'error', requestType: 'restart-server', message: '旧重启错误' });
    assert.equal(unfreeze.disabled, true);
    socket.receiveMessage({ type: 'unfreeze-all-users-success', count: 3 });
    assert.match(notice.textContent, /3 个账号/);
    assert.equal(unfreeze.disabled, false);

    const beforeRestart = socket.outbound.length;
    browser.evaluate('confirmRestartServer(); closeCustomModal(false)');
    assert.equal(socket.outbound.length, beforeRestart);
    browser.evaluate('confirmRestartServer(); closeCustomModal(true); confirmRestartServer(); closeCustomModal(true)');
    assert.deepEqual(socket.outbound.slice(beforeRestart).map(item => item.message), [{ type: 'restart-server' }]);
    socket.receiveMessage({ type: 'restart-server-accepted' });
    assert.equal(restart.disabled, true);
    assert.equal(unfreeze.disabled, false);
    assert.match(notice.textContent, /已受理/);
    browser.evaluate('confirmRestartServer(); closeCustomModal(true)');
    assert.equal(socket.outbound.length, beforeRestart + 1);

    socket.receiveMessage({ type: 'error', requestType: 'restart-server', message: '重启执行失败' });
    assert.equal(restart.disabled, false);
    assert.match(notice.textContent, /重启执行失败/);
});

test('总控断线回收等待请求和旧确认，重新认证后按新状态操作', () => {
    const browser = adminBrowser();
    const socket = startAdminSession(browser);
    const card = browser.element('server-control-panel');
    const freeze = browser.element('group-purchasing-freeze-btn');
    const status = browser.element('group-purchasing-status');
    browser.evaluate('switchToServerControl()');
    socket.receiveMessage({
        type: 'server-control-status', requestType: 'get-server-control', groupPurchasingFrozen: true
    });
    browser.evaluate('confirmRestartServer()');
    socket.receiveDisconnect();
    assert.equal(freeze.disabled, true);
    assert.match(status.textContent, /未知/);
    assert.equal(browser.element('custom-modal').style.display, 'none');
    assert.equal(browser.mainVisible(), false);
    const beforeReconnect = socket.outbound.length;
    socket.receiveConnect('reconnected');
    checkChallenge(socket, 'reconnected', 'next-key');
    browser.evaluate('switchToServerControl(); closeCustomModal(true)');
    assert.deepEqual(socket.outbound.slice(beforeReconnect).map(item => item.message.type), ['login', 'login']);
    authorize(socket);
    assert.equal(card.classList.contains('active'), false);
    browser.evaluate('switchToServerControl()');
    assert.deepEqual(socket.outbound.at(-1).message, { type: 'get-server-control' });
    socket.receiveMessage({
        type: 'server-control-status', requestType: 'get-server-control', groupPurchasingFrozen: false
    });
    assert.match(status.textContent, /已开放/);

    browser.evaluate('confirmRestartServer(); closeCustomModal(true)');
    assert.equal(browser.element('restart-server-btn').disabled, true);
    socket.receiveDisconnect();
    assert.equal(browser.element('restart-server-btn').disabled, false);
    assert.equal(browser.element('server-control-notice').textContent, '');
});
