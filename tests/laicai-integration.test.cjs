const test = require('node:test');
const assert = require('node:assert/strict');
const {simulateTask} = require('./helpers/laicai-integration.cjs');
const {gameScreen} = require('./helpers/laicai-game.cjs');
const {pathingHost} = require('./helpers/laicai-pathing.cjs');
const catalog = require('../js/来财/routes/catalog.json');

test('服务端、主用户及大号客户端通过实际邮箱连续完成两个世界的放行、入场与清场',async t=>{
  const workers=[{workerId:'worker1',uids:['200000001']},{workerId:'worker2',uids:['200000002']}];
  const game=gameScreen(async ()=>({op:'route-result',payload:{status:'success',evidence:'reward',isLast:true}}));
  const {room,trace}=await simulateTask(t,{workers,bigCount:1,makeActions:game.makeActions});
  const entries=(direction,op,uid)=>trace.filter(p=>p.direction===direction && p.data.op===op &&
    (!uid || p.data.worldUid===uid));
  for (const {uids:[uid]} of workers) {
    const order=[
      entries('down','admit-seat',uid)[0], entries('up','seat-armed',uid)[0],
      entries('down','join-world',uid)[0], entries('down','route-release',uid)[0],
      entries('up','route-result',uid)[0], entries('down','leave-world',uid)[0],
      entries('up','world-cleared',uid)[0], entries('down','release-world',uid)[0],
    ];
    assert(order.every(Boolean));
    assert.deepEqual(order,[...order].sort((a,b)=>trace.indexOf(a)-trace.indexOf(b)));
    const guest=entries('up','join-result',uid).find(p=>p.data.payload.status==='joined');
    const seen=entries('up','world-members',uid).find(p=>p.data.payload.stable && p.data.payload.members.length===1);
    const route=trace.indexOf(order[3]);
    assert(guest && seen && trace.indexOf(guest)<route && trace.indexOf(seen)<route);
    assert.equal(seen.data.payload.members[0].seatId,guest.data.seatId);
    assert.equal(game.worlds.get(uid).members.size,0);
    assert.equal(game.worlds.get(uid).permission,'不允许加入');
    assert.deepEqual(game.history.filter(p=>p.world===uid && p.ui!=='permission').map(p=>p.ui),
      ['request','approve','leave']);
  }
  const firstClear=entries('up','world-cleared',workers[0].uids[0])[0];
  const nextOpen=entries('down','open-admission',workers[1].uids[0])[0];
  assert(trace.indexOf(firstClear)<trace.indexOf(nextOpen));
  assert.equal(room.sent('task-end')[0].data.payload.worldResults.length,2);
});

function teamGame(witnessUid) {
  const hosts=new Map();
  const game=gameScreen(async (command,{uid,now,wait,ui,control})=>{
    if (!hosts.has(uid)) {
      const number=Number(uid.slice(-1));
      const host=pathingHost({now,wait,positionSign:ui.sign,duration:1500+number*1200,showReward:uid===witnessUid});
      hosts.set(uid,host);
      host.actions.enablePickup();
    }
    const host=hosts.get(uid);
    host.clearReward();
    return host.actions['run-route'](command,control,{timeoutSeconds:120});
  });
  return {game,hosts};
}

test('三大号中仅一席观察到奖励，同轮所有大号到达终点后才放行下一条',async t=>{
  const workers=[{workerId:'worker1',uids:['200000001']}];
  const {game,hosts}=teamGame('100000001');
  const {trace}=await simulateTask(t,{workers,bigCount:3,makeActions:game.makeActions});
  const results=trace.filter(p=>p.direction==='up' && p.data.op==='route-result');
  for (const routeSeq of [1,2]) {
    const done=results.filter(p=>p.data.routeSeq===routeSeq);
    const perSeat=done.filter((p,index)=>done.findIndex(first=>first.uid===p.uid)===index);
    assert.deepEqual(perSeat.map(p=>p.uid),['A','B','C'],'较快的大号必须先完成');
    assert.deepEqual(perSeat.map(p=>p.data.payload.status),['success','await-team','await-team']);
    assert.equal(perSeat[0].data.payload.evidence,'reward');
    assert(perSeat.every(p=>p.data.payload.isLast===(routeSeq===2)));
    const next=trace.findIndex(p=>p.direction==='down' &&
      (routeSeq===1 ? p.data.op==='route-release' && p.data.routeSeq===2 : p.data.op==='leave-world'));
    assert(next>Math.max(...perSeat.map(p=>trace.indexOf(p))));
  }
  for (const host of hosts.values()) {
    assert.deepEqual(host.calls,[catalog.routes.A.file,catalog.routes.B.file]);
    assert.equal(host.pickups,1);
    assert(host.tokens.every(t=>t.disposed && !t.canceled));
  }
});

test('三大号都跑完、到终点且脱战，全队无人观察到战斗结果时服务端保留本轮等待',async t=>{
  const workers=[{workerId:'worker1',uids:['200000001']}];
  const {game,hosts}=teamGame(null);
  const {room,trace}=await simulateTask(t,{workers,bigCount:3,makeActions:game.makeActions,
    stopWhen:room=>room.app.get('laicaiTasks').get('测试房间')?.phase==='waiting-evidence'});
  const reports=trace.filter(p=>p.direction==='up' && p.data.op==='route-result');
  assert.deepEqual([...new Set(reports.map(p=>p.uid))].sort(),['A','B','C']);
  assert(reports.every(p=>p.data.payload.status==='await-team' && !p.data.payload.evidence));
  assert.equal(room.sent('route-release',{routeSeq:2}).length,0);
  assert.equal(room.sent('task-end').length,0);
  for (const host of hosts.values()) assert.deepEqual(host.calls,[catalog.routes.A.file]);
});
