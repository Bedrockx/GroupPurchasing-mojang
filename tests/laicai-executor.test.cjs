const test = require("node:test");
const assert = require("node:assert/strict");
const { createExecutor } = require("../js/来财/main.js");

function fakeFile() {
    const files = new Map();
    return {
        files, IsFolder: dir => [...files.keys()].some(k => k.startsWith(dir + "/")),
        ReadTextSync: path => files.get(path), IsExists: path => files.has(path),
        WriteTextSync(path, body) { files.set(path, body); return true; },
        ReadPathSync(dir) { return [...files.keys()].filter(k => k.startsWith(dir + "/")); }
    };
}
function packet(id, op, fields = {}, payload = {}) {
    return { type: "laicai", version: 1, roomName: "测试", taskId: "t_1",
        messageId: id, op, ...fields, payload };
}
const start = packet("a", "task-start", {}, { role: "big", seatId: "s", laicaiVersion: "1.0.0" });
const world = { worldUid: "100000001", worldAttemptId: "w", seatId: "s", rosterVersion: 1 };
function deliver(file, cmd) { file.WriteTextSync("mailbox/in/" + cmd.messageId + ".json", JSON.stringify(cmd)); }
function results(file, op) {
    return [...file.files.entries()].filter(([key]) => key.startsWith("mailbox/out/") && key.endsWith(".ready.json"))
        .map(([, marker]) => JSON.parse(file.ReadTextSync("mailbox/out/" + JSON.parse(marker).messageId + ".json")))
        .filter(evt => evt.op === op);
}
async function admit(file, executor) {
    deliver(file, start); executor.poll();
    deliver(file, packet("j", "join-world", world)); executor.poll(); await executor.settle();
}
const join = () => ({ op: "join-result", payload: { status: "joined", position: 2, fromSingle: true } });

test("新版名册先到时，重启后的大号只执行其中指定的旧版本原入场授权",async()=>{
    const file=fakeFile(),calls=[];
    const options={role:"big",file,actions:{"join-world"(cmd){calls.push(cmd.messageId);return join();}}};
    const exe=createExecutor(options);
    deliver(file,start); exe.poll();
    deliver(file,packet("update","roster-update",{...world,rosterVersion:2},
        {roster:[{seatId:"s"}],retainedJoin:{messageId:"original",rosterVersion:1}}));
    exe.poll();
    const resumed=createExecutor(options);
    deliver(file,packet("other","join-world",world));
    deliver(file,packet("original","join-world",world));
    resumed.poll(); await resumed.settle();
    assert.deepEqual(calls,["original"]);
    assert.ok(results(file,"ack").some(e=>e.replyTo==="other" && e.payload.status==="rejected"));
    assert.ok(results(file,"join-result").some(e=>e.replyTo==="original"));
});

test("在补证期间收到取消、换路线、移出、退场或终止不会再提交旧证据", async () => {
    const original = packet("r1", "run-route", { ...world, routeSeq: 1 });
    const proof = { status: "success", evidence: "reward", isLast: false };
    const commands = [
        packet("cancel", "cancel-route", { ...world, routeSeq: 1 }, { targetMessageId: "r1" }),
        packet("r2", "run-route", { ...world, routeSeq: 2 }),
        packet("removed", "roster-update", { ...world, rosterVersion: 2 }, { roster: [] }),
        packet("leave", "leave-world", world),
        packet("end", "task-end")
    ];
    for (const cmd of commands) {
        const file = fakeFile(), runs = [];
        let reportReward;
        const ex = createExecutor({ file, role: "big", actions: {
            "join-world": join,
            "leave-world": () => ({ op: "seat-left", payload: { single: true } }),
            "run-route"(c) {
                runs.push(c.routeSeq);
                if (c.routeSeq === 2) return { op: "route-result", payload: proof };
                return { op: "route-result", payload: { status: "await-team", isLast: false },
                    observeProof: () => new Promise(resolve => { reportReward = resolve; }) };
            }
        } });
        await admit(file, ex);
        deliver(file, original); ex.poll();
        await new Promise(resolve => setImmediate(resolve));
        deliver(file, cmd); ex.poll();
        reportReward(proof);
        await ex.settle(); ex.poll(); await ex.settle();
        const statuses = results(file, "route-result").filter(m => m.replyTo === "r1").map(m => m.payload.status);
        assert.deepEqual(statuses, ["await-team"], cmd.op);
        assert.deepEqual(runs, cmd.op === "run-route" ? [1, 2] : [1], cmd.op);
    }
});

