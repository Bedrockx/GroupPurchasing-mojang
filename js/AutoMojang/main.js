(async function () {
    // 读取配置
    const commandType = settings.commandType || "自动上线";
    const param1 = settings.param1 || "";
    const param2 = settings.param2 || "";
    const param3 = settings.param3 || "";
    const param4 = settings.param4 || false;
    
    let commandData = {
        "mojiang-command": true
    };
    
    switch (commandType) {
        case "自动上线":
            commandData.command = "online";
            commandData.params = {
                "username": param1,  // 游戏名称
                "uid": param2,       // uid
                "room": param3,      // 目标房间
                "notHost": param4    // 是否不当房主
            };
            break;
            
        case "启动一条龙":
            commandData.command = "start-dragon";
            commandData.params = {
                "dragonName": param1  // dragonName
            };
            break;
            
        case "向服务端发送信息":
            commandData.command = "send-message";
            commandData.params = {
                "content": param1  // 消息内容
            };
            break;
            
        case "关闭进程":
            commandData.command = "close-process";
            commandData.params = {
                "process": param1  // 进程类型（BGI/原神/mojang）
            };
            break;
    }
    
    // 转换为JSON字符串
    const jsonString = JSON.stringify(commandData, null, 2);
    
    // 写入文件
    try {
        file.WriteTextSync('command.json', jsonString);
        log.info(`成功生成命令文件: command.json`);
        log.info(`命令类型: ${commandType}`);
        log.info(`生成的命令内容: ${jsonString}`);
    } catch (error) {
        log.error(`写入命令文件失败: ${error.message}`);
    }
}())