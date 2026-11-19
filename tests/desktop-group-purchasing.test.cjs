const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const renderer = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function desktop() {
    let now = Date.now();
    const sent = [];
    const logs = [];
    const storage = new Map();
    const files = new Set();
    const elements = new Map();
    const api = {
        consumeCommand: async (_file, id) => files.delete(id),
        onUpdateProgress: () => () => {},
        installUpdate: async () => { throw new Error('模拟失败'); }
    };
    const context = vm.createContext({
        window: { addEventListener() {}, electronAPI: api },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { classList: { contains: () => false }, style: {}, textContent: '' });
            return elements.get(id);
        } },
        localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
        crypto: { randomUUID }, Date: class extends Date { static now() { return now; } },
        setTimeout: () => 1, clearTimeout() {}, sent, logs
    });
    const run = code => vm.runInContext(code, context);
    run(renderer);
    run(`
        addLog = (msg, type) => logs.push({ msg, type });
        bindCommandAccount('甲');
        currentRideIdentifier = '车一';
        supportsReportAck = true;
        isLoggedIn = false;
        socket = {connected:false, emit: (_name, message) => sent.push(message)};
    `);
    function snapshot(id) {
        const content = {
            'mojiang-command': true, command: 'report-gain', params: { reportId: id, rideIdentifier: '车一', gameAccount: '游戏名', expGain: 1 },
            'command*': 'online', 'params*': { username: '游戏名', uid: '123456789', room: '测试房间' }
        };
        files.add(id);
        context.snapshot = { id, content: JSON.stringify(content), modified: now };
    }
    return { run, sent, api, logs, snapshot, advance(ms) { now += ms; },
        consume: () => run("consumeFileCommand('command.json', snapshot)"),
        reconnect: () => run('isLoggedIn = true; socket.connected = true; processRetryQueue()') };
}

test('暂时断线后同账号同车恢复，文件内报告等待回执，上线只执行一次', async () => {
    const d = desktop();
    d.snapshot('one');
    const claims = await Promise.all([d.consume(), d.consume()]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(d.sent.length, 0);
    d.reconnect();
    d.run("handleReportAck({reportId:'one', success:true})");
    await d.consume();
    d.reconnect();
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain', 'user-online'], JSON.stringify(d.logs));
    assert.equal(d.run('readReportQueue().size'), 0);
});

test('永久断线时控制到期释放，收益保留到重新送达', async () => {
    const d = desktop();
    d.snapshot('expired');
    await d.consume();
    d.advance(5 * 60 * 1000);
    d.run('processRetryQueue()');
    assert.equal(d.run('pendingFileControls.size'), 0);
    assert.equal(d.run('readReportQueue().size'), 1);
    d.reconnect();
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain']);
});

test('重连前切换账号，已消费及仍在文件中的旧命令均不归给新账号', async () => {
    const d = desktop();
    d.snapshot('old-account');
    await d.consume();
    d.snapshot('unclaimed');
    d.advance(50);
    d.run("bindCommandAccount('乙'); retryQueue = readReportQueue()");
    await d.consume();
    d.reconnect();
    assert.deepEqual(d.sent, []);
    assert.equal(d.run('readReportQueue().size'), 0);
    d.run("bindCommandAccount('甲'); retryQueue = readReportQueue()");
    d.reconnect();
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain']);
});

test('暂断后已开始另一车，只送达之前的报告', async () => {
    const d = desktop();
    d.snapshot('old-ride');
    await d.consume();
    d.run("preparedRide = {rideId:'车二'}");
    d.reconnect();
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain']);
});

test('团购更新失败、取消返回相应结果，成功才记录完成', async () => {
    const d = desktop();
    d.run('groupFolders = () => ["测试目录"]; closeVersionCheckModal = () => {}; showUpdateUI = () => {}');
    assert.equal((await d.run('downloadGroupUpdate()')).success, false);
    assert.equal((await d.run("installUpdate('groupPurchasing', {startup:true})")).success, false);
    let rejectInstall;
    d.api.installUpdate = () => new Promise((_resolve, reject) => { rejectInstall = reject; });
    d.api.cancelUpdate = () => rejectInstall(new Error('模拟取消'));
    const cancelled = d.run('downloadGroupUpdate()');
    d.run('currentDownloadController.abort()');
    assert.equal((await cancelled).cancelled, true);
    assert.equal(d.logs.filter(row => row.type === 'success').length, 0);
    d.api.installUpdate = async () => {};
    assert.equal((await d.run('downloadGroupUpdate()')).success, true);
    assert.equal(d.logs.filter(row => row.type === 'success').length, 1);
});


test('两条控制指令之间断线，恢复时只补发剩下的一条', async () => {
    const d = desktop();
    d.snapshot('between');
    d.run(`
        const batch = JSON.parse(snapshot.content);
        batch['command**'] = 'send-message';
        batch['params**'] = { content: '完成' };
        snapshot.content = JSON.stringify(batch);
    `);
    await d.consume();
    d.reconnect();
    d.run("handleReportAck({reportId:'between', success:true}); socket.connected=false");
    d.advance(500);
    d.run('drainFileControls()');
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain', 'user-online']);
    d.reconnect();
    d.reconnect();
    assert.deepEqual(d.sent.map(m => m.type), ['report-gain', 'user-online', 'custom-message']);
});

test('启动团购更新失败仍进入主界面，并保留失败结果', async () => {
    const d = desktop();
    d.run(`
        startupGroupUpdateAllowed = true;
        checkLocalGroupVersion = async () => '2.7.0';
        groupFolders = () => ['测试目录'];
        showMainApp = () => logs.push({msg:'主界面'});
        setTimeout = fn => { fn(); return 1; };
    `);
    await d.run("handleVersionInfo({data:{version:'2.2.0', groupPurchasingVersion:'2.8.0'}})");
    assert.equal(d.logs.some(row => row.msg.includes('更新失败：模拟失败')), true);
    assert.equal(d.logs.some(row => row.msg.includes('自动更新完成')), false);
    assert.equal(d.logs.some(row => row.msg === '主界面'), true);
});
