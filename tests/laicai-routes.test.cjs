const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRouteActions } = require("../js/来财/main.js");
const dir = path.join(__dirname, "../js/来财");
const routes = JSON.parse(fs.readFileSync(path.join(dir, "routes/catalog.json")));
function setup() {
    const calls = [], sources = [];
    const model = { t: 0, reward: "", point: routes.routes.A.end, pick: 0 };
    const env = {
        routes, pack: "前两条传奇", now: () => model.t,
        wait: async ms => { await new Promise(resolve => setImmediate(resolve)); model.t += ms; },
        sign: () => 2, position: () => ({ x: model.point[0], y: model.point[1] }),
        reward: () => model.reward, enemyVisible: () => false, autoPick: () => model.pick++,
        needFurina: () => false, teleport: (...p) => calls.push(p), checkGlobal: async () => {},
        newCTS() {
            const cts = { Token: {}, CancelAfter(ms) { this.ms = ms; }, Dispose() { this.closed = true; } };
            sources.push(cts);
            return cts;
        },
        runFile: async (file, token) => {
            calls.push(file); assert.equal(token, sources.at(-1).Token);
            if (file !== routes.furina) model.reward = "角色经验+19";
            return "finished";
        }
    };
    const ops = createRouteActions(env);
    const control = { canceled: false };
    return { model, env, calls, sources, control, ops, run: (routeSeq = 1) =>
        ops["run-route"]({ routeSeq, payload: { timeoutSeconds: 30 } }, control, {}) };
}
test("三种内置路线包均引用真实战斗路线，定位终点与作者信息完整", () => {
    assert.deepEqual(Object.values(routes.packs).map(p => p.length), [3,2,4]);
    for (const r of Object.values(routes.routes)) {
        const map = JSON.parse(fs.readFileSync(path.join(dir, r.file)));
        assert.ok(map.positions.some(p => ["fight","combat_script"].includes(p.action)));
        assert.ok(map.info.authors.length);
        assert.deepEqual(r.end, [map.positions.at(-1).x, map.positions.at(-1).y]);
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, routes.furina), "utf8").replace(/^\uFEFF/, "")).positions.length);
});

test("辅助、主追踪各用独立 CTS；本地路线包末条标记与传送", async () => {
    const { env,ops,model,sources,calls,run } = setup();
    ops.enablePickup(); ops.enablePickup();
    assert.equal(model.pick, 1);
    env.needFurina = () => true;
    model.point = routes.routes.B.end;
    const result = await run(2);
    assert.deepEqual(calls, [routes.routes.B.tp, routes.furina, routes.routes.B.file]);
    assert.deepEqual(result.payload, { status: "success", evidence: "reward", isLast: true });
    assert.ok(sources.length === 2 && sources.every(s => s.closed && s.ms > 0));
    assert.notEqual(sources[0].Token, sources[1].Token);
});
test("没有个人奖励的慢席仅报告自身完成，偏离终点或仍在战斗不接受团队代证", async () => {
    const slow = setup();
    slow.env.reward = () => "角色经验+旧";
    assert.deepEqual((await slow.run()).payload, { status: "await-team", isLast: false });
    for (const mode of ["偏离","仍有敌人"]) {
        const { model, env, run } = setup();
        if (mode === "偏离") model.point = [0,0];
        if (mode === "仍有敌人") env.enemyVisible = () => true;
        await assert.rejects(run(), /未能同时确认/);
    }
});
test("补证观察截止于追踪结束七秒或原授权超时，以先到者为准", async () => {
    for (const [timeoutSeconds, cutoff] of [[30, 7000], [3, 3000]]) {
        const { env, model, ops, control } = setup();
        env.reward = () => model.t >= cutoff ? "角色经验+19" : "";
        const result = await ops["run-route"]({ routeSeq: 1, payload: { timeoutSeconds } }, control, {});
        assert.equal(result.payload.status, "await-team");
        assert.equal(await result.observeProof(), null);
        assert.equal(model.t, cutoff);
    }
});
test("辅助追踪被取消后不开始主追踪，文件异常与全局停止分别传播", async () => {
    const { env, calls, control, sources, run } = setup();
    env.needFurina = () => true;
    env.runFile = async path => { calls.push(path); return "canceled"; };
    await assert.rejects(run(), /取消/);
    assert.deepEqual(calls, [routes.furina]); assert.ok(control.canceled && sources[0].closed);
    const again = setup();
    again.env.runFile = async () => { throw Error("追踪文件损坏"); };
    await assert.rejects(again.run(), /追踪文件损坏/);
    again.env.checkGlobal = async () => { throw Error("已停止"); };
    await assert.rejects(again.run(), e => e.globalStop === true);
});
