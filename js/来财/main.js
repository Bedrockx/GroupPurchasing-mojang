// 本地收件、游戏动作和控制消息共用协议 v1。轮询收件时不等待耗时游戏动作。
const LAICAI_VERSION = "1.0.0";
const contextFields = ["roomName", "taskId", "worldUid", "worldAttemptId", "workerId", "slotId", "slotGeneration", "rosterVersion", "seatId", "routeSeq"];
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const worldOps = ["prepare-world", "open-admission", "admit-seat", "join-world", "run-route", "cancel-route", "roster-update", "leave-world", "check-clear", "release-world", "cancel-attempt"];
const hostOnly = ["prepare-world", "open-admission", "admit-seat", "check-clear", "release-world", "cancel-attempt"];
const bigOnly = ["join-world", "run-route", "cancel-route", "leave-world"];

function createExecutor({ role, file, now = Date.now, actions = {} }) {
    if (!["big", "host"].includes(role)) throw new Error("需要设置来财角色");
    for (const dir of ["mailbox", "mailbox/in", "mailbox/out", "mailbox/state"]) {
        if (!file.CreateDirectory(dir)) throw new Error("无法创建 " + dir);
    }
    function read(path) { return JSON.parse(file.ReadTextSync(path)); }
    function write(path, data) {
        if (!file.WriteTextSync(path, JSON.stringify(data))) throw new Error("无法写入 " + path);
    }
    // LimitedFile 没有文件改名接口。交替写两份状态，断电时保留上次完整提交。
    const copies = [0, 1].map(i => {
        const path = "mailbox/state/executor" + i + ".json";
        if (!file.IsExists(path)) return null;
        try { return read(path); } catch { return { damaged: true }; }
    });
    let state = copies.filter(s => s && Number.isSafeInteger(s.revision))
        .sort((a, b) => b.revision - a.revision)[0];
    if (!state && copies.some(Boolean)) throw new Error("执行状态损坏，需要核对游戏现场");
    state ||= { revision: 0, session: null, ended: [], records: {} };
    let fatal;
    function save() {
        state.revision++;
        try { write("mailbox/state/executor" + (state.revision % 2) + ".json", state); }
        catch (error) { fatal = error; throw error; }
    }
    function manuallyEnded(taskId, room, expectedRole) {
        if (!identifier.test(taskId || "")) return false;
        const path = "mailbox/state/end-" + taskId + ".json";
        if (!file.IsExists(path)) return false;
        const mark = read(path);
        return mark?.type === "laicai-local-end" && mark.version === 1 && mark.taskId === taskId &&
            mark.roomName === room && ["big", "host"].includes(mark.role) && (!expectedRole || expectedRole === mark.role);
    }
    if (state.session && manuallyEnded(state.session.id, state.session.room, state.session.role)) {
        const previous = state.session;
        for (const [id, rec] of Object.entries(state.records)) {
            if (rec.command.taskId === previous.id && rec.command.roomName === previous.room) delete state.records[id];
        }
        if (state.quarantine?.taskId === previous.id) delete state.quarantine;
        state.session = null;
        save();
    }
    if (state.quarantine && manuallyEnded(state.quarantine.taskId, state.quarantine.roomName, "host")) {
        delete state.quarantine;
        save();
    }
    if (state.session && state.session.role !== role) throw new Error("原任务仍占用此游戏会话");
    let sequence = 0;
    function event(command, op, payload, taskOnly = false) {
        const id = "c_" + now().toString(36) + "_" + (++sequence).toString(36) + "_" + Math.random().toString(36).slice(2, 10);
        const result = { type: "laicai", version: 1, op, messageId: id, replyTo: command.messageId, payload };
        for (const key of taskOnly ? ["roomName", "taskId"] : contextFields) if (command[key] !== undefined) result[key] = command[key];
        return result;
    }
    function publish(result) {
        const base = "mailbox/out/" + result.messageId;
        write(base + ".json", result);
        write(base + ".ready.json", { messageId: result.messageId });
    }
    function flush(rec) {
        for (const result of rec.events) publish(result);
        if (rec.dirty) { rec.dirty = false; save(); }
    }
    function emit(rec, op, payload, taskOnly) {
        const result = event(rec.command, op, payload, taskOnly);
        if (op === "world-members" && state.session?.world?.worldAttemptId === rec.command.worldAttemptId) {
            for (const key of ["workerId", "slotId", "slotGeneration"]) result[key] = state.session.world[key];
        }
        rec.events.push(result);
        rec.dirty = true;
        save();
        // 只有当前事件尚未投递。收到重发指令时才重放整份已知结果。
        publish(result);
        rec.dirty = false;
        save();
    }
    let busy = null;
    let monitor = null, nextObservation = 0;
    let lastHeartbeat = 0;
    const heartbeatPath = "mailbox/state/heartbeat.json";
    let heartbeatId = null;
    if (file.IsExists(heartbeatPath)) {
        try { heartbeatId = read(heartbeatPath).id; } catch { /* 心跳可由新的观测替代 */ }
    }
    let visible = new Set();
    let stopped = false;
    function terminal(rec, status, reason) {
        rec.done = true;
        emit(rec, "ack", reason ? { status, reason } : { status });
    }
    // 仅对可直接观察的终态安排只读复核。路线、切号和入场等副作用不会因重启再次执行。
    const recovery = [];
    for (const rec of Object.values(state.records)) {
        if (rec.dirty) flush(rec);
        if (rec.done) continue;
        const completed = rec.events.find(e => ["route-result", "seat-left", "world-ready", "world-cleared", "join-result", "admission-opened", "seat-armed"].includes(e.op));
        if (completed) {
            terminal(rec, ["failed", "canceled"].includes(completed.payload.status) ? "rejected" : "applied",
                completed.payload.reason);
        } else if (actions.recover && ["leave-world", "check-clear"].includes(rec.command.op) &&
            rec.command.worldAttemptId === state.session?.world?.worldAttemptId) recovery.push(rec);
        else terminal(rec, "rejected", "执行端已重启，原动作未确认，需要核对现场");
    }
    function validation(c) {
        const p = c.payload;
        const s = state.session;
        if (!identifier.test(c.taskId || "")) return "无效任务";
        if (state.ended.includes(c.taskId)) return "任务已结束";
        if (s && (s.id !== c.taskId || s.room !== c.roomName)) return "会话已由其他任务占用";
        if (c.op === "task-start") {
            if (s || p.role !== role || p.laicaiVersion !== LAICAI_VERSION || !identifier.test(p.seatId || "")) return "席位、版本或任务不符";
            return;
        }
        if (c.op === "task-end") return;
        if (!s && !(["prepare-world", "cancel-attempt"].includes(c.op) && role === "host")) return "会话未绑定";
        if (c.op === "retire-worker") {
            const prev = s.lastReleased;
            if (role !== "host" || s.world || !prev || !["worldUid", "worldAttemptId", "workerId", "slotId", "slotGeneration"].every(k => prev[k] === c[k])) return "待回收会话与释放记录不符";
            return;
        }
        if (!worldOps.includes(c.op)) return "未知指令";
        if (hostOnly.includes(c.op) && role !== "host" || bigOnly.includes(c.op) && role !== "big") return "角色不符";
        if (!/^\d{9,10}$/.test(c.worldUid || "") || !identifier.test(c.worldAttemptId || "")) return "世界标识无效";
        if (role === "host" && c.op !== "roster-update" && (!identifier.test(c.workerId || "") ||
            ![1, 2].includes(c.slotId) || !Number.isSafeInteger(c.slotGeneration) || c.slotGeneration < 1)) return "多用户位置无效";
        if (bigOnly.includes(c.op) && c.seatId !== s.seatId) return "席位不符";
        if (["join-world", "leave-world", "run-route", "cancel-route", "open-admission", "admit-seat", "check-clear", "roster-update"].includes(c.op) &&
            (!Number.isSafeInteger(c.rosterVersion) || c.rosterVersion < 1)) return "名单版本无效";
        if (["run-route", "cancel-route"].includes(c.op) && (!Number.isSafeInteger(c.routeSeq) || c.routeSeq < 1)) return "路线序号无效";
        if (s && s.closed.includes(c.worldAttemptId)) return "世界尝试已关闭";
        if (state.retired && state.retired.some(r => r.task === c.taskId && r.world === c.worldAttemptId)) return "世界尝试已回收";
        const w = s && s.world;
        if (w && ["release-world", "cancel-attempt"].includes(c.op) && w.everOpened && !w.cleared) return "世界尚未确认清空";
        if (w && (w.worldAttemptId !== c.worldAttemptId || w.worldUid !== c.worldUid)) return "当前尝试不符";
        if (!w && !["prepare-world", "join-world", "cancel-attempt", "leave-world", "roster-update"].includes(c.op)) return "世界未绑定";
        if (w && role === "host" && (c.op !== "roster-update" || c.slotId !== undefined) &&
            (w.workerId !== c.workerId || w.slotId !== c.slotId || w.slotGeneration !== c.slotGeneration)) return "多用户代次不符";
        const activeCancel = c.op === "cancel-route" && busy && sameRoute(busy.command, c) &&
            (!c.payload.targetMessageId || c.payload.targetMessageId === busy.command.messageId);
        if (c.op === "cancel-route" && busy && sameRoute(busy.command, c) && c.payload.targetMessageId && !activeCancel) return "取消与本地授权不符";
        if (w && c.rosterVersion && c.rosterVersion < w.rosterVersion && !activeCancel && !routeWasCanceled(s, c)) return "名单版本已过期";
        if (w?.removed && ["join-world", "run-route"].includes(c.op) && !routeWasCanceled(s, c)) return "席位已从本世界移出";
    }
    function makeSession(c) {
        state.session = { id: c.taskId, room: c.roomName, role, seatId: c.payload.seatId,
            closed: [], world: null, roster: c.payload.roster || [], lastCommand: c, timeoutSeconds: c.payload.timeoutSeconds || 120 };
    }
    function closeWorld(s) {
        if (s.world) s.closed.push(s.world.worldAttemptId);
        s.world = null;
    }
    function retire(s) {
        state.retired ||= [];
        for (const world of s.closed) if (!state.retired.some(r => r.task === s.id && r.world === world)) state.retired.push({ task: s.id, world });
        state.session = null;
        stopped = true;
    }
    function cancel(job) {
        if (!job) return;
        job.canceled = true;
        if (job.cts) job.cts.Cancel();
    }
    function sameRoute(a, b) {
        return a.taskId === b.taskId && a.worldAttemptId === b.worldAttemptId &&
            a.worldUid === b.worldUid && a.seatId === b.seatId && a.routeSeq === b.routeSeq;
    }
    function routeWasCanceled(s, c) {
        if (c.op !== "run-route" || !s?.world?.canceledRoutes?.includes(c.routeSeq)) return false;
        const target = s.world.canceledTargets?.[c.routeSeq];
        return !target || target === c.messageId;
    }
    function run(rec, recovering = false) {
        const c = rec.command;
        const job = { command: c, cts: null, canceled: false,
            emit: (op, payload) => emit(rec, op, payload) };
        busy = job;
        job.promise = (async () => {
            if (!recovering) emit(rec, "ack", { status: "started" });
            const s = state.session;
            try {
                const action = recovering ? actions.recover : actions[c.op];
                if (!action) throw new Error("游戏动作尚未实现 " + c.op);
                const result = await action(c, job, s);
                if (job.canceled && ["join-world", "admit-seat", "prepare-world"].includes(c.op)) throw new Error("本次动作已撤销");
                if (recovering && !result) throw new Error("重启后未能从现场确认原操作");
                if (result) {
                    if (c.op === "admit-seat" && result.op === "seat-armed") {
                        s.watch = c.messageId;
                        s.lastObservation = null;
                    }
                    const single = c.op === "leave-world" && result.op === "seat-left" && result.payload.single === true;
                    if (single) { closeWorld(s); s.single = true; }
                    emit(rec, result.op, result.payload);
                    if (single) emit(rec, "executor-ready", { role, laicaiVersion: LAICAI_VERSION, single: true }, true);
                }
                terminal(rec, "applied");
            } catch (error) {
                if (fatal) throw fatal;
                if (error.globalStop) throw error;
                const reason = String(error.message || error);
                if (c.op === "prepare-world" && !job.canceled) emit(rec, "worker-stage", { stage: "failed", reason });
                if (c.op === "run-route") emit(rec, "route-result", { status: error.localCancel ? "canceled" : "failed", reason });
                if (c.op === "join-world") emit(rec, "join-result", { status: "failed", reason });
                terminal(rec, "rejected", reason);
            } finally { if (busy === job) busy = null; }
        })().catch(error => { fatal = error; });
    }
    function dispatch(c) {
        // ID 作为对象键时加前缀，避免普通对象的原型键冲突。
        const key = "m_" + c.messageId;
        const old = state.records[key];
        if (manuallyEnded(c.taskId, c.roomName)) {
            if (old?.manualEnd && JSON.stringify(old.command) === JSON.stringify(c)) flush(old);
            else {
                const denied = { command: c, events: [], done: false, manualEnd: true };
                state.records[key] = denied;
                terminal(denied, "rejected", "本机已人工复核并结束了该任务");
            }
            return true;
        }
        if (old) {
            if (JSON.stringify(old.command) === JSON.stringify(c)) flush(old);
            return true;
        }
        const invalid = validation(c);
        const control = ["task-end", "cancel-route", "cancel-attempt", "roster-update"];
        if (!invalid && monitor) {
            monitor.canceled = true;
            return false;
        }
        if (!invalid && busy && !control.includes(c.op)) {
            if (c.op === "leave-world" && c.worldAttemptId === busy.command.worldAttemptId &&
                ["run-route", "join-world"].includes(busy.command.op)) cancel(busy);
            return false;
        }
        if (c.op === "task-start" && !invalid) state.records = {};
        const rec = { command: c, events: [], done: false, dirty: false };
        state.records[key] = rec;
        if (invalid) { terminal(rec, "rejected", invalid); return true; }
        if (!state.session) makeSession(c);
        const s = state.session;
        if (["check-clear", "admit-seat", "cancel-attempt", "release-world", "task-end"].includes(c.op)) s.watch = null;
        s.lastCommand = c;
        if (worldOps.includes(c.op) && !s.world) s.world = { ...c, rosterVersion: c.rosterVersion || 0 };
        if (c.op === "join-world") s.single = false;
        if (c.op === "open-admission") s.world.everOpened = true;
        if (s.world && c.rosterVersion) s.world.rosterVersion = Math.max(s.world.rosterVersion, c.rosterVersion);
        if (c.op === "cancel-route") {
            // 先与收件回执一起持久化。重启后即使原授权才到，也不能再执行。
            s.world.canceledRoutes ||= [];
            if (!s.world.canceledRoutes.includes(c.routeSeq)) s.world.canceledRoutes.push(c.routeSeq);
            s.world.canceledTargets ||= {};
            if (c.payload.targetMessageId) s.world.canceledTargets[c.routeSeq] = c.payload.targetMessageId;
        }
        emit(rec, "ack", { status: "received" });
        if (c.op === "task-start") {
            emit(rec, "executor-ready", { role, laicaiVersion: LAICAI_VERSION });
            terminal(rec, "applied");
        } else if (c.op === "retire-worker") {
            retire(s);
            terminal(rec, "applied");
        } else if (c.op === "task-end" || c.op === "cancel-attempt") {
            const prior = busy;
            cancel(prior);
            const finish = () => {
                const active = s.world;
                closeWorld(s);
                if (c.op === "task-end") {
                    const unsafe = c.payload.unsafeWorlds?.find(w => active && w.worldAttemptId === active.worldAttemptId &&
                        w.workerId === active.workerId && w.slotGeneration === active.slotGeneration && w.slotId === active.slotId);
                    if (unsafe && role === "host") state.quarantine = { taskId: c.taskId, roomName: c.roomName, ...unsafe };
                    state.ended.push(c.taskId); state.session = null; stopped = true;
                }
                else retire(s);
                terminal(rec, "applied");
            };
            if (prior) prior.promise = prior.promise.then(finish).catch(error => { fatal = error; });
            else finish();
        } else if (c.op === "release-world") {
            closeWorld(s);
            s.lastReleased = c;
            if (c.payload.retire === true) retire(s);
            terminal(rec, "applied");
        } else if (c.op === "cancel-route") {
            if (busy && sameRoute(busy.command, c)) cancel(busy);
            terminal(rec, "applied");
        } else if (routeWasCanceled(s, c)) {
            emit(rec, "route-result", { status: "canceled", reason: "本条授权已撤销" });
            terminal(rec, "applied");
        } else if (c.op === "roster-update") {
            if (role === "host") s.world.knownRoster ||= s.roster;
            s.roster = c.payload.roster;
            if (role === "host") {
                if (busy?.command.op === "admit-seat") cancel(busy);
                s.watch = c.messageId;
                s.lastObservation = null;
                // 主用户的名单变更只负责观察，新的单席授权到来前不再同意申请。
            } else if (!s.roster.some(m => m.seatId === s.seatId)) {
                s.world.removed = true;
                if (busy && busy.command.worldAttemptId === c.worldAttemptId) cancel(busy);
            }
            terminal(rec, "applied");
        } else {
            if (c.op === "prepare-world") emit(rec, "executor-ready", { role, laicaiVersion: LAICAI_VERSION });
            run(rec);
        }
        return true;
    }
    function poll() {
        if (fatal) throw fatal;
        if (!busy && recovery.length) run(recovery.shift(), true);
        const current = new Set();
        for (const entry of Array.from(file.ReadPathSync("mailbox/in"))) {
            const path = String(entry).replace(/\\/g, "/");
            const match = /^mailbox\/in\/([a-zA-Z0-9_-]{1,128})\.json$/.exec(path);
            if (!match) continue;
            const id = match[1];
            if (visible.has(id)) { current.add(id); continue; }
            let c;
            // 主用户可能在枚举与读取之间根据上一条回执回收文件。
            // 临时空读留到下轮，其他已完整发布的命令仍可处理。
            try { c = read(path); } catch { continue; }
            if (!c || c.messageId !== id || c.type !== "laicai" || c.version !== 1 || typeof c.roomName !== "string" ||
                !c.roomName || !c.payload || typeof c.payload !== "object" || typeof c.op !== "string") continue;
            if (dispatch(c)) current.add(id);
            if (stopped) break;
        }
        visible = current;
        const s = state.session;
        if (s && s.watch && !busy && !monitor && actions.observe && now() >= nextObservation) {
            const rec = state.records["m_" + s.watch];
            const watching = { canceled: false };
            monitor = watching;
            nextObservation = now() + 500;
            watching.promise = (async () => {
                let observed;
                try { observed = await actions.observe(rec.command, watching, s); }
                catch { observed = { stable: false, ambiguous: true, members: [] }; }
                if (!watching.canceled && s.watch === rec.command.messageId && JSON.stringify(observed) !== JSON.stringify(s.lastObservation)) {
                    s.lastObservation = observed;
                    emit(rec, "world-members", observed);
                }
            })().catch(error => { fatal = error; }).finally(() => { monitor = null; });
        }
        if (s && now() - lastHeartbeat >= 5000) {
            lastHeartbeat = now();
            if (heartbeatId && file.IsExists("mailbox/out/" + heartbeatId + ".ready.json")) return;
            const ref = busy ? busy.command : s.lastCommand;
            const single = role === "big" && !s.world && s.single === true && !busy;
            const pulse = event(ref, "heartbeat", { role, laicaiVersion: LAICAI_VERSION, source: "executor",
                stage: busy ? busy.command.op : "idle", single, observedAt: lastHeartbeat }, single);
            heartbeatId = pulse.messageId;
            write(heartbeatPath, { id: heartbeatId });
            publish(pulse);
        }
    }
    return { poll, settle: async () => { if (busy) await busy.promise; if (monitor) await monitor.promise; if (fatal) throw fatal; },
        get stopped() { return stopped; } };
}

