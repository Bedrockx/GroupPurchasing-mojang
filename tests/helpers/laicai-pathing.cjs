const assert = require('node:assert/strict');
const catalog = require('../../js/来财/routes/catalog.json');
const {createRouteActions} = require('../../js/来财/main.js');

// 模拟 BetterGI 单次追踪的取消令牌，以及角色位置、队伍席位和击败敌人后的屏幕提示。
function pathingHost({now,wait,positionSign,duration=2500,onRun=()=>{},showReward=true,rewardDelay=0}) {
  const calls = [], tokens = [];
  let reward = '', rewardAt = Infinity, end = [0,0], pickups = 0;
  function newCTS() {
    const token = {canceled:false};
    const source = {Token:token, CancelAfter(){}, Cancel(){token.canceled=true;}, Dispose(){token.disposed=true;}};
    tokens.push(token);
    return source;
  }
  async function runFile(file,token) {
    const route=Object.values(catalog.routes).find(route=>route.file===file);
    assert(route,'只应调用当前包声明的追踪');
    calls.push(file);
    reward='';
    rewardAt=Infinity;
    onRun(file,token);
    const until=now()+duration;
    while (now()<until && !token.canceled) {
      if (now()>=until-duration/2) {
        end=route.end;
        if (showReward && !rewardDelay) reward='角色经验+19';
      }
      await wait(200);
    }
    if (token.canceled) return 'canceled';
    end=route.end;
    if (showReward && rewardDelay) rewardAt=now()+rewardDelay;
    return 'finished';
  }
  const actions=createRouteActions({pack:'前两条传奇',routes:catalog,now,wait,
    position:()=>({x:end[0],y:end[1]}),sign:positionSign,reward:()=>now()>=rewardAt?'角色经验+19':reward,
    teleport:async()=>{},needFurina:()=>false,enemyVisible:()=>false,
    runFile,newCTS,checkGlobal:async()=>{},autoPick:()=>{pickups++;}});
  return {actions,calls,tokens,get pickups(){return pickups;}, clearReward(){reward=''; rewardAt=Infinity;}};
}

module.exports = {pathingHost};
