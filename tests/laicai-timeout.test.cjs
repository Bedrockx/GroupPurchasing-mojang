const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');
const {boot,temporaryData} = require('./helpers/server-fixture.cjs');

async function enter(t, options={}) {
  const room=await createRoom(t,[{workerId:'w',uids:options.uids||['200000001']}],{bigCount:3,timeoutSeconds:10,...options});
  const {sent,reply,bigs}=room;
  for (const start of sent('task-start')) await reply(start,'ack',{status:'applied'});
  for (const start of sent('task-start').filter(s=>bigs.includes(s.uid))) await reply(start,'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
  await reply(sent('prepare-world')[0],'world-ready',{observedUid:'200000001',exactReads:2});
  await reply(sent('open-admission')[0],'admission-opened',{});
  const members=[];
  for (let i=0;i<bigs.length;i++) {
    const arm=sent('admit-seat').at(-1);
    await reply(arm,'seat-armed',{members:[...members]});
    const join=sent('join-world').at(-1);
    await reply(join,'join-result',{status:'joined',fromSingle:true,position:i+2});
    members.push({seatId:arm.data.seatId,position:i+2});
    await reply(arm,'world-members',{stable:true,ambiguous:false,members:[...members]});
  }
  return {...room,members};
}

test('降员后保留同轮证据和存活席的原授权，只有小号确认剔除者已离场才继续',async t=>{
  const r=await enter(t,{allowMissing:true});
  const [a,b,c]=r.sent('route-release');
  await r.reply(a,'route-result',{status:'success',isLast:false,evidence:'reward'});
  await r.reply(c,'route-result',{status:'failed',reason:'追踪失败'});
  assert.equal(r.sent('cancel-route').length,1);
  assert.equal(r.sent('leave-world').length,1);
  await r.reply(b,'route-result',{status:'await-team',isLast:false});
  const watch=r.sent('roster-update').find(x=>x.uid==='D');
  await r.reply(watch,'world-members',{stable:true,ambiguous:false,members:r.members});
  assert.equal(r.sent('route-release',{routeSeq:2}).length,0);
  await r.reply(watch,'world-members',{stable:true,ambiguous:false,members:r.members.slice(0,2)});
  assert.equal(r.sent('route-release',{routeSeq:2}).length,0,'复核必须包含目标小号和真实放行权限');
  await r.reply(watch,'world-members',{stable:true,ambiguous:false,members:r.members.slice(0,2),observedUid:a.data.worldUid,admissionMode:'confirm'});
  assert.equal(r.sent('route-release',{routeSeq:2}).length,2);
  await r.reply(r.sent('leave-world').at(-1),'seat-left',{single:true});
  await r.send('C',r.message('executor-ready',{role:'big',laicaiVersion:'1.0.0',single:true},{taskId:a.data.taskId}));
  assert.equal(r.sent('route-release',{routeSeq:2}).length,2,'当前世界不增员');
});

test('降员后的存活大号可以按原路线授权补交迟到的同轮奖励',async t=>{
  const r=await enter(t,{allowMissing:true});
  const [a,b,c]=r.sent('route-release');
  const proof={status:'success',isLast:false,evidence:'reward'};
  await r.reply(a,'route-result',{status:'await-team',isLast:false});
  await r.reply(c,'route-result',{status:'failed',reason:'追踪失败'});
  await r.reply(b,'route-result',{status:'await-team',isLast:false});
  await r.reply(r.sent('roster-update').find(x=>x.uid==='D'),'world-members',{
    stable:true,ambiguous:false,members:r.members.slice(0,2),observedUid:a.data.worldUid,admissionMode:'confirm'
  });
  assert.equal(r.sent('route-release',{routeSeq:2}).length,0);
  for (const fields of [{messageId:b.data.messageId},{rosterVersion:a.data.rosterVersion+1},{rosterVersion:99},{routeSeq:2}]) {
    await assert.rejects(r.reply({...a,data:{...a.data,...fields}},'route-result',proof));
  }
  const report=await r.reply(a,'route-result',proof);
  await r.send(a.uid,report);
  assert.equal(r.sent('route-release',{routeSeq:2}).length,2);
});

test('严格房超时取消、清场超时持久隔离，服务重启后原客户端取得终态',async t=>{
  const directory=temporaryData(t);
  const r=await enter(t,{directory,bigCount:1});
  const [a]=r.sent('route-release');
  r.app.clock.now+=5000;
  await r.reply(a,'ack',{status:'started'});
  r.app.clock.now+=6000;
  r.app.get('lcTick')();
  assert.equal(r.sent('cancel-route').length,0);
  await r.reply(a,'ack',{status:'started'});
  r.app.clock.now+=4001;
  r.app.get('lcTick')();
  assert.equal(r.sent('cancel-route').length,1);
  assert.equal(r.sent('check-clear').length,1);
  r.app.clock.now+=10001;
  r.app.get('lcTick')();
  const terminal=r.sent('task-end')[0].data.payload;
  assert.equal(terminal.unsafeWorlds[0].worldUid,'200000001');
  assert.equal(r.app.get('laicaiTasks').size,0,'离线席无需 ACK 即可释放房间');
  assert.equal(r.sent('release-world').length,0);
  const next=await boot(directory);
  const req=r.message('state-request',{clientId:'pc_D',taskId:a.data.taskId});
  await next.send('D',req);
  const snapshot=next.messages.at(-1).data.payload;
  assert.equal(snapshot.task,null);
  assert.equal(snapshot.terminal.status,'terminated');
  assert.equal(snapshot.terminal.unsafeWorlds[0].worldAttemptId,a.data.worldAttemptId);
  const rooms=next.get('rooms');
  rooms.splice(rooms.findIndex(v=>v.name===req.roomName),1);
  next.get('userAccounts').D.rooms=[];
  await next.send('D',req);
  assert.equal(next.messages.at(-1).data.payload.terminal.taskId,a.data.taskId,'即使已删房及撤销房权也能收尾');
  await next.send('A',req);
  assert.equal(next.messages.at(-1).data.payload.status,'rejected','其它登录账号不可冒领此客户端的终态');
  const end=r.sent('task-end').find(row=>row.uid==='D').data;
  const closed=r.message('ack',{status:'applied',clientId:'pc_D'},{taskId:end.taskId,replyTo:end.messageId});
  await next.send('D',closed);
  assert.equal(next.messages.at(-1).data.payload.status,'applied','终态收尾后可通过原授权清除待发回执');
  await next.send('A',closed);
  assert.equal(next.messages.at(-1).data.payload.status,'rejected');
});

test('无人证实击败时在原收证期限终止，写盘失败不会发出未提交的下一条',async t=>{
  const r=await enter(t,{bigCount:1});
  const [route]=r.sent('route-release');
  const save=r.app.disk.renameSync;
  r.app.disk.renameSync=()=>{throw Error('模拟断写');};
  await assert.rejects(r.reply(route,'route-result',{status:'success',isLast:false,evidence:'reward'}),/retryable/);
  assert.equal(r.sent('route-release',{routeSeq:2}).length,0);
  r.app.disk.renameSync=save;
  await r.reply(route,'route-result',{status:'await-team',isLast:false});
  r.app.clock.now+=10001; r.app.get('lcTick')();
  assert.equal(r.sent('route-release',{routeSeq:2}).length,0);
  assert.equal(r.sent('check-clear').length,1);
});

test('服务端重启时只重发仍未完成的相同授权，先完成的席位不重新执行',async t=>{
  const directory=temporaryData(t);
  const r=await enter(t,{directory,bigCount:2});
  const [a,b]=r.sent('route-release');
  await r.reply(a,'route-result',{status:'success',evidence:'reward',isLast:false});
  const next=await boot(directory);
  for (const uid of ['A','B']) {
    await next.send(uid,r.message('state-request',{clientId:'pc_'+uid,taskId:a.data.taskId}));
  }
  const replay=next.messages.filter(e=>e.data.op==='route-release');
  assert.deepEqual(replay.map(e=>e.data.messageId),[b.data.messageId]);
  const waiting=next.messages.find(e=>e.uid==='A'&&e.data.op==='state-snapshot').data.payload.task.worlds[0];
  assert.equal(waiting.completed[0].seatId,a.data.seatId);
  await next.send('B',r.message('route-result',{status:'await-team',isLast:false},{
    ...b.data, replyTo:b.data.messageId
  }));
  assert.equal(next.messages.filter(e=>e.data.op==='route-release'&&e.data.routeSeq===2).length,2);
});

test('短房间时限仍容得下正常心跳，已完成者等待队友不会被判定失联',async t=>{
  const r=await enter(t,{bigCount:2,timeoutSeconds:4,allowMissing:true});
  const [fast,slow]=r.sent('route-release');
  const pulse={role:'big',source:'client',laicaiVersion:'1.0.0',stage:'waiting'};
  await r.reply(fast,'heartbeat',pulse);
  await r.reply(fast,'route-result',{status:'success',isLast:true,evidence:'reward'});
  r.app.clock.now+=3500;
  await r.reply(slow,'ack',{status:'started'});
  r.app.clock.now+=1600;
  await r.reply(fast,'heartbeat',pulse);
  assert.equal(r.sent('roster-update').length,0);
  await r.reply(slow,'route-result',{status:'await-team',isLast:true});
  assert.equal(r.sent('leave-world').length,2);
});

test('降为零人的世界记失败，下一世界等重新就绪后才重新开放',async t=>{
  const room=await enter(t,{bigCount:1,allowMissing:true,uids:['200000001','200000002']});
  const route=room.sent('route-release')[0];
  await room.reply(route,'route-result',{status:'failed',reason:'操作失败'});
  const leave=room.sent('leave-world').at(-1);
  await room.reply(leave,'seat-left',{single:true});
  await room.reply(room.sent('check-clear').at(-1),'world-cleared',{stable:true,memberCount:0});
  await room.reply(room.sent('release-world').at(-1),'ack',{status:'applied'});
  await room.reply(room.sent('prepare-world').at(-1),'world-ready',{observedUid:'200000002',exactReads:2});
  assert.equal(room.sent('open-admission').length,1);
  const task=room.app.get('laicaiTasks').get(route.data.roomName);
  assert.equal(task.results[0].status,'failed');
  assert(task.waitReadyUntil>room.app.clock.now);
  await room.send('A',room.message('executor-ready',{role:'big',laicaiVersion:'1.0.0',single:true},{taskId:route.data.taskId}));
  assert.equal(room.sent('open-admission').at(-1).data.worldUid,'200000002');
});