// 坐标和状态标志取自「自动小号管理」，只在已识别的界面执行对应操作。
const loginRegions = {
    Paimon: [0, 0, 150, 150], Menu: [0, 0, 150, 150],
    PrepareToLogOut: [646, 488, 639, 97], SwitchAccount: [1783, 940, 100, 100],
    Exit: [911, 600, 341, 173], Confirm: [734, 826, 439, 116],
    EnterGame: [643, 565, 652, 186], LoginOther: [643, 565, 652, 186],
    SelectAccount: [642, 441, 644, 580], Login: [1776, 934, 100, 100],
    F2UIopenedcheck: [144, 993, 374, 48]
};

function coopPanelVisible(named, frame) {
    // 公共参考图 F2UIopenedcheck 含权限文字，只覆盖“确认后可加入”。
    return ["不允许加入", "确认后可加入", "直接加入", "leaveTeam", "enterUID"].some(name => named(name, frame));
}

function createGameUI() {
    const patterns = new Map();
    function pattern(path, region, threshold = 0.9) {
        const key = path + "|" + region + "|" + threshold;
        if (!patterns.has(key)) {
            const mat = file.ReadImageMatSync(path);
            const ro = RecognitionObject.TemplateMatch(mat, ...region);
            ro.Threshold = threshold;
            ro.InitTemplate();
            patterns.set(key, ro);
        }
        return patterns.get(key);
    }
    function picture(path, region = [0, 0, 1920, 1080], frame, threshold) {
        const own = !frame;
        frame ||= captureGameRegion();
        try {
            const found = frame.find(pattern(path, region, threshold));
            if (!found || !found.isExist()) return null;
            return [found.x + found.width / 2, found.y + found.height / 2].map(Math.round);
        } finally { if (own) frame.dispose(); }
    }
    function named(name, frame) { return picture("assets/界面/" + name + ".png", loginRegions[name], frame); }
    function screen() {
        const frame = captureGameRegion();
        try {
            if (coopPanelVisible(named, frame)) return "F2UIopenedcheck";
            for (const name of ["Confirm", "PrepareToLogOut", "Exit", "EnterAccountAndPassword", "EnterGame", "SelectAccount", "SwitchAccount", "Login", "Menu", "Paimon"]) {
                if (named(name, frame)) return name;
            }
            return "";
        } finally { frame.dispose(); }
    }
    function uid() {
        const frame = captureGameRegion();
        try {
            const result = frame.find(RecognitionObject.Ocr(1683, 1051, 234, 28));
            const text = String(result && result.text || "").trim().replace(/\s/g, "");
            const match = /^(?:UID[:：]?)?(\d{9,10})$/i.exec(text);
            return match ? match[1] : "";
        } finally { frame.dispose(); }
    }
    function loginMethod(target) {
        const path = "account/" + target + ".png";
        if (file.IsExists(path)) return { picture: path };
        if (file.IsExists("account/accounts.json")) {
            let credentials;
            try { credentials = JSON.parse(file.ReadTextSync("account/accounts.json"))[target]; }
            catch { throw new Error("本机账号配置无法解析"); }
            if (credentials && typeof credentials.account === "string" && credentials.account &&
                typeof credentials.password === "string" && credentials.password) return credentials;
        }
        throw new Error("当前会话未配置目标 UID 的账号图片或登录信息");
    }
    function pressNamed(name) {
        const pt = named(name);
        if (!pt) return false;
        click(...pt);
        return true;
    }
    return { screen, uid, loginMethod, named, picture, pressNamed, click: (x, y) => click(x, y),
        key: name => keyPress(name), type: value => {
            try { inputText(value); } catch { throw new Error("登录输入框写入失败"); }
        },
        wait: ms => sleep(ms), now: Date.now };
}

