const assert = require('node:assert/strict');
const {prepareWorld,createWorldActions} = require('../../js/来财/main.js');

// 模拟宿主的屏幕、UID 搜索、加入请求和名单读数。正式游戏动作用两端独立读数生成证据。
function gameScreen(routeResult) {
  const worlds = new Map(), history = [];
  function makeActions({role,name,wait,now}) {
    const host = role === 'host';
    const uid = host ? null : String(100000001 + name.charCodeAt(0) - 'A'.charCodeAt(0));
    let f2 = false, filtered = false, selected = '', selfWorld = '', guestWorld = '';
    const world = () => worlds.get(selfWorld);
    const ui = {
      now,wait,f2:()=>f2,screen:()=>f2?'F2UIopenedcheck':'Paimon',uid:()=>selfWorld,
      key:key=>{ if(key==='F2'){ f2=true; filtered=false; } if(key==='VK_ESCAPE')f2=false; },
      multipleResults:()=>f2 && !filtered,
      permission:()=>world().permission,
      pressNamed(label) {
        if (!f2) return false;
        if (label==='search') filtered=true;
        if (host && label.startsWith('设置')) {
          world().permission=label.slice(2);
          history.push({ui:'permission',world:selfWorld,value:world().permission});
        }
        if (!host && label==='leaveTeam' && guestWorld) {
          worlds.get(guestWorld).members.delete(uid);
          history.push({ui:'leave',world:guestWorld,uid});
          guestWorld=''; f2=false;
        }
        return true;
      },
      type:value=>{selected=value;}, searchUid:()=>selected,
      requestButton:()=>f2 && worlds.get(selected)?.permission==='确认后可加入' ? [1,1] : null,
      click() {
        const target=worlds.get(selected);
        assert(!host && target && f2);
        target.pending.set(uid, position=>{guestWorld=selected; f2=false; target.members.set(uid,position);});
        history.push({ui:'request',world:selected,uid});
      },
      sign:()=>guestWorld ? worlds.get(guestWorld).members.get(uid) : 0,
      request(roster,expected) {
        const request=world().pending.entries().next().value;
        if (!request) return 'none';
        const [guest,approve]=request;
        world().pending.delete(guest);
        if (!roster.some(seat=>seat.seatId===expected && seat.uid===guest)) return 'rejected';
        approve(world().members.size+2);
        history.push({ui:'approve',world:selfWorld,uid:guest});
        return 'approved';
      },
      members(roster) {
        if (!f2) return null;
        const rows=Array.from(world().members,([uid,position])=>({
          seatId:roster.find(seat=>seat.uid===uid)?.seatId,position
        }));
        return {ambiguous:rows.some(row=>!row.seatId),members:rows};
      }
    };
    const actions=createWorldActions(ui);
    actions['prepare-world']=async (command,control)=>{
      selfWorld=command.worldUid;
      assert(!worlds.has(selfWorld),'重复准备同一世界');
      worlds.set(selfWorld,{permission:'不允许加入',members:new Map(),pending:new Map()});
      const ready=await prepareWorld(command,control,ui);
      await actions.permission('不允许加入',control,now()+15000);
      return ready;
    };
    actions['run-route']=async (command,control)=>{
      assert.equal(guestWorld,command.worldUid,'客机实际进入的世界必须与路线授权匹配');
      return routeResult(command,{uid,now,wait,control,ui});
    };
    return actions;
  }
  return {makeActions,history,worlds};
}

module.exports = {gameScreen};
