const test = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');
const {temporaryData} = require('./helpers/server-fixture.cjs');
const {limitedFile} = require('./helpers/laicai-files.cjs');
const {createExecutor,createWorldActions} = require('../js/来财/main.js');

async function launch(t, workers, options = {}) {
  const room = await createRoom(t,workers,{bigCount:1,...options});
  const starts = room.sent('task-start');
  for (const s of starts) await room.reply(s,'ack',{status:'applied'});
  await room.reply(starts.find(s => s.uid === 'A'),'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
  return room;
}

const timeoutCases=[{timeoutSeconds:300},{timeoutSeconds:30},{timeoutSeconds:300,legacy:true}];
for (const {timeoutSeconds,legacy} of timeoutCases) test((legacy?'旧会话恢复后':'小号')+'按 '+timeoutSeconds+' 秒房间时限等待第 150 秒完成清场',async t=>{
  const room=await launch(t,[{workerId:'alpha',uids:['200000001']}],{timeoutSeconds});
  const prepare=room.sent('prepare-world')[0].data;
  let at=0;
  const file=limitedFile(temporaryData(t));
  const actions=createWorldActions({
    now:()=>at,wait:async ms=>{at+=ms;},
    f2:()=>true,uid:()=>prepare.worldUid,permission:()=>'不允许加入',
    members:()=>({ambiguous:false,members:at<150000?[{seatId:'guest',position:2}]:[]})
  });
  actions['prepare-world']=async()=>({op:'world-ready',payload:{observedUid:prepare.worldUid,exactReads:2}});
  const exe=createExecutor({role:'host',file,actions,now:()=>at});
  async function execute(command) {
    file.WriteTextSync('mailbox/in/'+command.messageId+'.json',JSON.stringify(command));
    exe.poll();await exe.settle();
  }
  const initial={...prepare,payload:{...prepare.payload}};
  if (legacy) delete initial.payload.timeoutSeconds;
  await execute(initial);
  await execute({...prepare,op:'check-clear',rosterVersion:1,messageId:'cleanup',payload:legacy?{timeoutSeconds}:{}});
  const outputs=file.ReadPathSync('mailbox/out').filter(path=>!path.endsWith('.ready.json'))
    .map(path=>JSON.parse(file.ReadTextSync(path))).filter(e=>e.replyTo==='cleanup');
  if (timeoutSeconds===300) {
    assert.ok(outputs.some(e=>e.op==='world-cleared'),'第 150 秒清场仍应在房间允许的时限内');
    assert.ok(at>=150000 && at<160000);
  } else {
    assert.ok(outputs.some(e=>e.op==='ack' && e.payload.status==='rejected' && /超时/.test(e.payload.reason)));
    assert.ok(at>=30000 && at<31000,'短房间不得延长到默认 120 秒');
  }
  assert.equal(prepare.payload.deadline-room.app.clock.now,90000);
  assert.equal(prepare.payload.prepareUntil-room.app.clock.now,360000);
});

test('预备多用户明确失败，跳过同组未做 UID，在役世界继续，下一候选复用安全位置', async t => {
  const {sent,reply,app} = await launch(t,[
    {workerId:'alpha',uids:['200000001']}, {workerId:'beta',uids:['200000002','200000003']},
    {workerId:'gamma',uids:['200000004']}
  ]);
  const [a,b] = sent('prepare-world');
  await reply(a,'world-ready',{observedUid:a.data.worldUid, exactReads:2});
  await reply(sent('open-admission')[0],'admission-opened',{});
  const armed = sent('admit-seat')[0];
  await reply(armed,'seat-armed',{members:[]});
  await reply(sent('join-world')[0],'join-result',{status:'joined',fromSingle:true,position:2});
  await reply(armed,'world-members',{stable:true,ambiguous:false,members:[{seatId:armed.data.seatId,position:2}]});
  await reply(b,'worker-stage',{stage:'failed',reason:'BAT 找不到',slotReusable:true});
  const [c] = sent('prepare-world',{workerId:'gamma'});
  assert.equal(c.data.slotId,b.data.slotId);
  assert.equal(c.data.slotGeneration,b.data.slotGeneration+1);
  const task = [...app.get('laicaiTasks').values()][0];
  assert.equal(task.phase,'route');
  assert.deepEqual(Array.from(task.results,r => r.status),['prepare-failed','skipped']);
  assert.equal(sent('cancel-route').length,0);
  await assert.rejects(reply(b,'world-ready',{observedUid:b.data.worldUid,exactReads:2}),/旧世界/);
  await reply(sent('route-release')[0],'route-result',{status:'success',evidence:'reward',isLast:true});
  assert.equal(sent('leave-world').length,1);
});

test('准备阶段重复不续期，截止后旧世界失效，复用必须有对应清理回执', async t => {
  const {sent,reply,app} = await launch(t,[
    {workerId:'alpha',uids:['200000001']},{workerId:'beta',uids:['200000002']},
    {workerId:'gamma',uids:['200000003']}
  ],{timeoutSeconds:300});
  const [a,b] = sent('prepare-world');
  await reply(a,'world-ready',{observedUid:a.data.worldUid,exactReads:2});
  const start = app.clock.now;
  app.clock.now += 50000;
  await reply(b,'worker-stage',{stage:'game'});
  app.clock.now += 90000;
  await reply(b,'worker-stage',{stage:'game'});
  app.clock.now = start+230001;
  app.get('lcTick')();
  assert.equal(sent('prepare-world',{workerId:'gamma'}).length,0);
  const revoke = sent('cancel-attempt')[0];
  assert.equal(revoke.data.worldUid,b.data.worldUid);
  await assert.rejects(reply({...revoke,data:{...revoke.data,slotGeneration:8}},'ack',{status:'applied',slotReusable:true}),/不匹配/);
  await reply(revoke,'ack',{status:'applied',slotReusable:true});
  assert.equal(sent('prepare-world',{workerId:'gamma'}).length,1);
});

test('两处隔离后限时等待恢复，所有世界在终态都有结果', async t => {
  const {sent,reply,app} = await launch(t,[
    {workerId:'alpha',uids:['200000001']},{workerId:'beta',uids:['200000002']},{workerId:'gamma',uids:['200000003']}
  ]);
  for (const p of sent('prepare-world')) await reply(p,'worker-stage',{stage:'failed',slotReusable:false,reason:'无法确认登录状态'});
  assert.equal(sent('task-end').length,0);
  app.clock.now += 120001;
  app.get('lcTick')();
  assert.equal(sent('task-end')[0].data.payload.status,'partial');
  assert.deepEqual(Array.from(sent('task-end')[0].data.payload.worldResults,r => r.status),
    ['prepare-failed','prepare-failed','skipped']);
});
