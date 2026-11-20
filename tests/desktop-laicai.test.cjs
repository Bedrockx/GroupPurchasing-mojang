const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function script(file) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}
function fixture() {
    const elements = new Map(), sent = [], data = new Map();
    const lookup = id => {
        if (!elements.has(id)) elements.set(id, {style:{}, replaceChildren(){this.children=[];}, appendChild(item){this.children.push(item);}, children:[]});
        return elements.get(id);
    };
    const ctx = vm.createContext({
        window:{addEventListener(){},electronAPI:{onUpdateProgress(){},bindLaicaiOwner:async()=>{},holdLaicaiOwner(){},laicaiVersion:async () => '1.2.3'}},
        document:{getElementById:lookup,createElement:()=>({})}, localStorage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},
        crypto:{randomUUID}, setTimeout(){return 1;}, sent
    });
    const run = code => vm.runInContext(code, ctx);
    run(script('client/index.html'));
    run("accountId='甲'; isLoggedIn=true; socket={connected:true,emit(_e,m){sent.push(m)}}; lcRooms={房:{roomType:'laicai'}}; addLog=()=>{};");
    for (const [k,v] of Object.entries({'lc-room':'房','lc-uid':'100000001','lc-role':'big','lc-name':'甲','lc-dragon':'来财'})) lookup(k).value=v;
    lookup('bgi-folder-path').textContent='E:\\bgi';
    const msg = (op,fields) => {ctx.input={op,type:'laicai',version:1,messageId:randomUUID(),roomName:'房',...fields};run('lcReceive(input)');};
    return {run,sent,msg,lookup,ctx};
}

test('大号报名使用安装版本，先发车后报名确认时保持占用，重复发车只保留同一任务',async ()=>{
    const f=fixture();
    await f.run('lcEnroll()');
    const first=f.sent[0];
    assert.equal(first.payload.laicaiVersion,'1.2.3');
    const payload={role:'big',seatId:'s1',laicaiVersion:'1.2.3'};
    f.msg('task-start',{taskId:'t1',payload});
    f.msg('ack',{replyTo:first.messageId,payload:{status:'applied'}});
    assert.equal(f.lookup('lc-status').textContent,'已发车');
    assert.equal(f.run("addDragonTask('普通')"),false);
    f.msg('task-start',{taskId:'t2',payload});
    assert.equal(f.sent.at(-1).payload.status,'rejected');
    f.msg('task-end',{taskId:'t1',payload:{reason:'完成'}});
    assert.equal(f.run('lcLock()'),null);
});

test('未满员时重连重新登记，关闭参与后重连仅撤销，迟到发车被拒绝',async ()=>{
    const f=fixture();
    await f.run('lcEnroll()');
    f.run('lcBind()');
    const request=f.sent.at(-1);
    f.msg('state-snapshot',{replyTo:request.messageId,payload:{task:null}});
    assert.equal(f.sent.at(-1).op,'seat-ready');
    f.run('lcWithdraw();lcBind()');
    f.msg('state-snapshot',{replyTo:f.sent.at(-1).messageId,payload:{task:null}});
    assert.equal(f.sent.at(-1).op,'seat-withdraw');
    f.msg('task-start',{taskId:'t',payload:{role:'big',laicaiVersion:'1.2.3'}});
    assert.equal(f.sent.at(-1).payload.status,'rejected');
    assert.equal(f.run('lcLock()'),null);
});

test('报名、快照和关闭参与在临时写盘失败后按原编号重试，永久拒绝停止',async()=>{
    const f=fixture();
    const retry=async packet=>{
        f.msg('ack',{replyTo:packet.messageId,payload:{status:'rejected',retryable:true,reason:'磁盘暂时占用'}});
        const before=f.sent.length;
        await f.run('lcPump()');
        assert.equal(f.sent.length,before);
        f.run('lcControlSent.clear()');
        await f.run('lcPump()');
        assert.equal(f.sent.at(-1).messageId,packet.messageId);
    };
    await f.run('lcEnroll()');
    const enrollment=f.sent.at(-1);
    await retry(enrollment);
    assert.equal(f.run('lcState.enabled'),true);
    f.msg('ack',{replyTo:enrollment.messageId,payload:{status:'applied'}});
    f.run('lcBind()');
    const snapshot=f.sent.at(-1);
    await retry(snapshot);
    f.msg('state-snapshot',{replyTo:snapshot.messageId,payload:{task:null}});
    const current=f.sent.at(-1);
    assert.equal(current.op,'seat-ready');
    f.run('lcWithdraw()');
    const withdrawn=f.sent.at(-1);
    assert.equal(f.run('Object.values(lcControls()).some(p=>p.op==="seat-ready")'),false);
    await retry(withdrawn);
    f.msg('ack',{replyTo:withdrawn.messageId,payload:{status:'rejected',reason:'房间已删除'}});
    assert.equal(f.run('Object.keys(lcControls()).length'),0);
    assert.equal(f.run('lcState.enabled'),false);
});

