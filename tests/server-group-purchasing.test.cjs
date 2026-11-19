const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, temporaryData, seats } = require('./helpers/server-fixture.cjs');
const { createRoom } = require('./helpers/laicai-room.cjs');

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

async function freezeAccount(app, accountId, isFrozen) {
  app.get('adminConnections').set('冻管', {adminInfo:{username:'冻管'}, connections:[{socketId:'freeze-admin'}]});
  let reply;
  await app.get('handleReceivedMessage')({id:'freeze-admin', emit:(_, m) => { reply = m; }},
    {type:'toggle-freeze-user', accountId, isFrozen});
  assert.equal(reply.type, 'freeze-user-success');
}

test('冻结移除同账号的所有等待席，重传旧报名或解冻均不能直接发车', async t => {
  const app = await boot(temporaryData(t));
  lcRoomSetup(app, {bigCount:2});
  const big = lcReady('big','pc_B');
  const other = lcReady('big','pc_C',{uid:'100000002'});
  const first = await lcSend(app, 'B', 'seat-ready', big);
  const second = await lcSend(app, 'C', 'seat-ready', other);
  await freezeAccount(app, 'B', true); // B、C 是同一账号的两个连接。
  const view = () => app.get('laicaiRoomsView')(app.get('rooms').find(r => r.name === lcRoom));
  assert.equal(view().users.length, 0);
  for (const receipt of [first, second]) {
    assert.ok(app.messages.some(r => r.data.replyTo === receipt.replyTo && r.data.payload?.status === 'rejected'));
  }
  assert.equal((await lcSend(app, 'B', 'seat-ready', big, {messageId:first.replyTo})).payload.status, 'rejected');
  const frozenReply = await lcSend(app, 'C', 'seat-ready', other);
  assert.equal(frozenReply.payload.status, 'rejected');
  assert.equal((await lcSend(app, 'B', 'seat-withdraw', {clientId:'pc_B'})).payload.status, 'applied');
  await freezeAccount(app, 'B', false);
  await lcSend(app, 'D', 'seat-ready', lcReady('host','pc_D'));
  for (const [socket, registration, replyTo] of [['B', big, first.replyTo], ['C', other, frozenReply.replyTo]]) {
    assert.equal((await lcSend(app, socket, 'seat-ready', registration, {messageId:replyTo})).payload.status, 'rejected');
  }
  assert.equal(app.get('laicaiTasks').size, 0);
  await lcSend(app, 'B', 'seat-ready', big);
  await lcSend(app, 'C', 'seat-ready', other);
  assert.equal(app.get('laicaiTasks').size, 1);
});

test('来财满员检查重新核验等待席的冻结状态，冻结的主用户也不能报名', async t => {
  const app = await boot(temporaryData(t));
  lcRoomSetup(app);
  await lcSend(app, 'D', 'seat-ready', lcReady('host','pc_D'));
  app.get('userAccounts').D.isFrozen = true; // 模拟等待表仍残留已冻结席位。
  await lcSend(app, 'A', 'seat-ready', lcReady('big','pc_A'));
  assert.equal(app.get('laicaiTasks').size, 0);
  assert.equal((await lcSend(app, 'D', 'seat-ready', lcReady('host','pc_D'))).payload.status, 'rejected');
  assert.deepEqual(Array.from(app.get('laicaiWaiting').get(lcRoom), s => s.accountId), ['A']);
});

test('团购炸车自动冻结会撤销该账号在另一个来财房的报名', async t => {
  const app = await boot(temporaryData(t));
  const name = '来财联机';
  const laicai = {bigCount:1, worldUids:[uid1], allowMissing:false, timeoutSeconds:120};
  app.get('rooms').push({name, mode:'random', count:2, roomType:'laicai', laicai});
  app.get('userAccounts').B.rooms.push(name);
  await lcSend(app, 'B', 'seat-ready', lcReady('big','pc_B'), {roomName:name});
  for (let i = 0; i < 2; i++) {
    const rideId = await app.openRide();
    await prepare(app, rideId, []);
    app.report('B', rideId);
    app.get('processCrashReports')(rideId);
  }
  assert.equal(app.get('userAccounts').B.isFrozen, true);
  assert.equal(app.get('laicaiWaiting').get(name)?.length || 0, 0);
});

test('已经发车的来财账号被冻结后仍能恢复原任务、回报退场和清场', async t => {
  const r = await createRoom(t, [{workerId:'w',uids:[uid1]}], {bigCount:1});
  const start = r.sent('task-start');
  for (const item of start) await r.reply(item, 'ack', {status:'applied'});
  await r.reply(start.find(s => s.uid === 'A'), 'executor-ready', {role:'big', laicaiVersion:'1.0.0'});
  await r.reply(r.sent('prepare-world')[0], 'world-ready', {observedUid:uid1, exactReads:2});
  await r.reply(r.sent('open-admission')[0], 'admission-opened', {});
  const arm = r.sent('admit-seat')[0];
  await r.reply(arm, 'seat-armed', {members:[]});
  await r.reply(r.sent('join-world')[0], 'join-result', {status:'joined', fromSingle:true, position:2});
  await r.reply(arm, 'world-members', {stable:true, ambiguous:false, members:[{seatId:arm.data.seatId, position:2}]});
  await r.reply(r.sent('route-release')[0], 'route-result', {status:'success', evidence:'reward', isLast:true});

  await freezeAccount(r.app, 'A', true);
  await freezeAccount(r.app, 'D', true);
  const state = await lcSend(r.app, 'A', 'state-request', {clientId:'pc_A'});
  assert.equal(state.payload.task.taskId, arm.data.taskId);
  await r.reply(r.sent('leave-world')[0], 'seat-left', {single:true});
  await r.reply(r.sent('check-clear')[0], 'world-cleared', {stable:true, memberCount:0});
  await r.reply(r.sent('release-world')[0], 'ack', {status:'applied'});
  assert.equal(r.sent('task-end')[0].data.payload.worldResults[0].status, 'completed');
});

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
