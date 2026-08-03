(async function () {
    const gameName = (settings.gameName || "").trim();
    const uid = (settings.uid || "").trim();

    if (!gameName || !uid) {
        log.error(`游戏名称或UID为空，请检查配置`);
        return;
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
