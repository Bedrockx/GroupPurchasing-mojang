const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID,createHash} = require('node:crypto');
const {createRoom} = require('./laicai-room.cjs');
const {temporaryData} = require('./server-fixture.cjs');
const {createDesktopFiles,limitedFile} = require('./laicai-files.cjs');
const {createExecutor} = require('../../js/来财/main.js');
const {memoryDisk} = require('./laicai-memory-disk.cjs');

const html = fs.readFileSync(path.join(__dirname,'../../client/index.html'),'utf8');
const renderer = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createRenderer(transport, actor, options, api, clock, seed) {
  const storage = new Map([['laicai-client-id','pc_'+actor]]), elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{style:{},textContent:'',children:[],replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}});
    return elements.get(id);
  };
  let sequence=0;
  const uuid=seed ? ()=>createHash('sha256').update(seed+'/'+actor+'/'+(++sequence)).digest('hex').slice(0,32) : randomUUID;
  const ctx = vm.createContext({
    window:{electronAPI:{onUpdateProgress(){},...api},addEventListener(){}},
    document:{getElementById:element,createElement:()=>({})}, localStorage:{
      getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:()=>1,clearTimeout(){},crypto:{randomUUID:uuid},Date:class extends Date {static now(){return clock.now;}},
    account:actor, options,
    network:{connected:true,emit:(_name,data)=>transport.push({uid:actor,data})}
  });
  const run = code => vm.runInContext(code,ctx);
  run(renderer);
  run(`accountId=account; isLoggedIn=true; socket=network; closeBGI=async()=>true;
      lcState={enabled:true,room:'测试房间',options,payload:{laicaiVersion:'1.0.0'}};`);
  return {receive(message){ctx.message=message;run('lcReceive(message)');},
    requestSnapshot:()=>run("lcSend('state-request',{}, {clientId:lcClientId(),taskId:lcState.task.taskId})"),
    pump:()=>run('lcPump()'), locked:()=>Boolean(run('lcLock()'))};
}

// 房间创建与报名已由 createRoom 经网络入口完成。运行阶段 C/B/A 只通过真实协议通信。
// 驱动顺序模拟挂起的 Socket、桌面轮询和 BetterGI 游戏线程。
async function simulateTask(t, {workers,bigCount,makeActions,limit=2000,stopWhen,large=false,seed,sendUp}) {
  const room = await createRoom(t,workers,{bigCount});
  const root = temporaryData(t);
  const disk=large?memoryDisk():fs;
  const bFiles = createDesktopFiles(root,disk);
  const launches=[], retired=new Set();
  let workerPeak=0;
  const clock = {now:room.app.clock.now,waiting:[]};
  function wait(ms) { return new Promise(resolve=>clock.waiting.push({at:clock.now+ms,resolve})); }
  const up = [], trace = [], clients = new Map(), scripts = new Map();
  const configured = workers.map(w=>({...w,batId:'bat_'+w.workerId,directory:path.join(root,w.workerId,'来财')}));
  async function addDirectory(dir) {
    disk.mkdirSync(dir,{recursive:true});
    await bFiles.select(dir);
  }
  function start(dir,role,name) {
    if (scripts.get(dir) && !scripts.get(dir).stopped) throw Error('测试游戏会话被重复启动 ' + name);
    launches.push({role,name});
    scripts.set(dir,createExecutor({role,file:limitedFile(dir,disk),now:()=>clock.now,
      actions:makeActions({role,name,wait,now:()=>clock.now})}));
  }
  const api = {
    publishLaicai:bFiles.publish, laicaiEvents:bFiles.events,bindLaicaiOwner:bFiles.bind,holdLaicaiOwner:bFiles.bind,
    consumeLaicai:(dir,id,side)=>bFiles.consume(dir,side,id),
    laicaiVersion:async ()=>'1.0.0',
    startLaicaiWorker:async batId=>{
      const worker=configured.find(w=>w.batId===batId);
      assert(worker);
      start(worker.directory,'host',worker.workerId);
      return {started:true};
    }
  };
  for (const w of configured) await addDirectory(w.directory);
  clients.set('D',createRenderer(up,'D',{role:'host',workers:configured},api,clock,seed));
  for (const id of room.bigs) {
    const directory=path.join(root,'大号'+id,'来财');
    await addDirectory(directory);
    clients.set(id,createRenderer(up,id,{role:'big',directory,dragon:'来财'},{
      ...api,startProcess:async()=>start(directory,'big',id)
    },clock,seed));
  }
  let next = 0;
  for (let ticks=0;ticks<limit;ticks++) {
    while (next<room.app.messages.length) {
      const {uid,data} = room.app.messages[next++];
      if (data.type!=='laicai') continue;
      trace.push({direction:'down',uid,data});
      clients.get(uid)?.receive(data);
    }
    for (const c of clients.values()) await c.pump();
    for (const c of scripts.values()) if (!c.stopped) c.poll();
    for (const packet of up.splice(0)) {
      trace.push({direction:'up',...packet});
      const deliver=(event=packet.data)=>room.app.send(packet.uid,event);
      if(sendUp)await sendUp(packet,room,deliver,clients.get(packet.uid));
      else await deliver();
    }
    // 让异步游戏操作运行到下一次等待，不能直接 await settle 而阻塞另一窗口。
    const startedWorkers=configured.filter(w=>scripts.has(w.directory));
    for(const worker of startedWorkers) if(scripts.get(worker.directory).stopped) retired.add(worker.workerId);
    workerPeak=Math.max(workerPeak,startedWorkers.filter(w=>!scripts.get(w.directory).stopped).length);
    clock.now += large?500:100;
    room.app.clock.now=clock.now;
    const due=clock.waiting.filter(entry=>entry.at<=clock.now);
    clock.waiting=clock.waiting.filter(entry=>entry.at>clock.now);
    for (const entry of due) entry.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    if (stopWhen && stopWhen(room)) return {room,trace,ticks};
    if (room.sent('task-end').length && [...clients.values()].every(c=>!c.locked())) return {room,trace,ticks,launches,retired,workerPeak};
  }
  const history=trace.filter(p=>!['heartbeat','ack'].includes(p.data.op) || p.data.payload.status==='rejected');
  assert.fail('模拟超时，最后消息 '+JSON.stringify(history.slice(-12).map(p=>[p.direction,p.uid,p.data.op,p.data.payload])));
}

module.exports = {simulateTask};
