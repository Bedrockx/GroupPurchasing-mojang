const test = require('node:test');
const assert = require('node:assert/strict');
const {createRoom} = require('./helpers/laicai-room.cjs');

test('原世界、错误基线和变化后的旧成员图均不能作为入场凭据', async t => {
  const {reply,sent} = await createRoom(t,[{workerId:'w',uids:['200000001']}],{bigCount:1});
  const starts = sent('task-start');
  for (const start of starts) await reply(start,'ack',{status:'applied'});
  await reply(starts.find(s => s.uid === 'A'),'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
  const prep = sent('prepare-world')[0];
  await assert.rejects(reply({...prep,data:{...prep.data,slotGeneration:2}},'world-ready',
    {observedUid:prep.data.worldUid,exactReads:2}),/旧世界或位置/);
  await reply(prep,'world-ready',{observedUid:prep.data.worldUid,exactReads:2});
  await reply(sent('open-admission')[0],'admission-opened',{});
  const arm = sent('admit-seat')[0];
  const member = {seatId:arm.data.seatId,position:2};
  await assert.rejects(reply(arm,'seat-armed',{members:[member]}),/基线/);
  assert.equal(sent('join-world').length,0);
  await reply(arm,'seat-armed',{members:[]});
  await reply(arm,'world-members',{stable:true,ambiguous:false,members:[member]});
  await reply(arm,'world-members',{stable:true,ambiguous:false,members:[member,{seatId:'stranger',position:3}]});
  await reply(sent('join-world')[0],'join-result',{status:'joined',fromSingle:true,position:2});
  assert.equal(sent('route-release').length,0);
  await reply(arm,'world-members',{stable:true,ambiguous:false,members:[member]});
  assert.equal(sent('route-release').length,1);
});

const pulse={role:'big',source:'client',laicaiVersion:'1.0.0',stage:'waiting'};
async function firstSeatInWorld(t,allowMissing=true) {
    const r=await createRoom(t,[{workerId:'w',uids:['200000001']}],{bigCount:2,allowMissing,timeoutSeconds:20});
    for (const start of r.sent('task-start')) {
      await r.reply(start,'ack',{status:'applied'});
      if (start.uid!=='D') await r.reply(start,'executor-ready',{role:'big',laicaiVersion:'1.0.0'});
    }
    const prep=r.sent('prepare-world')[0];
    await r.reply(prep,'world-ready',{observedUid:prep.data.worldUid,exactReads:2});
    await r.reply(r.sent('open-admission')[0],'admission-opened',{});
    const armA=r.sent('admit-seat')[0];
    const oldMember={seatId:armA.data.seatId,position:2};
    await r.reply(armA,'seat-armed',{members:[]});
    const joinA=r.sent('join-world')[0];
    await r.reply(joinA,'join-result',{status:'joined',fromSingle:true,position:2});
    await r.reply(joinA,'heartbeat',pulse);
    await r.reply(armA,'world-members',{stable:true,ambiguous:false,members:[oldMember]});
    const armB=r.sent('admit-seat').at(-1);
    return {r,armB,joinA,oldMember,worldUid:prep.data.worldUid};
}

for (const order of ['先回报', '后回报', '位置改变','延后失联']) {
  test('已入场 A 离开时保留 B 的原申请并按新名册复核：'+order, async t => {
    const {r,armB,joinA,oldMember,worldUid}=await firstSeatInWorld(t);
    await r.reply(armB,'seat-armed',{members:[oldMember]});
    const joinB=r.sent('join-world').at(-1);
    const guest={seatId:armB.data.seatId,position:order==='位置改变'?2:3};
    const fresh={stable:true,ambiguous:false,observedUid:worldUid,admissionMode:'confirm',members:[guest]};
    const joined={status:'joined',fromSingle:true,position:3};
    if (order!=='后回报') await r.reply(joinB,'join-result',joined);
    if (order!=='延后失联') await r.reply(armB,'world-members',fresh);
    r.app.clock.now+=19000;
    if (order==='延后失联') {
      await r.reply(joinA,'heartbeat',pulse);
      await r.reply(armB,'world-members',fresh);
    }
    await r.reply(joinB,'heartbeat',pulse);
    r.app.clock.now+=1001;
    r.app.get('lcTick')();
    if (order==='延后失联') {
      assert.equal(r.sent('leave-world').length,0,'必须给较晚离场的 A 留出完整确认时间');
      r.app.clock.now+=18000;
      await r.reply(joinB,'heartbeat',pulse);
      r.app.clock.now+=1000;
      r.app.get('lcTick')();
    }
    assert.deepEqual(r.sent('leave-world').map(m=>m.uid),['A']);
    const watch=r.sent('roster-update').find(m=>m.uid==='D');
    assert.equal(watch.data.payload.applicant,guest.seatId);
    await r.reply(watch,'world-members',{...fresh,members:[oldMember]});
    assert.equal(r.sent('route-release').length,0);
    await r.reply(watch,'world-members',fresh);
    if (order==='后回报') {
      const keep=r.sent('roster-update').find(m=>m.uid==='B').data.payload.retainedJoin;
      assert.equal(keep.messageId,joinB.data.messageId);
      assert.equal(keep.rosterVersion,joinB.data.rosterVersion);
      assert.equal(r.sent('route-release').length,0);
      await r.reply(joinB,'join-result',joined);
    }
    if (order==='位置改变') {
      assert.equal(r.sent('route-release').length,0);
      const refresh=r.sent('join-world').at(-1);
      assert.equal(refresh.data.payload.positionOnly,true);
      await r.reply(refresh,'join-result',{status:'position',position:2});
    }
    assert.equal(r.sent('join-world').filter(m=>m.uid==='B' && !m.data.payload.positionOnly).length,1);
    assert.deepEqual(r.sent('route-release').map(m=>m.uid),['B']);
  });
}

for (const allowMissing of [true,false]) {
  test('放行 B 之前的基线已经缺 A，按配置处理已离场但心跳在线的席位：'+allowMissing,async t=>{
    const {r,armB,joinA,worldUid}=await firstSeatInWorld(t,allowMissing);
    const empty={stable:true,ambiguous:false,observedUid:worldUid,admissionMode:'confirm',members:[]};
    await r.reply(armB,'seat-armed',empty);
    await r.reply(armB,'world-members',empty);
    assert.equal(r.sent('join-world').length,1);
    r.app.clock.now+=19000;
    await r.reply(joinA,'heartbeat',pulse);
    r.app.clock.now+=1001;
    r.app.get('lcTick')();
    if (!allowMissing) {
      assert.equal(r.sent('roster-update').length,0);
      assert.ok(r.sent('check-clear').length>0);
      return;
    }
    assert.deepEqual(r.sent('leave-world').map(m=>m.uid),['A']);
    const watch=r.sent('roster-update').find(m=>m.uid==='D');
    assert.equal(watch.data.payload.applicant,undefined);
    await r.reply(watch,'world-members',empty);
    const arm=r.sent('admit-seat').at(-1);
    assert.equal(arm.data.seatId,armB.data.seatId);
    assert.notEqual(arm.data.messageId,armB.data.messageId);
    await r.reply(arm,'seat-armed',empty);
    const member={seatId:arm.data.seatId,position:2};
    await r.reply(arm,'world-members',{...empty,members:[member]});
    await r.reply(r.sent('join-world').at(-1),'join-result',{status:'joined',fromSingle:true,position:2});
    assert.deepEqual(r.sent('route-release').map(m=>m.uid),['B']);
  });
}

test('基线采样后暂时缺席的队友重现，原放行授权须由目标小号稳定观测补齐',async t=>{
  const {r,armB,oldMember,worldUid}=await firstSeatInWorld(t);
  const fresh={stable:true,ambiguous:false,observedUid:worldUid,admissionMode:'confirm',members:[]};
  await r.reply(armB,'seat-armed',fresh);
  const watch={uid:armB.uid,data:{...armB.data}};
  delete watch.data.seatId;
  await r.reply(watch,'world-members',{...fresh,observedUid:'200000009',members:[oldMember]});
  assert.equal(r.sent('join-world').length,1);
  await r.reply(watch,'world-members',{...fresh,members:[oldMember]});
  assert.deepEqual(r.sent('join-world').map(m=>m.uid),['A','B']);
  assert.equal(r.sent('roster-update').length,0);
});