test('启动只执行一次，重连快照保留指令编号和待确认结果，结束后可重发 applied',async ()=>{
    const f=fixture(), files=new Map(), events=[];
    let launches=0;
    Object.assign(f.ctx.window.electronAPI,{
        closeProcess:async()=>true,startProcess:async()=>++launches,
        publishLaicai:async (dir,m)=>files.set(m.messageId,m),
        laicaiEvents:async ()=>[...events],
        consumeLaicai:async (_dir,id,side)=>{
            if(side==='in') files.delete(id);
            else {const index=events.findIndex(e=>e.messageId===id);if(index>=0)events.splice(index,1);}
        }
    });
    await f.run('lcEnroll()');
    const payload={role:'big',seatId:'s1',laicaiVersion:'1.2.3'};
    const start={taskId:'t',messageId:'start',payload};
    f.msg('task-start',start);
    const started=f.sent.at(-1);
    assert.equal(started.payload.clientId,f.run('lcClientId()'));
    f.msg('ack',{replyTo:started.messageId,taskId:'t',payload:{status:'rejected',retryable:true}});
    f.run('lcControlSent.clear()');
    await f.run('lcPump()');
    assert.ok(f.sent.filter(m=>m.messageId===started.messageId).length>=2);
    f.msg('ack',{replyTo:started.messageId,taskId:'t',payload:{status:'applied'}});
    f.msg('task-start',start);
    await f.run('lcPump()');
    assert.equal(launches,1);
    const local=[...files.values()][0];
    assert.notEqual(local.messageId,'start');
    events.push({...local,op:'executor-ready',messageId:'ready',replyTo:local.messageId,payload:{role:'big',laicaiVersion:'1.2.3'}});
    f.run('socket.connected=false');
    await f.run('lcPump()');
    assert.equal(files.size,0);
    assert.equal(f.sent.some(m=>m.messageId==='ready'),false);
    f.run('socket.connected=true;lcBind()');
    f.msg('state-snapshot',{replyTo:f.sent.at(-1).messageId,payload:{task:{...payload,taskId:'t',phase:'preparing',pending:[]}}});
    f.run('lcLastSent=0');
    await f.run('lcPump()');
    assert.equal(f.sent.find(m=>m.messageId==='ready').replyTo,'start');
    f.msg('ack',{replyTo:'ready',taskId:'t',payload:{status:'rejected',retryable:true}});
    assert.ok(f.run("lcBridge().outbox.ready"));
    const sent=f.sent.filter(m=>m.messageId==='ready').length;
    f.run('lcLastSent=0');
    await f.run('lcPump()');
    assert.equal(f.sent.filter(m=>m.messageId==='ready').length,sent+1);
    f.msg('ack',{replyTo:'ready',taskId:'t',payload:{status:'applied'}});
    assert.equal(f.run("lcBridge().outbox.ready"),undefined);
    const end={taskId:'t',messageId:'end',payload:{reason:'完成'}};
    f.msg('task-end',end);
    await f.run('lcPump()');
    const close=[...files.values()].find(m=>m.op==='task-end');
    assert.ok(close);
    assert.equal(f.run('lcLock().taskId'),'t');
    events.push({...close,op:'ack',messageId:'closed',replyTo:close.messageId,payload:{status:'applied'}});
    await f.run('lcPump()');
    assert.equal(f.run('lcLock()'),null);
    const ack=f.sent.find(m=>m.replyTo==='end');
    f.msg('task-end',end);
    assert.equal(f.sent.at(-1).messageId,ack.messageId);
    f.msg('ack',{replyTo:ack.messageId,taskId:'t',payload:{status:'rejected',retryable:true}});
    f.run('lcControlSent.clear()');
    await f.run('lcPump()');
    assert.equal(f.sent.at(-1).messageId,ack.messageId);
    f.msg('ack',{replyTo:ack.messageId,taskId:'t',payload:{status:'applied'}});
    assert.equal(f.run('lcControls()[input.replyTo]'),undefined);
});

test('快照已撤销旧世界时，本地持久化且尚未投递的路线不能下发',async ()=>{
    const f=fixture(), writes=[], removed=[];
    Object.assign(f.ctx.window.electronAPI,{laicaiEvents:async()=>[],publishLaicai:async (_dir,m)=>writes.push(m),
        consumeLaicai:async (_dir,id,side)=>removed.push([id,side])});
    await f.run('lcEnroll()');
    const task={role:'big',seatId:'s',taskId:'t',laicaiVersion:'1.2.3'};
    f.msg('task-start',{taskId:'t',messageId:'start',payload:task});
    f.run("lcState.bridge.commands.start.launch='spawned';lcState.bridge.commands.start.locals[0].seen=true;lcBridge().bigWorld={id:'w1',uid:'100000001',rosterVersion:1};lcPersist()");
    f.msg('route-release',{taskId:'t',messageId:'oldroute',worldUid:'100000001',worldAttemptId:'w1',routeSeq:1,seatId:'s',rosterVersion:1,payload:{}});
    f.run('lcBind()');
    f.msg('state-snapshot',{replyTo:f.sent.at(-1).messageId,payload:{task:{...task,phase:'preparing',pending:[]}}});
    await f.run('lcPump()');
    assert.equal(writes.length,0);
    assert.deepEqual(removed,[[f.run('lcState.bridge.commands.oldroute.locals[0].message.messageId'),'in']]);
});

