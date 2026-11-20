const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorldActions, identifyMember, coopPanelVisible } = require("../js/来财/main.js");
const roster = ["甲", "乙", "丙"].map((gameName, i) => ({ seatId: "s" + i, uid: String(100000001 + i), gameName }));
const worldUid = "100000008";
function fixture() {
    const model = { t: 0, panel: true, pos: 0, list: [], permission: "不允许加入", uncertain: false };
    const ui = {
        now: () => model.t, wait: async ms => { model.t += ms; },
        f2: () => model.panel, sign: () => model.pos, permission: () => model.permission, uid: () => worldUid,
        key(key) { model.panel = key === "F2"; },
        pressNamed(name) {
            if (name.startsWith("设置")) model.permission = name.slice(2);
            if (name === "search") model.searched = true;
            if (name === "leaveTeam") { model.panel = false; model.pos = 0; }
            return true;
        },
        type: value => { model.typed = value; }, searchUid: () => model.typed,
        multipleResults: () => !model.searched, requestButton: () => model.searched ? [100, 200] : null,
        click() { model.pos = 3; model.panel = false; },
        request: () => "none",
        members: () => ({ ambiguous: model.uncertain, members: model.list })
    };
    return { model, ui, ops: createWorldActions(ui), session: { roster, world: {}, timeoutSeconds: 4 }, control: { canceled: false } };
}

test("F2 锚点覆盖房主世界权限三种状态和客人的离队面板", () => {
    for (const anchor of ["不允许加入", "确认后可加入", "直接加入", "leaveTeam"]) {
        const frame = { matches: new Set([anchor]) };
        assert.equal(coopPanelVisible((name, f) => f.matches.has(name), frame), true);
    }
    assert.equal(coopPanelVisible(name => name === "Paimon"), false);
});

test("先记录基线，批准点击和实际成员观测分别回报，清场须复核访客与权限", async () => {
    const { model, ui, ops, session, control } = fixture();
    await ops["open-admission"]({ worldUid, payload: { roster } }, control, session);
    assert.equal(model.permission, "确认后可加入");
    const arm = { worldUid, seatId: "s0", payload: roster[0] };
    const baseline = await ops["admit-seat"](arm, control, session);
    assert.deepEqual(baseline.payload.members, []);
    ui.request = () => "approved";
    assert.equal((await ops.observe(arm, control, session)).stable, false);
    ui.request = () => "none";
    model.list = [{ seatId: "s0", position: 2 }];
    assert.deepEqual((await ops.observe(arm, control, session)).members, model.list);
    model.uncertain = true;
    assert.equal((await ops.observe(arm, control, session)).ambiguous, true);
    await assert.rejects(ops["check-clear"]({ worldUid }, control, session), /超时/);
    assert.equal(model.permission, "不允许加入");
    model.uncertain = false; model.list = [];
    assert.equal((await ops["check-clear"]({ worldUid }, control, session)).payload.memberCount, 0);
});

test("大号从单人定向申请、确认三号位，退场须连续两次为单人", async () => {
    const { ops, model, control, session } = fixture();
    const joined = await ops["join-world"]({ worldUid: "100000004" }, control, session);
    assert.equal(model.typed, "100000004");
    assert.deepEqual(joined.payload, { fromSingle: true, status: "joined", position: 3 });
    await assert.rejects(ops["join-world"]({ worldUid: "100000004" }, control, session), /单人/);
    const left = await ops["leave-world"]({}, control, session);
    assert.equal(left.payload.single, true);
});
test("搜索框 UID 与目标不符不会发申请，重名和冲突资料不识别为队友", async () => {
    const { ui, ops, session, control } = fixture();
    ui.searchUid = () => "100000008";
    ui.click = () => assert.fail("错误 UID 不应申请");
    await assert.rejects(ops["join-world"]({ worldUid: "100000004" }, control, session), /超时/);
    assert.equal(identifyMember(["陌生人"], roster), null);
    assert.equal(identifyMember(["甲"], [...roster, { ...roster[1], gameName: "甲" }]), null);
    assert.equal(identifyMember(["甲", roster[1].uid], roster), null);
    assert.equal(identifyMember(["甲"], roster).seatId, "s0");
});
test("残留上一次搜索的单个玩家时不得申请", async () => {
    const { ui, ops, session, control } = fixture();
    ui.multipleResults = () => false;
    ui.requestButton = () => [100, 200];
    ui.click = () => assert.fail("旧搜索结果不应获准");
    await assert.rejects(ops["join-world"]({ worldUid: "100000004" }, control, session), /超时/);
});
test("列表只有一行时可以独立核对结果名片上的 UID", async () => {
    const { model, ui, ops, session, control } = fixture();
    ui.multipleResults = () => false;
    ui.resultCard = () => ({ uid: model.searched ? "100000004" : "100000002" });
    const result = await ops["join-world"]({ worldUid: "100000004" }, control, session);
    assert.equal(result.payload.status, "joined");
});
test("无法读取旧名片 UID 时通过明确的空搜索结果再查目标", async () => {
    const { model, ui, ops, session, control } = fixture();
    ui.multipleResults = () => false;
    ui.resultCard = () => ({ uid: "" });
    ui.emptySearch = () => model.searched && model.typed === "000000000";
    const queries = [];
    ui.type = uid => { model.typed = uid; queries.push(uid); };
    const result = await ops["join-world"]({ worldUid: "100000004" }, control, session);
    assert.deepEqual(queries, ["000000000", "100000004"]);
    assert.equal(result.payload.status, "joined");
});

