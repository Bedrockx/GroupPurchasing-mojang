const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createDesktopFiles, limitedFile} = require('./helpers/laicai-files.cjs');
const {createExecutor} = require('../js/来财/main.js');

for (const restart of [false,true]) test('小号目录隔离只接受原任务的人工解除，'+(restart?'重启执行端':'驻留执行端')+'随后只能运行新授权',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'laicai-isolated-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:60}));
  const dir=path.join(root,'多用户','来财');
  fs.mkdirSync(dir,{recursive:true});
  const [oldClient,otherClient]=['原安装','另一安装'].map(name=>{
    const install=path.join(root,name);
    fs.mkdirSync(install);
    return createDesktopFiles(install);
  });
  for (const client of [oldClient,otherClient]) { await client.select(dir); client.confirmRecovery(true); }
  const owner={taskId:'old',roomName:'原房',role:'host',accountId:'原账号',clientId:'old_pc'};
  const other={...owner,taskId:'other',accountId:'另一账号',clientId:'other_pc'};
  oldClient.bind(dir,owner); otherClient.bind(dir,other);
  const calls=[];
  const create=()=>createExecutor({role:'host',file:limitedFile(dir),actions:{'prepare-world':async c=>{
    calls.push(c.taskId);
    return {op:'world-ready',payload:{observedUid:c.worldUid,exactReads:2}};
  }}});
  const world={workerId:'worker1',slotId:1,slotGeneration:1,worldUid:'200000001',worldAttemptId:'world1'};
  // 一条用旧版本已经发出的准备指令，另一条核验新版保存的原主用户归属。
  const first={type:'laicai',version:1,messageId:'old_prepare',taskId:'old',roomName:'原房',op:'prepare-world',...world,
    payload:restart ? {} : {localOwner:owner}};
  async function send(client,ex,m) {
    client.publish(dir,m); ex.poll(); await ex.settle(); client.consume(dir,'in',m.messageId);
  }
  const original=create();
  await send(oldClient,original,first);
  await send(oldClient,original,{...first,op:'task-end',messageId:'end',payload:{unsafeWorlds:[world]}});
  assert(original.stopped);
  let worker=create();
  const next={...first,taskId:'next',worldAttemptId:'world2',messageId:'new_prepare',payload:{localOwner:{...other,taskId:'next'}}};
  await send(otherClient,worker,next);
  assert.deepEqual(calls,['old'],'隔离时不能切换小号');
  assert(otherClient.events(dir).some(e=>e.replyTo===next.messageId && e.payload.status==='rejected'));
  assert.equal(await otherClient.recover(dir,other),true);
  await send(otherClient,worker,{...next,messageId:'another'});
  assert.deepEqual(calls,['old'],'其他主用户解除自己的任务不能解除原隔离');
  if (!restart) {
    const barrier=path.join(dir,'mailbox/state/end-old.json');
    fs.writeFileSync(barrier,'{');
    await send(otherClient,worker,{...next,messageId:'unreadable'});
    assert.deepEqual(calls,['old'],'无法读取有效解除记录时应继续隔离');
    for (const [i,wrong] of [{accountId:'其他账号'},{clientId:'other_pc'},{roomName:'其他房'},{role:'big'}].entries()) {
      fs.writeFileSync(barrier,JSON.stringify({type:'laicai-local-end',version:1,...owner,...wrong}));
      await send(otherClient,worker,{...next,messageId:'wrong_'+i});
      assert.deepEqual(calls,['old'],'解除记录必须与原归属相匹配');
    }
    fs.unlinkSync(barrier);
  }
  assert.equal(await oldClient.recover(dir,owner),true);
  if (restart) worker=create();
  await send(otherClient,worker,next);
  await send(oldClient,worker,{...first,messageId:'late_old'});
  await send(otherClient,worker,{...next,messageId:'after_clear'});
  assert.deepEqual(calls,['old','next']);
  assert(otherClient.events(dir).some(e=>e.replyTo==='after_clear' && e.op==='world-ready'));
});