function hostFixture(start) {
    const f=fixture(), launched=[], published=[], events=[];
    const workers=['a','b','c'].map((workerId,index)=>({workerId,uids:index===0?['100000001','100000004']:['10000000'+(index+1)],batId:workerId,directory:workerId}));
    Object.assign(f.ctx,{workers});
    f.run("lcState={enabled:true,room:'房',options:{role:'host',workers},payload:{laicaiVersion:'1.2.3'},task:{role:'host',taskId:'t',seatId:'host',laicaiVersion:'1.2.3',worldUids:workers.flatMap(w=>w.uids)}}");
    Object.assign(f.ctx.window.electronAPI,{startLaicaiWorker:async id=>{launched.push(id);return start?.(id) || {started:true,pid:1};},
        publishLaicai:async (directory,message)=>published.push({directory,message}),
        laicaiEvents:async dir=>events.filter(e=>e.directory===dir).map(e=>e.message),
        consumeLaicai:async (_dir,id,side)=>{if(side==='out') {const i=events.findIndex(e=>e.message.messageId===id);if(i>=0)events.splice(i,1);}}
    });
    const prep=(workerId,slotId,slotGeneration,uid)=>({messageId:'p'+uid,taskId:'t',worldUid:uid,
        worldAttemptId:'w'+uid,workerId,slotId,slotGeneration,payload:{}});
    async function result(command,op,payload) {
        const {directory,message}=command;
        events.push({directory,message:{...message,op,payload,replyTo:message.messageId,messageId:randomUUID()}});
        await f.run('lcPump()');
    }
    return {f,launched,published,events,prep,result};
}

test('小号准备及终止的本地指令都保留原莫酱账号和客户端归属',async()=>{
    const {f,published,prep}=hostFixture();
    const original=prep('a',1,1,'100000001');
    f.run('lcState.task.timeoutSeconds=20');
    f.msg('prepare-world',original);
    await f.run('lcPump()');
    f.msg('task-end',{taskId:'t',messageId:'end',payload:{unsafeWorlds:[original]}});
    await f.run('lcPump()');
    const messages=published.map(p=>p.message);
    assert.deepEqual(messages.map(m=>m.op),['prepare-world','task-end']);
    for (const m of messages) {
        assert.deepEqual({...m.payload.localOwner},{taskId:'t',roomName:'房',role:'host',accountId:'甲',clientId:f.run('lcClientId()')});
    }
});

test('主用户重连收回旧入场授权后仍轮询在役槽位，只转发匹配代次的新鲜小号心跳',async()=>{
    const {f,published,events,prep,result}=hostFixture();
    const a=prep('a',1,1,'100000001'), b=prep('b',2,1,'100000002');
    const polls=[];
    const read=f.ctx.window.electronAPI.laicaiEvents;
    f.ctx.window.electronAPI.laicaiEvents=async dir=>{polls.push(dir);return read(dir);};
    f.msg('prepare-world',a);f.msg('prepare-world',b);
    await f.run('lcPump()');
    for (const cmd of published) await result(cmd,'world-ready',{exactReads:2,observedUid:cmd.message.worldUid});
    f.msg('open-admission',{...a,rosterVersion:1,messageId:'open',payload:{roster:[]}});
    await f.run('lcPump()');
    await result(published.at(-1),'admission-opened',{});
    f.msg('admit-seat',{...a,seatId:'guest',rosterVersion:1,messageId:'arm',payload:{uid:'100000008',gameName:'甲'}});
    await f.run('lcPump()');
    const arm=published.at(-1);
    await result(arm,'seat-armed',{stable:true,ambiguous:false,members:[]});
    await result(arm,'ack',{status:'applied'});
    const snapshot=f.run("lcSend('state-request',{}, {clientId:lcClientId(),taskId:'t'})");
    const task=f.run('lcState.task');
    f.msg('state-snapshot',{replyTo:snapshot,payload:{task:{...task,phase:'route',pending:[],worlds:[
        {...a,phase:'route',rosterVersion:1},{...b,phase:'ready'}
    ]}}});
    await f.run('lcPump()');
    assert.equal(f.run("lcBridge().commands.arm.retired && lcBridge().commands.arm.locals[0].withdrawn"),true);
    const heartbeat=()=>({source:'executor',role:'host',laicaiVersion:'1.2.3',observedAt:Date.now(),stage:'idle'});
    const observed=()=>f.sent.filter(m=>m.op==='heartbeat' && m.payload.source==='executor');
    polls.length=0;
    await result(arm,'heartbeat',heartbeat());
    await result(published[1],'heartbeat',heartbeat());
    assert.deepEqual([...new Set(polls)].sort(),['a','b']);
    assert.deepEqual(observed().map(e=>e.worldAttemptId),[a.worldAttemptId,b.worldAttemptId]);
    await result(arm,'heartbeat',{...heartbeat(),observedAt:Date.now()-20000});
    await result({...arm,message:{...arm.message,slotGeneration:2}},'heartbeat',heartbeat());
    assert.equal(observed().length,2);
    for (const state of ['isolated','cold','released']) {
        polls.length=0;
        if (state==='released') f.run("lcWorkerData(lcBridge(),'a').state='idle';lcBridge().slots[1].released=true");
        else {f.ctx.workerState=state;f.run("lcWorkerData(lcBridge(),'a').state=workerState");}
        await result(arm,'heartbeat',heartbeat());
        assert.equal(polls.includes('a'),false);
        // 强制其他待办轮询该目录时，迟到心跳也不能表示槽位仍在役。
        const event=events.splice(0).at(-1);
        f.ctx.oldPulse=event.message;
        await f.run("lcEvent('a',oldPulse,lcBridge(),()=>true)");
        assert.equal(observed().length,2);
    }
});

test('旧准备授权首次投递时从房间补齐时限，重复派发沿用同一本地指令',async()=>{
    const {f,published,prep}=hostFixture();
    f.run('lcState.task.timeoutSeconds=300');
    const p=prep('a',1,1,'100000001');
    f.msg('prepare-world',p);await f.run('lcPump()');
    assert.equal(published[0].message.payload.timeoutSeconds,300);
    assert.equal(published[0].message.payload.localOwner.clientId,f.run('lcClientId()'));
    assert.equal(p.payload.timeoutSeconds,undefined);
    f.msg('prepare-world',p);await f.run('lcPump()');
    assert.equal(published.length,1);
});

