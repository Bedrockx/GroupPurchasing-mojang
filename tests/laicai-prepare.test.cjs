const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareWorld } = require("../js/来财/main.js");
const command = { worldUid: "100000001" };
function setup({ start = "Paimon", afterUid = command.worldUid, initialUid = command.worldUid } = {}) {
    const stages = [], inputs = [];
    let page = start, time = 0, currentUid = initialUid, reads = 0, selected = false;
    const ui = {
        now: () => time, wait: async ms => { time += ms; },
        uid() { reads++; return currentUid; }, screen: () => page,
        key(key) {
            inputs.push(key);
            if (key === "F2") page = "F2UIopenedcheck";
            else if (page === "Paimon") page = "Menu";
            else if (page === "F2UIopenedcheck") page = "Paimon";
        },
        click(x) {
            inputs.push(x);
            if (page === "Menu") page = "PrepareToLogOut";
            else if (page === "SwitchAccount" && selected) { page = "Paimon"; currentUid = afterUid; }
            else if (page === "EnterGame") page = "SelectAccount";
            else if (page === "SelectAccount") { page = "EnterGame"; selected = true; }
        },
        picture: () => [750, 500], loginMethod: () => ({ picture: "account/test.png" }),
        pressNamed(name) {
            inputs.push(name);
            page = { PrepareToLogOut: "SwitchAccount", SwitchAccount: "Exit", Exit: "EnterGame", EnterGame: "SwitchAccount" }[name];
            return true;
        }
    };
    const control = { canceled: false, emit(op, body) { assert.equal(op, "worker-stage"); stages.push(body.stage); } };
    return { ui, control, inputs, stages, reads: () => reads };
}
test("小号选择目标账号，核验两次 UID 及可打开联机界面", async () => {
    const { ui, control, inputs, stages, reads } = setup({ initialUid: "100000002" });
    const result = await prepareWorld(command, control, ui);
    assert.deepEqual(result, { op: "world-ready", payload: { observedUid: command.worldUid, exactReads: 2 } });
    assert.deepEqual(stages, ["game", "switching", "verifying"]);
    assert.ok(inputs.includes("Exit") && inputs.includes("F2"));
    assert.equal(reads(), 4);
});
test("切换后仍为错误 UID 时到期失败，不能开放联机", async () => {
    const { ui, control, inputs } = setup({ initialUid: "100000002", afterUid: "100000009" });
    await assert.rejects(prepareWorld(command, control, ui), /超时/);
    assert.ok(!inputs.includes("F2"));
});
test("撤销恰好发生在读取 UID 后时，不能点击或上报已就绪", async () => {
    const { ui, control, inputs } = setup();
    ui.uid = async () => { control.canceled = true; return command.worldUid; };
    await assert.rejects(prepareWorld(command, control, ui), /撤销/);
    assert.deepEqual(inputs, []);
});
test("未识别到有效游戏画面时不点击并限时结束", async () => {
    const { ui, control, inputs } = setup({ start: "unknown" });
    await assert.rejects(prepareWorld(command, control, ui), /超时/);
    assert.deepEqual(inputs, []);
});
