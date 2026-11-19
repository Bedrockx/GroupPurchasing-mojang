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