test('账本中已有的小号准备信封按原文恢复，新清场授权同步房间时限',async()=>{
    const {f,published,prep}=hostFixture();
    const p=prep('a',1,1,'100000001');
    f.msg('prepare-world',p);
    const original=f.run("JSON.stringify(lcBridge().commands.p100000001.locals[0].message)");
    f.run('lcState.task.timeoutSeconds=300;lcPersist()');
    f.msg('prepare-world',p);await f.run('lcPump()');
    assert.equal(JSON.stringify(published[0].message),original);
    f.msg('check-clear',{...p,messageId:'cleanup',rosterVersion:1,payload:{}});
    await f.run('lcPump()');
    assert.equal(published.find(e=>e.message.op==='check-clear').message.payload.timeoutSeconds,300);
});

test('备用多用户启动失败后可接替，已接待的位置正常复用且不重复启动 BAT',async()=>{
    const {f,launched,published,prep,result}=hostFixture(id=>id==='b'?{started:false,reason:'BAT不存在'}:null);
    const a=prep('a',1,1,'100000001'), b=prep('b',2,1,'100000002'), c=prep('c',2,2,'100000003');
    f.msg('prepare-world',a);f.msg('prepare-world',b);
    await f.run('lcPump()');
    assert.deepEqual(launched,['a','b']);
    assert.equal(f.sent.find(m=>m.payload.stage==='failed').payload.slotReusable,true);
    const first=published[0];
    await result(first,'world-ready',{exactReads:2,observedUid:a.worldUid});
    f.msg('prepare-world',c);
    await f.run('lcPump()');
    const release={...a,messageId:'releaseA',rosterVersion:1};
    f.msg('release-world',release);
    await f.run('lcPump()');
    const releaseFile=published.find(e=>e.message.op==='release-world');
    assert.equal(releaseFile.message.payload.retire,false);
    await result(releaseFile,'ack',{status:'applied'});
    f.msg('prepare-world',prep('a',1,2,'100000004'));
    f.msg('prepare-world',b);
    await f.run('lcPump()');
    assert.deepEqual(launched,['a','b','c']);
    assert.ok(published.some(e=>e.message.worldUid==='100000004'));
});

test('同一位置替换待命多用户时先退役，未知启动结果超时隔离且不再次启动',async()=>{
    const {f,launched,published,prep,result}=hostFixture();
    const a=prep('a',1,1,'100000001');
    f.msg('prepare-world',a);await f.run('lcPump()');
    await result(published[0],'world-ready',{exactReads:2,observedUid:a.worldUid});
    f.msg('release-world',{...a,messageId:'r',rosterVersion:1});await f.run('lcPump()');
    await result(published.find(e=>e.message.op==='release-world'),'ack',{status:'applied'});
    const c=prep('c',1,2,'100000003');
    f.msg('prepare-world',c);await f.run('lcPump()');
    assert.deepEqual(launched,['a']);
    const retire=published.find(e=>e.message.op==='retire-worker');
    await result(retire,'ack',{status:'applied'});
    await f.run('lcPump()');
    assert.deepEqual(launched,['a','c']);
    f.run("lcBridge().commands.p100000003.deadline=Date.now()-1");
    await f.run('lcPump()');
    const failure=f.sent.find(m=>m.payload.stage==='failed');
    assert.equal(failure.payload.slotReusable,false);
    f.msg('prepare-world',prep('a',1,3,'100000004'));
    await f.run('lcPump()');
    assert.deepEqual(launched,['a','c']);
});

test('准备已经排队但服务端先撤销时，不得启动 BAT 或向小号发布旧指令',async()=>{
    const {f,launched,published,prep}=hostFixture();
    const a=prep('a',1,1,'100000001');
    f.msg('prepare-world',a);
    f.msg('cancel-attempt',{...a,messageId:'cancel',payload:{reason:'准备到期'}});
    await f.run('lcPump()');
    assert.deepEqual(launched,[]);
    assert.deepEqual(published,[]);
    assert.equal(f.sent.find(m=>m.replyTo==='cancel').payload.slotReusable,true);
});