test("降员后的只读成员观测仍能辨认已移出的大号，不再批准它的申请", async () => {
    const { ops, ui, session, control } = fixture();
    await ops["open-admission"]({ worldUid, payload: { roster } }, control, session);
    session.roster = roster.slice(1);
    ui.request = (_, seat) => { assert.equal(seat, ""); return "none"; };
    ui.members = known => ({ ambiguous: false, members: known.some(m => m.seatId === "s0") ? [{ seatId: "s0", position: 2 }] : [] });
    const seen = await ops.observe({ worldUid, op: "roster-update" }, control, session);
    assert.deepEqual(seen, { stable: true, ambiguous: false, members: [{ seatId: "s0", position: 2 }], observedUid: worldUid, admissionMode: "confirm" });
});
test("降员后小号只继续放行指名且仍在世界名单的申请者",async()=>{
    const {ops,ui,session,control}=fixture();
    await ops["open-admission"]({worldUid,payload:{roster}},control,session);
    session.roster=roster.slice(1);
    const permitted=[];
    ui.request=(_,seat)=>{ permitted.push(seat); return "none"; };
    for (const applicant of ["s0","s1"]) {
        await ops.observe({worldUid,op:"roster-update",payload:{applicant}},control,session);
    }
    assert.deepEqual(permitted,["s1"]);
});
test("席号复核只读两次一致的客人席号，期间不会再次申请或离队",async()=>{
    const {ops,ui,model,session,control}=fixture();
    ui.click=ui.key=ui.pressNamed=()=>assert.fail("席号复核不能操作游戏");
    const cmd={worldUid,payload:{positionOnly:true}};
    model.pos=2;
    assert.deepEqual((await ops["join-world"](cmd,control,session)).payload,{status:"position",position:2});
    let flip=false;
    ui.sign=()=>(flip=!flip)?2:3;
    await assert.rejects(ops["join-world"](cmd,control,session),/超时/);
});
test("已开放后小号切错账号、禁止加入或识别不稳定时，不能给下一席授权或通过降员复核", async () => {
    for (const fault of ["错账号", "禁止加入", "读数交替"]) {
        const { ops, ui, model, control, session } = fixture();
        await ops["open-admission"]({ worldUid, payload: { roster } }, control, session);
        if (fault === "错账号") ui.uid = () => "100000009";
        if (fault === "禁止加入") model.permission = "不允许加入";
        if (fault === "读数交替") { let flip = false; ui.uid = () => (flip = !flip) ? worldUid : "100000009"; }
        const arm = { worldUid, messageId: "next", seatId: "s1", payload: roster[1] };
        await assert.rejects(ops["admit-seat"](arm, control, session), /超时/);
        const recheck = await ops.observe({ worldUid, op: "roster-update" }, control, session);
        assert.equal(recheck.stable, false);
        assert.equal(recheck.ambiguous, true);
        assert.equal(recheck.observedUid, undefined);
    }
});
test("进程重启后清场的只读复核要求当前 UID 和关闭权限及稳定空场全部成立", async () => {
    const { ops, ui, model, session, control } = fixture();
    const cmd = { op: "check-clear", worldUid: "100000001" };
    ui.uid = () => "100000002";
    assert.equal(await ops.recover(cmd, control, session), null);
    ui.uid = () => cmd.worldUid;
    model.uncertain = true;
    assert.equal(await ops.recover(cmd, control, session), null);
    model.uncertain = false;
    assert.equal((await ops.recover(cmd, control, session)).op, "world-cleared");
});
