(async function () {
    // 读取路线偏好（多选，参考 !ocrBackpack 的 multi-checkbox 用法）
    const routePreferences = Array.isArray(settings.routePreferences) ? settings.routePreferences : ['全选'];

    // 战斗配队名称
    const combatTeamName = (settings.combatTeamName || '').trim();

    // 采集配队：依次解析 1/2/3 的名称与角色（中文逗号分隔）
    const collectTeams = [];
    for (let i = 1; i <= 3; i++) {
        const name = (settings['collectTeam' + i + 'Name'] || '').trim();
        const charsRaw = (settings['collectTeam' + i + 'Chars'] || '').trim();
        const characters = charsRaw ? charsRaw.split(/[，,]/).map(s => s.trim()).filter(Boolean) : [];
        collectTeams.push({ name, characters });
    }

    const commandData = {
        "mojiang-command": true,
        "command": "route-test-apply",
        "params": {
            "routePreferences": routePreferences,
            "combatTeamName": combatTeamName,
            "collectTeams": collectTeams
        }
    };

    const jsonString = JSON.stringify(commandData, null, 2);

    try {
        file.WriteTextSync('command.json', jsonString);
        log.info('成功生成命令文件: command.json');
        log.info('申请路线测试 | 路线偏好: ' + routePreferences.join('、') + ' | 战斗配队: ' + (combatTeamName || '未填写'));
        collectTeams.forEach((team, index) => {
            if (team.name || team.characters.length > 0) {
                log.info(`采集配队${index + 1}: ${team.name || '未命名'} (${team.characters.join('，') || '无角色'})`);
            }
        });
    } catch (error) {
        log.error(`写入命令文件失败: ${error.message}`);
    }
}())
