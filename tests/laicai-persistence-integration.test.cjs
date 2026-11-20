const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {simulateTask}=require('./helpers/laicai-integration.cjs');
const {gameScreen}=require('./helpers/laicai-game.cjs');

test('落盘临时占用时保留原消息重投，业务证据与控制回执均不会重跑游戏动作',async t=>{
  const workers=[{workerId:'worker1',uids:['200000001','200000002']}];
  const failed=new Map();
  const executed=[];
  const game=gameScreen(async command=>{
    executed.push(command.worldUid);
    return {op:'route-result',payload:{status:'success',evidence:'reward',isLast:true}};
  });
  let invalid;
  const {room,trace}=await simulateTask(t,{workers,bigCount:1,makeActions:game.makeActions,
    async sendUp({data},room,deliver){
      if(!invalid && data.op==='worker-stage' && data.payload.stage==='game') {
        invalid=data.messageId;
        return deliver({...data,payload:{stage:'invalid-stage'}});
      }
      const isRelease=data.op==='ack' && data.payload.status==='applied' &&
        room.sent('release-world').some(s=>s.data.messageId===data.replyTo);
      const kind=isRelease?'release':data.op==='route-result'?'result':null;
      if(!kind || failed.has(kind))return deliver();
      const disk=room.app.disk,rename=disk.renameSync;
      let injected=false;
      try {
        disk.renameSync=(source,target)=>{
          if(path.basename(target)==='laicai_tasks.json'){
            injected=true;
            throw Object.assign(Error('模拟 Windows 短暂占用账本'),{code:'EPERM'});
          }
          return rename.call(disk,source,target);
        };
        await deliver();
      } finally {disk.renameSync=rename;}
      assert(injected,'要在真实状态事务写入处制造临时错误');
      const task=room.app.get('laicaiTasks').get('测试房间');
      assert(task.pending.some(p=>p.message.messageId===data.replyTo),'持久化失败前不得消费原授权');
      assert(!task.receipts.some(r=>r.messageId===data.messageId),'失败的事务未能提交原回执');
      failed.set(kind,data.messageId);
    }
  });
  assert.deepEqual([...failed.keys()],['result','release']);
  for(const id of failed.values()) {
    assert(trace.filter(p=>p.direction==='up' && p.data.messageId===id).length>=2,'重投必须沿用初始 messageId '+id);
  }
  const rejected=trace.findIndex(p=>p.direction==='down' && p.data.replyTo===invalid && p.data.payload.status==='rejected');
  assert(rejected>=0);
  assert(!trace.slice(rejected+1).some(p=>p.direction==='up' && p.data.messageId===invalid),'永久拒绝后不应再发');
  assert.deepEqual(executed,workers[0].uids);
  assert.deepEqual(room.sent('release-world').map(p=>p.data.worldUid),executed);
  assert.deepEqual(Array.from(room.sent('task-end')[0].data.payload.worldResults,r=>r.status),['completed','completed']);
});
