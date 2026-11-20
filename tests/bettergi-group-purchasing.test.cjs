const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const group = 'ArtifactsGroupPurchasing';
const solo = 'AAA-Artifacts-Bulk-Supply';
const noop = () => {};

// 只延迟脚本入口，测试直接调用发布脚本的主流程和函数。文件读写均在内存中。
function loadScript(name) {
    const writes = new Map();
    const filename = path.join(__dirname, '..', 'js', name, 'main.js');
    const source = fs.readFileSync(filename, 'utf8');
    const script = source.replace('(async function () {', 'const runMain = (async function () {')
        .replace(/\n\}\)\(\);/, '\n});');
    const ctx = vm.createContext({
        settings: { groupMode: '手动进入后运行', runExtra: true, autoOnline: '测试-100000001-房间', accountName: '测试' },
        file: {
            ReadImageMatSync: name => name,
            ReadTextSync: () => JSON.stringify({ onlineInfo: { gameName: '测试' } }),
            writeText: (name, value) => writes.set(name, value)
        },
        RecognitionObject: { TemplateMatch: name => name, ocr: (_x, y) => y },
        log: { info: noop, warn: noop, error: noop },
        notification: { send: noop, Send: noop },
        genshin: { returnMainUi: noop, tpToStatueOfTheSeven: noop, clearPartyCache: noop },
        setGameMetrics: noop, dispatcher: { AddTrigger: noop }, RealtimeTimer: class {},
        sleep: noop, moveMouseTo: noop, keyPress: noop
    });
    vm.runInContext(script, ctx, { filename });
    ctx.findAndClick = () => true;
    return { ctx, run: expression => vm.runInContext(expression, ctx), writes };
}

function supplyOcr(ctx, stored, total) {
    ctx.numberTemplateMatch = templates => {
        if (templates === 'assets/已储存经验数字') return stored.shift();
        if (templates === 'assets/分解可获得经验数字') return total.shift();
        return 1000; // 批发脚本另读一次分解数量
    };
}

for (const name of [group, solo]) {
    test(name + ' 分解经验只计算选中圣遗物的增量', async () => {
        const { ctx } = loadScript(name);
        for (const [stored, total, expected] of [
            [1200, 1200, 0], [1200, 1800, 600], [0, 0, 0], [1200, 900, null],
            [-1, 1800, null], [1200, -1, null]
        ]) {
            supplyOcr(ctx, [stored], [total]);
            assert.equal(await ctx.processArtifacts(), expected);
        }
    });

    test(name + ' 收益命令保留另一项有效读数', async () => {
        for (const [stored, totals, balances, expected] of [
            [[1200, 1200], [1200, 900], [500, 550], { moraGain: 50 }],
            [[1200, 1200], [1200, 1500], [null, 550], { expGain: 300 }],
            [[1200, 1200], [1200, 1200], [500, 500], { expGain: 0, moraGain: 0 }],
            [[1200, 1200], [-1, 1500], [null, 550], null]
        ]) {
            const { ctx, run, writes } = loadScript(name);
            supplyOcr(ctx, stored, totals);
            ctx.mora = () => balances.shift();
            ctx.loadTargetItems = noop;
            if (name === group) {
                ctx.readOnlineRecord = ctx.switchPartyIfNeeded = ctx.runGroupPurchasing = ctx.handleOnlineRecordAndReonline = noop;
            } else {
                ctx.readRecord = () => run('record.records = []');
                ctx.readCDInfo = ctx.writeCDInfo = ctx.writeRecord = noop;
                ctx.runNormalPath = ctx.runActivatePath = ctx.runEndingAndExtraPath = noop;
            }
            await run('runMain()');
            if (expected === null) {
                assert.equal(writes.has('command.json'), false);
            } else {
                const { command, params } = JSON.parse(writes.get('command.json'));
                assert.equal(command, 'report-gain');
                const { reportId, gameAccount, ...gains } = params;
                assert.ok(reportId);
                assert.equal(gameAccount, '测试');
                assert.deepEqual(gains, expected);
            }
        }
    });
}

test('F2 实际进场顺序可不同于发车席位，重名、未识别或名单变化不能确定缺席者', async () => {
    const { ctx } = loadScript(group);
    const names = ['房主', '乙', '丙', '丁'];
    for (let i = 0; i < names.length; i++) {
        ctx.settings['p' + (i + 1) + 'Name'] = names[i];
        ctx.settings['p' + (i + 1) + 'UID'] = String(100000001 + i);
    }
    const observe = async (first, second = first) => {
        const observations = [first, second];
        ctx.captureGameRegion = () => {
            const rows = observations.shift();
            let slot = 0;
            return {
                findMulti: y => (rows[(y - 146) / 125 - 1] || []).map(text => ({ text })),
                Find: () => ({ isExist: () => slot++ < rows.length }),
                dispose: noop
            };
        };
        return JSON.parse(JSON.stringify(await ctx.collectHostEvidence()));
    };
    const rows = [['UID: 100000004'], ['乙']];
    assert.deepEqual(await observe(rows), { enteredUids: ['100000002', '100000004'], missingUids: ['100000003'] });
    assert.equal((await observe([['丁'], ['未知']])).missingUids, undefined);
    assert.equal((await observe(rows, [['乙']])).missingUids, undefined);
    assert.equal((await observe([])).missingUids, undefined);
    ctx.settings.p3Name = '乙';
    assert.equal((await observe(rows)).missingUids, undefined);
});