async function prepareWorld(command, control, ui) {
    const uid = command.worldUid;
    let stage = "";
    let deadline = ui.now() + 180000;
    const total = ui.now() + 360000;
    const stageTime = { game: 180000, switching: 180000, verifying: 30000 };
    function enterStage(next) {
        if (stage === next) return;
        stage = next;
        deadline = Math.min(total, ui.now() + stageTime[next]);
        control.emit("worker-stage", { stage });
    }
    function check() {
        if (control.canceled) throw new Error("本次小号准备已撤销");
        if (ui.now() >= deadline) throw new Error("小号准备超时，阶段 " + stage);
    }
    let method, chosen = false, switching = false, matches = 0, previousOther = "";
    let accountFilled = false, passwordFilled = false;
    enterStage("game");
    while (true) {
        check();
        const screen = ui.screen();
        if (screen === "Paimon") {
            const observed = await ui.uid();
            check();
            if (observed === uid) {
                previousOther = "";
                enterStage("verifying");
                if (++matches >= 2) {
                    ui.key("F2");
                    for (let i = 0; i < 8; i++) {
                        await ui.wait(300); check();
                        if (ui.screen() === "F2UIopenedcheck") {
                            ui.key("VK_ESCAPE");
                            return { op: "world-ready", payload: { observedUid: observed, exactReads: matches } };
                        }
                    }
                    throw new Error("目标 UID 已核对，联机界面未能打开");
                }
            } else {
                matches = 0;
                if (observed && observed === previousOther && !chosen) {
                    method ||= ui.loginMethod(uid);
                    switching = true;
                    enterStage("switching");
                    ui.key("VK_ESCAPE");
                } else if (chosen) enterStage("verifying");
                previousOther = observed;
            }
        } else {
            matches = 0;
            previousOther = "";
            if (screen === "F2UIopenedcheck") ui.key("VK_ESCAPE");
            if (screen === "Menu") {
                if (switching && !chosen) ui.click(50, 1025);
                else ui.key("VK_ESCAPE");
            }
            if (screen === "PrepareToLogOut" && switching) ui.pressNamed("PrepareToLogOut");
            if (screen === "SwitchAccount") {
                if (switching && !chosen) ui.pressNamed("SwitchAccount");
                else ui.click(10, 10);
            }
            if (["Exit", "Confirm", "Login"].includes(screen)) ui.pressNamed(screen);
            if (screen === "EnterGame") {
                if (chosen) ui.pressNamed("EnterGame");
                else {
                    method ||= ui.loginMethod(uid);
                    switching = true;
                    enterStage("switching");
                    if (method.picture) ui.click(974, 496);
                    else ui.pressNamed("LoginOther");
                }
            }
            if (screen === "SelectAccount") {
                method ||= ui.loginMethod(uid);
                if (method.picture) {
                    const pos = ui.picture(method.picture);
                    if (pos) { ui.click(...pos); chosen = true; }
                } else ui.click(957, 404);
            }
            if (screen === "EnterAccountAndPassword") {
                method ||= ui.loginMethod(uid);
                if (method.picture) { ui.click(1260, 259); }
                else if (ui.pressNamed("Agree")) { /* 勾选后等待界面刷新 */ }
                else if (!accountFilled && ui.pressNamed("EnterAccount")) { await ui.wait(100); check(); ui.type(method.account); accountFilled = true; }
                else if (!passwordFilled && ui.pressNamed("EnterPassword")) { await ui.wait(100); check(); ui.type(method.password); passwordFilled = true; }
                else if (accountFilled && passwordFilled && ui.pressNamed("EnterGame2")) chosen = true;
            }
        }
        await ui.wait(450);
    }
}

