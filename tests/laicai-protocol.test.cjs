const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 只载入共享信封检查，不启动网络服务。各方事件使用真实的字段检查。
const src = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
const from = src.indexOf('const LAICAI_OPS =');
const until = src.indexOf('// 错误类型枚举', from);
assert(from >= 0 && until > from);
const check = vm.runInNewContext(src.slice(from, until) + '\nlaicaiEnvelopeError');
const scope = { taskId: 'task_1', worldUid: '100000002', worldAttemptId: 'attempt_1',
  workerId: 'worker_1', slotId: 1, slotGeneration: 1, seatId: 'seat_1', rosterVersion: 1 };
function event(op, messageId, extra = {}) {
  return { type: 'laicai', version: 1, roomName: '测试房间', op, messageId, ...scope, payload: {}, ...extra };
}

test('协议示例走过准备、逐席入场、两条路线和清场', () => {
  const trace = [
    ['server', 'prepare-world'], ['host', 'world-ready', {observedUid: scope.worldUid, exactReads: 2}],
    ['server', 'open-admission', {roster: [{seatId: scope.seatId, uid: '100000001', gameName: '甲'}]}],
    ['host', 'admission-opened'], ['server', 'admit-seat', {uid: '100000001', gameName: '甲'}],
    ['host', 'seat-armed',{members:[]}], ['server', 'join-world'], ['big', 'join-result', {status: 'joined', fromSingle: true, position: 2}],
    ['host', 'world-members', {stable: true, ambiguous: false, members: [{seatId: scope.seatId, position: 2}]}],
    ['server', 'route-release', {}, 1], ['bridge', 'run-route', {}, 1], ['big', 'route-result', {status: 'success', evidence:'reward', isLast: false}, 1],
    ['server', 'route-release', {}, 2], ['bridge', 'run-route', {}, 2], ['big', 'route-result', {status: 'success', evidence:'reward', isLast: true}, 2],
    ['server', 'leave-world'], ['big', 'seat-left', {single: true}], ['server', 'check-clear'],
    ['host', 'world-cleared', {stable: true, memberCount: 0}], ['server', 'release-world']
  ];
  const directReplies = {1:0, 3:2, 5:4, 7:6, 8:4, 11:10, 14:13, 16:15, 18:17};
  const accepted = new Set();
  for (const [i, [sender, op, payload = {}, routeSeq]] of trace.entries()) {
    const replyTo = Object.hasOwn(directReplies,i) ? 'e' + directReplies[i] : undefined;
    const message = event(op, 'e' + i, {payload, routeSeq, replyTo});
    for (const m of [message, message, {...message, taskId:'old'}, {...message, worldAttemptId:'old'}]) {
      if (check(m, sender, scope) || accepted.has(m.messageId)) continue;
      accepted.add(m.messageId);
    }
    assert.equal(accepted.size, i + 1, op);
    assert.equal(check({...message, taskId:'old'}, sender, scope), 'stale-context');
  }
});

test('控制按实际角色及当前尝试验证，拒绝错席、错位置和非法消息标识', () => {
  assert.equal(check(event('route-result', 'r', {routeSeq:1}), 'host'), 'wrong-role');
  assert.equal(check(event('world-ready', 'r', {slotGeneration:2, replyTo:'request'}), 'host', scope), 'stale-context');
  assert.equal(check(event('seat-left', 'r', {seatId:'other', replyTo:'request'}), 'big', scope), 'stale-context');
  assert.equal(check(event('cancel-route', 'r', {routeSeq:0}), 'server'), 'invalid-route');
  assert.equal(check(event('ack', 'r'), 'server'), 'invalid-reply');
  assert.equal(check(event('world-ready', '../r'), 'host'), 'invalid-envelope');
  assert.equal(check(event('constructor', 'r'), 'host'), 'invalid-envelope');
  assert.equal(check(event('world-ready', 'r', {replyTo:'request', payload:{observedUid:scope.worldUid, exactReads:1}}), 'host'), 'invalid-evidence');
  assert.equal(check(event('route-result', 'r', {replyTo:'request', routeSeq:1}), 'big'), 'invalid-result');
});