test('执行端离线错过终止，原客户端现场核对后拦截旧任务重放并允许新任务',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'laicai-recover-'));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:60});
  });
  const directory=path.join(root,'小号甲','来财');
  fs.mkdirSync(directory,{recursive:true});
  const desktop=createDesktopFiles(root);
  await desktop.select(directory);
  const owner={taskId:'old',role:'host',clientId:'station',accountId:'主用户',roomName:'旧房间'};
  desktop.bind(directory,owner);
  const first={type:'laicai',version:1,taskId:'old',op:'prepare-world',messageId:'oldPrepare',roomName:'旧房间',
    worldUid:'200000001',worldAttemptId:'attempt1',workerId:'worker1',slotId:1,slotGeneration:1,payload:{}};
  let actions=[];
  const create=()=>createExecutor({role:'host',file:limitedFile(directory),actions:{
    'prepare-world':async c=>{actions.push(c.taskId);return {op:'world-ready',payload:{observedUid:c.worldUid,exactReads:2}};}
  }});
  desktop.publish(directory,first);
  const offline=create();
  await offline.poll(); await offline.settle();
  assert.deepEqual(actions,['old']);
  // 原执行端在此停止，再未收到 task-end。新任务已在同一个邮箱。
  const next={...first,taskId:'next',roomName:'新房间',worldAttemptId:'attempt2',messageId:'newPrepare'};
  desktop.publish(directory,next);
  const restarted=createDesktopFiles(root);
  restarted.confirmRecovery(true);
  await assert.rejects(restarted.recover(directory,{...owner,accountId:'其他用户'}),/归属|隔离/);
  restarted.confirmRecovery(false);
  assert.equal(await restarted.recover(directory,owner),false);
  const barrier=path.join(directory,'mailbox/state/end-old.json');
  assert.equal(fs.existsSync(barrier),false);
  restarted.confirmRecovery(true);
  assert.equal(await restarted.recover(directory,owner),true);
  assert.equal(await restarted.recover(directory,owner),true);
  assert.equal(JSON.parse(fs.readFileSync(barrier,'utf8')).roomName,'旧房间');
  assert.equal(fs.existsSync(path.join(directory,'mailbox/in/oldPrepare.json')),false);
  assert.equal(fs.existsSync(path.join(directory,'mailbox/in/newPrepare.json')),true);
  restarted.publish(directory,{...first,messageId:'replay'});
  const recovered=create();
  for (let i=0;i<3;i++) {await recovered.poll();await recovered.settle();}
  assert.deepEqual(actions,['old','next']);
  assert.ok(restarted.events(directory).some(e=>e.taskId==='next' && e.op==='world-ready'));
});

test('两个来财实例并行收件，主进程读取完整事件，重启后重投同一指令不会再切号', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'laicai-mailbox-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const desktop = createDesktopFiles(root);
  const worlds = [];
  for (const slotId of [1, 2]) {
    const directory = path.join(root, 'Windows用户' + slotId, '来财');
    fs.mkdirSync(directory,{recursive:true});
    await desktop.select(directory);
    const command = {
      type:'laicai', version:1, op:'prepare-world', roomName:'模拟房间', messageId:'prepare_01',
      taskId:'run', worldUid:'20000000' + slotId, worldAttemptId:'try_' + slotId,
      slotId, slotGeneration:1, workerId:'worker_' + slotId, payload:{},
    };
    const game = {attempts:0};
    const create = () => createExecutor({
      role:'host', file:limitedFile(directory), now:Date.now, sleep:async () => {},
      actions:{'prepare-world':async (message, control) => {
        game.attempts++;
        control.emit('worker-stage',{stage:'verifying'});
        return {op:'world-ready',payload:{observedUid:message.worldUid,exactReads:2}};
      }},
    });
    const executor = create();
    executor.poll();
    assert.equal(fs.existsSync(path.join(directory, 'mailbox')), false);
    desktop.publish(directory,command);
    worlds.push({directory, command, executor, create, game});
  }
  await Promise.all(worlds.map(async ({executor}) => { await executor.poll(); await executor.settle(); }));
  for (const {directory, command, game} of worlds) {
    assert(fs.existsSync(path.join(directory, 'mailbox/state/executor0.json')));
    assert(fs.existsSync(path.join(directory, 'mailbox/out')));
    const received = desktop.events(directory);
    const ready = received.find(m => m.op === 'world-ready');
    assert(ready, 'B 应读取 C 的正式 world-ready 事件');
    assert.equal(ready.replyTo,command.messageId);
    assert.equal(ready.payload.observedUid,command.worldUid);
    assert.equal(ready.slotId,command.slotId);
    assert.equal(game.attempts,1);
    assert(received.every(m => !m.workerId || m.workerId === command.workerId));
    const marker = path.join(directory,'mailbox','out',ready.messageId + '.ready.json');
    const saved = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    assert(!desktop.events(directory).some(m => m.messageId === ready.messageId), '只有正文时 B 必须等待标记');
    fs.writeFileSync(marker,saved);
    assert(desktop.events(directory).some(m => m.messageId === ready.messageId));
    for (const event of received) desktop.consume(directory,'out',event.messageId);
    desktop.consume(directory,'in',command.messageId);
  }
  // 客户端已经接收事件后重启，同一命令因网络确认丢失而再次投递。
  const {directory,command,create,game} = worlds[0];
  const restartedDesktop = createDesktopFiles(root);
  restartedDesktop.publish(directory,command);
  const resumed = create();
  await resumed.poll();
  await resumed.settle();
  assert.equal(game.attempts,1);
  assert(restartedDesktop.events(directory).some(m => m.op === 'world-ready' && m.replyTo === command.messageId));
  assert.equal(restartedDesktop.events(worlds[1].directory).length,0);
});