function identifyMember(lines, roster) {
    const ids = lines.map(line => /^(?:UID\s*[:：]?\s*)?(\d{9,10})$/i.exec(line)?.[1]).filter(Boolean);
    const byName = roster.filter(m => lines.includes(m.gameName));
    if (ids.length) {
        const byUid = roster.filter(m => ids.every(id => id === m.uid));
        return byUid.length === 1 && byName.every(m => m.seatId === byUid[0].seatId) ? byUid[0] : null;
    }
    return byName.length === 1 ? byName[0] : null;
}

function worldUI(base) {
    const inFrame = read => {
        const frame = captureGameRegion();
        try { return read(frame); } finally { frame.dispose(); }
    };
    function texts(frame, ...rect) {
        return Array.from(frame.findMulti(RecognitionObject.Ocr(...rect)), item => String(item.text || "").trim()).filter(Boolean);
    }
    const img = (name, region, frame) => base.picture("assets/界面/" + name + ".png", region, frame);
    return Object.assign(base, {
        sign: () => inFrame(frame => {
            for (let i = 0; i < 5; i++) if (img(i + "P", [200, 10, 400, 70], frame)) return i;
            return -1;
        }),
        f2: () => inFrame(frame => coopPanelVisible(base.named, frame)),
        permission: () => inFrame(frame => ["确认后可加入", "不允许加入", "直接加入"].find(name => base.named(name, frame)) || ""),
        searchUid: () => inFrame(frame => {
            const ids = texts(frame, 160, 36, 1620, 128).flatMap(line => line.match(/\d{9,10}/g) || []);
            return new Set(ids).size === 1 ? ids[0] : "";
        }),
        focusSearch() {
            const empty = base.named("enterUID");
            const button = !empty && base.named("search");
            if (!empty && !button) return false;
            if (empty) base.click(...empty);
            else base.click(button[0] - 130, button[1]);
            keyDown("VK_CONTROL");
            try { keyPress("A"); } finally { keyUp("VK_CONTROL"); }
            return true;
        },
        resultCard: () => inFrame(frame => {
            if (!img("requestEnter", [1460, 175, 310, 120], frame)) return null;
            // 排除顶部搜索输入框，仅读取第一行玩家名片。
            const lines = texts(frame, 400, 175, 700, 119);
            const ids = lines.map(line => /^(?:UID\s*[:：]?\s*)?(\d{9,10})$/i.exec(line)?.[1]).filter(Boolean);
            return { uid: new Set(ids).size === 1 ? ids[0] : "", lines: lines.join("\n") };
        }),
        emptySearch: () => inFrame(frame => !img("requestEnter", [1460, 175, 310, 770], frame) &&
            texts(frame, 250, 170, 1420, 710).some(text => /(?:无搜索结果|未(?:搜索|查找|找到).*玩家|没有找到.*玩家|无法找到.*玩家)/.test(text))),
        requestButton: () => inFrame(frame => img("requestEnter", [1460, 295, 310, 650], frame) ? null :
            img("requestEnter", [1460, 175, 310, 120], frame)),
        multipleResults: () => inFrame(frame => Boolean(img("requestEnter", [1460, 175, 310, 120], frame) &&
            img("requestEnter", [1460, 295, 310, 650], frame))),
        request(roster, seatId) {
            return inFrame(frame => {
                if (img("yUIopenedcheck", [1322, 278, 48, 48], frame)) {
                    const requester = identifyMember(texts(frame, 668, 512, 300, 50), roster);
                    const allowed = requester && requester.seatId === seatId;
                    const button = img(allowed ? "allowEnter" : "refuseEnter", [520, 710, 850, 90], frame);
                    if (button) { base.click(...button); return allowed ? "approved" : "rejected"; }
                    base.key("VK_ESCAPE");
                    return "pending";
                }
                if (img("yUI", [1142, 25, 93, 93], frame)) { base.key("Y"); return "pending"; }
                return "none";
            });
        },
        members(roster) {
            return inFrame(frame => {
                if (!coopPanelVisible(base.named, frame)) return null;
                const members = [];
                let ambiguous = false;
                const singleSearch = Boolean(base.named("enterUID", frame));
                for (let i = 0; i < 3; i++) {
                    const y = 271 + i * 125;
                    const occupied = img("kickButton", [1476, y, 299, 124], frame);
                    const lines = texts(frame, 400, y, 549, 124);
                    if (!occupied) {
                        if (!singleSearch && lines.length) ambiguous = true;
                        continue;
                    }
                    const person = identifyMember(lines, roster);
                    if (!person || singleSearch || members.some(m => m.seatId === person.seatId)) ambiguous = true;
                    else members.push({ seatId: person.seatId, position: i + 2 });
                }
                // 空队伍需要单人搜索页或房主名片作为有效列表标志。
                if (!singleSearch && !members.length && !texts(frame, 400, 146, 549, 124).length) ambiguous = true;
                return { ambiguous, members };
            });
        }
    });
}

