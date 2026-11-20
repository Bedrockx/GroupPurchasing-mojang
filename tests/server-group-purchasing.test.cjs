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
async function boot(dir, { now = Date.parse('2024-03-01T04:30:00+08:00'), execFile, onTimeout } = {}) {
  const clock = { now };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const messages = [];
  const sockets = new Map(seats.map(({ uid }) => [uid, {
    id: uid, connected: true,
    emit(_event, data) { messages.push({ uid, data }); }
  }]));
  let started, failed, onConnection;
  const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
  const noop = () => {};
  const express = Object.assign(() => ({ get: noop, use: noop }), { static: noop });
  const disk = Object.create(fs);
  disk.appendFile = (_file, _data, callback) => callback(null);
  const modules = {
    express, fs: disk, path, crypto: require('node:crypto'),
    ...(execFile ? { child_process: { execFile } } : {}),
    http: { createServer: () => ({ listen: started }) },
    'socket.io': () => ({
      sockets: { sockets },
      on(event, handler) { if (event === 'connection') onConnection = handler; }
    })
  };
  const ctx = vm.createContext({
    __dirname: dir, Date: ClockDate, Buffer,
    require(name) { assert(Object.hasOwn(modules, name), name); return modules[name]; },
    console: { log: noop, error: noop, warn: noop },
    process: { pid: process.pid, on: noop, exit: code => failed(new Error('初始化退出 ' + code)) },
    setTimeout(callback, delay) {
      onTimeout?.(callback, delay);
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
    connections.get(seat.accountId).connections.push({ ...seat });
  }
  return {
    clock, disk, get, messages,
    connect(id) {
      const handlers = new Map();
      const socket = {
        id, connected: true,
        emit(_event, data) { messages.push({ uid: id, data }); },
        on(event, handler) { handlers.set(event, handler); },
        disconnect() {
          this.connected = false;
          sockets.delete(id);
          handlers.get('disconnect')?.();
        }
      };
      sockets.set(id, socket);
      onConnection(socket);
      return socket;
    },
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

test('管理请求按连接鉴权，账户列表脱敏且房权落盘后回执', async t => {
  const app = await boot(temporaryData(t));
  const socketId = 'admin-socket';
  const accountId = 'B';
  const adminPassword = 'admin-fixture-only';
  app.get('adminAccounts')[accountId] = { username: '测试管理员', password: adminPassword };
  const admin = app.connect(socketId);
  const latest = () => app.messages.at(-1).data;

  const list = { type: 'get-all-accounts' };
  await app.send('A', list);
  assert.equal(latest().message, '权限不足');
  const login = { type: 'login', accountId, isAdminLogin: true };
  await app.send(socketId, login);
  const { type, key } = latest();
  assert.equal(type, 'login-key');
  const password = require('node:crypto').createHash('sha256').update(adminPassword + key).digest('hex');
  await app.send(socketId, { ...login, password, key });
  assert.equal(latest().type, 'login-success');
  assert.equal(latest().isAdmin, true);

  const users = app.get('userAccounts');
  Object.assign(users.B, { username: '测试用户', password: 'user-fixture-only', lastRide: app.clock.now });
  await app.send(socketId, list);
  assert.equal(latest().type, 'all-accounts');
  assert.deepEqual({ ...latest().data.B }, {
    username: '测试用户', isAdmin: false, isFrozen: false, lastRide: app.clock.now
  });

  const room = '测试房间';
  app.get('rooms').push({ name: room, mode: 'none', count: 4 });
  const revoke = { type: 'update-room-permission', accountId: 'B', room, isGranted: false };
  const accountsFile = app.get('USER_ACCOUNTS_FILE');
  await app.get('saveData')(accountsFile, users);
  const savedRooms = () => JSON.parse(fs.readFileSync(accountsFile, 'utf8')).B.rooms;
  const rename = app.disk.renameSync;
  const failAccountsRename = (from, to) => {
    if (to === accountsFile) throw new Error('模拟账户文件写入失败');
    rename(from, to);
  };
  app.disk.renameSync = failAccountsRename;
  const replyStart = app.messages.length;
  try {
    await app.send(socketId, revoke);
  } finally {
    app.disk.renameSync = rename;
  }
  assert.deepEqual(app.messages.slice(replyStart).map(reply => reply.data.type), ['error']);
  assert(users.B.rooms.includes(room));
  assert(savedRooms().includes(room));

  await app.send(socketId, revoke);
  assert.deepEqual({ ...latest() }, { ...revoke, type: 'permission-updated', message: '房间权限已移除' });
  assert(!users.B.rooms.includes(room));
  assert(!savedRooms().includes(room));

  const fromRoom = '测试源房间';
  app.get('rooms').push({ name: fromRoom, mode: 'none', count: 4 });
  users.B.rooms.push(fromRoom);
  const sourceRoom = app.get('getOrCreateRoom')(fromRoom);
  for (const seat of seats.slice(1, 3)) {
    sourceRoom.users.push({ ...seat });
    app.get('setConnectionUserInfo')(seat.socketId, { uid: seat.uid, roomName: fromRoom });
  }
  const move = { type: 'move-user', uid: 'B', fromRoom, toRoom: room };
  await app.send(socketId, { ...move, confirmGrantPermission: 'true' });
  assert.equal(latest().type, 'move-user-permission-required');
  const confirmedMove = { ...move, confirmGrantPermission: true };
  app.disk.renameSync = failAccountsRename;
  try {
    await app.send(socketId, confirmedMove);
  } finally {
    app.disk.renameSync = rename;
  }
  assert.equal(latest().type, 'error');
  assert(sourceRoom.users.some(user => user.uid === 'B'));
  assert(!users.B.rooms.includes(room));
  assert(!savedRooms().includes(room));
  await app.send(socketId, confirmedMove);
  assert(app.messages.some(reply => reply.uid === socketId && reply.data.type === 'user-moved'));
  assert(savedRooms().includes(room));
  await app.send(socketId, { type: 'get-online-users' });
  const connections = latest().data.find(user => user.accountId === 'B').sockets;
  assert.equal(connections.find(socket => socket.socketId === 'B').roomName, room);
  assert.equal(connections.find(socket => socket.socketId === 'C').roomName, fromRoom);
  await app.send(socketId, { type: 'toggle-user-status', uid: 'B', roomName: room });
  const offline = app.messages.findLast(reply => reply.uid === socketId && reply.data.type === 'user-offline-success');
  assert.deepEqual({ ...offline.data.data }, { uid: 'B', room });

  for (const requestType of ['upload-client-package', 'upload-group-purchasing-package', 'upload-asar']) {
    await app.send(socketId, { type: requestType, fileName: 'wrong-name' });
    assert.equal(latest().type, 'error');
    assert.equal(latest().requestType, requestType);
  }

  const counts = app.get('getTotalConnections');
  const connectionsBefore = counts();
  admin.disconnect();
  assert.equal(counts(), connectionsBefore - 1);
  assert.equal(app.get('getConnectionBySocketId')(socketId), null);
  assert.equal(app.get('getConnectionBySocketId')('B').isAdmin, false);
});

test('全局冻结拦住已安排的撮合，用户仍可上下线，解冻后排队自动恢复', async t => {
  const app = await boot(temporaryData(t));
  app.connect('control');
  app.connect('observer');
  app.get('adminConnections').set('admin', {
    adminInfo: { username: '管理员' },
    connections: [{ socketId: 'control' }, { socketId: 'observer' }]
  });
  const room = '测试房间';
  app.get('rooms').push({ name: room, mode: 'random', count: 2 });
  const timerManager = app.get('timerManager');
  const schedule = timerManager.setTimeout.bind(timerManager);
  const checks = new Map();
  timerManager.setTimeout = (callback, delay) => {
    const id = schedule(callback, delay);
    if (delay === 1000) checks.set(id, callback);
    return id;
  };
  const latest = uid => ({ ...app.messages.findLast(reply => reply.uid === uid).data });
  const online = uid => app.send(uid, { type: 'user-online', username: uid, uid, room });
  const setFrozen = frozen => ({ type: 'set-group-purchasing-frozen', frozen });
  const rideTimers = app.get('roomRideCheckTimers');
  const activeRides = app.get('RideManager.activeRides');

  await online('A');
  await online('B');
  const scheduledBeforeFreeze = checks.get(rideTimers.get(room));
  await app.send('A', setFrozen(true));
  assert.equal(latest('A').message, '权限不足');
  await app.send('control', { type: 'get-server-control' });
  assert.deepEqual(latest('control'), {
    type: 'server-control-status', requestType: 'get-server-control', groupPurchasingFrozen: false
  });
  await app.send('control', setFrozen('true'));
  assert.equal(latest('control').type, 'error');
  await app.send('control', setFrozen(true));
  assert.deepEqual(latest('control'), {
    type: 'server-control-status', requestType: 'set-group-purchasing-frozen', groupPurchasingFrozen: true
  });
  assert.deepEqual(latest('observer'), { type: 'server-control-status', groupPurchasingFrozen: true });
  await scheduledBeforeFreeze();
  assert.equal(activeRides.size, 0);

  await app.send('B', { type: 'user-offline', uid: 'B', room });
  assert(app.messages.some(reply => reply.uid === 'B' && reply.data.type === 'user-offline-success'));
  await online('C');
  await online('D');
  assert(!rideTimers.has(room));
  assert.deepEqual(Array.from(app.get('roomUsers').get(room).users, user => user.uid), ['A', 'C', 'D']);

  await app.send('control', setFrozen(false));
  assert.equal(latest('observer').groupPurchasingFrozen, false);
  await checks.get(rideTimers.get(room))();
  assert.equal(activeRides.size, 1);
  assert.equal(activeRides.values().next().value.riders.length, 2);
});

test('冻结团购保留已经触发的车次和席位启动回执', async t => {
  const app = await boot(temporaryData(t));
  const rideId = await app.openRide();
  app.connect('control');
  app.get('adminConnections').set('admin', {
    adminInfo: { username: '管理员' },
    connections: [{ socketId: 'control' }]
  });
  await app.send('control', { type: 'set-group-purchasing-frozen', frozen: true });
  await prepare(app, rideId, []);
  assert.equal(app.messages.filter(reply => reply.data.type === 'ride-message-2' && reply.data.rideId === rideId).length, seats.length);
  assert.equal(app.get('RideManager.activeRides').size, 0);
});

test('批量解冻先统一落盘，仅为本次解冻账户重置冻结统计', async t => {
  const app = await boot(temporaryData(t));
  app.connect('control');
  app.get('adminConnections').set('admin', {
    adminInfo: { username: '管理员' },
    connections: [{ socketId: 'control' }]
  });
  const request = { type: 'unfreeze-all-users' };
  const latest = () => ({ ...app.messages.at(-1).data });
  const accounts = app.get('userAccounts');
  const states = app.get('crashFreezeState');
  const oldState = { count: 17, ignoredThrough: 2 };
  for (const id of ['A', 'B', 'D']) states.set(accounts[id], oldState);
  for (const id of ['A', 'B']) accounts[id].isFrozen = true;
  app.get('crashReportSequence = 23');

  await app.send('A', request);
  assert.deepEqual(latest(), { type: 'error', message: '权限不足' });

  const accountsFile = app.get('USER_ACCOUNTS_FILE');
  await app.get('saveData')(accountsFile, accounts);
  const saved = () => JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  const rename = app.disk.renameSync;
  let writes = 0;
  let failWrite = true;
  app.disk.renameSync = (from, to) => {
    if (to === accountsFile) {
      writes++;
      if (failWrite) throw new Error('模拟账户文件写入失败');
    }
    rename(from, to);
  };

  await app.send('control', request);
  assert.equal(latest().type, 'error');
  assert.equal(latest().requestType, request.type);
  for (const id of ['A', 'B']) {
    assert.equal(accounts[id].isFrozen, true);
    assert.equal(saved()[id].isFrozen, true);
    assert.equal(states.get(accounts[id]), oldState);
  }

  failWrite = false;
  await app.send('control', request);
  assert.deepEqual(latest(), { type: 'unfreeze-all-users-success', count: 2 });
  for (const id of ['A', 'B']) {
    assert.equal(accounts[id].isFrozen, false);
    assert.equal(saved()[id].isFrozen, false);
    assert.deepEqual({ ...states.get(accounts[id]) }, { count: 0, ignoredThrough: 23 });
  }
  assert.equal(states.get(accounts.D), oldState);
  assert([...app.get('roomUsers').values()].every(room => room.users.length === 0));

  app.get('crashReportSequence = 24');
  await app.send('control', request);
  assert.deepEqual(latest(), { type: 'unfreeze-all-users-success', count: 0 });
  assert.equal(states.get(accounts.A).ignoredThrough, 23);
  assert.equal(writes, 2);
});

test('北京时间 03:50 和手动重启合并等待，停服失败恢复撮合并允许重试', async t => {
  const dir = temporaryData(t);
  const timers = [];
  const scripts = [];
  const app = await boot(dir, {
    now: Date.parse('2024-03-01T03:49:53+08:00'),
    onTimeout(callback, delay) { timers.push({ callback, delay }); },
    execFile(command, args, callback) { scripts.push({ command, args: [...args], callback }); }
  });
  app.connect('control');
  app.get('adminConnections').set('admin', {
    adminInfo: { username: '管理员' },
    connections: [{ socketId: 'control' }]
  });
  const request = { type: 'restart-server' };
  const latest = () => ({ ...app.messages.at(-1).data });
  async function fire(timer) {
    assert(timer, '应已安排计时回调');
    timer.callback();
    await new Promise(setImmediate);
  }

  await app.send('A', request);
  assert.deepEqual(latest(), { type: 'error', message: '权限不足' });
  const rideId = await app.openRide();
  const activeRides = app.get('RideManager.activeRides');
  const room = '等待撮合';
  app.get('rooms').push({ name: room, mode: 'random', count: 2 });
  const waitingRoom = app.get('getOrCreateRoom')(room);
  for (const uid of ['E', 'F']) {
    app.connect(uid);
    app.get('userAccounts')[uid] = { points: 20, rooms: [room] };
    waitingRoom.users.push({ uid, username: uid, accountId: uid, socketId: uid, notHost: uid !== 'E' });
  }
  const checks = app.get('roomRideCheckTimers');
  app.get('scheduleRideCheck')(room);
  const queuedCheck = timers.at(-1);
  assert(checks.has(room));
  const timedRestart = timers.find(timer => timer.delay === 7000);
  app.clock.now += 7000;
  let start = timers.length;
  await fire(timedRestart);
  await app.send('control', request);
  assert.deepEqual(latest(), { type: 'restart-server-accepted' });
  const attempts = timers.slice(start).filter(timer => timer.delay === 1000);
  assert.equal(attempts.length, 1);
  start = timers.length;
  await fire(attempts[0]);
  assert.equal(scripts.length, 0);
  assert.equal(activeRides.size, 1);
  const retry = timers.slice(start).find(timer => timer.delay === 30000);
  await app.send('control', request);
  assert(!timers.slice(start).some(timer => timer.delay === 1000));

  await fire(queuedCheck);
  assert(!checks.has(room));
  app.get('scheduleRideCheck')(room);
  assert(!checks.has(room));
  assert.equal(activeRides.size, 1);

  await prepare(app, rideId, ['A']);
  await app.send('A', { type: 'ride-started', rideId, uid: 'A', success: true });
  assert.equal(activeRides.size, 0);
  await fire(retry);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].command, 'bash');
  assert.deepEqual(scripts[0].args, [path.join(dir, 'restart-server.sh')]);

  app.get('scheduleRideCheck')(room);
  await app.get('checkAndHandleRideInternal')(room);
  assert(!checks.has(room));
  assert.equal(activeRides.size, 0);

  scripts[0].callback(new Error('模拟重启脚本失败'), '', '');
  assert.equal(latest().requestType, request.type);
  assert.equal(app.messages.at(-1).uid, 'control');
  assert(checks.has(room));

  start = timers.length;
  await app.send('control', request);
  await fire(timers.slice(start).find(timer => timer.delay === 1000));
  assert.equal(scripts.length, 2);
  scripts[1].callback(null, '', '');
});
