const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');

test('三名大号逐席入场，每条完整路线同步，两个已就绪的世界依次开放', async t => {
  const workers = [
    {workerId:'worker1', uids:['200000001']}, {workerId:'worker2', uids:['200000002']}
  ];
  const room = await createRoom(t, workers);
  const {sent, reply, bigs} = room;
  const starts = sent('task-start');
  assert.equal(starts.length, 4);
  for (const start of starts) await reply(start, 'ack', {status:'applied'});
  for (const start of starts.filter(row => bigs.includes(row.uid))) {
    await reply(start, 'executor-ready', {role:'big', laicaiVersion:'1.0.0'});
  }
  const prepare = sent('prepare-world');
  assert.equal(prepare.length, 2);
  assert.equal(new Set(prepare.map(row => row.data.slotId)).size, 2);
  for (const command of prepare) {
    await reply(command, 'world-ready', {observedUid:command.data.worldUid, exactReads:2});
  }
  assert.equal(sent('open-admission').length, 1, '预备世界必须保持关闭');

  for (const [index, preparation] of prepare.entries()) {
    const worldUid = preparation.data.worldUid;
    const inWorld = op => sent(op, {worldUid});
    const open = inWorld('open-admission');
    assert.equal(open.length, 1);
    await reply(open[0], 'admission-opened', {});

    const members = [];
    for (const position of [2, 3, 4]) {
      const armed = inWorld('admit-seat').at(-1);
      assert(armed, '必须先指定一个待批准的席位');
      const seatId = armed.data.seatId;
      assert(!members.some(seat => seat.seatId === seatId));
      await reply(armed, 'seat-armed', {members:[...members]});
      const join = sent('join-world', {worldUid, seatId});
      assert.equal(join.length, 1);
      await reply(join[0], 'join-result', {status:'joined', fromSingle:true, position});
      assert.equal(inWorld('admit-seat').length, position - 1, '单边回报不能授权下一席');
      assert.equal(inWorld('route-release').length, 0);
      members.push({seatId, position});
      await reply(armed, 'world-members', {stable:true, ambiguous:false, members:[...members]});
    }

    for (const routeSeq of [1, 2]) {
      const routes = sent('route-release', {worldUid, routeSeq});
      assert.deepEqual(routes.map(row => row.uid).sort(), bigs);
      for (const route of routes) await reply(route, 'ack', {status:'started'});
      for (const [i, route] of routes.entries()) {
        const evidence = i === 0 && routeSeq === 1;
        const result = await reply(route, 'route-result', evidence ? {status:'success',evidence:'reward',isLast:false} :
          {status:'await-team', isLast:routeSeq === 2});
        await room.send(route.uid, result); // 模拟成功回执丢失后重发。
        if (i < 2) {
          assert.equal(sent('route-release', {worldUid, routeSeq:routeSeq + 1}).length, 0);
          assert.equal(inWorld('leave-world').length, 0);
        }
      }
      if (routeSeq === 2) {
        assert.equal(inWorld('leave-world').length,0,'上一条路线的击败证据不能用于本条');
        const task = [...room.app.get('laicaiTasks').values()][0];
        assert.equal(task.phase,'waiting-evidence');
        assert(task.worlds[0].proofUntil > room.app.clock.now);
        await assert.rejects(reply(routes[0],'route-result',{status:'success',isLast:true}),/invalid-result/);
        await reply(routes[1],'route-result',{status:'success',evidence:'reward',isLast:true});
      }
    }

    const leaving = inWorld('leave-world');
    assert.equal(leaving.length, 3);
    for (const leave of leaving) await reply(leave, 'seat-left', {single:true});
    assert.equal(inWorld('release-world').length, 0, '大号都退回单人仍需小号清场');
    assert.equal(sent('open-admission').length, index + 1);
    const clear = inWorld('check-clear');
    assert.equal(clear.length, 1);
    await reply(clear[0], 'world-cleared', {stable:true, memberCount:0});
    const release = inWorld('release-world');
    assert.equal(release.length, 1);
    await reply(release[0], 'ack', {status:'applied'});
  }
  const ended = sent('task-end');
  assert.equal(ended.length, 4);
  assert.equal(ended[0].data.payload.worldResults.length, workers.length);
  assert.equal(sent('route-release').length, 12);
});
