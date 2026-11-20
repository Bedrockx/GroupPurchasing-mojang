const test=require('node:test');
const assert=require('node:assert/strict');
const {simulateTask}=require('./helpers/laicai-integration.cjs');
const {gameScreen}=require('./helpers/laicai-game.cjs');
const {pathingHost}=require('./helpers/laicai-pathing.cjs');
const catalog=require('../js/来财/routes/catalog.json');

// 耗时的规模验收独立运行：node --test tests/laicai-scale.cjs。
test('十五个多用户轮班准备四十五个世界，三席逐条完成共二百七十次追踪',async t=>{
  const workers=Array.from({length:15},(_,i)=>({workerId:'worker_'+(i+1),
    uids:Array.from({length:3},(_,j)=>String(200000001+i*3+j))}));
  const ids=workers.flatMap(w=>w.uids);
  const seed=process.env.LAICAI_SCALE_SEED || 'scale-45';
  const hosts=new Map(), actualRuns=[];
  const game=gameScreen(async (cmd,{uid,now,wait,ui,control})=>{
    if(!hosts.has(uid)) {
      const host=pathingHost({now,wait,positionSign:ui.sign,duration:2000+Number(uid.slice(-1))*500,
        showReward:uid==='100000001'});
      host.actions.enablePickup();
      hosts.set(uid,host);
    }
    const host=hosts.get(uid);
    host.clearReward();
    const before=host.calls.length;
    const report=await host.actions['run-route'](cmd,control,{timeoutSeconds:120});
    assert.equal(host.calls.length,before+1);
    actualRuns.push([cmd.worldUid,cmd.seatId,cmd.routeSeq,host.calls[before]]);
    return report;
  });
  const {room,trace,launches,retired,workerPeak}=await simulateTask(t,{
    workers,bigCount:3,makeActions:game.makeActions,limit:15000,large:true,seed
  });
  const starts=room.sent('task-start');
  assert.equal(starts.length,4);
  assert.equal(new Set(starts.map(s=>s.data.taskId)).size,1);
  assert.equal(room.sent('task-end').length,4);
  const ended=room.sent('task-end')[0].data.payload;
  assert.deepEqual(Array.from(ended.worldResults,r=>r.worldUid).sort(),[...ids].sort());
  const failure=ended.worldResults.find(r=>r.status!=='completed');
  if(failure){
    const attempts=new Set(trace.filter(p=>p.data.worldUid===failure.worldUid).map(p=>p.data.messageId));
    const steps=trace.filter(p=>p.data.worldUid===failure.worldUid && !['heartbeat','ack'].includes(p.data.op) ||
      attempts.has(p.data.replyTo) && p.data.op==='ack' && p.data.payload.status==='rejected'
    ).map(p=>[p.direction,p.uid,p.data.op,p.data.payload]);
    assert.fail(JSON.stringify({seed,failure,reason:ended.reason,steps,screen:game.history.filter(h=>h.world===failure.worldUid)}));
  }
  assert.equal(workerPeak,2);
  assert.equal(retired.size,workers.length);
  assert.equal(launches.filter(p=>p.role==='host').length,workers.length);
  assert.equal(launches.filter(p=>p.role==='big').length,3);
  assert.equal(hosts.size,3);
  for (const op of ['prepare-world','open-admission','release-world']) {
    assert.deepEqual(room.sent(op).map(row=>row.data.worldUid).sort(),[...ids].sort(),op);
  }
  for(const worker of workers) {
    assert.deepEqual(room.sent('prepare-world',{workerId:worker.workerId}).map(row=>row.data.worldUid).sort(),
      [...worker.uids].sort(),worker.workerId);
  }
  const expected=ids.flatMap(uid=>starts.filter(row=>row.data.payload.role==='big').flatMap(row=>
    [1,2].map((seq)=>[uid,row.data.payload.seatId,seq,seq===1?catalog.routes.A.file:catalog.routes.B.file].join('/')))).sort();
  assert.deepEqual(actualRuns.map(row=>row.join('/')).sort(),expected);
  assert.equal(room.sent('route-release').length,270);
  assert.equal(room.sent('admit-seat').length,135);
  assert.equal(game.history.filter(e=>e.ui==='approve').length,135);
  assert.equal(game.history.filter(e=>e.ui==='leave').length,135);
  assert(game.worlds.size===45 && [...game.worlds.values()].every(w=>w.members.size===0 && w.permission==='不允许加入'));
  assert.equal(trace.filter(p=>p.direction==='up' && p.data.op==='world-cleared')
    .reduce((set,p)=>set.add(p.data.worldUid),new Set()).size,45);
  for (const host of hosts.values()) {
    assert.equal(host.pickups,1);
    assert(host.tokens.every(token=>token.disposed && !token.canceled));
  }
});