test("客户端离线期间保留两次路线回报，重复派发仅重放原消息", async () => {
    const file = fakeFile(), original = packet("r", "run-route", { ...world, routeSeq: 1 });
    let runs = 0;
    const options = { file, role: "big", actions: { "join-world": join, "run-route"() {
        runs++;
        return { op: "route-result", payload: { status: "await-team", isLast: true },
            observeProof: async () => ({ status: "success", evidence: "reward", isLast: true }) };
    } } };
    const ex = createExecutor(options);
    await admit(file, ex);
    deliver(file, original); ex.poll(); await ex.settle();
    const saved = results(file, "route-result");
    assert.deepEqual(saved.map(m => m.payload.status), ["await-team", "success"]);
    assert.ok(saved.every(m => m.replyTo === original.messageId));
    for (const key of file.files.keys()) if (key.startsWith("mailbox/out/")) file.files.delete(key);
    const recovered = createExecutor(options);
    recovered.poll(); await recovered.settle();
    assert.deepEqual(results(file, "route-result"), saved);
    assert.equal(runs, 1);
});

test("执行期间接收取消，旧世界和旧路线取消不触及当前追踪", async () => {
    const file = fakeFile();
    let cancelCalls = 0, finish;
    const executor = createExecutor({ role: "big", file, actions: {
        "join-world": join,
        async "run-route"(cmd, control) {
            await new Promise(resolve => {
                finish = resolve;
                control.cts = { Cancel() { cancelCalls++; resolve(); } };
            });
            return { op: "route-result", payload: { status: control.canceled ? "canceled" : "success", isLast: true } };
        }
    }});
    await admit(file, executor);
    deliver(file, packet("r", "run-route", { ...world, routeSeq: 1 })); executor.poll();
    deliver(file, packet("c1", "cancel-route", { ...world, routeSeq: 2 }));
    deliver(file, packet("c2", "cancel-route", { ...world, worldAttemptId: "old", routeSeq: 1 }));
    executor.poll();
    assert.equal(cancelCalls, 0);
    deliver(file, packet("c3", "cancel-route", { ...world, routeSeq: 1, rosterVersion: 2 })); executor.poll();
    assert.equal(cancelCalls, 1);
    finish(); await executor.settle();
    assert.equal(results(file, "route-result")[0].payload.status, "canceled");
});

test("重复派单和宿主重启重放同一组结果，不重复操作游戏", async () => {
    const file = fakeFile();
    let calls = 0;
    const options = { file, role: "big", actions: { "join-world"() { calls++; return join(); } } };
    let executor = createExecutor(options);
    await admit(file, executor);
    const id = results(file, "join-result")[0].messageId;
    for (const key of file.files.keys()) if (key.startsWith("mailbox/out/")) file.files.delete(key);
    executor = createExecutor(options);
    executor.poll(); await executor.settle();
    assert.equal(calls, 1);
    assert.equal(results(file, "join-result")[0].messageId, id);
    deliver(file, packet("alien", "leave-world", { ...world, seatId: "stranger" }));
    executor.poll();
    assert.equal(results(file, "ack").find(e => e.replyTo === "alien").payload.status, "rejected");
});

test("动作已开始但无结果时，进程重启要求核对现场", async () => {
    const file = fakeFile();
    let calls = 0;
    const options = { file, role: "big", actions: { "join-world"() { calls++; return new Promise(() => {}); } } };
    const old = createExecutor(options);
    deliver(file, start); old.poll();
    deliver(file, packet("j", "join-world", world)); old.poll();
    // 旧运行环境至此停止。新实例从已保存的状态恢复。
    const recovered = createExecutor(options);
    recovered.poll(); await recovered.settle();
    assert.equal(calls, 1);
    assert.ok(results(file, "ack").some(e => e.replyTo === "j" && e.payload.status === "rejected"));
    assert.equal(results(file, "join-result").length, 0);
});

test("投递标记须在消息正文写入成功后创建", () => {
    const file = fakeFile();
    const write = file.WriteTextSync;
    file.WriteTextSync = function(path, body) {
        if (path.startsWith("mailbox/out/") && !path.endsWith(".ready.json")) return false;
        return write.call(this, path, body);
    };
    const executor = createExecutor({ file, role: "big" });
    deliver(file, start);
    assert.throws(() => executor.poll(), /无法写入/);
    assert.ok(![...file.files.keys()].some(k => k.endsWith(".ready.json")));
});

