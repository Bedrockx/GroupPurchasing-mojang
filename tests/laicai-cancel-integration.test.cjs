const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {temporaryData}=require('./helpers/server-fixture.cjs');
const {limitedFile,createDesktopFiles}=require('./helpers/laicai-files.cjs');
const {pathingHost}=require('./helpers/laicai-pathing.cjs');
const {createExecutor,createWorldActions}=require('../js/来财/main.js');
const catalog=require('../js/来财/routes/catalog.json');

for (const [routeSeq,stage] of [[1,'主追踪'],[2,'前置传送']]) test(stage+'通过文件接收取消后可按令退出世界',async t=>{
  const root=temporaryData(t), folder=path.join(root,'来财');
  fs.mkdirSync(folder);
  const desktop=createDesktopFiles(root);
  await desktop.select(folder);
  let now=1000, panel=false, sign=2, pending=[];
  const wait=ms=>new Promise(resolve=>pending.push({until:now+ms,resolve}));
  const host=pathingHost({now:()=>now,wait,positionSign:()=>sign,duration:60000});
  const leave=createWorldActions({now:()=>now,wait,sign:()=>sign,f2:()=>panel,
    key:key=>{panel=key==='F2';},pressNamed:button=>{if(button==='leaveTeam'){sign=0;panel=false;return true;}return false;}});
  const script=createExecutor({role:'big',now:()=>now,file:limitedFile(folder),actions:{
    'run-route':host.actions['run-route'],'leave-world':leave['leave-world'],
    'join-world':async()=>({op:'join-result',payload:{status:'joined',fromSingle:true,position:2}})
  }});
  const world={worldUid:'200000001',worldAttemptId:'w1',seatId:'s1',rosterVersion:1};
  function publish(messageId,op,scope,payload={}) {
    desktop.publish(folder,{type:'laicai',version:1,roomName:'测试',taskId:'t1',messageId,op,...scope,payload});
  }
  async function pumpUntil(check) {
    for(let i=0;i<160;i++){
      script.poll();
      if(check())return;
      now+=100;
      const due=pending.filter(entry=>entry.until<=now);
      pending=pending.filter(entry=>entry.until>now);
      for(const entry of due)entry.resolve();
      await new Promise(resolve=>setImmediate(resolve));
    }
    assert.fail('执行端未按时交付预期结果');
  }
  const event=(replyTo,op,status)=>desktop.events(folder).find(m=>m.replyTo===replyTo && m.op===op &&
    (status===undefined || m.payload.status===status));
  publish('start','task-start',{}, {role:'big',seatId:'s1',laicaiVersion:'1.0.0'});
  await pumpUntil(()=>event('start','executor-ready'));
  publish('join','join-world',world);
  await pumpUntil(()=>event('join','join-result'));
  publish('run','run-route',{...world,routeSeq});
  await pumpUntil(()=>host.tokens.length && (routeSeq===1?host.calls.length:host.teleports.length));
  publish('old','cancel-route',{...world,routeSeq:routeSeq+1});
  await pumpUntil(()=>event('old','ack','applied'));
  assert.equal(host.tokens[0].canceled,false);
  publish('cancel','cancel-route',{...world,routeSeq,rosterVersion:2},{reason:'路线超时'});
  publish('exit','leave-world',{...world,rosterVersion:2});
  await pumpUntil(()=>event('exit','seat-left'));
  assert(event('run','route-result','canceled'));
  assert(host.tokens[0].canceled && host.tokens[0].disposed);
  if (routeSeq===2) {
    assert.deepEqual(host.teleports,[catalog.routes.B.teleportFile]);
    assert.deepEqual(host.calls,[],'传送取消后不启动主追踪');
  }
  assert.equal(sign,0);
  assert.equal(event('run','route-result','success'),undefined);
});

test('runFile 返回 finished 且到达终点，缺少本次战斗证据时向队伍回报本地到达',async ()=>{
  let now=0, timers=[],finished=false;
  const wait=ms=>new Promise(resolve=>timers.push({until:now+ms,resolve}));
  const host=pathingHost({now:()=>now,wait,positionSign:()=>2,showReward:false});
  const cmd={routeSeq:1,payload:{}};
  const action=host.actions['run-route'](cmd,{canceled:false},{timeoutSeconds:120});
  action.then(()=>{finished=true;},()=>{finished=true;});
  for(let i=0;i<200 && !finished;i++) {
    now+=100;
    const due=timers.filter(entry=>entry.until<=now);
    timers=timers.filter(entry=>entry.until>now);
    for(const entry of due)entry.resolve();
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert(finished);
  const report=await action;
  assert.equal(report.op,'route-result');
  assert.deepEqual(report.payload,{status:'await-team',isLast:false});
  assert(host.tokens.every(token=>token.disposed && !token.canceled));
});
