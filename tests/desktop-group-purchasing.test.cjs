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

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

for (const transition of ['注销', '切号']) {
    test(transition + '后才返回的旧配置不会重新填入凭据或调度自动登录', async () => {
        const d = desktop();
        let reply;
        d.api.readFile = (_path, callback) => { reply = callback; };
        d.run(`
            const scheduled = [];
            setTimeout = fn => scheduled.push(fn);
            config = { dragonName:'当前设置' };
            document.getElementById('login-account').value = '乙';
            document.getElementById('login-password').value = '';
        `);
        const loading = d.run('loadConfig()');
        if (transition === '注销') {
            d.run("socket = null; document.getElementById('main-container').classList.add = () => {}; document.getElementById('login-container').classList.remove = () => {}; logout()");
        } else {
            d.run("bindCommandAccount('乙')");
        }
        reply(null, JSON.stringify({ autoLogin:{account:'甲', password:'旧凭据'}, dragonName:'迟到的设置' }));
        await loading;
        assert.equal(d.run("document.getElementById('login-account').value"), transition === '注销' ? '' : '乙');
        assert.equal(d.run("document.getElementById('login-password').value"), '');
        assert.equal(d.run("config.dragonName"), '当前设置');
        assert.equal(d.run('scheduled.length'), 0);
    });
}

function rideDesktop() {
    const d = desktop();
    const files = new Map();
    d.run(`
        socket.connected = isLoggedIn = true;
        getBgiFolderPath = () => '测试BGI';
        schedules = [{ trigger:{ type:'trigger-ride', config:{ uid:'1', username:'甲' }},
            action:{ type:'start-online-dragon', config:{ jsFolder:'同一目录', configName:'联机' } } }];
        const prepare = rideId => handleRideMessage1({ rideId, seatUid:'1',
            rideInfo:{ host:{ uid:'1', username:'甲' }, members:[], room:'测试房间' } });
    `);
    d.api.writeFile = (name, data, done) => { files.set(name, JSON.parse(data).onlineInfo.rideIdentifier); done(); };
    d.api.listImageMetadata = async () => ({ success:true, files:[] });
    return { d, files };
}

test('旧车扫描迟到，新车匹配信息已落盘后仍保持新车内容', async () => {
    const { d, files } = rideDesktop();
    const scanning = deferred(), release = deferred();
    d.api.listImageMetadata = async () => {
        scanning.resolve();
        await release.promise;
        return { success:true, files:[] };
    };
    const oldRide = d.run("prepare('旧车')");
    await scanning.promise;
    d.run("handleRideCancel({rideId:'旧车'})");
    d.api.listImageMetadata = async () => ({success:true, files:[]});
    await d.run("prepare('新车')");
    release.resolve();
    await oldRide;
    assert.equal(files.get('同一目录/匹配信息.json'), '新车');
    assert.deepEqual(d.sent.filter(m => m.ready).map(m => m.rideId), ['新车']);
});

test('已经提交的旧车匹配写入必须在新车扫描和落盘之前结束', async () => {
    const { d, files } = rideDesktop();
    const writing = deferred(), release = deferred();
    const write = d.api.writeFile;
    d.api.writeFile = async (name, data, done) => {
        if (JSON.parse(data).onlineInfo.rideIdentifier === '旧车') { writing.resolve(); await release.promise; }
        write(name, data, done);
    };
    const oldRide = d.run("prepare('旧车')");
    await writing.promise;
    d.run("handleRideCancel({rideId:'旧车'})");
    let scanned;
    d.api.listImageMetadata = async () => { scanned = files.get('同一目录/匹配信息.json'); return {success:true, files:[]}; };
    const newRide = d.run("prepare('新车')");
    release.resolve();
    await Promise.all([oldRide, newRide]);
    assert.equal(scanned, '旧车');
    assert.equal(files.get('同一目录/匹配信息.json'), '新车');
});

test('同目录旧车图片写盘期间换车，新车读取落盘结果且旧车余图不再写入', async () => {
    const { d, files } = rideDesktop();
    await d.run("prepare('旧车')");
    const writing = deferred(), release = deferred();
    d.api.saveImageFile = async (name, data) => {
        if (data === '旧图') { writing.resolve(); await release.promise; }
        files.set(name, data);
    };
    const oldImages = d.run(`handleRideImages({rideId:'旧车', images:[
        {fileName:'甲.png',imageData:'旧图'}, {fileName:'乙.png',imageData:'过期图片'}]}); preparedRide.images`);
    await writing.promise;
    d.run("handleRideCancel({rideId:'旧车'})");
    let scanned;
    d.api.listImageMetadata = async () => { scanned = files.get('同一目录/targets/甲.png'); return { success:true, files:[] }; };
    const newRide = d.run("prepare('新车')");
    release.resolve();
    await Promise.all([oldImages, newRide]);
    await d.run("handleRideImages({rideId:'新车',images:[{fileName:'甲.png',imageData:'新图'}]}); preparedRide.images");
    assert.equal(scanned, '旧图');
    assert.equal(files.get('同一目录/targets/甲.png'), '新图');
    assert.equal(files.has('同一目录/targets/乙.png'), false);
});
