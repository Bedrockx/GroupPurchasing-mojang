const test = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');

async function activeRoom(t,uids=['200000001']) {
  const r = await createRoom(t,[{workerId:'worker1',uids}],{bigCount:1,timeoutSeconds:10});
  const {reply,sent} = r;
  const start = sent('task-start').find(x=>x.uid==='A');
  const {taskId} = start.data, {seatId} = start.data.payload;
  for (const row of sent('task-start')) await reply(row,'ack',{status:'applied'});
  await reply(start,'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
  await reply(sent('prepare-world')[0],'world-ready',{observedUid:'200000001',exactReads:2});
  await reply(sent('open-admission')[0],'admission-opened',{});
  const arm = sent('admit-seat')[0];
  await reply(arm,'seat-armed',{members:[]});
  await reply(sent('join-world')[0],'join-result',{status:'joined',fromSingle:true,position:2});
  await reply(arm,'world-members',{stable:true,ambiguous:false,members:[{seatId,position:2}]});
  const route = sent('route-release')[0].data;
  return {...r,taskId,seatId,start,route};
}

test('撤权的大号重连只能恢复原席清理，退场和终态回执均可确认', async t => {
  const {app,reply,sent,message,taskId,seatId,start,route} = await activeRoom(t);
  app.get('userAccounts').A.rooms = [];
  app.get('userAccounts').B.rooms = [];
  const sockets = app.get('io').sockets.sockets;
  sockets.set('A2',{...sockets.get('A'),id:'A2',emit:(_,data)=>app.messages.push({uid:'A2',data})});
  app.get('userConnections').get('A').connections.push({socketId:'A2',accountId:'A'});
  const scope = {taskId,clientId:'pc_A',seatId};
  const send = async(uid,m) => {
    await app.send(uid,m);
    return app.messages.findLast(row=>row.uid===uid && row.data.replyTo===m.messageId)?.data;
  };
  const snapshot = (uid,extra={}) => send(uid,message('state-request',{...scope,...extra}));
  assert.equal((await snapshot('A2')).payload.retryable,true,'仍在线的原连接不能被接管');
  sockets.get('A').connected = false;
  for (const [uid,extra] of [['B',{}],['A2',{taskId:'other'}],['A2',{clientId:'wrong'}],['A2',{seatId:'wrong'}]]) {
    assert.equal((await snapshot(uid,extra)).payload.status,'rejected');
  }
  const restored = (await snapshot('A2')).payload.task;
  assert.equal(restored.cleanupOnly,true);
  assert.equal(restored.seatId,seatId);
  assert.deepEqual(Array.from(restored.pending),[]);
  assert(!restored.roster && !restored.worlds && !restored.worldUids);
  const prohibited = [
    message('route-result',{status:'success',isLast:true,evidence:'reward'},{...route,replyTo:route.messageId}),
    message('ack',{status:'started',clientId:'pc_A'},{...route,replyTo:route.messageId}),
    message('seat-ready',{...start.data.payload,clientId:'pc_A'}),
    message('executor-ready',{role:'big',laicaiVersion:'1.0.0'},{taskId})
  ];
  for (const m of prohibited) assert.equal((await send('A2',m)).payload.status,'rejected');
  app.clock.now += 10001;
  app.get('lcTick')();
  const clean = (await snapshot('A2')).payload.task.pending;
  assert.deepEqual(Array.from(clean,m=>m.op).sort(),['cancel-route','leave-world']);
  const leave = clean.find(m=>m.op==='leave-world');
  const left = message('seat-left',{single:true},{...leave,replyTo:leave.messageId});
  assert.equal((await send('A2',left)).payload.status,'applied');
  assert.equal((await send('A2',left)).payload.status,'applied');
  await reply(sent('check-clear')[0],'world-cleared',{stable:true,memberCount:0});
  await reply(sent('release-world')[0],'ack',{status:'applied'});
  const end = sent('task-end').find(x=>x.uid==='A2').data;
  const terminal = (await snapshot('A2')).payload.terminal;
  assert.equal(terminal.taskId,taskId);
  assert.equal(terminal.commandId,end.messageId);
  assert.equal((await snapshot('A2',{seatId:'wrong'})).payload.status,'rejected');
  assert.equal((await send('A2',message('ack',{status:'applied',clientId:'pc_A'},{taskId,replyTo:end.messageId}))).payload.status,'applied');
});

test('已撤权的主用户仍可确认清场和释放，下一小号的启动指令不能下发或重放', async t => {
  const {app,reply,sent,send,message,taskId} = await activeRoom(t,['200000001','200000002']);
  const host = sent('task-start').find(x=>x.uid==='D');
  app.get('userAccounts').D.rooms=[];
  const request = () => message('state-request',{taskId,seatId:host.data.payload.seatId,clientId:'pc_D'});
  await send('D',request());
  assert.equal(sent('state-snapshot').at(-1).data.payload.task.cleanupOnly,true);
  await reply(sent('route-release')[0],'route-result',{status:'success',evidence:'reward',isLast:true});
  await reply(sent('leave-world')[0],'seat-left',{single:true});
  await reply(sent('check-clear')[0],'world-cleared',{stable:true,memberCount:0});
  const release = sent('release-world')[0];
  const receipt = await reply(release,'ack',{status:'applied',clientId:'pc_D'});
  await send('D',receipt);
  assert.equal(sent('prepare-world',{worldUid:'200000002'}).length,0);
  assert(app.get('laicaiTasks').get('测试房间').pending.some(i=>i.message.op==='prepare-world' && i.message.worldUid==='200000002'));
  await send('D',request());
  assert.equal(sent('state-snapshot').at(-1).data.payload.task.pending.length,0);
  assert.equal(sent('prepare-world',{worldUid:'200000002'}).length,0);
});
