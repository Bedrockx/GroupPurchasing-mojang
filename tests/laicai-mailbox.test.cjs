const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createDesktopFiles, limitedFile} = require('./helpers/laicai-files.cjs');
const {createExecutor} = require('../js/来财/main.js');

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
    desktop.publish(directory,command);
    worlds.push({directory, command, executor, create, game});
  }
  await Promise.all(worlds.map(async ({executor}) => { await executor.poll(); await executor.settle(); }));
  for (const {directory, command, game} of worlds) {
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