test('白名单 BAT 在包含中文、空格和与号的临时目录中可以启动',{skip:process.platform!=='win32'},async t=>{
    const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'来财 BAT & '));
    let closed;
    t.after(async()=>{
        assert.equal(path.dirname(path.resolve(dir)),path.resolve(require('node:os').tmpdir()));
        assert.ok(path.basename(dir).startsWith('来财 BAT & '));
        try { if (closed) await closed; }
        finally { await fs.promises.rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const file=path.join(dir,'模拟 BAT &.bat');
    fs.writeFileSync(file,'@echo off\r\n>ready.txt echo OK\r\n');
    const handlers={};
    const body=fs.readFileSync(path.join(__dirname,'../client/main.js'),'utf8');
    const ctx=vm.createContext({ipcMain:{handle(k,fn){handlers[k]=fn;}},fs,path,process,
        readRemoteWhitelist:()=>[dir],collectExecutables:()=>[{id:'w',name:path.basename(file)}],
        remoteExecutableCache:new Map([['w',file]]),isWithinRoot:()=>true,spawn(...args){
            const child=require('node:child_process').spawn(...args);
            // 产品在 spawn 时即返回。清理临时目录前须等实际 cmd.exe 释放工作目录。
            closed=new Promise((resolve,reject)=>{
                const timer=setTimeout(()=>reject(Error('测试 BAT 未在 8 秒内退出')),8000);
                child.once('close',code=>{clearTimeout(timer);resolve(code);});
            });
            return child;
        }});
    vm.runInContext(body.slice(body.indexOf("ipcMain.handle('laicai-start-worker'"),body.indexOf('// 每份脚本使用本目录的邮箱')),ctx);
    assert.equal((await handlers['laicai-start-worker'](null,'w')).started,true);
    const marker=path.join(dir,'ready.txt');
    assert.equal(await closed,0);
    assert.equal(fs.readFileSync(marker,'utf8').trim(),'OK');
    assert.equal((await handlers['laicai-start-worker'](null,'missing')).started,false);
});

test('两位依次放行时多次观测关联当前授权，上一席晚到的成员观测无效',async()=>{
    const {f,published,prep,result}=hostFixture();
    const a=prep('a',1,1,'100000001');
    f.msg('prepare-world',a);await f.run('lcPump()');
    await result(published[0],'world-ready',{exactReads:2,observedUid:a.worldUid});
    const scope={...a,rosterVersion:1};
    f.msg('open-admission',{...scope,messageId:'open',payload:{roster:[]}});
    await f.run('lcPump()');
    await result(published.at(-1),'admission-opened',{});
    f.msg('admit-seat',{...scope,messageId:'one',seatId:'s1',payload:{gameName:'甲',uid:'200000001'}});
    await f.run('lcPump()');
    const first=published.at(-1);
    await result(first,'seat-armed',{stable:true,members:[]});
    await result(first,'world-members',{stable:true,ambiguous:false,members:[{seatId:'s1',position:2}]});
    const count=()=>f.sent.filter(m=>m.op==='world-members' && m.replyTo==='one').length;
    assert.ok(count()>=1);
    const before=count();
    f.msg('admit-seat',{...scope,messageId:'two',seatId:'s2',payload:{gameName:'乙',uid:'200000002'}});
    await f.run('lcPump()');
    const second=published.at(-1);
    await result(first,'world-members',{stable:true,ambiguous:true,members:[]});
    assert.equal(count(),before);
    await result(second,'seat-armed',{stable:true,members:[{seatId:'s1',position:2}]});
    await result(second,'world-members',{stable:true,ambiguous:false,members:[{seatId:'s1',position:2},{seatId:'s2',position:3}]});
    assert.ok(f.sent.some(m=>m.op==='world-members' && m.replyTo==='two' && m.payload.members.length===2));
    f.msg('check-clear',{...scope,messageId:'clear',payload:{}});
    await f.run('lcPump()');
    await result(published.at(-1),'world-cleared',{stable:true,memberCount:0});
    assert.match(f.lookup('lc-status').textContent,/清空|清场/);
});

test('大号仅处理自己的当前世界，退回单人后拒绝旧尝试的新申请',async()=>{
    const f=fixture(), published=[], events=[];
    Object.assign(f.ctx.window.electronAPI,{publishLaicai:async(_dir,m)=>published.push(m),laicaiEvents:async()=>events.splice(0),consumeLaicai:async()=>{}});
    await f.run('lcEnroll()');
    const task={role:'big',seatId:'s',taskId:'t',laicaiVersion:'1.2.3',worldUids:['100000001','100000002']};
    f.msg('task-start',{taskId:'t',messageId:'start',payload:task});
    f.run("lcState.bridge.commands.start.launch='spawned';lcState.bridge.commands.start.locals[0].seen=true;");
    const scope={taskId:'t',worldUid:'100000001',worldAttemptId:'w',rosterVersion:1,seatId:'s',payload:{}};
    f.msg('join-world',{...scope,seatId:'other',messageId:'wrong'});
    f.msg('join-world',{...scope,messageId:'join'});
    await f.run('lcPump()');
    assert.equal(published.length,1);
    events.push({...published[0],messageId:'joined',replyTo:published[0].messageId,op:'join-result',payload:{status:'joined',fromSingle:true,position:2}});
    await f.run('lcPump()');
    assert.match(f.lookup('lc-status').textContent,/等待目标小号确认/);
    f.msg('leave-world',{...scope,messageId:'leave'});
    await f.run('lcPump()');
    const leave=published.at(-1);
    events.push({...leave,messageId:'single',replyTo:leave.messageId,op:'seat-left',payload:{single:true}});
    await f.run('lcPump()');
    f.msg('join-world',{...scope,messageId:'late'});
    await f.run('lcPump()');
    assert.equal(published.length,2);
    assert.match(f.lookup('lc-status').textContent,/已退回单人/);
});

for (const updateFirst of [false,true]) test('客户端把保留的原入场授权映射到同一本地指令，并中转只读席号复核：'+updateFirst,async()=>{
    const f=fixture(),published=[],events=[];
    Object.assign(f.ctx.window.electronAPI,{publishLaicai:async(_dir,m)=>published.push(m),laicaiEvents:async()=>events.splice(0),consumeLaicai:async()=>{}});
    await f.run('lcEnroll()');
    f.msg('task-start',{taskId:'t',messageId:'start',payload:{role:'big',seatId:'s',taskId:'t',laicaiVersion:'1.2.3',worldUids:['100000001']}});
    f.run("lcBridge().commands.start.launch='spawned';lcBridge().commands.start.locals[0].seen=true");
    const scope={taskId:'t',worldUid:'100000001',worldAttemptId:'w',rosterVersion:1,seatId:'s',payload:{}};
    const join=()=>f.msg('join-world',{...scope,messageId:'original'});
    const update=()=>f.msg('roster-update',{...scope,messageId:'update',rosterVersion:2,payload:{
        roster:[{seatId:'s'}],removed:['former'],retainedJoin:{messageId:'original',rosterVersion:1}}});
    if (updateFirst) { update(); join(); } else { join(); update(); }
    f.msg('join-world',{...scope,messageId:'unauthorized'});
    await f.run('lcPump()');
    const original=published.find(m=>m.op==='join-world');
    assert.equal(published.filter(m=>m.op==='join-world').length,1);
    assert.equal(published.find(m=>m.op==='roster-update').payload.retainedJoin.messageId,original.messageId);
    events.push({...original,op:'join-result',messageId:'entered',replyTo:original.messageId,payload:{status:'joined',position:3,fromSingle:true}});
    await f.run('lcPump()');
    assert.ok(f.sent.some(m=>m.op==='join-result' && m.replyTo==='original' && m.rosterVersion===1));
    f.msg('join-world',{...scope,messageId:'position',rosterVersion:2,payload:{positionOnly:true}});
    await f.run('lcPump()');
    const verify=published.at(-1);
    assert.equal(verify.payload.positionOnly,true);
    events.push({...verify,op:'join-result',messageId:'fresh',replyTo:verify.messageId,payload:{status:'position',position:2}});
    await f.run('lcPump()');
    assert.ok(f.sent.some(m=>m.op==='join-result' && m.replyTo==='position' && m.payload.position===2));
    assert.match(f.lookup('lc-status').textContent,/2P，等待目标小号确认/);
});

for (const completion of ['success','await-team']) test('个人路线回报 '+completion+' 后等待授权，旧取消不会中断新路线',async()=>{
    const f=fixture(), published=[], events=[];
    Object.assign(f.ctx.window.electronAPI,{publishLaicai:async(_dir,m)=>published.push(m),laicaiEvents:async()=>events.splice(0),consumeLaicai:async()=>{}});
    await f.run('lcEnroll()');
    const task={role:'big',seatId:'s',taskId:'t',laicaiVersion:'1.2.3',timeoutSeconds:90,worldUids:['100000001']};
    f.msg('task-start',{taskId:'t',messageId:'start',payload:task});
    f.run("lcBridge().commands.start.launch='spawned';lcBridge().commands.start.locals[0].seen=true");
    const scope={taskId:'t',worldUid:'100000001',worldAttemptId:'w',rosterVersion:1,seatId:'s',payload:{}};
    f.msg('join-world',{...scope,messageId:'join'});
    f.msg('route-release',{...scope,messageId:'r1',routeSeq:1});
    await f.run('lcPump()');
    assert.equal(published.at(-1).op,'run-route');
    assert.equal(published.at(-1).payload.timeoutSeconds,90);
    f.msg('route-release',{...scope,messageId:'early',routeSeq:2});
    await f.run('lcPump()');
    assert.equal(published.at(-1).routeSeq,1);
    const first=published.at(-1);
    const result={status:completion,isLast:false,...(completion==='success' ? {evidence:'reward'} : {})};
    events.push({...first,op:'route-result',messageId:'done',replyTo:first.messageId,payload:result});
    await f.run('lcPump()');
    assert.match(f.lookup('lc-status').textContent,completion==='success'?/等待队友同步/:/等待同轮队伍击败证据/);
    if (completion==='await-team') {
        f.run('lcBind()');
        const worlds=[{worldAttemptId:'w',routeSeq:1,completed:[{seatId:'s',commandId:'r1',...result}]}];
        f.msg('state-snapshot',{replyTo:f.sent.at(-1).messageId,payload:{task:{...task,worlds,pending:[]}}});
        assert.match(f.lookup('lc-status').textContent,/等待同轮队伍击败证据/);
        assert.match(f.run("lcRoomProgress({laicai:{worldUids:['100000001']},laicaiProgress:{routeSeq:1,complete:0,localComplete:2,total:3}})"),/待队伍证据 2 人.*尚在执行 1 人/);
    }
    f.msg('route-release',{...scope,messageId:'r2',routeSeq:2});
    await f.run('lcPump()');
    const second=published.at(-1);
    f.msg('cancel-route',{...scope,messageId:'old',routeSeq:1});
    f.msg('cancel-route',{...scope,messageId:'wrongseat',routeSeq:2,seatId:'other'});
    await f.run('lcPump()');
    assert.equal(published.at(-1),second);
    f.msg('cancel-route',{...scope,messageId:'cancel',rosterVersion:2,routeSeq:2,payload:{reason:'降员'}});
    await f.run('lcPump()');
    assert.equal(published.at(-1).payload.targetMessageId,second.messageId);
    events.push({...second,op:'route-result',messageId:'canceled',replyTo:second.messageId,payload:{status:'canceled',reason:'降员'}});
    await f.run('lcPump()');
    assert.match(f.lookup('lc-status').textContent,/已取消/);
    assert.match(f.run("lcRoomProgress({laicai:{worldUids:['100000001']},laicaiProgress:{processedWorlds:0,routeSeq:1,complete:2,total:3}})"),/完成 2\/3/);
});

test('单场占用覆盖普通队列、旧联机流程以及关闭游戏入口，主用户其他 Windows 会话保持独立',async()=>{
    const f=fixture(), calls=[];
    Object.assign(f.ctx.window.electronAPI,{closeProcess:async name=>{calls.push(name);return true;},startProcess:async()=>{calls.push('start');return 1;}});
    await f.run('lcEnroll()');
    f.msg('task-start',{taskId:'t',messageId:'start',payload:{role:'big',seatId:'s',laicaiVersion:'1.2.3'}});
    assert.equal(f.run("addDragonTask('普通')"),false);
    assert.equal(await f.run('closeBGI()'),false);
    assert.equal(await f.run('closeGenshin(true)'),false);
    await assert.rejects(f.run("executeDragonLaunch('外部',true)"),/占用/);
    assert.equal(calls.length,0);
    assert.equal(await f.run("closeBGI('t')"),true);
    f.run("lcSetLock({role:'host',taskId:'调度'})");
    assert.equal(await f.run('closeBGI()'),true);
    assert.deepEqual(calls,['BetterGI.exe','BetterGI.exe']);
});

async function runningBig() {
    const f=fixture(),published=[],events=[];
    Object.assign(f.ctx.window.electronAPI,{publishLaicai:async(_dir,m)=>published.push(m),
        laicaiEvents:async()=>events.splice(0),consumeLaicai:async()=>{}});
    await f.run('lcEnroll()');
    const task={role:'big',seatId:'s',taskId:'t',laicaiVersion:'1.2.3',timeoutSeconds:120,worldUids:['100000001','100000002']};
    f.msg('task-start',{taskId:'t',messageId:'start',payload:task});
    f.run("lcBridge().commands.start.launch='spawned';lcBridge().commands.start.locals[0].seen=true");
    const scope={taskId:'t',worldUid:'100000001',worldAttemptId:'w',rosterVersion:1,seatId:'s',payload:{}};
    f.msg('join-world',{...scope,messageId:'join'}); await f.run('lcPump()');
    return {f,published,events,scope,task};
}

test('降员先取消后到的原路线授权，退出获确认后仅用单人就绪参加下一世界',async()=>{
    const {f,published,events,scope}=await runningBig();
    f.msg('cancel-route',{...scope,messageId:'cancel',routeSeq:1,rosterVersion:2,payload:{reason:'超时'}});
    f.msg('route-release',{...scope,messageId:'oldroute',routeSeq:1,rosterVersion:2});
    f.msg('roster-update',{...scope,messageId:'remove',rosterVersion:2,payload:{roster:[],removed:['s']}});
    f.msg('leave-world',{...scope,messageId:'leave',rosterVersion:2});
    await f.run('lcPump()');
    assert.equal(published.some(m=>m.op==='run-route'),false);
    const leave=published.find(m=>m.op==='leave-world');
    events.push({type:'laicai',version:1,roomName:'房',taskId:'t',messageId:'idle',op:'executor-ready',replyTo:leave.messageId,payload:{single:true,role:'big',laicaiVersion:'1.2.3'}});
    events.push({...leave,op:'seat-left',messageId:'left',replyTo:leave.messageId,payload:{single:true}});
    await f.run('lcPump()');
    assert.equal(f.sent.some(m=>m.op==='executor-ready'),false);
    f.msg('ack',{replyTo:'left',taskId:'t',payload:{status:'applied'}});
    const ready=f.sent.at(-1);
    assert.equal(ready.op,'executor-ready');
    assert.equal(ready.worldAttemptId,undefined);
    f.msg('ack',{replyTo:ready.messageId,taskId:'t',payload:{status:'rejected',reason:'原世界尚未释放'}});
    events.push({type:'laicai',version:1,roomName:'房',taskId:'t',op:'heartbeat',replyTo:leave.messageId,messageId:'fresh',payload:{
        role:'big',laicaiVersion:'1.2.3',source:'executor',stage:'idle',single:true,observedAt:Date.now()
    }});
    await f.run('lcPump()');
    assert.equal(f.sent.filter(m=>m.op==='executor-ready').length,2);
    assert.equal(f.run("Object.hasOwn(lcBridge().outbox,'fresh')"),false);
    f.msg('join-world',{...scope,messageId:'late'});
    f.msg('join-world',{...scope,worldUid:'100000002',worldAttemptId:'w2',messageId:'next'});
    await f.run('lcPump()');
    assert.deepEqual(published.filter(m=>m.op==='join-world').map(m=>m.worldAttemptId),['w','w2']);
});

test('终态时执行端无回应会持久隔离并解除整场占用，未经现场核对不能再报名',async()=>{
    const {f,scope,task}=await runningBig();
    f.run('lcBind()');
    const snapshot=f.sent.at(-1);
    assert.equal(snapshot.payload.taskId,'t');
    f.msg('state-snapshot',{replyTo:snapshot.messageId,payload:{task:null,terminal:{taskId:'t',reason:'收尾超时',
        unsafeWorlds:[{worldAttemptId:'w',worldUid:scope.worldUid}]}}});
    const close=f.run("Object.values(lcBridge().commands).find(c=>c.net.op==='task-end')");
    assert.ok(close);
    close.endDeadline=Date.now()-1;
    await f.run('lcPump()');
    assert.equal(f.run('lcLock()'),null);
    assert.equal(f.run('lcQuarantines().length'),1);
    f.run('lcBind()');
    await assert.rejects(f.run('lcEnroll()'),/隔离/);
    assert.equal(f.lookup('lc-quarantines').children.length,1);
});

test('撤权快照拒绝后保留锁、重查终态，只把归属本席的原收尾指令交给执行端',async()=>{
    const {f,scope,published,events}=await runningBig();
    f.run('lcBind()');
    const request=f.sent.at(-1);
    f.msg('ack',{replyTo:request.messageId,payload:{status:'rejected',reason:'账号未获得该来财房的权限'}});
    assert.equal(f.run('lcState.snapshotId'),undefined);
    assert.equal(f.run('lcLock().taskId'),'t');
    f.msg('route-release',{...scope,messageId:'late',routeSeq:1});
    await f.run('lcPump()');
    assert(!published.some(m=>m.op==='run-route'));
    f.run('lcState.snapshotRetryAt=Date.now()-1');
    await f.run('lcPump()');
    const current=f.sent.at(-1);
    assert.equal(current.op,'state-request');
    assert.equal(current.payload.seatId,'s');
    f.msg('state-snapshot',{replyTo:current.messageId,payload:{task:null,terminal:{
        taskId:'t',commandId:'original-end',status:'terminated',reason:'已结束',unsafeWorlds:[]}}});
    await f.run('lcPump()');
    const end=published.find(m=>m.op==='task-end');
    assert.ok(end);
    assert.equal(f.run('lcLock().taskId'),'t');
    events.push({...end,op:'ack',messageId:'ended',replyTo:end.messageId,payload:{status:'applied'}});
    await f.run('lcPump()');
    assert.equal(f.run('lcLock()'),null);
    assert(f.sent.some(m=>m.replyTo==='original-end' && m.payload.status==='applied'));
});

test('快照恢复前先到的原任务终态进入收尾，晚快照不能恢复运行',async()=>{
    const {f,task,scope,published}=await runningBig();
    f.run('lcBind()');
    const request=f.sent.at(-1);
    f.msg('task-end',{roomName:'其他房',taskId:'t',payload:{}});
    f.msg('task-end',{taskId:'另一个任务',payload:{}});
    assert.equal(f.run('lcState.snapshotId'),request.messageId);
    f.msg('task-end',{taskId:'t',messageId:'real-end',payload:{reason:'清场未确认',unsafeWorlds:[scope]}});
    f.msg('state-snapshot',{replyTo:request.messageId,payload:{task:{...task,phase:'route',pending:[]}}});
    await f.run('lcPump()');
    assert.ok(published.some(m=>m.op==='task-end'));
    assert.equal(f.run('lcLock().taskId'),'t');
    f.run("lcBridge().commands['real-end'].endDeadline=Date.now()-1");
    await f.run('lcPump()');
    assert.equal(f.run('lcLock()'),null);
    assert.equal(f.run('lcQuarantines().length'),1);
});

test('受限活动快照撤销本机未发路线，只下发本席退场',async()=>{
    const {f,scope,task,published}=await runningBig();
    f.msg('route-release',{...scope,messageId:'r',routeSeq:1});
    f.run('lcBind()');
    const request=f.sent.at(-1);
    const leave={...scope,roomName:'房',op:'leave-world',messageId:'leave'};
    f.msg('state-snapshot',{replyTo:request.messageId,payload:{task:{...task,phase:'leaving',cleanupOnly:true,pending:[leave]}}});
    f.msg('route-release',{...scope,messageId:'replay',routeSeq:1});
    await f.run('lcPump()');
    assert.equal(f.run('lcBridge().commands.r.retired'),true);
    assert.equal(published.filter(m=>m.op==='run-route').length,0);
    assert.equal(published.filter(m=>m.op==='leave-world').length,1);
    assert.equal(f.run('lcLock().taskId'),'t');
});

test('客户端恢复联网后丢弃历史执行端心跳，不回放为当前存活',async()=>{
    const {f,events,published}=await runningBig();
    const join=published.at(-1);
    events.push({...join,op:'heartbeat',messageId:'oldbeat',replyTo:join.messageId,payload:{
        source:'executor',stage:'idle',role:'big',laicaiVersion:'1.2.3',observedAt:Date.now()-60000}});
    await f.run('lcPump()');
    assert.equal(f.sent.some(m=>m.messageId==='oldbeat'),false);
    assert.equal(f.run("Object.hasOwn(lcBridge().outbox,'oldbeat')"),false);
});

test('安装文件缺失时不会虚报来财就绪',async ()=>{
    const f=fixture();
    f.ctx.window.electronAPI.laicaiVersion=async ()=>{throw Error('manifest 不存在');};
    await assert.rejects(f.run('lcEnroll()'),/manifest/);
    assert.equal(f.sent.length,0);
});

test('管理端来财参数可往返，拒绝重复 UID 并保留原房型选择',()=>{
    const source=script('admin/admin.html');
    const ctx=vm.createContext({document:{getElementById:id=>elements[id]},showAlertModal(){}});
    const elements={};
    for(const id of ['type','big-count','worlds','allow-missing','timeout','settings','mode','count'])elements['edit-room-'+id]={parentElement:{}};
    vm.runInContext(source.slice(source.indexOf('        function laicaiRoomSummary'),source.indexOf('        // 打开编辑房间属性模态框')),ctx);
    const room={roomType:'laicai',laicai:{bigCount:3,worldUids:['100000001','100000002'],allowMissing:true,timeoutSeconds:300}};
    ctx.setRoomTypeFields('edit',room);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.readRoomTypeFields('edit'))),room);
    elements['edit-room-worlds'].value='100000001 100000001';
    assert.equal(ctx.readRoomTypeFields('edit'),null);
    ctx.setRoomTypeFields('edit',{});
    assert.equal(ctx.readRoomTypeFields('edit').roomType,'group');
});