test('队员按目标 UID 入场后直接占位，期间无需再次打开 F2、核验名片或主动退队', async () => {
    const { ctx, run } = loadScript(group);
    ctx.settings.groupMode = '使用JSON配置文件';
    ctx.settings.runExtra = false;
    ctx.file.ReadTextSync = () => JSON.stringify({
        myPosition: '2',
        teamMembers: [
            { position: '1', uid: '100000001', username: '房主' },
            { position: '2', uid: '100000002', username: '队员' }
        ],
        onlineInfo: { gameName: '队员', rideIdentifier: '测试车次' }
    });
    const steps = [];
    const signs = [0, 2, 2, 0, 0];
    ctx.readOnlineRecord = ctx.switchPartyIfNeeded = ctx.loadTargetItems = noop;
    ctx.getPlayerSign = () => {
        assert.ok(signs.length, '队员不应反复申请入场或退队');
        return signs.shift();
    };
    ctx.keyPress = key => steps.push(key);
    ctx.inputText = uid => steps.push(uid);
    ctx.findAndClick = target => {
        if (target.endsWith('/requestEnter.png')) steps.push('申请加入');
        if (target.endsWith('/leaveTeam.png')) steps.push('主动退队');
        return true;
    };
    ctx.captureGameRegion = () => ({
        find: () => ({ isExist: () => false }),
        findMulti: () => assert.fail('入场成功后不应 OCR 核验房主名片'),
        dispose: noop
    });
    ctx.waitForMainUI = ctx.isMainUI = () => true;
    ctx.genshin.getPositionFromMap = () => ({ x: 14031, y: 440 });
    ctx.readFolder = folder => folder === 'targets' ? [] : [{ fullPath: folder + '/路线.json' }];
    ctx.runPath = file => steps.push(file);
    ctx.handleOnlineRecordAndReonline = crashed => {
        assert.equal(crashed, false);
        steps.push('成功收尾');
    };

    await run('runMain()');
    assert.deepEqual(steps, ['F2', '100000001', '申请加入', 'assets/ArtifactsPath/度假村/占位/路线.json', '成功收尾']);
});

test('凌晨四点跨日、重复回执与只当队员偏好共同决定是否重新上线', async () => {
    const { ctx, run } = loadScript(group);
    const now = Date.parse('2026-11-18T20:00:01Z');
    ctx.Date = class extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    };
    const calls = [];
    ctx.settings.groupMode = '使用JSON配置文件';
    ctx.settings.autoReonline = 1;
    ctx.settings.afterOneDragon = '收尾';
    ctx.generateReonlineCommand = info => calls.push(info.notHost ? '队员' : '可当房主');
    ctx.generateOneDragonCommand = name => calls.push(name);
    run("matchInfo = {myPosition: '2', onlineInfo: {rideIdentifier: 'R', notHost: true, memberOnly: false}}");
    run("onlineRecord.todayRecords = [{isCrash:false, isHost:true, endTime:'2026-11-18T19:59:59Z'}]");
    await ctx.handleOnlineRecordAndReonline(false);
    await ctx.handleOnlineRecordAndReonline(false);
    assert.deepEqual(calls, ['可当房主', '可当房主']);
    assert.equal(run('onlineRecord.todayRecords.length'), 1);
    run('matchInfo.onlineInfo.memberOnly = true');
    await ctx.handleOnlineRecordAndReonline(false);
    assert.equal(calls.at(-1), '收尾');
    run('delete matchInfo.onlineInfo.memberOnly');
    await ctx.handleOnlineRecordAndReonline(false);
    assert.equal(calls.at(-1), '收尾');
});

test('占位路线重跑失败或取消时，主流程传播原异常并停止等待和成功记账', async () => {
    for (const failure of [new Error('路线执行失败'), new Error('A task was canceled.')]) {
        const { ctx, run, writes } = loadScript(group);
        ctx.settings.runExtra = false;
        ctx.readOnlineRecord = ctx.switchPartyIfNeeded = ctx.loadTargetItems = noop;
        ctx.getPlayerSign = () => 2;
        ctx.readFolder = () => [{ fullPath: '占位路线.json' }];
        ctx.genshin.getPositionFromMap = () => ({ x: 2298, y: -824 });
        let runs = 0;
        ctx.runPath = async () => {
            if (++runs === 2) throw failure;
        };
        ctx.isMainUI = () => assert.fail('不应进入占位等待');
        ctx.handleOnlineRecordAndReonline = () => assert.fail('不应记录成功或再次上线');
        const logs = [];
        ctx.log.info = message => logs.push(message);
        await assert.rejects(run('runMain()'), error => error === failure);
        assert.equal(runs, 2);
        assert.equal(logs.some(message => message.includes('全部路线已完成')), false);
        assert.equal(writes.size, 0);
    }
});
