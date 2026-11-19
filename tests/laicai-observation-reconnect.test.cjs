const test = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');
const {boot,temporaryData} = require('./helpers/server-fixture.cjs');
const {simulateTask} = require('./helpers/laicai-integration.cjs');
const {gameScreen} = require('./helpers/laicai-game.cjs');
const {limitedFile} = require('./helpers/laicai-files.cjs');
const {createExecutor} = require('../js/来财/main.js');

async function admission(t,directory) {
  const r=await createRoom(t,[{workerId:'w',uids:['200000001']}],{bigCount:1,directory});
  for (const start of r.sent('task-start')) {
    await r.reply(start,'ack',{status:'applied'});
    if (start.uid==='A') await r.reply(start,'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
  }
  const prep=r.sent('prepare-world')[0];
  await r.reply(prep,'world-ready',{observedUid:prep.data.worldUid,exactReads:2});
  await r.reply(r.sent('open-admission')[0],'admission-opened',{});
  const arm=r.sent('admit-seat')[0];
  const fresh={stable:true,ambiguous:false,observedUid:prep.data.worldUid,admissionMode:'confirm',
    members:[{seatId:arm.data.seatId,position:2}]};
  return {r,arm,fresh};
}

for (const cached of ['大号回报','小号观测']) test('服务器重启隔离原入场观测及在途回报：'+cached,async t=>{
  const directory=temporaryData(t);
  const {r,arm,fresh}=await admission(t,directory);
  await r.reply(arm,'seat-armed',{members:[]});
  const join=r.sent('join-world')[0], joined={status:'joined',fromSingle:true,position:2};
  if (cached==='大号回报') await r.reply(join,'join-result',joined);
  else await r.reply(arm,'world-members',fresh);
  const next=await boot(directory);
  const request=uid=>r.message('state-request',{taskId:arm.data.taskId,clientId:'pc_'+uid});
  await next.send('A',request('A'));
  if (cached==='小号观测') await next.send('A',r.message('join-result',joined,{...join.data,replyTo:join.data.messageId}));
  const released=()=>next.messages.filter(m=>m.data.op==='route-release');
  assert.equal(released().length,0,'主用户恢复前不能复用持久账本中的在场观测');
  const resume=request('D');
  await next.send('D',resume);
  await next.send('D',r.message('world-members',fresh,{...arm.data,replyTo:arm.data.messageId}));
  assert.equal(released().length,0,'重连后到达的旧正向观测不能放行');
  const watch=next.messages.find(m=>m.uid==='D' && m.data.op==='roster-update').data;
  await next.send('D',resume);
  assert.ok(next.messages.filter(m=>m.uid==='D' && m.data.op==='roster-update').every(m=>m.data.messageId===watch.messageId));
  const observe=payload=>next.send('D',r.message('world-members',payload,{...watch,replyTo:watch.messageId}));
  await observe({...fresh,members:[]});
  await observe({...fresh,observedUid:'200000009'});
  await observe({...fresh,admissionMode:'closed'});
  assert.equal(released().length,0);
  await observe(fresh);
  assert.equal(released().length,1);
});

test('准备入场时重新取得基线，旧授权和错误现场无效，恢复不延长截止时间',async t=>{
  const {r,arm,fresh}=await admission(t);
  const deadline=()=>r.app.get('laicaiTasks').get('测试房间').worlds[0].deadline;
  const due=deadline(),resume=r.message('state-request',{clientId:'pc_D',taskId:arm.data.taskId});
  r.app.clock.now+=5000;
  await r.send('D',resume);
  const current=r.sent('admit-seat').at(-1);
  assert.notEqual(current.data.messageId,arm.data.messageId);
  assert.equal(deadline(),due);
  assert.equal(r.sent('roster-update').length,0);
  const empty={...fresh,members:[]};
  await assert.rejects(r.reply(arm,'seat-armed',empty),/不对应授权/);
  await assert.rejects(r.reply(current,'seat-armed',{...empty,admissionMode:'closed'}),/基线/);
  assert.equal(r.sent('join-world').length,0);
  await r.reply(current,'seat-armed',empty);
  assert.equal(r.sent('join-world').length,1);
});

test('刷新授权写盘失败后继续阻断旧观测，原恢复请求可安全重试',async t=>{
  const {r,arm,fresh}=await admission(t);
  await r.reply(arm,'seat-armed',{members:[]});
  await r.reply(arm,'world-members',fresh);
  const resume=r.message('state-request',{clientId:'pc_D',taskId:arm.data.taskId});
  const save=r.app.disk.renameSync;
  r.app.disk.renameSync=()=>{throw Error('模拟断写');};
  await assert.rejects(r.send('D',resume),/retryable/);
  r.app.disk.renameSync=save;
  await r.reply(r.sent('join-world')[0],'join-result',{status:'joined',fromSingle:true,position:2});
  assert.equal(r.sent('route-release').length,0);
  await r.send('D',resume);
  await r.reply(r.sent('roster-update').at(-1),'world-members',fresh);
  assert.equal(r.sent('route-release').length,1);
});

test('执行端刷新观测后重启，同一名册晚到的旧基线或旧成员观测授权不会切回原监控',async t=>{
  const file=limitedFile(temporaryData(t));
  let at=100000;
  const watched=[];
  const options={file,role:'host',now:()=>at,actions:{
    'prepare-world':async c=>({op:'world-ready',payload:{observedUid:c.worldUid,exactReads:2}}),
    'admit-seat':async()=>assert.fail('不能执行旧的放行基线'),
    observe:async c=>{watched.push(c.messageId);return {stable:true,ambiguous:false,members:[]};}
  }};
  let exe=createExecutor(options);
  const scope={version:1,type:'laicai',taskId:'t',roomName:'房间',workerId:'w',worldUid:'200000001',worldAttemptId:'world',slotId:1,slotGeneration:1};
  function publish(op,messageId,payload) {
    const c={...scope,op,messageId,payload,...(op!=='prepare-world' && {rosterVersion:1})};
    file.WriteTextSync('mailbox/in/'+messageId+'.json',JSON.stringify(c));
  }
  publish('prepare-world','prepare',{seatId:'host'});
  exe.poll();await exe.settle();
  publish('roster-update','fresh',{observationSeq:3,roster:[]});
  exe.poll();await exe.settle();
  exe=createExecutor(options);
  publish('roster-update','staleRoster',{observationSeq:2,roster:[]});
  publish('admit-seat','staleArm',{observationSeq:1,uid:'100000001',gameName:'甲'});
  at+=1000;
  exe.poll();await exe.settle();
  assert.deepEqual(watched,['fresh','fresh']);
});

test('真实桌面及执行端邮箱在恢复后重新采集现场，历史在场随后离开的回报均无法放行',async t=>{
  const uid='200000001', guest='100000001';
  const game=gameScreen(async()=>({op:'route-result',payload:{status:'success',evidence:'reward',isLast:true}}));
  let oldGrant, historical, absent;
  const {room}=await simulateTask(t,{workers:[{workerId:'w',uids:[uid]}],bigCount:1,makeActions:game.makeActions,
    async sendUp({uid:actor,data},r,deliver,client) {
      if (actor==='D' && data.op==='state-request') {
        await deliver();
        await r.app.send('D',historical);
        await r.app.send('D',absent);
        assert.equal(r.sent('route-release').length,0,'重放过时的在场观测提前放行了路线');
        return;
      }
      if (actor==='D' && data.op==='world-members') {
        if (!historical && data.payload.members.length===1) {
          historical=data; oldGrant=data.replyTo;
          game.worlds.get(uid).members.delete(guest);
          return;
        }
        if (historical && data.replyTo===oldGrant) {
          if (!data.payload.members.length && data.payload.stable && !absent) {
            absent=data;
            client.requestSnapshot();
          }
          return;
        }
        if (absent && data.replyTo!==oldGrant && data.payload.stable && !data.payload.members.length) {
          assert.equal(r.sent('route-release').length,0);
          game.worlds.get(uid).members.set(guest,2);
        }
      }
      await deliver();
    },stopWhen:r=>absent && r.sent('route-release').length>0});
  assert.ok(absent);
  assert.equal(room.sent('route-release').length,1);
  assert.equal(game.history.filter(e=>e.ui==='request').length,1);
});
