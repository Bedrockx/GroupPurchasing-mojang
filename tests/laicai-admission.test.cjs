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