function createWorldActions(ui) {
    const uncertain = () => ({ stable: false, ambiguous: true, members: [] });
    function check(control, until) {
        if (control.canceled) throw new Error("世界操作已撤销");
        if (ui.now() >= until) throw new Error("等待游戏现场确认超时");
    }
    async function wait(control, until, ms) { await ui.wait(ms); check(control, until); }
    const deadline = s => ui.now() + Math.max(1, s.timeoutSeconds || 120) * 1000;
    async function openPanel(control, until) {
        while (!ui.f2()) {
            check(control, until);
            ui.key("F2");
            await wait(control, until, 750);
        }
    }
    async function permission(target, control, until) {
        await openPanel(control, until);
        while (true) {
            check(control, until);
            const current = ui.permission();
            if (current === target) return;
            if (current && ui.pressNamed(current)) {
                await wait(control, until, 280);
                ui.pressNamed("设置" + target);
            }
            await wait(control, until, 400);
        }
    }
    async function hostMatches(uid, mode) {
        return /^\d{9,10}$/.test(uid) && ui.f2() && (await ui.uid()) === uid && ui.permission() === mode;
    }
    async function targetPanel(uid, control, until) {
        await openPanel(control, until);
        let matched = 0;
        while (matched < 2) {
            check(control, until);
            matched = ui.f2() && (await ui.uid()) === uid && /^\d{9,10}$/.test(uid) ? matched + 1 : 0;
            if (matched < 2) await wait(control, until, 400);
        }
        check(control, until);
    }
    async function stableMembers(s, control, until, uid, mode) {
        const recognizable = s.world.knownRoster || s.roster;
        const first = await hostMatches(uid, mode) ? ui.members(recognizable) : null;
        await wait(control, until, 400);
        const second = await hostMatches(uid, mode) ? ui.members(recognizable) : null;
        check(control, until);
        if (!first || !second || first.ambiguous || second.ambiguous ||
            JSON.stringify(first.members) !== JSON.stringify(second.members)) return uncertain();
        const observed = { stable: true, ambiguous: false, members: second.members, observedUid: uid };
        if (mode === "确认后可加入") observed.admissionMode = "confirm";
        return observed;
    }
    async function search(uid, control, until) {
        if (!(ui.focusSearch ? ui.focusSearch() : ui.pressNamed("enterUID"))) return false;
        await wait(control, until, 200);
        ui.type(uid);
        await wait(control, until, 300);
        return ui.searchUid() === uid && ui.pressNamed("search");
    }
    let lastAdmission = null;
    return {
        async "open-admission"(c, control, s) {
            if (!Array.isArray(c.payload.roster) || !c.payload.roster.length) throw new Error("缺少世界名单");
            s.roster = c.payload.roster;
            s.world.knownRoster = c.payload.roster;
            const until = deadline(s);
            await targetPanel(c.worldUid, control, until);
            await permission("确认后可加入", control, until);
            s.world.opened = true;
            s.world.everOpened = true;
            return { op: "admission-opened", payload: {} };
        },
        async "admit-seat"(c, control, s) {
            if (!s.world.opened || !s.roster.some(m => m.seatId === c.seatId && m.uid === c.payload.uid && m.gameName === c.payload.gameName)) throw new Error("本席没有放行授权");
            const until = deadline(s);
            while (true) {
                await openPanel(control, until);
                const seen = await stableMembers(s, control, until, c.worldUid, "确认后可加入");
                if (seen.stable && !seen.members.some(m => m.seatId === c.seatId)) {
                    lastAdmission = { command: c.messageId, time: ui.now() };
                    return { op: "seat-armed", payload: seen };
                }
            }
        },
        async observe(c, control, s) {
            const until = deadline(s);
            check(control, until);
            if (c.op !== "roster-update") {
                const uid = await ui.uid();
                check(control, until);
                if (uid !== c.worldUid) { lastAdmission = null; return uncertain(); }
                const mode = ui.permission();
                // Y 申请弹窗可遮住 F2 权限标签。仅在本席刚核实过现场时允许短暂遮挡。
                const recent = lastAdmission && lastAdmission.command === c.messageId && ui.now() - lastAdmission.time < 2500;
                const active = s.world.opened && s.roster.some(m => m.seatId === c.seatId) &&
                    (mode === "确认后可加入" || !mode && recent);
                if (mode && mode !== "确认后可加入") lastAdmission = null;
                if (ui.request(s.roster, active ? c.seatId : "") !== "none") return uncertain();
            }
            if (!ui.f2()) {
                ui.key("F2");
                await wait(control, until, 500);
            }
            const seen = await stableMembers(s, control, until, c.worldUid, "确认后可加入");
            lastAdmission = seen.stable && c.op !== "roster-update" ? { command: c.messageId, time: ui.now() } : null;
            return seen;
        },
        async "join-world"(c, control, s) {
            const until = deadline(s);
            if (ui.sign() !== 0) throw new Error("入场前未确认单人");
            await wait(control, until, 300);
            if (ui.sign() !== 0) throw new Error("单人状态不稳定");
            while (true) {
                await openPanel(control, until);
                let refreshedBaseline = ui.multipleResults() || Boolean(ui.emptySearch && ui.emptySearch());
                const before = !refreshedBaseline && ui.resultCard ? ui.resultCard() : null;
                if (!refreshedBaseline && before?.uid !== c.worldUid && ui.emptySearch) {
                    // 没有可区分的原始名片时，用不存在的 UID 搜索，只认可界面明确给出的空结果。
                    if (await search("000000000", control, until)) {
                        for (let i = 0; i < 5 && !refreshedBaseline; i++) {
                            await wait(control, until, 300);
                            refreshedBaseline = ui.emptySearch();
                        }
                    }
                }
                if (await search(c.worldUid, control, until)) {
                        let button = null;
                        const searchUntil = Math.min(ui.now() + 4500, until);
                        while (ui.now() < searchUntil) {
                            await wait(control, until, 300);
                            const candidate = ui.requestButton();
                            if (!candidate) continue;
                            const firstCard = ui.resultCard ? ui.resultCard() : null;
                            await wait(control, until, 300);
                            const verified = ui.requestButton();
                            const after = ui.resultCard ? ui.resultCard() : null;
                            const observed = [firstCard?.uid, after?.uid].filter(Boolean);
                            const target = observed.every(id => id === c.worldUid) &&
                                (refreshedBaseline || observed.length === 2);
                            if (verified && target && Math.abs(verified[0] - candidate[0]) < 4 && Math.abs(verified[1] - candidate[1]) < 4) {
                                button = verified;
                                break;
                            }
                        }
                        if (button) {
                            ui.click(...button);
                            const retryAt = Math.min(until, ui.now() + 12000);
                            while (ui.now() < retryAt) {
                                await wait(control, until, 350);
                                const position = ui.sign();
                                if (position >= 2 && position <= 4) return { op: "join-result", payload: { status: "joined", fromSingle: true, position } };
                            }
                        }
                }
                if (ui.f2()) ui.key("VK_ESCAPE");
                await wait(control, until, 600);
                const position = ui.sign();
                if (position >= 2 && position <= 4) throw new Error("申请状态不明，需要小号与服务端复核");
            }
        },
        async "leave-world"(c, control, s) {
            const until = deadline(s);
            while (true) {
                check(control, until);
                const pos = ui.sign();
                if (pos === 0) {
                    await wait(control, until, 400);
                    if (ui.sign() === 0) return { op: "seat-left", payload: { single: true } };
                } else if (ui.f2()) {
                    if (!ui.pressNamed("leaveTeam")) ui.key("VK_ESCAPE");
                } else if (pos >= 2 && pos <= 4) ui.key("F2");
                else if (pos === 1) throw new Error("本机是房主，无法确认预期退场");
                await wait(control, until, 600);
            }
        },
        async "check-clear"(c, control, s) {
            s.world.opened = false;
            const until = deadline(s);
            await targetPanel(c.worldUid, control, until);
            await permission("不允许加入", control, until);
            while (true) {
                await openPanel(control, until);
                const seen = await stableMembers(s, control, until, c.worldUid, "不允许加入");
                if (seen.stable && !seen.members.length && ui.permission() === "不允许加入") {
                    s.world.cleared = true;
                    return { op: "world-cleared", payload: { stable: true, memberCount: 0 } };
                }
            }
        },
        async recover(c, control, s) {
            const until = deadline(s);
            if (c.op === "leave-world" && ui.sign() === 0) {
                await wait(control, until, 450);
                if (ui.sign() === 0) return { op: "seat-left", payload: { single: true } };
            }
            if (c.op === "check-clear" && ui.f2() && ui.permission() === "不允许加入" &&
                await ui.uid() === c.worldUid) {
                const seen = await stableMembers(s, control, until, c.worldUid, "不允许加入");
                if (seen.stable && !seen.members.length && await ui.uid() === c.worldUid && ui.permission() === "不允许加入") {
                    s.world.cleared = true;
                    return { op: "world-cleared", payload: { stable: true, memberCount: 0 } };
                }
            }
            return null;
        },
        permission
    };
}

