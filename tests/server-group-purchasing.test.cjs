const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, temporaryData, seats } = require('./helpers/server-fixture.cjs');

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

const lcRoom = '测试房间';
const uid1 = '100000010';
let lcSequence = 0;
async function lcSend(app, socket, op, payload, scope = {}) {
  const m = {type:'laicai', version:1, messageId:'m' + (++lcSequence), roomName:lcRoom, op, payload, ...scope};
  await app.send(socket, m);
  return app.messages.filter(entry => entry.uid === socket && entry.data.replyTo === m.messageId).at(-1)?.data;
}
function lcReady(role, clientId, data = {}) {
  return {role,clientId, laicaiVersion:'1.0.0', ...(role === 'big' ? {gameName:clientId, uid:'100000001'} :
    {workers:[{workerId:'worker_1',uids:[uid1]}]}), ...data};
}
function lcRoomSetup(app, config = {}) {
  const laicai = {bigCount:1, worldUids:[uid1], allowMissing:true, timeoutSeconds:120, ...config};
  app.get('rooms').push({name:lcRoom, mode:'random', count:laicai.bigCount+1, roomType:'laicai', laicai});
}

test('来财认证报名与撤销，兼容旧房并只在角色全部就绪时启动一次', async t => {
  const dir = temporaryData(t);
  const app = await boot(dir);
  lcRoomSetup(app);
  const bad = await lcSend(app,'B','seat-ready', lcReady('host','pc_B',{workers:[{workerId:'w',uids:[uid1,uid1]}]}));
  assert.ok(bad, JSON.stringify(app.messages.slice(-2)));
  assert.equal(bad.payload.status,'rejected');
  await lcSend(app,'A','seat-ready',lcReady('big','pc_A'));
  await lcSend(app,'A','seat-withdraw',{clientId:'pc_A'});
  await lcSend(app,'B','seat-ready',lcReady('host','pc_B'));
  assert.equal(app.get('laicaiTasks').size,0);
  assert.equal((await lcSend(app,'A','seat-ready',lcReady('big','pc_A',{laicaiVersion:'2'}))).payload.status,'rejected');
  assert.equal((await lcSend(app,'A','seat-ready',lcReady('big','pc_A'))).payload.status,'applied');
  const start = app.messages.filter(o => o.data.op === 'task-start');
  assert.equal(start.length,2);
  assert.equal(start[0].data.taskId,start[1].data.taskId);
  await app.get('checkAndHandleRideInternal')(lcRoom);
  assert.equal(app.get('RideManager').activeRides.size,0);
  app.get('adminConnections').set('管理员', {adminInfo:{username:'管理员'},connections:[{socketId:'adminSocket'}]});
  let details;
  app.get('handleGetRoomUsers')({roomName:lcRoom},{id:'adminSocket', emit:(_, msg) => {details=msg;}});
  assert.equal(details.roomProperties.roomType,'laicai');
  assert.equal(details.roomProperties.laicai.worldUids[0],uid1);
  assert.ok(details.users.some(s => s.role === 'host' && s.online && s.uid === ''));
  assert.equal((await lcSend(app,'D','state-request',{clientId:'pc_A'})).payload.task,null);
  const next = await boot(dir);
  lcRoomSetup(next);
  const state = await lcSend(next,'A','state-request',{clientId:'pc_A'});
  assert.equal(state.payload.task.taskId,start[0].data.taskId);
  assert.equal(next.messages.filter(o => o.data.op === 'task-start').length,1);
});

test('管理员创建及编辑来财参数经房间查询回显，旧房不被自动转换', async t => {
  const app = await boot(temporaryData(t));
  app.get('adminConnections').set('管理', {adminInfo:{username:'管理'},connections:[{socketId:'q'}]});
  const replies = [];
  const socket = {id:'q',emit:(_, m) => replies.push(m)};
  const admin = m => app.get('handleReceivedMessage')(socket,m);
  const config = {bigCount:3,worldUids:[uid1],allowMissing:false,timeoutSeconds:15};
  await admin({type:'create-room',roomName:lcRoom,roomType:'laicai',laicai:config});
  await admin({type:'get-rooms-status'});
  assert.equal(replies.at(-1).data[lcRoom].count,4);
  assert.equal(replies.at(-1).data[lcRoom].laicai.timeoutSeconds,15);
  await admin({type:'edit-room-properties',roomName:lcRoom,newRoomName:lcRoom,roomMode:'random',roomCount:4,roomType:'laicai',laicai:{...config,bigCount:4}});
  assert.equal(replies.at(-1).type,'error');
  await admin({type:'edit-room-properties',roomName:lcRoom,newRoomName:lcRoom,roomMode:'random',roomCount:4,roomType:'group'});
  await admin({type:'get-rooms-status'});
  assert.equal(replies.at(-1).data[lcRoom].roomType,undefined);
});