test("撤销先于路线到达，跨重启和名单升版也不会执行原路线", async () => {
    const file = fakeFile();
    const calls = [];
    const options = { file, role: "big", actions: { "join-world": join,
        "run-route"(c) { calls.push(c.routeSeq); return { op: "route-result", payload: { status: "success", isLast: true } }; }
    }};
    let ex = createExecutor(options);
    await admit(file, ex);
    deliver(file, packet("c1", "cancel-route", { ...world, rosterVersion: 2, routeSeq: 1 })); ex.poll();
    ex = createExecutor(options);
    deliver(file, packet("r1", "run-route", { ...world, routeSeq: 1 })); ex.poll(); await ex.settle();
    deliver(file, packet("r2", "run-route", { ...world, rosterVersion: 2, routeSeq: 2 })); ex.poll(); await ex.settle();
    assert.deepEqual(calls, [2]);
    assert.ok(results(file, "route-result").some(e => e.replyTo === "r1" && e.payload.status === "canceled"));
});

test("收件后瞬时空读不影响下一文件，未完整文件在下轮处理", () => {
    const file = fakeFile();
    file.WriteTextSync("mailbox/in/gone.json", "");
    deliver(file, start);
    const executor = createExecutor({ file, role: "big" });
    executor.poll();
    assert.equal(results(file, "executor-ready").length, 1);
    deliver(file, packet("gone", "task-end"));
    executor.poll();
    assert.equal(executor.stopped, true);
});

test("取消与执行异常交错时，Promise 拒绝仍作为失败回报", async () => {
    const file = fakeFile();
    let fail;
    const executor = createExecutor({ role: "big", file, actions: {
        "join-world": join,
        "run-route": (c, control) => new Promise((_, reject) => {
            control.cts = { Cancel() {} };
            fail = reject;
        })
    } });
    await admit(file, executor);
    deliver(file, packet("run", "run-route", { ...world, routeSeq: 1 })); executor.poll();
    deliver(file, packet("stop", "cancel-route", { ...world, routeSeq: 1 })); executor.poll();
    fail(Error("地图文件读取失败"));
    await executor.settle();
    assert.equal(results(file, "route-result")[0].payload.status, "failed");
});

test("名单升版后旧授权的精准取消仍有效，退单人后单独重报下个世界就绪", async () => {
    const file = fakeFile();
    let calls = 0;
    const ex = createExecutor({ role: "big", file, actions: {
        "join-world": join, "leave-world": () => ({ op: "seat-left", payload: { single: true } }),
        "run-route": (c, control) => new Promise(resolve => {
            control.cts = { Cancel() { calls++; resolve({ op: "route-result", payload: { status: "canceled", reason: "撤销" } }); } };
        })
    } });
    await admit(file, ex);
    deliver(file, packet("r", "run-route", { ...world, routeSeq: 1 })); ex.poll();
    deliver(file, packet("n", "roster-update", { ...world, rosterVersion: 2 }, { roster: [{ seatId: "s" }] })); ex.poll();
    deliver(file, packet("wrong", "cancel-route", { ...world, routeSeq: 1 }, { targetMessageId: "another" })); ex.poll();
    assert.equal(calls, 0);
    deliver(file, packet("can", "cancel-route", { ...world, routeSeq: 1 }, { targetMessageId: "r" })); ex.poll();
    await ex.settle();
    assert.equal(calls, 1);
    deliver(file, packet("leave", "leave-world", { ...world, rosterVersion: 2 })); ex.poll(); await ex.settle();
    const ready = results(file, "executor-ready").find(m => m.replyTo === "leave");
    assert.ok(ready.payload.single);
    assert.ok(!("worldAttemptId" in ready));
});

test("连续降员后仍执行本席旧名单的退场，并拒绝不匹配的退场", async () => {
    const file = fakeFile(), leaves = [];
    const options = { role: "big", file, actions: {
        "join-world": join,
        "leave-world"(cmd) {
            leaves.push(cmd.messageId);
            return { op: "seat-left", payload: { single: true } };
        }
    }};
    const executor = createExecutor(options);
    await admit(file, executor);
    deliver(file, packet("v2", "roster-update", { ...world, rosterVersion: 2 },
        { roster: [{ seatId: "teammate" }], removed: ["s"] }));
    executor.poll();
    deliver(file, packet("v3", "roster-update", { ...world, rosterVersion: 3 },
        { roster: [], removed: ["s", "teammate"] }));
    executor.poll();

    const resumed = createExecutor(options);
    const leave = packet("leave", "leave-world", { ...world, rosterVersion: 2 });
    const invalid = [
        ["task", { taskId: "other" }], ["room", { roomName: "其他房间" }],
        ["world", { worldAttemptId: "other" }], ["uid", { worldUid: "100000002" }],
        ["seat", { seatId: "other" }], ["version", { rosterVersion: 0 }],
    ];
    for (const [name, scope] of invalid) {
        deliver(file, { ...leave, ...scope, messageId: "bad_" + name });
    }
    resumed.poll();
    assert.deepEqual(leaves, []);
    for (const [name] of invalid) {
        assert.ok(results(file, "ack").some(e => e.replyTo === "bad_" + name && e.payload.status === "rejected"));
    }
    deliver(file, leave);
    resumed.poll();
    await resumed.settle();
    assert.deepEqual(leaves, ["leave"]);
    assert.ok(results(file, "seat-left").some(e => e.replyTo === "leave" && e.rosterVersion === 2 && e.payload.single));

    deliver(file, leave);
    deliver(file, { ...leave, messageId: "closed" });
    resumed.poll();
    await resumed.settle();
    assert.deepEqual(leaves, ["leave"]);
    assert.ok(results(file, "ack").some(e => e.replyTo === "closed" && e.payload.status === "rejected"));
});