// 每一项完整路线只接受一次客户端授权。传送、辅助追踪与战斗共享总截止时间。
function createRouteActions(env) {
    let pickupEnabled = false;
    function near(end, point) {
        return point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
            Math.hypot(point.x - end[0], point.y - end[1]) <= 55;
    }
    return {
        enablePickup() {
            if (!pickupEnabled) { env.autoPick(); pickupEnabled = true; }
        },
        async "run-route"(cmd, control, session) {
            const ids = env.routes.packs[env.pack];
            if (!Array.isArray(ids)) throw new Error("所选路线包不存在");
            if (!ids.length) return { op: "route-result", payload: { status: "empty" } };
            const route = env.routes.routes[ids[cmd.routeSeq - 1]];
            if (!route) throw new Error("指定路线序号超出路线包范围");
            if (![2, 3, 4].includes(env.sign())) throw new Error("执行路线前未确认客人席位");
            const seconds = Number(cmd.payload.timeoutSeconds || session.timeoutSeconds || 120);
            const until = env.now() + seconds * 1000;
            function localCancel(reason) {
                control.canceled = true;
                const error = new Error(reason);
                error.localCancel = true;
                throw error;
            }
            function check() {
                if (control.canceled || env.now() >= until) {
                    localCancel("本条路线已取消或超时");
                }
            }
            let evidence = false;
            let prevReward;
            async function observeReward() {
                const label = env.reward();
                if (label && label !== prevReward) {
                    const pos = await env.position(route.map);
                    if (near(route.end, pos)) evidence = true;
                }
                prevReward = label;
            }
            async function track(path, observe) {
                check();
                const cts = env.newCTS();
                control.cts = cts;
                let running = true, observer;
                try {
                    cts.CancelAfter(Math.max(1, until - env.now()));
                    if (observe) {
                        prevReward = env.reward();
                        observer = (async () => {
                            while (running && !control.canceled) {
                                await env.wait(550);
                                if (running && !control.canceled) {
                                    try { await observeReward(); } catch { /* 画面切换期间无有效证据 */ }
                                }
                            }
                        })().catch(() => {});
                    }
                    const status = await env.runFile(path, cts.Token);
                    if (status === "canceled") localCancel("本次地图追踪已局部取消");
                    if (status !== "finished") throw new Error("BetterGI 未返回预期的单次追踪结果");
                    check();
                } finally {
                    running = false;
                    control.cts = null;
                    cts.Dispose();
                    if (observer) await observer;
                }
            }
            try {
                check();
                if (route.tp) { await env.teleport(...route.tp); check(); }
                if (env.needFurina()) await track(env.routes.furina, false);
                await track(route.file, true);
                let stable = 0;
                const verifyUntil = Math.min(until, env.now() + 7000);
                while (env.now() < verifyUntil) {
                    check();
                    await observeReward();
                    check();
                    const pos = await env.position(route.map);
                    const clear = near(route.end, pos) && [2, 3, 4].includes(env.sign()) && !env.enemyVisible();
                    stable = clear ? stable + 1 : 0;
                    if (stable >= 2) {
                        const isLast = cmd.routeSeq === ids.length;
                        return { op: "route-result", payload: evidence
                            ? { status: "success", evidence: "reward", isLast }
                            : { status: "await-team", isLast } };
                    }
                    await env.wait(450);
                }
                check();
                throw new Error("未能同时确认终点、客人席位和脱离战斗");
            } catch (error) {
                try { await env.checkGlobal(); } catch {
                    const stop = new Error("BetterGI 全局任务已停止");
                    stop.globalStop = true;
                    throw stop;
                }
                throw error;
            }
        }
    };
}
function createRouteEnvironment(ui) {
    function readLines(rect) {
        const frame = captureGameRegion();
        try { return Array.from(frame.findMulti(RecognitionObject.Ocr(...rect)), item => String(item.text || "").trim()); }
        finally { frame.dispose(); }
    }
    return {
        routes: JSON.parse(file.ReadTextSync("routes/catalog.json")), pack: settings.routePack || "传奇三线",
        now: Date.now, wait: ms => sleep(ms), sign: ui.sign,
        position: async map => {
            const point = await genshin.getPositionFromMap(map, 0);
            if (!point) return null;
            return { x: Number(point.X ?? point.x), y: Number(point.Y ?? point.y) };
        },
        reward: () => {
            const lines = readLines([20, 325, 650, 540]).join("").replace(/\s/g, "");
            const match = /角色经验[×xX·:+：＊*]?\d+/.exec(lines);
            return match ? match[0] : "";
        },
        enemyVisible: () => readLines([265, 65, 1270, 720]).some(line => /(?:Lv\.?|等级)\s*\d+/i.test(line)),
        teleport: (x, y, map) => genshin.tp(x, y, map || "Teyvat", true),
        needFurina: () => Boolean(ui.picture("assets/界面/白芙图标.png", [1634, 967, 116, 103])),
        newCTS: () => new CancellationTokenSource(), runFile: (path, token) => pathingScript.runFile(path, token),
        checkGlobal: () => sleep(1),
        autoPick: () => dispatcher.addTimer(new RealtimeTimer("AutoPick"))
    };
}

async function startLaicai() {
    const role = settings.role || "big";
    setGameMetrics(1920, 1080, 1);
    if (role === "host" && !file.CreateDirectory("account")) throw new Error("无法创建本机账号目录");
    const ui = worldUI(createGameUI());
    const actions = createWorldActions(ui);
    if (role === "big") {
        const routes = createRouteActions(createRouteEnvironment(ui));
        routes.enablePickup();
        actions["run-route"] = routes["run-route"];
    }
    actions["prepare-world"] = async (command, control) => {
        const result = await prepareWorld(command, control, ui);
        await actions.permission("不允许加入", control, ui.now() + 15000);
        return result;
    };
    const worker = createExecutor({ role, file, actions });
    while (!worker.stopped) {
        worker.poll();
        await sleep(250);
    }
}
if (typeof module !== "undefined" && module.exports) module.exports = { createExecutor, prepareWorld, createWorldActions, createRouteActions, identifyMember, coopPanelVisible, LAICAI_VERSION };
else (async () => { await startLaicai(); })();
