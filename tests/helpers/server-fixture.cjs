const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../..', 'server', 'server.js');
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

module.exports = { boot, temporaryData, seats };