test("重新启动只读核对退场结果，不再发起离开操作", async () => {
    const file = fakeFile();
    let clicks = 0, inspections = 0;
    const options = { file, role: "big", actions: {
        "join-world": join, "leave-world"() { clicks++; return new Promise(() => {}); },
        recover: async () => { inspections++; return { op: "seat-left", payload: { single: true } }; }
    } };
    const original = createExecutor(options);
    await admit(file, original);
    deliver(file, packet("l", "leave-world", world)); original.poll();
    const recovered = createExecutor(options); recovered.poll(); await recovered.settle();
    assert.equal(clicks, 1); assert.equal(inspections, 1);
    assert.equal(results(file, "seat-left")[0].replyTo, "l");
});

test("主用户离线跨重启仅滞留一个带观测时间的执行端心跳", () => {
    const file = fakeFile();
    let t = 200000;
    const options = { role: "big", now: () => t, file };
    let ex = createExecutor(options);
    deliver(file, start); ex.poll();
    for (let i = 0; i < 12; i++) { t += 3600000; ex.poll(); }
    ex = createExecutor(options); ex.poll();
    const first = results(file, "heartbeat");
    assert.equal(first.length, 1); assert.equal(first[0].payload.observedAt, 200000);
    const base = "mailbox/out/" + first[0].messageId;
    file.files.delete(base + ".ready.json"); file.files.delete(base + ".json");
    t += 6000; ex.poll();
    assert.equal(results(file, "heartbeat")[0].payload.observedAt, t);
});

test("同一目录换角色或用可创建会话的撤销指令，仍须服从原小号隔离", async () => {
    const file = fakeFile();
    file.WriteTextSync("mailbox/state/executor1.json", JSON.stringify({ revision: 1, session: null, ended: ["old"],
        records: {}, quarantine: { taskId: "old", roomName: "原房" } }));
    const host = createExecutor({ role: "host", file });
    deliver(file, packet("cancel", "cancel-attempt", { ...world, workerId: "worker", slotId: 1, slotGeneration: 1 }));
    host.poll(); await host.settle();
    assert.equal(host.stopped, false);
    const big = createExecutor({ role: "big", file });
    deliver(file, start); big.poll(); await big.settle();
    assert.deepEqual(results(file, "executor-ready"), []);
    for (const id of ["cancel", start.messageId]) {
        assert.ok(results(file, "ack").some(e => e.replyTo === id && e.payload.status === "rejected" && e.payload.reason.includes("隔离")));
    }
});

test("人工核对标记只解除对应旧任务，也阻止从未领取的旧发车在离线后复活", () => {
    const file = fakeFile();
    const options = { role: "big", file };
    const old = createExecutor(options);
    deliver(file, start); old.poll();
    const mark = (taskId, roomName) => file.WriteTextSync("mailbox/state/end-" + taskId + ".json",
        JSON.stringify({ type: "laicai-local-end", version: 1, taskId, roomName, role: "big", accountId: "user", clientId: "pc" }));
    mark("t_1", "另一个房间");
    let restarted = createExecutor(options);
    const newStart = packet("b1", "task-start", { taskId: "t_2" }, start.payload);
    deliver(file, newStart); restarted.poll();
    assert.ok(results(file, "ack").some(e => e.replyTo === "b1" && e.payload.status === "rejected"));
    mark("t_1", start.roomName);
    mark("never", start.roomName);
    restarted = createExecutor(options);
    deliver(file, packet("b2", "task-start", { taskId: "t_2" }, start.payload));
    deliver(file, packet("stale", "task-start", { taskId: "never" }, start.payload));
    restarted.poll();
    assert.ok(results(file, "executor-ready").some(e => e.replyTo === "b2"));
    assert.ok(results(file, "ack").some(e => e.replyTo === "stale" && e.payload.status === "rejected"));
    assert.ok(!results(file, "executor-ready").some(e => e.replyTo === "stale"));
});
