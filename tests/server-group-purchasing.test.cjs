const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '..', 'server', 'server.js');
const source = fs.readFileSync(filename, 'utf8');
const seats = ['A', 'B', 'C', 'D'].map(uid => ({
  uid, username: uid, socketId: uid, accountId: uid === 'C' ? 'B' : uid, notHost: uid !== 'A'
}));

function temporaryData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojang-server-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 每次创建独立的服务端运行环境。账本使用临时目录，监听、网络和定时任务由测试接管。
async function boot(dir) {
  const clock = { now: Date.parse('2024-03-01T04:30:00+08:00') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const messages = [];
  const sockets = new Map(seats.map(({ uid }) => [uid, {
    id: uid, connected: true,
    emit(_event, data) { messages.push({ uid, data }); }
  }]));
  let started, failed;
  const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
  const noop = () => {};
  const express = Object.assign(() => ({ get: noop, use: noop }), { static: noop });
  const disk = Object.create(fs);
  disk.appendFile = (_file, _data, callback) => callback(null);
  const modules = {
    express, fs: disk, path, crypto: require('node:crypto'),
    http: { createServer: () => ({ listen: started }) },
    'socket.io': () => ({ sockets: { sockets }, on: noop })
  };
  const ctx = vm.createContext({
    __dirname: dir, Date: ClockDate, Buffer,
    require(name) { assert(Object.hasOwn(modules, name), name); return modules[name]; },
    console: { log: noop, error: noop, warn: noop },
    process: { pid: process.pid, on: noop, exit: code => failed(new Error('初始化退出 ' + code)) },
    setTimeout(callback, delay) {
      if (delay === 2000) queueMicrotask(callback); // 图片传输后的发车延时
      return { unref: noop };
    },
    setInterval: () => ({ unref: noop }), clearTimeout: noop, clearInterval: noop
  });
  vm.runInContext(source, ctx, { filename });
  await ready;
  const get = name => vm.runInContext(name, ctx);
  for (const seat of seats) {
    const accounts = get('userAccounts');
    accounts[seat.accountId] ||= { points: 20, rooms: ['测试房间'] };
    const connections = get('userConnections');
    if (!connections.has(seat.accountId)) {
      connections.set(seat.accountId, { userInfo: { username: seat.accountId }, connections: [] });
    }
    connections.get(seat.accountId).connections.push(seat);
  }
  return {
    clock, disk, get, messages,
    async send(uid, message) { await get('handleReceivedMessage')(sockets.get(uid), message); },
    async openRide() {
      const room = { name: '测试房间', mode: 'random', count: 4, users: [...seats] };
      if (!get('rooms').some(r => r.name === room.name)) get('rooms').push(room);
      get('roomUsers').set(room.name, room);
      await get('checkAndHandleRideInternal')(room.name);
      const ride = [...get('RideManager').activeRides.values()][0];
      assert(ride, '房间应已匹配');
      return ride.record.rideId;
    },
    report(uid, rideId, evidence = {}) {
      get('handleReportCrash')({
        rideIdentifier: rideId, reportId: rideId + '-' + uid,
        crashInfo: { reporter: { uid }, crashType: uid === 'A' ? 'waitForExpectedPlayers' : 'playerTimeoutEnterWorld', ...evidence }
      }, sockets.get(uid));
      assert.equal(messages.at(-1).data.type, 'report-ack');
      assert.equal(messages.at(-1).data.success, true);
    },
    async ranking(gainType, date) {
      await get('handleGetGainRecords')({ gainType, date }, sockets.get('A'));
      const response = messages.at(-1).data;
      assert.equal(response.type, 'gain-records');
      return new Map(response.data.map(row => [row.gameAccount, row.expGain + row.moraGain]));
    }
  };
}

async function prepare(app, id, ackUids) {
  for (const { uid } of seats) {
    await app.send(uid, { type: 'ride-ready', rideId: id, uid, ready: true,
      supportsLaunchAck: ackUids.includes(uid), imageMeta: { hasImage: false } });
  }
}

test('按北京四点划分日榜、最近七天和最近四十二天，保留单日二十六万边界', async t => {
  const dir = temporaryData(t);
  const app = await boot(dir);
  const totals = { '2024-01-19': 1, '2024-01-20': 2, '2024-02-23': 4, '2024-02-24': 8,
    '2024-02-29': 16, '2024-03-01': 32 };
  for (const [date, points] of Object.entries(totals)) {
    const entries = [{ gameAccount: '周期', expGain: points }];
    if (date === '2024-03-01') entries.push(
      { gameAccount: '刚好达限', expGain: 130000, moraGain: 130000 },
      { gameAccount: '超限', expGain: 130000, moraGain: 130001 });
    fs.writeFileSync(path.join(dir, 'gainRecords', date + '.json'), JSON.stringify({ A: entries }));
  }
  for (const [time, date, day, week, version] of [
    ['03:59', '2024-02-29', 16, 28, 31],
    ['04:00', '2024-03-01', 32, 56, 62],
    ['07:59', '2024-03-01', 32, 56, 62]
  ]) {
    app.clock.now = Date.parse('2024-03-01T' + time + ':00+08:00');
    assert.equal(app.get('getTodayDateStr')(), date);
    for (const [type, expected] of [['day', day], ['week', week], ['version', version]]) {
      const result = await app.ranking(type, date);
      assert.equal(result.get('周期'), expected, type + ' ' + time);
      if (date === '2024-03-01') assert.equal(result.get('刚好达限'), 260000);
      assert(!result.has('超限'));
    }
  }
});

test('同一运行中从历史文件读回的车仍计冻结，重启前的车只结算积分', async t => {
  const dir = temporaryData(t);
  const app = await boot(dir);
  const pending = [];
  for (let n = 0; n < 3; n++) {
    const id = await app.openRide();
    await prepare(app, id, []);
    pending.push(id);
  }
  // 生产缓存仅保留最近1000车；释放内存记录，强制以下首次上报从日文件重新解析。
  app.get('rideRecords').length = 0;
  for (const id of pending.slice(0, 2)) {
    app.report('B', id);
    app.get('processCrashReports')(id);
  }
  assert.equal(app.get('userAccounts').B.isFrozen, true);
  const next = await boot(dir);
  next.get('userAccounts').B.isFrozen = false;
  next.report('B', pending[2]);
  const before = next.get('userAccounts').B.points;
  next.get('processCrashReports')(pending[2]);
  assert(next.get('userAccounts').B.points < before);
  assert.equal(next.get('crashFreezeState').get(next.get('userAccounts').B), undefined);
});

test('混合新旧桌面按席确认启动，账本已提交后断写历史可恢复', async t => {
  const dir = temporaryData(t);
  const app = await boot(dir);
  const id = await app.openRide();
  await prepare(app, id, ['B']);
  const launches = app.messages.filter(({ data }) => data.type === 'ride-message-2');
  assert.deepEqual(launches.map(({ data }) => [data.seatUid, data.requireLaunchAck]),
    [['A', false], ['B', true], ['C', false], ['D', false]]);
  await app.send('C', { type: 'ride-started', rideId: id, uid: 'B', success: true });
  assert.equal(app.get('userAccounts').A.points, 20);
  const rename = app.disk.renameSync;
  app.disk.renameSync = (from, to) => {
    if (path.dirname(to) === path.join(dir, 'rideRecords')) throw new Error('模拟日记录写入失败');
    rename(from, to);
  };
  await app.send('B', { type: 'ride-started', rideId: id, uid: 'B', success: true });
  assert.equal(app.get('userAccounts').A.points, 17);
  const next = await boot(dir);
  assert.equal(next.get('rideRecords').find(ride => ride.rideId === id).charged, true);
  assert.equal(next.get('userAccounts').A.points, 17);
  assert.equal(next.get('userAccounts').B.points, 23); // 两席基础分和一次首程奖励
});

test('BC 失败判 BC，全队 BCD 失败判 A，未确证的房主报告不覆盖队员自报', async t => {
  const app = await boot(temporaryData(t));
  const cases = [
    { failed: ['B', 'C'], expected: ['B', 'C'], host: { evidenceVersion: 2, enteredUids: [] } },
    { failed: ['B', 'C', 'D'], expected: ['A'] },
    { failed: ['B', 'C'], expected: ['C'], host: { evidenceVersion: 2, enteredUids: ['B'] } }
  ];
  for (const { failed, expected, host } of cases) {
    const id = await app.openRide();
    await prepare(app, id, []);
    if (host) app.report('A', id, host);
    for (const uid of failed) app.report(uid, id);
    app.report(failed[0], id);
    const window = app.get('pendingCrashRides').get(id);
    assert.equal(window.reports.length, failed.length + (host ? 1 : 0));
    assert.deepEqual([...app.get('determineFaultUids')(window.ride, window.reports)], expected);
    const accounts = app.get('userAccounts');
    const oldPoints = accounts.B.points;
    app.get('processCrashReports')(id);
    assert.equal(accounts.B.points - oldPoints, expected.includes('A') ? 0 : -8);
    app.report('D', id);
    assert(!app.get('pendingCrashRides').has(id));
  }
});

test('收益回执丢失后跨重启、跨四点重试保留真零且只落盘一次', async t => {
  const dir = temporaryData(t);
  const app = await boot(dir);
  const gain = { type: 'report-gain', reportId: 'g1', gameAccount: '角色', expGain: 0, moraGain: 150001 };
  app.clock.now = Date.parse('2024-03-01T03:59:00+08:00');
  await app.send('B', gain);
  assert.equal(app.messages.at(-1).data.success, true);
  const next = await boot(dir);
  await next.send('B', gain);
  assert.equal(next.messages.at(-1).data.success, true);
  const readDay = day => JSON.parse(fs.readFileSync(path.join(dir, 'gainRecords', day + '.json')));
  assert.equal(readDay('2024-02-29').B.length, 1);
  assert.equal(readDay('2024-02-29').B[0].expGain, 0);
  assert(!Object.hasOwn(readDay('2024-02-29').B[0], 'moraGain'));
  assert.equal(readDay('2024-03-01').B, undefined);
});
