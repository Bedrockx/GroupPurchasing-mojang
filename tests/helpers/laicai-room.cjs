const assert = require('node:assert/strict');
const { boot, temporaryData } = require('./server-fixture.cjs');

// 使用生产消息入口和临时账本。只替换 Socket 传输及已登录用户的身份。
async function createRoom(t, workers, options = {}) {
  const app = await boot(options.directory || temporaryData(t));
  const roomName = '测试房间';
  const bigCount = options.bigCount || 3;
  const roomConfig = {bigCount, worldUids: workers.flatMap(worker => worker.uids),
    allowMissing: Boolean(options.allowMissing), timeoutSeconds: options.timeoutSeconds ?? 120};
  app.get('adminConnections').set('房间管理员', {adminInfo:{username:'房间管理员'}, connections:[{socketId:'admin'}]});
  const adminEvents = [];
  const admin = {id:'admin', emit: (_event, message) => adminEvents.push(message)};
  await app.get('handleReceivedMessage')(admin, {type:'create-room', roomName, roomType:'laicai', laicai:roomConfig});
  assert(!adminEvents.some(m => m.type === 'error'), JSON.stringify(adminEvents));
  let sequence = 0;
  function message(op, payload, scope = {}) {
    return {...scope, type:'laicai', version:1, roomName, op, payload, messageId:'fixture_' + (++sequence)};
  }
  function sent(op, filter = {}) {
    return app.messages.filter(row => row.data.op === op &&
      Object.entries(filter).every(([key, value]) => row.data[key] === value));
  }
  async function send(uid, event) {
    const before = app.messages.length;
    await app.send(uid, event);
    const replies = app.messages.slice(before).filter(row => row.uid === uid).map(row => row.data);
    const rejected = replies.find(m => m.type === 'error' ||
      (m.replyTo === event.messageId && m.op === 'ack' && m.payload.status === 'rejected'));
    assert(!rejected, event.op + ' 被拒绝 ' + JSON.stringify(rejected));
  }
  // 按真实命令复制上下文和授权 ID，每个回执独立编号。
  async function reply({uid, data}, op, payload) {
    const event = message(op, payload, {...data, replyTo:data.messageId});
    await send(uid, event);
    return event;
  }
  const bigs = ['A','B','C'].slice(0, bigCount);
  for (const [index, id] of bigs.entries()) {
    await send(id, message('seat-ready', {role:'big', clientId:'pc_' + id, laicaiVersion:'1.0.0',
      uid:String(100000001 + index), gameName:'测试队员' + id}));
  }
  await send('D', message('seat-ready', {role:'host', clientId:'pc_D', laicaiVersion:'1.0.0', workers}));
  return {app, sent, send, reply, message, bigs};
}

module.exports = { createRoom };
