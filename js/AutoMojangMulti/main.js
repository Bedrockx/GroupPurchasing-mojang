(async function () {
    const gameName = (settings.gameName || "").trim();
    const uid = (settings.uid || "").trim();

    if (!gameName || !uid) {
        log.error(`游戏名称或UID为空，请检查配置`);
        return;
    }

    // ==================== 允许上线的时间段判断 ====================
    // 复用 BetterGI「锄地一条龙」timeRule 的时间语法，但语义为【允许】上线：
    //   - 多项用中/英文逗号分隔，取并集，如：8-11，19:30-22:00
    //   - 只写小时：8 表示 8:00 整起 9:00 前；8-11 表示 8:00 整起 12:00 前
    //   - 含分钟则精确到分钟；跨天自动识别，如 22:00-01:30
    //   - 留空或没有任何有效时段 = 不限制
    // （比较方式与 AutoHoeing 的 isTimeRestricted 保持一致：end 为开区间边界）

    // 把单个时间取整：含冒号按实际时分，否则 end 取下个整点（对齐 AutoHoeing 的 parseTime）。
    // 返回 { h, m } 或 null（解析失败）
    function parseClockFragment(str, isEnd) {
        const raw = (str || "").trim();
        if (raw.includes(':')) {
            const [h, m] = raw.split(':').map(Number);
            if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                return { h, m };
            }
            return null;
        }
        // 无冒号：仅小时。起点 = 该时整点；终点 = 下个整点（当作开区间边界）
        const h = Number(raw);
        if (!Number.isInteger(h) || h < 0 || h > 23) return null;
        return { h: isEnd ? h + 1 : h, m: 0 };
    }

    // 解析一个时段段，返回 { startTotal, endTotal }（endTotal 可能已加一天以表达跨天），无效返回 null
    function parseTimeWindow(seg) {
        let startStr, endStr;
        if (seg.includes('-')) {
            [startStr, endStr] = seg.split('-').map(s => s.trim());
        } else {
            // 单个值：起点与终点相同（如 8 → 8:00~9:00 前）
            startStr = endStr = seg;
        }
        const startClock = parseClockFragment(startStr, false);
        const endClock = parseClockFragment(endStr, true);
        if (!startClock || !endClock) return null;
        let startTotal = startClock.h * 60 + startClock.m;
        let endTotal = endClock.h * 60 + endClock.m;
        if (endTotal <= startTotal) endTotal += 24 * 60; // 跨天：wrap 到次日
        return { startTotal, endTotal };
    }

    // 当前本地时分（用分钟表示）是否落在任一被允许时段内；返回 { inWindow, hasValid }
    function nowAllowed(rawRule) {
        const now = new Date();
        const currentTotal = now.getHours() * 60 + now.getMinutes();
        let hasValid = false;
        const clean = (rawRule || "").trim()
            .replace(/，/g, ',')
            .replace(/：/g, ':');
        for (const rawSeg of clean.split(',')) {
            const seg = rawSeg.trim();
            if (!seg) continue;
            const win = parseTimeWindow(seg);
            if (!win) {
                log.info(`忽略无效的允许时段: ${seg}`);
                continue;
            }
            hasValid = true;
            const inFirstDay = currentTotal >= win.startTotal && currentTotal < win.endTotal;
            const inWrapped = currentTotal + 24 * 60 >= win.startTotal && currentTotal + 24 * 60 < win.endTotal;
            if (inFirstDay || inWrapped) return { inWindow: true, hasValid };
        }
        return { inWindow: false, hasValid };
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowTimeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const timeCheck = nowAllowed(settings.allowedHours);
    const allowedNow = timeCheck.hasValid ? timeCheck.inWindow : true;

    if (!allowedNow) {
        // 当前不在允许上线的时间段：改为启动一条龙
        const dragonName = (settings.offHourDragonName || "").trim();
        if (!dragonName) {
            log.error(`当前时间 ${nowTimeStr} 不在允许上线时间段内，且未配置启动的一条龙名称`);
            return;
        }
        const commandData = {
            "mojiang-command": true,
            "command": "start-dragon",
            "params": {
                "dragonName": dragonName
            }
        };
        const jsonString = JSON.stringify(commandData, null, 2);
        try {
            file.WriteTextSync('command.json', jsonString);
            log.info(`当前时间 ${nowTimeStr} 不在允许上线时间段内，改为启动一条龙: ${dragonName}`);
            log.info(`成功生成命令文件: command.json`);
        } catch (error) {
            log.error(`写入命令文件失败: ${error.message}`);
        }
        return;
    }

    if (timeCheck.hasValid) {
        log.info(`当前时间 ${nowTimeStr} 在允许上线时间段内`);
    } else {
        log.info(`未限制上线时间段，当前时间 ${nowTimeStr} 可上线`);
    }

    // 收集所有非空的目标房间
    const rooms = [];
    for (let i = 1; i <= 10; i++) {
        const room = (settings[`room${i}`] || "").trim();
        if (room) {
            rooms.push(room);
        }
    }

    if (rooms.length === 0) {
        log.error(`未配置任何目标房间，请检查配置`);
        return;
    }

    log.info(`游戏名称: ${gameName}, UID: ${uid}`);
    log.info(`目标房间 (${rooms.length}个): ${rooms.join(', ')}`);

    // 构建多指令命令数据
    const commandData = {
        "mojiang-command": true
    };

    rooms.forEach((room, index) => {
        const cmdField = index === 0 ? 'command' : `command${'*'.repeat(index)}`;
        const paramsField = index === 0 ? 'params' : `params${'*'.repeat(index)}`;

        commandData[cmdField] = "online";
        commandData[paramsField] = {
            "username": gameName,
            "uid": uid,
            "room": room,
            "notHost": true
        };
    });

    // 转换为JSON字符串
    const jsonString = JSON.stringify(commandData, null, 2);

    // 写入文件
    try {
        file.WriteTextSync('command.json', jsonString);
        log.info(`成功生成命令文件: command.json`);
        log.info(`生成的指令数: ${rooms.length}`);
    } catch (error) {
        log.error(`写入命令文件失败: ${error.message}`);
    }
}())
