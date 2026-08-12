// 主逻辑
let numberRos;
let scrollScale = 10;     // 材料识别：滚动倍率，在 !settings.doTest 内从 settings 加载
let delayScale = 1;       // 材料识别：延迟倍率
let delay1 = 50;          // 材料识别：短延-时
let delay2 = 150;         // 材料识别：中延迟
let delay3 = 1000;        // 材料识别：长延迟
const gameRegionManager = {
    newGameRegion: null,
    oldGameRegion: null,
    lastCapture: new Date(),
    isDisposing: false,
    isCapturing: false
};
(async function () {
    const numberRegion = {
        x: 865,
        y: 980,
        width: 150,
        height: 50
    };
    numberRos = await buildTextRos('assets/怪物图鉴数字', numberRegion, [0.9, 0.8]);

    const name1 = "单路线测试";
    const duration1 = 1234; // 1.234 秒
    await fakeLog(name1, true, false, duration1);

    if (settings.activatePickup) {
        dispatcher.addTimer(new RealtimeTimer("AutoPick"));
    }

    const pathingFolderPath = "pathing";
    const resultFolderPath = "records";
    const fileInfo = file.readTextSync("assets/info.json");
    const infoData = JSON.parse(fileInfo);

    if (!settings.doTest) {
        // ============ 单路线模式：读取指定路线 ============
        const routeFileName = (settings.routeFileName || '').trim();
        if (!routeFileName) {
            log.error('未配置 routeFileName，单路线测试无法运行');
            return;
        }
        const routeFullPath = pathingFolderPath + '/' + routeFileName;
        let route;
        try {
            route = JSON.parse(file.readTextSync(routeFullPath));
        } catch (e) {
            log.error(`读取路线文件失败 ${routeFullPath}: ${e.message}`);
            return;
        }
        route.fullPath = routeFullPath;
        log.info(`单路线测试：${routeFullPath}`);

        let materialBefore = null;
        let materialAfter = null;

        async function scanBackpackMaterials() {
            const starCounts = await scanBackpackOriginal();
            const flat = {};
            for (const counts of Object.values(starCounts)) {
                Object.assign(flat, counts);
            }
            return flat;
        }

        const startTime = new Date();
        const formattedStartTime = startTime.toISOString().replace(/[^0-9]/g, '');
        const recordFileName = `${formattedStartTime}.json`;
        const recordFilePath = resultFolderPath + '/' + recordFileName;

        let MonsterInfo = null;
        if (settings.statisticsMode !== "识别材料") {
            MonsterInfo = await getMonsterCounts();
        }
        let routeTime = new Date();

        // 时间限制检查
        if (await isTimeRestricted(settings.timeRule, 10)) {
            log.warn("因时间限制终止脚本");
            return;
        }

        await genshin.tpToStatueOfTheSeven();
        if (settings.underwater) {
            await pathingScript.runFile("assets/学习螃蟹技能.json");
        }

        route.expectMora = 0;
        route.eliteNum = 0;
        route.normalNum = 0;

        const duration2 = 0;
        await fakeLog(route.fullPath, false, true, duration2);
        routeTime = new Date();
        log.info(`开始运行单路线：${route.fullPath}`);

        if (settings.statisticsMode === "识别材料") {
            materialBefore = await scanBackpackMaterials();
            log.info(`材料扫描（跑图前）完成，共 ${Object.keys(materialBefore).length} 种`);
        }

        await pathingScript.runFile(route.fullPath);

        const newDate = new Date();
        const timeDiffInSeconds = (newDate - routeTime) / 1000;
        route.routeTime = timeDiffInSeconds;

        const duration3 = 5000;
        await fakeLog(route.fullPath, false, false, duration3);

        try { await sleep(10); } catch (error) { log.error(`运行中断: ${error}`); return; }
        await genshin.returnMainUi();
        await sleep(2000);

        if (settings.statisticsMode === "识别材料") {
            materialAfter = await scanBackpackMaterials();
            const itemDiff = {};
            for (const [name, count] of Object.entries(materialAfter)) {
                const beforeCount = materialBefore[name] || 0;
                const diff = count - beforeCount;
                if (diff > 0) itemDiff[name] = diff;
            }
            route.itemNum = itemDiff;
            log.info(`材料变化：${JSON.stringify(itemDiff)}`);
        }

        if (settings.statisticsMode !== "识别材料") {
            const currentMonsterInfo = await getMonsterCounts();
            const monsterDifferences = {};
            for (const monster in currentMonsterInfo) {
                if (currentMonsterInfo[monster] !== MonsterInfo[monster] &&
                    currentMonsterInfo[monster] !== -1 &&
                    MonsterInfo[monster] !== -1) {
                    monsterDifferences[monster] = currentMonsterInfo[monster] - MonsterInfo[monster];
                }
            }
            route.monsterNum = monsterDifferences;
            MonsterInfo = currentMonsterInfo;
        }

        if (settings.statisticsMode !== "识别材料") {
            for (const [monsterName, count] of Object.entries(route.monsterNum)) {
                const monsterInfo = infoData.find(item => item.name === monsterName);
                if (monsterInfo) {
                    if (monsterInfo.type === "普通") {
                        route.normalNum += count;
                        route.expectMora += count * monsterInfo.moraRate * 40.5;
                    } else if (monsterInfo.type === "精英") {
                        route.eliteNum += count;
                        route.expectMora += count * monsterInfo.moraRate * 200;
                    }
                }
            }
        }

        log.info(`单路线测试完成：用时 ${route.routeTime}s，普通怪 ${route.normalNum}，精英怪 ${route.eliteNum}，预期摩拉 ${route.expectMora}`);

        // 写 command.json 上报结果给莫酱妙妙屋客户端
        const commandResult = {
            "mojiang-command": true,
            "command": "route-test-result",
            "params": {
                "taskId": settings.taskId || "",
                "routeFileName": routeFileName,
                "routeTime": Math.round(route.routeTime),
                "expectMora": Math.round(route.expectMora),
                "normalNum": route.normalNum,
                "eliteNum": route.eliteNum,
                "monsterNum": route.monsterNum || {},
                "itemNum": route.itemNum || {}
            }
        };
        try {
            await file.writeText("command.json", JSON.stringify(commandResult));
            log.info(`已写入 command.json: ${JSON.stringify(commandResult)}`);
        } catch (error) {
            log.error(`写入 command.json 失败: ${error.message}`);
        }

        // 本地记录留存
        const recordContent = JSON.stringify(route, null, 2);
        try {
            await file.writeText(recordFilePath, recordContent);
            log.info(`记录文件已写入 ${recordFilePath}`);
        } catch (error) {
            log.error(`写入记录文件失败: ${error.message}`);
        }
    } else {
        log.info("doTest 设置为 false，读取 records 文件夹中的文件");

        const routes = await readFolder(pathingFolderPath, "json");
        log.info(`找到 ${routes.length} 个路径文件`);
        const records = await readFolder("records", "json");
        log.info(`找到 ${records.length} 个记录文件`);

        const recordMap = {}; // 🔥 文件名匹配

        for (const record of records) {
            log.info(`处理文件：${record.fullPath}`);
            try {
                const fileContent = file.readTextSync(record.fullPath);
                const jsonData = JSON.parse(fileContent);
                const filtered = jsonData.filter(r => {
                    if (r.routeTime < 10) {
                        log.warn(`过滤异常记录: ${r.fullPath} | 用时=${r.routeTime}s（<10s）`);
                        return false;
                    }
                    const isMaterialMode = settings.statisticsMode === "识别材料";
                    // 材料模式：itemNum 过滤；怪物模式：monsterNum 过滤
                    const checkField = isMaterialMode ? 'itemNum' : 'monsterNum';
                    if (!r[checkField] || typeof r[checkField] !== 'object' || Object.keys(r[checkField]).length === 0) {
                        log.warn(`过滤无${isMaterialMode ? '材料' : '怪物'}记录: ${r.fullPath} | ${checkField} 为空或不存在`);
                        return false;
                    }
                    // 检查数量是否合法（材料容差大，怪物容差小）
                    const maxVal = isMaterialMode ? 999 : 50;
                    for (const [k, v] of Object.entries(r[checkField])) {
                        if (typeof v !== 'number' || v < 0 || v > maxVal) {
                            log.warn(`修正异常数量: ${r.fullPath} | ${k}: ${v} → 0`);
                            r[checkField][k] = 0;
                        }
                    }
                    // 检查是否全零
                    const nums = Object.values(r[checkField]);
                    if (nums.every(c => c === 0)) {
                        log.warn(`过滤全零记录: ${r.fullPath}`);
                        return false;
                    }
                    return true;
                });

                if (Array.isArray(filtered)) {
                    for (const entry of filtered) {
                        const fileName = entry.fullPath.split('\\').pop(); // 🔥 文件名匹配
                        if (!fileName) {
                            log.warn(`fileName 为空，跳过该记录`);
                            continue;
                        }
                        if (!recordMap[fileName]) recordMap[fileName] = []; // 🔥 文件名匹配
                        recordMap[fileName].push({
                            fullPath: entry.fullPath,
                            fileName, // 🔥 文件名匹配
                            monsterNum: entry.monsterNum,
                            itemNum: entry.itemNum || {},
                            moraDiff: entry.moraDiff,
                            routeTime: entry.routeTime,
                            expectMora: entry.expectMora,
                            normalNum: entry.normalNum,
                            eliteNum: entry.eliteNum
                        });
                        if (recordMap[fileName].length > 7) recordMap[fileName].shift(); // 🔥 文件名匹配
                    }
                } else {
                    log.warn(`文件 ${record.fileName} 的内容不是数组，跳过该文件`);
                }
            } catch (error) {
                log.error(`读取或解析文件 ${record.fileName} 时出错：${error.message}`);
            }
        }

        const finalRecords = [];
        for (const fileName in recordMap) { // 🔥 文件名匹配
            const records = recordMap[fileName]; // 🔥 文件名匹配
            const fields = ["routeTime"];
            const processedRecord = { fileName, records: {} }; // 🔥 文件名匹配

            // =================  1. routeTime：只认 >10 秒  =================
            {
                const values = records
                    .map(r => r.routeTime)
                    .filter(v => typeof v === 'number' && v > 10);   // 🔥 只要 >10 秒
                if (values.length === 0) {
                    processedRecord.records.routeTime = 0;
                } else {
                    values.sort((a, b) => a - b);
                    const mid = Math.floor(values.length / 2);
                    const median = values.length % 2 === 0
                        ? (values[mid - 1] + values[mid]) / 2
                        : values[mid];
                    processedRecord.records.routeTime = Math.ceil(median);
                }
            }

            // =================  2. monsterNum：仅怪物模式  =================
            if (settings.statisticsMode !== "识别材料") {
                processedRecord.records.monsterNum = {};

                // 所有出现过的怪物名
                const allMonsters = [...new Set(records.flatMap(r => Object.keys(r.monsterNum || {})))];

                allMonsters.forEach(monster => {
                    // 逐条采样：没写就按 0 算
                    const values = records
                        .map(r => {
                            const v = r.monsterNum?.[monster];   // 可能为 undefined
                            const num = typeof v === 'number' ? v : 0; // 没写→0
                            return num >= 0 && num <= 40 ? num : NaN;  // 超界当 NaN 扔
                        })
                        .filter(v => !isNaN(v))                 // 只保留 0-40 的采样
                        .sort((a, b) => a - b);

                    if (values.length === 0) return;          // 全部超界才真的跳过
                    const mid = Math.floor(values.length / 2);
                    const median = values.length % 2 === 0
                        ? (values[mid - 1] + values[mid]) / 2
                        : values[mid];

                    // 中位数>0 才写，向上取整
                    if (median > 0) processedRecord.records.monsterNum[monster] = Math.ceil(median);
                });

                processedRecord.records.normalNum = 0;
                processedRecord.records.eliteNum = 0;
                processedRecord.records.expectMora = 0;
                for (const [monsterName, count] of Object.entries(processedRecord.records.monsterNum)) {
                    const monsterInfo = infoData.find(item => item.name === monsterName);
                    if (monsterInfo) {
                        if (monsterInfo.type === "普通") {
                            processedRecord.records.normalNum += count;
                            processedRecord.records.expectMora += count * monsterInfo.moraRate * 40.5;
                        } else if (monsterInfo.type === "精英") {
                            processedRecord.records.eliteNum += count;
                            processedRecord.records.expectMora += count * monsterInfo.moraRate * 200;
                        }
                    }
                }
            }
            // =================  2b. itemNum（材料）：仅材料模式  =================
            if (settings.statisticsMode === "识别材料") {
                processedRecord.records.itemNum = {};
                const allItems = [...new Set(records.flatMap(r => Object.keys(r.itemNum || {})))];
                allItems.forEach(item => {
                    const values = records
                        .map(r => {
                            const v = r.itemNum?.[item];
                            return typeof v === 'number' && v >= 0 && v <= 999 ? v : NaN;
                        })
                        .filter(v => !isNaN(v))
                        .sort((a, b) => a - b);
                    if (values.length === 0) return;
                    const mid = Math.floor(values.length / 2);
                    const median = values.length % 2 === 0
                        ? (values[mid - 1] + values[mid]) / 2
                        : values[mid];
                    if (median > 0) processedRecord.records.itemNum[item] = Math.ceil(median);
                });
            }

            finalRecords.push(processedRecord);
        }

        let matchedCount = 0;
        let unmatchedCount = 0;
        for (const { fileName, records } of finalRecords) { // 🔥 文件名匹配
            const route = routes.find(r => r.fileName === fileName); // 🔥 文件名匹配
            if (!route) {
                log.warn(`未找到文件名对应的路线: ${fileName}`); // 🔥 文件名匹配
                unmatchedCount++;
                continue;
            }
            const fileContent = file.readTextSync(route.fullPath);
            const jsonData = JSON.parse(fileContent);
            const { routeTime, expectMora, normalNum, eliteNum, monsterNum, itemNum } = records;
            const refCount = recordMap[fileName] ? recordMap[fileName].length : 0; // 🔥 文件名匹配

            let newDescription;
            if (settings.statisticsMode === "识别材料") {
                // 材料模式：生成【】格式
                const itemParts = Object.entries(itemNum).map(([name, count]) => `${name}*${count}`);
                const declaration = itemParts.length > 0 ? `【用时${routeTime}秒，${itemParts.join('，')}】` : '';
                newDescription = `  路线信息${declaration}`;
            } else {
                // 怪物模式：沿用现有逻辑
                const monsterDescription = Object.entries(monsterNum)
                    .map(([m, c]) => `${c}只${m}`)
                    .join('、');
                if (eliteNum === 0 && normalNum === 0) {
                    newDescription = `  路线信息：该路线预计用时${routeTime}秒，该路线不含任何精英或小怪。`;
                } else {
                    newDescription = `  路线信息：该路线预计用时${routeTime}秒，包含以下怪物：${monsterDescription}。`;
                }
            }
            jsonData.info.description = `${newDescription}`;
            const targetFolder = refCount >= 3 ? 'pathingOut' : 'pathingToCheck';
            const modifiedFullPath = route.fullPath.replace('pathing', targetFolder);
            await file.writeTextSync(modifiedFullPath, JSON.stringify(jsonData, null, 2));
            log.info(`文件 ${route.fullPath} 的 description 已更新，本次共参考 ${refCount} 份历史记录`);
            if (refCount < 3) log.warn('参考记录少于 3 份，可信度较低，输出到 pathingToCheck 目录');
            matchedCount++;
        }
        log.info(`总路径文件数：${routes.length}`);
        log.info(`成功匹配并修改的文件数：${matchedCount}`);
        log.info(`未匹配的记录数：${unmatchedCount}`);
    }

    const duration4 = 0;
    await fakeLog(name1, true, true, duration4);
})();


/**
 * 递归读取目录下所有文件
 * @param {string} folderPath 起始目录
 * @param {string} [ext='']   需要的文件后缀，空字符串表示不限制；例如 'json' 或 '.json' 均可
 * @returns {Array<{fullPath:string, fileName:string, folderPathArray:string[]}>}
 */
async function readFolder(folderPath, ext = '') {
    // 统一后缀格式：确保前面有一个点，且全小写
    const targetExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase() : '';

    const folderStack = [folderPath];
    const files = [];

    while (folderStack.length > 0) {
        const currentPath = folderStack.pop();
        const filesInSubFolder = file.ReadPathSync(currentPath); // 同步读取当前目录
        const subFolders = [];

        for (const filePath of filesInSubFolder) {
            if (file.IsFolder(filePath)) {
                subFolders.push(filePath);          // 子目录稍后处理
            } else {
                // 后缀过滤
                if (targetExt) {
                    const fileExt = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
                    if (fileExt !== targetExt) continue;
                }

                const fileName = filePath.split('\\').pop();
                const folderPathArray = filePath.split('\\').slice(0, -1);
                files.push({ fullPath: filePath, fileName, folderPathArray });
            }
        }

        // 保持同层顺序，reverse 后仍按原顺序入栈
        folderStack.push(...subFolders.reverse());
    }

    return files;
}

/**
 * 通用找图/找RO并可选点击（支持单图片文件路径、单RO、图片文件路径数组、RO数组）
 * @param {string|string[]|RecognitionObject|RecognitionObject[]} target
 * @param {boolean}  [doClick=true]                是否点击
 * @param {number}   [timeout=3000]                识别时间上限（ms）
 * @param {number}   [interval=50]                 识别间隔（ms）
 * @param {number}   [retType=0]                   0-返回布尔；1-返回 Region 结果
 * @param {number}   [preClickDelay=50]            点击前等待
 * @param {number}   [postClickDelay=50]           点击后等待
 * @returns {boolean|Region}  根据 retType 返回是否成功或最终 Region
 */
async function findAndClick(target,
    doClick = true,
    timeout = 3000,
    interval = 50,
    retType = 0,
    preClickDelay = 50,
    postClickDelay = 50) {
    try {
        // 1. 统一转成 RecognitionObject 数组
        let ros = [];
        if (Array.isArray(target)) {
            ros = target.map(t =>
                (typeof t === 'string')
                    ? RecognitionObject.TemplateMatch(file.ReadImageMatSync(t))
                    : t
            );
        } else {
            ros = [(typeof target === 'string')
                ? RecognitionObject.TemplateMatch(file.ReadImageMatSync(target))
                : target];
        }

        const start = Date.now();
        let found = null;

        while (Date.now() - start <= timeout) {
            const gameRegion = await getGameRegion();
            try {
                // 依次尝试每一个 ro
                for (const ro of ros) {
                    const res = gameRegion.find(ro);
                    if (!res.isEmpty()) {          // 找到
                        found = res;
                        if (doClick) {
                            await sleep(preClickDelay);
                            res.click();
                            await sleep(postClickDelay);
                        }
                        break;                     // 成功即跳出 for
                    }
                }
                if (found) break;                  // 成功即跳出 while
            } finally {
            }
            await sleep(interval);                 // 没找到时等待
        }

        // 3. 按需返回
        return retType === 0 ? !!found : (found || null);

    } catch (error) {
        log.error(`执行通用识图时出现错误：${error.message}`);
        return retType === 0 ? false : null;
    }
}

async function getMonsterCounts() {

    let failcount = 0;
    /* 0. 读取怪物列表 */
    const raw = file.readTextSync('assets/info.json');
    const monsterList = JSON.parse(raw).map(it => it.name);
    const monsterCounts = {};

    /* 外层重试：最多 3 轮 */
    for (let round = 1; round <= 3; round++) {
        log.info(`===== 第 ${round} 轮获取怪物数量 =====`);

        /* 1. 外层循环：最多 3 次进入生物志 */
        let attempt = 0;
        while (attempt < 3) {
            attempt++;
            log.info(`第 ${attempt} 次尝试进入生物志`);
            await genshin.returnMainUi();
            keyPress('VK_ESCAPE');
            await sleep(1500);

            if (!(await findAndClick('assets/RecognitionObject/图鉴.png'))) continue;

            if (!(await findAndClick('assets/RecognitionObject/生物志.png'))) continue;

            click(1355, 532);
            await sleep(2000);
            break;
        }
        if (attempt >= 3) {
            log.error('连续 3 次无法进入生物志，脚本终止');
            await genshin.returnMainUi();
            return {};
        }
        // findAndClick 已提升到全局作用域（位于 getMonsterCounts 之前）

        async function scrollPage(totalDistance, stepDistance = 10, delayMs = 5) {
            moveMouseTo(400, 750); // 移动到屏幕水平中心，垂直750坐标
            await sleep(50);
            leftButtonDown();

            // 计算滚动方向和总步数
            const isDownward = totalDistance < 0; // 如果totalDistance为负数，则向下滑动
            const steps = Math.ceil(Math.abs(totalDistance) / stepDistance); // 使用绝对值计算步数

            for (let j = 0; j < steps; j++) {
                const remainingDistance = Math.abs(totalDistance) - j * stepDistance;
                const moveDistance = remainingDistance < stepDistance ? remainingDistance : stepDistance;

                // 根据滚动方向调整移动方向
                const direction = isDownward ? 1 : -1; // 向下滑动为正方向，向上滑动为负方向
                moveMouseBy(0, 1.2 * direction * moveDistance); // 根据方向调整滚动方向
                await sleep(delayMs);
            }

            await sleep(300);
            leftButtonUp();
            await sleep(600);
        }

        async function readKillCount(timeout = 500) {
            await sleep(50);
            const start = Date.now();

            while (Date.now() - start < timeout) {
                const countStr = await textTemplateMatch(numberRos);
                const count = Number(countStr);
                if (!isNaN(count) && count > 0) {
                    return { success: true, count };
                }
                await sleep(10);   // 短暂歇口气再试
            }

            return { success: false, count: -1 };
        }

        async function readKillCountStable(prevCount, sameTolerance = 5) {
            //log.info(`执行了一次readKillCountStable`)
            let lastCount = -1;
            for (let r = 0; r < sameTolerance; r++) {
                //log.info(`执行第${r}次ocr`)
                const ocrRet = await readKillCount();
                lastCount = ocrRet.count;

                if (lastCount !== prevCount) return { success: true, count: lastCount }; // 变了→成功
            }
            // 5 次仍相同→返回最后一次相同值
            return { success: true, count: lastCount };
        }


        async function findMonsterIcon(monsterId) {
            const roi = { x: 130, y: 80, w: 670, h: 970 };
            const thresholds = [0.8, 0.75];
            let tpl = null;

            for (let t = 0; t < 2; t++) {
                // 只在第一次加载模板，后面复用并改阈值
                if (!tpl) {
                    tpl = RecognitionObject.TemplateMatch(
                        file.readImageMatSync(`assets/monster/${monsterId.trim()}.png`),
                        roi.x, roi.y, roi.w, roi.h);
                }
                tpl.Threshold = thresholds[t];
                tpl.use3Channels = true;
                tpl.InitTemplate();

                let pageTurnsUp = 0;
                while (pageTurnsUp < 1) {
                    let pageTurns = 0;
                    while (pageTurns < 2) {
                        moveMouseTo(1332, 664);
                        await sleep(16);
                        if (await findAndClick(tpl, true, 300)) {
                            return true;
                        }
                        await scrollPage(320);
                        pageTurns++;
                    }
                    // 回滚
                    for (let j = 0; j < 2; j++) await scrollPage(-310);
                    pageTurnsUp++;
                }
            }

            return false;
        }

        /* ===== 主循环 ===== */
        let prevCount = -1;          // 上一轮 OCR 结果
        let retryMask = 0;           // 位掩码：第 i 位为 1 表示已回退过
        let prevFinalCount = -1;   // 上一只怪物的最终击杀数
        let continuousFail = 0;    // 连续 -1 计数器（新增）

        for (let i = 0; i < monsterList.length; i++) {
            const monsterId = monsterList[i];
            /* 1. 找怪 + OCR */
            if (!(await findMonsterIcon(monsterId))) {
                log.info(`怪物: ${monsterId.trim()}, 未找到图标`);
                failcount++;
                if (failcount >= 10) {
                    break;
                }
                monsterCounts[monsterId.trim()] = -1;
                prevCount = -1;                 // 重置
                continuousFail++;               // 新增
                if (continuousFail >= 7) {      // 新增
                    log.warn('连续 7 个怪物获取失败，中断本轮');
                    break;                      // 新增：中断本轮
                }
                continue;
            }
            const ocr = await readKillCountStable(prevFinalCount, 3);
            const count = ocr.success ? ocr.count : -1;
            /* 2. 结果相同且本行还没回退过 → 回退一次 */
            if (count === prevCount && !(retryMask & (1 << i))) {
                retryMask |= (1 << i);          // 标记已回退
                i--;                            // 回退同一 i 一次
                continue;
            }

            /* 3. 正常记录 */
            monsterCounts[monsterId.trim()] = count;
            log.info(`怪物: ${monsterId.trim()}, 数量: ${count}`);
            prevCount = count;
            prevFinalCount = count;   // 记录本次最终值，供下一只比对

            /* 新增：连续失败计数更新 */
            if (count === -1) {
                continuousFail++;
                if (continuousFail >= 7) {
                    log.warn('连续 7 个怪物获取失败，中断本轮');
                    break;
                }
            } else {
                continuousFail = 0;   // 成功就清零
            }
        }

        /* 本轮结束判定：如果中途没有因“7连失败”跳出，则认为成功 */
        if (continuousFail < 7) {
            log.info('所有怪物数量获取完成');
            return monsterCounts;
        }
        continuousFail = 0;
        /* 否则 continuousFail >=7，自动进入下一轮重试 */
    }

    /* 3 轮都失败 */
    log.error('3 轮重试后仍连续 7 次失败，放弃获取');
    return monsterCounts;
}

// 定义 mora 函数
async function mora() {
    // 定义所有图标的图像识别对象，每个图片都有自己的识别区域
    let CharacterMenuRo = RecognitionObject.TemplateMatch(file.ReadImageMatSync("assets/CharacterMenu.png"), 60, 991, 38, 38);

    // 定义一个函数用于识别图像
    async function recognizeImage(recognitionObject, timeout = 5000) {
        log.info(`开始图像识别，超时时间: ${timeout}ms`);
        let startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                // 尝试识别图像
                let imageResult = (await getGameRegion()).find(recognitionObject);
                if (imageResult) {
                    log.info(`成功识别图像，坐标: x=${imageResult.x}, y=${imageResult.y}`);
                    return { success: true, x: imageResult.x, y: imageResult.y };
                }
            } catch (error) {
                log.error(`识别图像时发生异常: ${error.message}`);
            }
            await sleep(500); // 短暂延迟，避免过快循环
        }
        log.warn(`经过多次尝试，仍然无法识别图像`);
        return { success: false };
    }

    // 定义一个函数用于识别文字并点击
    async function recognizeTextAndClick(targetText, ocrRegion, timeout = 5000) {
        log.info(`开始文字识别，目标文本: ${targetText}，区域: x=${ocrRegion.x}, y=${ocrRegion.y}, width=${ocrRegion.width}, height=${ocrRegion.height}`);
        let startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                // 尝试 OCR 识别
                let resList = (await getGameRegion()).findMulti(RecognitionObject.ocr(ocrRegion.x, ocrRegion.y, ocrRegion.width, ocrRegion.height)); // 指定识别区域
                // 遍历识别结果，检查是否找到目标文本
                for (let res of resList) {
                    // 后处理：根据替换映射表检查和替换错误识别的字符
                    let correctedText = res.text;

                    if (correctedText.includes(targetText)) {
                        // 如果找到目标文本，计算并点击文字的中心坐标
                        let centerX = res.x + res.width / 2;
                        let centerY = res.y + res.height / 2;
                        log.info(`识别到目标文本: ${correctedText}，点击坐标: x=${centerX}, y=${centerY}`);
                        await click(centerX, centerY);
                        await sleep(500); // 确保点击后有足够的时间等待
                        return { success: true, x: centerX, y: centerY };
                    }
                }
            } catch (error) {
                log.warn(`页面标志识别失败，正在进行重试... 错误信息: ${error.message}`);
            }
            await sleep(1000); // 短暂延迟，避免过快循环
        }
        log.warn(`经过多次尝试，仍然无法识别文字: ${targetText}`);
        return { success: false };
    }

    // 定义一个独立的函数用于在指定区域进行 OCR 识别并输出识别内容
    async function recognizeTextInRegion(ocrRegion, timeout = 5000) {
        log.info(`开始 OCR 识别，区域: x=${ocrRegion.x}, y=${ocrRegion.y}, width=${ocrRegion.width}, height=${ocrRegion.height}`);
        let startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                // 在指定区域进行 OCR 识别
                let ocrResult = (await getGameRegion()).find(RecognitionObject.ocr(ocrRegion.x, ocrRegion.y, ocrRegion.width, ocrRegion.height));
                if (ocrResult) {
                    log.info(`OCR 识别成功，原始文本: ${ocrResult.text}`);
                    // 后处理：根据替换映射表检查和替换错误识别的字符
                    let correctedText = ocrResult.text;
                    log.info(`修正后文本: ${correctedText}`);
                    return correctedText; // 返回识别到的内容
                } else {
                    log.warn(`OCR 识别区域未找到内容`);
                    return null; // 如果 OCR 未识别到内容，返回 null
                }
            } catch (error) {
                log.error(`OCR 摩拉数识别失败，错误信息: ${error.message}`);
            }
            await sleep(500); // 短暂延迟，避免过快循环
        }
        log.warn(`经过多次尝试，仍然无法在指定区域识别到文字`);
        return null; // 如果未识别到文字，返回 null
    }
    log.info("开始执行 mora 函数");
    // 设置游戏分辨率和 DPI 缩放比例
    setGameMetrics(1920, 1080, 1);
    log.info("游戏分辨率和 DPI 设置完成");

    // 返回游戏主界面
    await genshin.returnMainUi();
    log.info("返回游戏主界面");

    // 按下 C 键
    keyPress("C");
    log.info("按下 C 键");
    await sleep(1500);

    let recognized = false;

    // 识别“角色菜单”图标或“天赋”文字
    let startTime = Date.now();
    while (Date.now() - startTime < 5000) {
        // 尝试识别“角色菜单”图标
        let characterMenuResult = await recognizeImage(CharacterMenuRo, 5000);
        if (characterMenuResult.success) {
            await click(177, 433);
            log.info("点击角色菜单图标");
            await sleep(500);
            recognized = true;
            break;
        }

        // 尝试识别“天赋”文字
        let targetText = "天赋";
        let ocrRegion = { x: 133, y: 395, width: 115, height: 70 }; // 设置对应的识别区域
        let talentResult = await recognizeTextAndClick(targetText, ocrRegion);
        if (talentResult.success) {
            log.info(`点击天赋文字，坐标: x=${talentResult.x}, y=${talentResult.y}`);
            recognized = true;
            break;
        }

        await sleep(1000); // 短暂延迟，避免过快循环
    }

    // 如果识别到了“角色菜单”或“天赋”，则识别“摩拉数值”
    if (recognized) {
        let ocrRegionMora = { x: 1620, y: 25, width: 152, height: 46 }; // 设置对应的识别区域
        let recognizedText = await recognizeTextInRegion(ocrRegionMora);
        if (recognizedText) {
            log.info(`成功识别到摩拉数值: ${recognizedText}`);
            return recognizedText; // 返回识别到的摩拉数值
        } else {
            log.warn("未能识别到摩拉数值。");
        }
    } else {
        log.warn("未能识别到角色菜单或天赋，跳过摩拉数值识别。");
    }

    await sleep(500);
    await genshin.returnMainUi();
    log.info("返回游戏主界面");

    return null; // 如果未能识别到摩拉数值，返回 null
}

async function fakeLog(name, isJs, isStart, duration) {
    await sleep(10);
    const currentTime = Date.now();
    // 参数检查
    if (typeof name !== 'string') {
        log.error("参数 'name' 必须是字符串类型！");
        return;
    }
    if (typeof isJs !== 'boolean') {
        log.error("参数 'isJs' 必须是布尔型！");
        return;
    }
    if (typeof isStart !== 'boolean') {
        log.error("参数 'isStart' 必须是布尔型！");
        return;
    }
    if (typeof currentTime !== 'number' || !Number.isInteger(currentTime)) {
        log.error("参数 'currentTime' 必须是整数！");
        return;
    }
    if (typeof duration !== 'number' || !Number.isInteger(duration)) {
        log.error("参数 'duration' 必须是整数！");
        return;
    }

    // 将 currentTime 转换为 Date 对象并格式化为 HH:mm:ss.sss
    const date = new Date(currentTime);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
    const formattedTime = `${hours}:${minutes}:${seconds}.${milliseconds}`;

    // 将 duration 转换为分钟和秒，并保留三位小数
    const durationInSeconds = duration / 1000; // 转换为秒
    const durationMinutes = Math.floor(durationInSeconds / 60);
    const durationSeconds = (durationInSeconds % 60).toFixed(3); // 保留三位小数

    // 使用四个独立的 if 语句处理四种情况
    if (isJs && isStart) {
        // 处理 isJs = true 且 isStart = true 的情况
        const logMessage = `正在伪造js开始的日志记录\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `------------------------------\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `→ 开始执行JS脚本: "${name}"`;
        log.debug(logMessage);
    }
    if (isJs && !isStart) {
        // 处理 isJs = true 且 isStart = false 的情况
        const logMessage = `正在伪造js结束的日志记录\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `→ 脚本执行结束: "${name}", 耗时: ${durationMinutes}分${durationSeconds}秒\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `------------------------------`;
        log.debug(logMessage);
    }
    if (!isJs && isStart) {
        // 处理 isJs = false 且 isStart = true 的情况
        const logMessage = `正在伪造地图追踪开始的日志记录\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `------------------------------\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `→ 开始执行地图追踪任务: "${name}"`;
        log.debug(logMessage);
    }
    if (!isJs && !isStart) {
        // 处理 isJs = false 且 isStart = false 的情况
        const logMessage = `正在伪造地图追踪结束的日志记录\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `→ 脚本执行结束: "${name}", 耗时: ${durationMinutes}分${durationSeconds}秒\n\n` +
            `[${formattedTime}] [INF] BetterGenshinImpact.Service.ScriptService\n` +
            `------------------------------`;
        log.debug(logMessage);
    }
}

/**
 * 多文本模板匹配
 *
 * @param {Array<{name:string, index:number, ros:Array}>} texts
 *        待识别文本列表，按 index 升序匹配
 * @param {boolean} [sortByX=true]  true→按 x 坐标从左到右排序；false→按 y 坐标从上到下排序
 * @param {number}  [maxOverlap=2]  NMS 去重时允许的最大重叠像素
 *
 * @returns {string} 识别出的拼接文本；无任何结果返回空字符串
 */
async function textTemplateMatch(texts, sortByX = true, maxOverlap = 2) {
    if (!texts || texts.length === 0) return '';
    const allCandidates = [];
    let gameRegion;
    try {
        gameRegion = await getGameRegion();
        const levelCount = texts[0].ros.length;   // 阈值梯度层数
        // 逐阈值层扫描
        for (let lvl = 0; lvl < levelCount; lvl++) {
            for (const item of texts) {
                try {
                    const ros = item.ros[lvl];
                    const res = gameRegion.findMulti(ros);
                    if (!res || res.count === 0) continue;

                    for (let i = 0; i < res.count; i++) {
                        const box = res[i];
                        allCandidates.push({
                            name: item.name,
                            x: box.x,
                            y: box.y,
                            w: box.width,
                            h: box.height
                        });
                    }
                } catch (e) {
                    log.error(`文本模板匹配失败（name:${item.name}, lvl:${lvl}）：${e.message}`);
                }
            }
        }
    } catch (error) {
        log.error(`文本识别过程中出现错误：${error.message}`);
    }

    // NMS 去重
    const adopted = [];
    for (const c of allCandidates) {
        let overlap = false;
        for (const a of adopted) {
            const xOverlap = Math.max(0, Math.min(c.x + c.w, a.x + a.w) - Math.max(c.x, a.x));
            const yOverlap = Math.max(0, Math.min(c.y + c.h, a.y + a.h) - Math.max(c.y, a.y));
            if (xOverlap > maxOverlap && yOverlap > maxOverlap) {
                overlap = true;
                break;
            }
        }
        if (!overlap) adopted.push(c);
    }

    if (adopted.length === 0) return '';
    adopted.sort((a, b) => (sortByX ? a.x - b.x : a.y - b.y));
    return adopted.map(item => item.name).join('');
}

/**
 * 为 textTemplateMatch 生成配置对象
 * 依赖：readFolder(...) 必须已实现且返回 { fullPath, fileName, folderPathArray }[]
 *
 * @param {string} pngFilePath        存放各文本 png 的目录（每套图仅一张，文件名即文本内容）
 * @param {Object} [region]           识别区域
 * @param {number} [region.x=0]       截图左上角 x
 * @param {number} [region.y=0]       截图左上角 y
 * @param {number} [region.width=1920]  截图宽度
 * @param {number} [region.height=1080] 截图高度
 * @param {number[]} [thresholds=[0.95,0.9,0.85,0.8]]  需要生成的阈值梯度
 * @param {boolean} [use3Channels=false]  是否启用三通道匹配
 * @param {number} [sortRule=0]        index 排序规则：
 *                                     0-宽度从大到小（默认）
 *                                     1-高度从大到小
 *                                     2-readFolder 原始顺序
 *                                     3-name 升序
 *
 * @returns {Array<{name:string, index:number, ros:Array}>}  可直接喂给 textTemplateMatch 的 texts 数组
 */
async function buildTextRos(
    pngFilePath,
    region = {},
    thresholds = [0.95, 0.9, 0.85, 0.8],
    use3Channels = false,
    sortRule = 0
) {
    const { x = 0, y = 0, width = 1920, height = 1080 } = region || {};

    // 1. 读取目录下所有 png
    const files = await readFolder(pngFilePath, 'png'); // 字符串后缀
    if (!files.length) return [];

    // 2. 内联工具：批量改阈值并重新初始化
    function setThreshold(roArr, newThreshold) {
        for (let i = 0; i < roArr.length; i++) {
            roArr[i].Threshold = newThreshold;
            roArr[i].InitTemplate();
        }
    }

    // 3. 根据排序规则预处理文件列表
    let sortedFiles = [];
    switch (sortRule) {
        case 0: // 宽度从大到小
            sortedFiles = files
                .map(f => ({ f, mat: file.ReadImageMatSync(f.fullPath) }))
                .sort((a, b) => b.mat.Width - a.mat.Width)
                .map(item => {
                    item.mat.Dispose(); // 立即释放临时 Mat
                    return item.f;
                });
            break;
        case 1: // 高度从大到小
            sortedFiles = files
                .map(f => ({ f, mat: file.ReadImageMatSync(f.fullPath) }))
                .sort((a, b) => b.mat.Height - a.mat.Height)
                .map(item => {
                    item.mat.Dispose();
                    return item.f;
                });
            break;
        case 2: // 原始顺序
            sortedFiles = files;
            break;
        case 3: // name 升序
            sortedFiles = files.slice().sort((a, b) => a.fileName.localeCompare(b.fileName));
            break;
        default:
            sortedFiles = files;
    }

    // 4. 为每张图生成多阈值 ros
    const texts = [];
    for (let idx = 0; idx < sortedFiles.length; idx++) {
        const f = sortedFiles[idx];
        const name = f.fileName.replace(/\.png$/i, '');
        const baseRos = RecognitionObject.TemplateMatch(
            file.ReadImageMatSync(f.fullPath),
            x, y, width, height
        );
        if (use3Channels) baseRos.Use3Channels = true;

        const ros = [];
        for (const thr of thresholds) {
            setThreshold([baseRos], thr);
            ros.push(baseRos);
        }
        texts.push({ name: name, index: idx, ros: ros });
    }
    return texts;
}

/**
 * 获取游戏区域截图，根据时间间隔决定是否重新捕获
 * 
 * @param {number} [minInterval=17] - 最小截图间隔（毫秒），默认17ms（约60fps）
 * @param {boolean} [asyncDispose=false] - 是否异步释放旧截图，默认false
 * @returns {Promise<Object>} 游戏区域截图对象
 * 
 * @description
 * 使用 gameRegionManager 对象管理以下属性：
 * - newGameRegion: 存储最新的游戏区域截图对象
 * - oldGameRegion: 存储上一个游戏区域截图对象，用于资源释放
 * - lastCapture: 上一次捕获游戏区域的时间戳
 * - isDisposing: 标记是否正在释放旧截图，用于安全锁
 * - isCapturing: 标记是否正在执行截图操作，用于全局锁
 */
async function getGameRegion(minInterval = 17, asyncDispose = false) {
    async function disposeOldGameRegion() {
        if (gameRegionManager.oldGameRegion) {
            gameRegionManager.isDisposing = true;
            try {
                gameRegionManager.oldGameRegion.dispose();
            } catch (error) {
                log.error(`释放旧游戏区域截图失败: ${error.message}`);
            } finally {
                gameRegionManager.isDisposing = false;
                gameRegionManager.oldGameRegion = gameRegionManager.newGameRegion;
            }
        } else {
            gameRegionManager.oldGameRegion = gameRegionManager.newGameRegion;
        }
    }

    // 等待其他任务完成截图
    while (gameRegionManager.isCapturing) {
        await sleep(1);
    }

    gameRegionManager.isCapturing = true;
    try {
        if (new Date() - gameRegionManager.lastCapture >= minInterval || !gameRegionManager.newGameRegion) {
            while (gameRegionManager.isDisposing) {
                await sleep(1);
            }
            gameRegionManager.lastCapture = new Date();
            gameRegionManager.newGameRegion = captureGameRegion();

            // 根据参数决定是否等待释放完成
            if (asyncDispose) {
                disposeOldGameRegion();
            } else {
                await disposeOldGameRegion();
            }
        }
    } catch (error) {
        log.error(`获取游戏区域截图失败: ${error.message}`);
    } finally {
        gameRegionManager.isCapturing = false;
        return gameRegionManager.newGameRegion;
    }
}

/**
 * 检查当前时间是否处于限制时间内或即将进入限制时间
 * @param {string} timeRule - 时间规则字符串，格式如 "8, 8-11, 23:11-23:55"
 * @param {number} [threshold=5] - 接近限制时间的阈值（分钟）
 * @returns {Promise<boolean>} - 如果处于限制时间内或即将进入限制时间，则返回 true，否则返回 false
 */
async function isTimeRestricted(timeRule, threshold = 5) {
    if (!timeRule) return false;

    const ruleClean = timeRule
        .replace(/，/g, ',')
        .replace(/：/g, ':');

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTotal = currentHour * 60 + currentMinute;

    for (const seg of ruleClean.split(',').map(s => s.trim())) {
        if (!seg) continue;

        let startStr, endStr;
        if (seg.includes('-')) {
            [startStr, endStr] = seg.split('-').map(s => s.trim());
        } else {
            startStr = endStr = seg.trim();
        }

        const parseTime = (str, isEnd) => {
            if (str.includes(':')) {
                const [h, m] = str.split(':').map(Number);
                return { h, m };
            }
            const h = Number(str);
            return { h, m: isEnd ? 59 : 0 };
        };

        const start = parseTime(startStr, false);
        const end = parseTime(endStr, true);

        const startTotal = start.h * 60 + start.m;
        const endTotal = end.h * 60 + end.m;

        const effectiveEnd = endTotal >= startTotal ? endTotal : endTotal + 24 * 60;

        if (
            (currentTotal >= startTotal && currentTotal < effectiveEnd) ||
            (currentTotal + 24 * 60 >= startTotal && currentTotal + 24 * 60 < effectiveEnd)
        ) {
            log.warn("处于限制时间内");
            return true;
        }

        let nextStartTotal = startTotal;
        if (nextStartTotal <= currentTotal) nextStartTotal += 24 * 60;
        const waitMin = nextStartTotal - currentTotal;
        if (waitMin > 0 && waitMin <= threshold) {
            log.warn(`接近限制时间，等待 ${waitMin} 分钟`);
            await genshin.tpToStatueOfTheSeven();
            await sleep(waitMin * 60 * 1000);
            return true;
        }
    }

    log.info("不处于限制时间");
    return false;
}

/**
 * 滚动鼠标滚轮
 * @param {number} [lines=1] 滚动行数
 */
async function scrollDown(lines = 1) {
    lines = lines * scrollScale;
    for (let i = 0; i < lines; i++) {
        await keyMouseScript.runFile(`assets/滚轮下翻.json`);
    }
    await sleep(delay2);
    click(1477, 1031);
    await sleep(2 * delay2);
}

/**
 * 加载物品名称模板识别对象
 * @param {string} baseDir 基础目录
 * @param {string} fileKey 目标文件名（如 '名称图片.png'）
 * @returns {Promise<Array>} 识别对象数组
 */
async function loadTargetItems(baseDir, fileKey) {
    const items = [];
    const allPng = await readFolder(baseDir, '.png');
    for (const f of allPng) {
        if (f.fileName === fileKey) {
            try {
                const mat = file.ReadImageMatSync(f.fullPath);
                const roi = RecognitionObject.TemplateMatch(mat);
                roi.Use3Channels = true;
                roi.Threshold = 0.97;
                roi.InitTemplate();
                const star = f.folderPathArray[f.folderPathArray.length - 2];
                items.push({
                    fullPath: f.fullPath,
                    itemName: f.folderPathArray[f.folderPathArray.length - 1],
                    star,
                    template: mat,
                    roi
                });
            } catch (err) {
                log.error(`[加载图片] ${f.fullPath}: ${err.message}`);
            }
        }
    }
    return items;
}

/**
 * 原版 !ocrBackpack 的完整包裹函数
 * 直接照抄原版代码，不做内部逻辑修改
 * 注入 settings 兼容属性，移除 TP/开背包/文件写入
 * @returns {Object} ITEM_COUNTS — { "0星": {"甜甜花": 12}, "1星": {"枫木": 5}, ... }
 */
async function scanBackpackOriginal() {
    /* 注入 settings 缺失属性 */
    const _origExecutingTypes = settings.executingTypes;
    const _origForceCheck = settings.forceCheck;
    const _origDoSave = settings.doSave;
    settings.executingTypes = ['材料'];
    settings.forceCheck = false;
    settings.doSave = false;

    try {
        /* ====== 以下为原版 !ocrBackpack/main.js 完整代码，照抄不做修改 ====== */
        const bottomRo = RecognitionObject.TemplateMatch(file.ReadImageMatSync("assets/RecognitionObject/到底了.png"), 1282, 934, 1296 - 1282, 945 - 934);
        bottomRo.Threshold = 0.9;
        bottomRo.InitTemplate();
        // 8 条 x 区间
        const xRanges = [
            [117, 241], [264, 386], [410, 533], [557, 680],
            [703, 826], [849, 971], [996, 1119], [1142, 1266]
        ];
        // 全局物品数量统计：{ [star: string]: { [itemName: string]: number } }
        let ITEM_COUNTS = {};

        const starRos = xRanges.map(([x1, x2]) =>
            Array.from({ length: 6 }, (_, star) => {
                const ro = RecognitionObject.TemplateMatch(
                    file.ReadImageMatSync(`assets/RecognitionObject/${star}星.png`),
                    x1, 230, x2 - x1, 898 - 230          // 新 ROI：竖长条
                );
                ro.Threshold = star === 0 ? 0.98 : 0.9;
                ro.Use3Channels = true;
                ro.InitTemplate();
                return ro;
            })
        );

        // 预加载星标模板图片，用于窄带扫描
        const starMats = [];
        for (let s = 0; s <= 5; s++) {
            starMats.push(file.ReadImageMatSync(`assets/RecognitionObject/${s}星.png`));
        }

        let delayScale = Number(settings.delayScale) || 1;
        let delay1 = 50 * delayScale;
        let delay2 = 150 * delayScale;
        let delay3 = 1000 * delayScale;
        let scrollScale = Number(settings.scrollScale) || 10;

        let itemNameRos;
        let gameRegion;
        let gameRegion2;
        let doSave = settings.doSave;
        let sortMode = settings.sortMode || "按背包出现顺序";

        let STAR_MOSAICS = [];

        // ====== 原版 IIFE 主体 ======
        // 注：移除外部的 tpToStatueOfTheSeven()，保留 keyPress("B") 打开背包
        keyPress('B');
        await sleep(delay3);
        let types = Array.from(settings.executingTypes);
        if (types.includes("全选")) {
            types = [
                "养成道具",
                "食物",
                "材料",
            ]
        }
        for (let type of types) {
            STAR_MOSAICS = [];
            ITEM_COUNTS = {};
            await switchToBagTab(type);
            log.info(`加载${type}物品图片`);
            for (let star = 0; star <= 5; star++) {
                try {
                    const dir = `assets/${type}/拼图输出/${star}星`;
                    const mat = file.ReadImageMatSync(`${dir}/物品图片.png`);
                    const idx = JSON.parse(await file.readText(`${dir}/${star}星索引.json`));
                    STAR_MOSAICS.push({ mat, idx });   // mat=母图  idx=JSON数组
                } catch (e) { }
            }

            log.info(`加载${type}物品名称图片`);
            itemNameRos = await loadTargetItems(`assets/${type}/材料截图`, '名称图片.png');
            gameRegion = captureGameRegion();

            const textsRos = await buildTextRos(
                'assets/背包物品数字',
                null,                       // 不指定区域（全图匹配）
                [0.95, 0.9, 0.85],        // 阈值梯度
                false,                      // 默认灰度匹配
                0                           // 默认按宽度从大到小排序
            );

            let scrolls = 0
            while (scrolls < 200) {
                try { await sleep(1); } catch (e) { break; }
                let time0 = new Date();
                // ====== Phase 1: 扫前 2 列，获取参考行 Y 坐标 ======
                gameRegion = captureGameRegion();
                const rawYSet = new Set();
                for (let col = 0; col < 2; col++) {
                    for (let star = 0; star <= 5; star++) {
                        const res = gameRegion.findMulti(starRos[col][star]);
                        for (let i = 0; i < res.count; i++) {
                            rawYSet.add(Math.round(res[i].y));
                        }
                    }
                }
                // 去重（±5px 合并为同一行）
                let sortedYs = [...rawYSet].sort((a, b) => a - b);
                const uniqueYs = [];
                for (const y of sortedYs) {
                    if (uniqueYs.length === 0 || Math.abs(y - uniqueYs[uniqueYs.length - 1]) > 5) {
                        uniqueYs.push(y);
                    }
                }
                // 计算平均行间距，补全缺项
                const avgGap = uniqueYs.length > 1
                    ? Math.round((uniqueYs[uniqueYs.length - 1] - uniqueYs[0]) / (uniqueYs.length - 1))
                    : 82;
                const TOP_Y = 230, BOTTOM_Y = 898;
                // 从第一个实际 Y 向前扩展到 TOP_Y
                let rowY = uniqueYs[0];
                while (rowY - avgGap >= TOP_Y) rowY -= avgGap;
                const refRowYs = [];
                const rowSet = new Set(uniqueYs);
                while (rowY <= BOTTOM_Y) {
                    if (rowSet.has(rowY)) {
                        refRowYs.push(rowY);
                    } else {
                        // 检查 ±8px 内是否有实际值，有则使用
                        const nearby = uniqueYs.find(y => Math.abs(y - rowY) <= 8);
                        refRowYs.push(nearby !== undefined ? nearby : rowY);
                    }
                    rowY += avgGap;
                }

                // ====== Phase 2: 扫描所有列 ======
                const allStars = [];
                const NARROW_BAND = 20;
                // 前 2 列：全高度扫描（原逻辑）
                for (let col = 0; col < 2; col++) {
                    for (let star = 0; star <= 5; star++) {
                        const res = gameRegion.findMulti(starRos[col][star]);
                        if (res.count === 0) continue;
                        for (let i = 0; i < res.count; i++) {
                            const box = res[i];
                            allStars.push({ star, x: box.x, y: box.y, width: box.width, height: box.height });
                        }
                    }
                }
                // 后 6 列：窄带扫描（仅对参考行附近进行模板匹配）
                for (let col = 2; col < 8; col++) {
                    const [x1, x2] = xRanges[col];
                    for (const refY of refRowYs) {
                        const bandY = refY - 3;  // refY 是星标左上角，中心在 refY+7，20px 带居中
                        for (let star = 0; star <= 5; star++) {
                            const ro = RecognitionObject.TemplateMatch(
                                starMats[star],
                                x1, bandY, x2 - x1, NARROW_BAND
                            );
                            ro.Threshold = star === 0 ? 0.98 : 0.9;
                            ro.Use3Channels = true;
                            ro.InitTemplate();
                            const res = gameRegion.find(ro);
                            if (!res.isEmpty()) {
                                allStars.push({ star, x: res.x, y: res.y, width: res.width, height: res.height });
                            }
                        }
                    }
                }
                gameRegion.dispose();
                allStars.sort((a, b) => Math.abs(a.y - b.y) <= 5 ? a.x - b.x : a.y - b.y);
                for (const s of allStars) {
                    let count;
                    const currentStar = `${s.star}星`;
                    let currentItem = null;          // 最终识别结果
                    let found1 = false;               // 仅用于控制是否跳过点击/后续校验，不决定输出
                    let found2 = false;
                    STAR: {                          // ← 给这颗星的所有校验加标签
                        /* ===================== 一次校验 ===================== */
                        let time1 = new Date();
                        try {
                            /* 0️⃣ 先读数量 */
                            const numStr = await textTemplateMatch(
                                textsRos,
                                true,
                                2,
                                { x: s.x + 20, y: s.y + 14, width: 80, height: 25 }
                            );
                            count = Number(numStr) || 0;

                            /* 1️⃣ 再拿图做模板匹配 */
                            gameRegion?.dispose();
                            gameRegion = captureGameRegion();
                            const cropRegion = gameRegion.DeriveCrop(s.x, s.y - 75, 120, 70);
                            const cropMat = cropRegion.SrcMat;              // 120×80 实时掉落图
                            const starIdx = Number(currentStar[0]);         // '0星'->0
                            const { mat: mosaicmat, idx: jsonIdx } = STAR_MOSAICS[starIdx];
                            let img = new ImageRegion(mosaicmat, 0, 0);
                            const ro = RecognitionObject.TemplateMatch(cropMat);
                            ro.Threshold = 0.97;
                            ro.InitTemplate();
                            const res = img.findMulti(ro);
                            cropMat.dispose();

                            let hitName = '';      // 最终干净名字
                            let hitCount = 0;       // 1=唯一确定  0=没命中  -1=冲突/异常
                            if (res.count === 0) {
                                hitCount = 0;
                                log.info(`[${currentStar}] 模板匹配未命中，点击确认`);
                            } else if (res.count === 1) {
                                const cy = res[0].y + res[0].height / 2;
                                const gridY = Math.floor(cy / 81);          // 80图+1缝
                                if (gridY >= 0 && gridY < jsonIdx.length) {
                                    hitName = jsonIdx[gridY].itemName.replace(/\s*\(\d+\)$/, '');
                                    hitCount = 1;
                                } else {
                                    hitCount = -1;
                                    log.info(`[${currentStar}] 唯一命中但 gridY=${gridY} 越界，共 ${jsonIdx.length} 行`);
                                }
                            } else { // res.count > 1
                                const cleanNames = [];
                                for (let k = 0; k < res.count; k++) {
                                    const cXk = res[k].x + res[k].width / 2;
                                    const gridXk = Math.floor(cXk / 121);
                                    if (gridXk >= 0 && gridXk < jsonIdx.length) {
                                        cleanNames.push(jsonIdx[gridXk].itemName.replace(/\s*\(\d+\)$/, ''));
                                    }
                                }
                                if (cleanNames.length === 0) {
                                    hitCount = -1;
                                    log.info(`[${currentStar}] 多命中但全部越界`);
                                } else if (cleanNames.every(n => n === cleanNames[0])) {
                                    hitName = cleanNames[0];
                                    hitCount = 1;
                                } else {
                                    hitCount = -1;
                                    log.info(`[${currentStar}] 多命中冲突：${cleanNames.join(' | ')}`);
                                }
                            }

                            // 2️⃣ 只有 1 才写结果
                            if (hitCount === 1) {
                                currentItem = { name: hitName, star: currentStar, source: 'template' };
                                found1 = true;
                            }
                        } catch (e) {
                        } finally {
                            gameRegion?.dispose();
                        }
                        /* 1️⃣ 一次校验后 */
                        if (found1 && !settings.forceCheck) break STAR;

                        /* ===================== 二次校验 ===================== */
                        click(s.x + (s.width >> 1), s.y + (s.height >> 1));
                        await sleep(delay2);
                        let time2 = new Date();
                        try {
                            gameRegion = captureGameRegion();
                            const nameCropRegion1 = gameRegion.DeriveCrop(1311, 121, 348, 55);
                            for (const it of itemNameRos) {
                                if (it.star !== currentStar) continue;
                                const res = nameCropRegion1.find(it.roi);
                                if (!res.isEmpty()) {        // ✅ 拿到名字
                                    // 去掉 (数字) 尾巴，合并为同一物品
                                    const cleanName = it.itemName.replace(/\s*\(\d+\)$/, '');
                                    currentItem = { name: cleanName, star: currentStar, source: 'nameTemplate' };
                                    found2 = true;
                                }
                            }
                        } catch (e) {
                            log.error(`二次校验异常：${e.message}`);
                        } finally {
                            gameRegion?.dispose();
                        }
                        if (found2) {
                            if (!doSave) {
                                break STAR; // 不截图时直接跳出
                            } else {
                                if (found1) {
                                    break STAR; // 截图时，只有一二次校验均通过才跳出
                                }
                            }
                        }
                        /* ===================== 三次校验（OCR） ===================== */
                        let time3 = new Date();
                        try {
                            gameRegion = captureGameRegion();
                            const nameCropRegion = gameRegion.DeriveCrop(1311, 123, 348, 51);
                            const resList = gameRegion.findMulti(RecognitionObject.ocr(1311, 123, 348, 51));
                            if (!resList.count) throw new Error('OCR 未识别到文字');
                            let longest = resList[0];
                            for (let i = 1; i < resList.count; i++) {
                                if (resList[i].text.length > longest.text.length) longest = resList[i];
                            }
                            const ocrName = longest.text.replace(/[^\u4e00-\u9fa5]/g, '');
                            if (!ocrName) throw new Error('OCR 结果无中文');

                            // 生成唯一目录名（仅依据 itemNameRos 去重）
                            function uniqueOcrDir(baseDir, rawName) {
                                const exists = name => itemNameRos.some(it => it.itemName === name);
                                if (!exists(rawName)) return `${baseDir}/${rawName}`;

                                let idx = 1;
                                while (exists(`${rawName}(${idx})`)) idx++;
                                return `${baseDir}/${rawName}(${idx})`;
                            }

                            const baseSaveDir = `assets/${type}/材料截图/${s.star}星`;
                            const saveDir = uniqueOcrDir(baseSaveDir, ocrName);
                            const finalName = saveDir.split('/').pop();

                            currentItem = { name: finalName, star: currentStar, source: 'ocr' }; // ✅ 拿到名字

                            if (doSave) {
                                /* 回点上一颗星重新截图并入库 */
                                const prevIdx = (allStars.indexOf(s) + allStars.length - 1) % allStars.length;
                                const prevStar = allStars[prevIdx];
                                click(prevStar.x + (prevStar.width >> 1), prevStar.y + (prevStar.height >> 1));
                                await sleep(delay2);
                                click(1477, 1031);
                                await sleep(delay2);
                                gameRegion2 = captureGameRegion();
                                const CropRegion = gameRegion2.DeriveCrop(s.x, s.y - 80, 120, 80);
                                let itemPic = CropRegion.SrcMat;
                                file.WriteImageSync(saveDir + "/物品图片.png", itemPic);

                                let itemNamePic = nameCropRegion.SrcMat;
                                file.WriteImageSync(saveDir + "/名称图片.png", itemNamePic);
                                itemPic.dispose();
                                itemNamePic.dispose();

                                const pushItem = (list, fullPath, itemName, star) => {
                                    const mat = file.ReadImageMatSync(fullPath);
                                    const roi = RecognitionObject.TemplateMatch(mat);
                                    roi.Threshold = 0.9; roi.InitTemplate();
                                    list.push({ fullPath, itemName, star, template: mat, roi });
                                };
                                pushItem(itemNameRos, `${saveDir}/名称图片.png`, finalName, currentStar);
                            }
                        } catch (e) {
                            log.error(`三次校验异常：${e.message}`);
                        } finally {
                            gameRegion?.dispose();
                            gameRegion2?.dispose();
                        }
                    }   // ← STAR 标签结束

                    try {
                        const starKey = currentItem.star;          // "0星"..."5星"
                        const itemKey = currentItem.name;

                        // 如果已经记录过，直接跳过
                        if (ITEM_COUNTS[starKey]?.[itemKey] !== undefined) { log.info(`重复物品${starKey}]${itemKey}`); continue; }
                        // 写表 & 打印
                        ITEM_COUNTS[starKey] ??= {};
                        ITEM_COUNTS[starKey][itemKey] = count;
                        log.info(`[${starKey}] ${itemKey}  数量=${count} 识别方式${currentItem.source}`);
                    } catch (e) {
                        log.error(`数量识别失败：${e.message}`);
                    }

                }

                if (settings.firstPageOnly) {
                    log.info(`仅扫描第一页，跳过翻页`);
                    break;
                }
                scrolls++;
                let bottomres = await findAndClick(bottomRo, false, 2, 3, 1);
                if (bottomres) {
                    moveMouseTo(139, 910);
                    await scrollDown(3.7);
                    bottomres = await findAndClick(bottomRo, false, 2, 3, 1);
                    if (bottomres) {
                        log.info(`到底了,处理完毕`);
                        break;
                    }
                }
                moveMouseTo(139, 910);
                await scrollDown(3.7);
            }
            // 跳过原版文件写入，由 scanBackpackMaterials 处理返回值
        }

        return ITEM_COUNTS;
    } finally {
        /* 恢复 settings */
        settings.executingTypes = _origExecutingTypes;
        settings.forceCheck = _origForceCheck;
        settings.doSave = _origDoSave;
    }

    /* ====== 以下为原版辅助函数（全部搬入函数作用域内） ====== */

    /**
     * 通用找图/找RO并可选点击（支持单图片文件路径、单RO、图片文件路径数组、RO数组）
     */
    async function findAndClick(target,
        doClick = true,
        timeout = 3000,
        interval = delay1,
        retType = 0,
        preClickDelay = delay1,
        postClickDelay = delay1) {
        try {
            let ros = [];
            if (Array.isArray(target)) {
                ros = target.map(t =>
                    (typeof t === 'string')
                        ? RecognitionObject.TemplateMatch(file.ReadImageMatSync(t))
                        : t
                );
            } else {
                ros = [(typeof target === 'string')
                    ? RecognitionObject.TemplateMatch(file.ReadImageMatSync(target))
                    : target];
            }

            const start = Date.now();
            let found = null;

            while (Date.now() - start <= timeout) {
                const gameRegion = captureGameRegion();
                try {
                    for (const ro of ros) {
                        const res = gameRegion.find(ro);
                        if (!res.isEmpty()) {
                            found = res;
                            if (doClick) {
                                await sleep(preClickDelay);
                                res.click();
                                await sleep(postClickDelay);
                            }
                            break;
                        }
                    }
                    if (found) break;
                } finally {
                    gameRegion.dispose();
                }
                await sleep(interval);
            }

            return retType === 0 ? !!found : (found || null);

        } catch (error) {
            log.error(`执行通用识图时出现错误：${error.message}`);
            return retType === 0 ? false : null;
        }
    }

    /**
     * 向下滚动lines行
     */
    async function scrollDown(lines = 1) {
        lines = lines * scrollScale;
        for (let i = 0; i < lines; i++) {
            await keyMouseScript.runFile(`assets/滚轮下翻.json`);
        }
        await sleep(delay2);
        click(1477, 1031);
        await sleep(2 * delay2);
    }

    /**
     * 切换到指定背包界面
     */
    async function switchToBagTab(type) {
        const success = await findAndClick([
            `assets/RecognitionObject/背包界面/${type}1.png`,
            `assets/RecognitionObject/背包界面/${type}2.png`
        ]);
        if (success) {
            log.info(`成功进入${type}界面，开始执行`);
        }
        await sleep(delay3);
        return success;
    }

    async function loadTargetItems(baseDir, fileKey) {
        const items = [];
        const allPng = await readFolder(baseDir, '.png');
        for (const f of allPng) {
            if (f.fileName === fileKey) {
                try {
                    const mat = file.ReadImageMatSync(f.fullPath);
                    const roi = RecognitionObject.TemplateMatch(mat);
                    roi.Use3Channels = true;
                    roi.Threshold = 0.97;
                    roi.InitTemplate();

                    const star = f.folderPathArray[f.folderPathArray.length - 2];

                    items.push({
                        fullPath: f.fullPath,
                        itemName: f.folderPathArray[f.folderPathArray.length - 1],
                        star,
                        template: mat,
                        roi
                    });
                } catch (err) {
                    log.error(`[加载图片] ${f.fullPath}: ${err.message}`);
                }
            }
        }
        return items;
    }

    /**
     * 递归读取目录下所有文件
     */
    async function readFolder(folderPath, ext = '') {
        const targetExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase() : '';

        const folderStack = [folderPath];
        const files = [];

        while (folderStack.length > 0) {
            const currentPath = folderStack.pop();
            const filesInSubFolder = file.ReadPathSync(currentPath);
            const subFolders = [];

            for (const filePath of filesInSubFolder) {
                if (file.IsFolder(filePath)) {
                    subFolders.push(filePath);
                } else {
                    if (targetExt) {
                        const fileExt = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
                        if (fileExt !== targetExt) continue;
                    }

                    const fileName = filePath.split('\\').pop();
                    const folderPathArray = filePath.split('\\').slice(0, -1);
                    files.push({ fullPath: filePath, fileName, folderPathArray });
                }
            }

            folderStack.push(...subFolders.reverse());
        }

        return files;
    }

    /**
     * 多文本模板匹配
     */
    async function textTemplateMatch(texts, sortByX = true, maxOverlap = 2, region = null) {
        if (!texts || texts.length === 0) return '';
        const allCandidates = [];
        let gameRegion;
        let searchRegion;

        try {
            gameRegion = captureGameRegion();
            searchRegion = region
                ? gameRegion.DeriveCrop(region.x, region.y, region.width, region.height)
                : gameRegion;

            const levelCount = texts[0].ros.length;
            for (let lvl = 0; lvl < levelCount; lvl++) {
                for (const item of texts) {
                    try {
                        const ros = item.ros[lvl];
                        const res = searchRegion.findMulti(ros);
                        if (!res || res.count === 0) continue;

                        for (let i = 0; i < res.count; i++) {
                            const box = res[i];
                            const absBox = region
                                ? {
                                    x: box.x + region.x,
                                    y: box.y + region.y,
                                    w: box.width,
                                    h: box.height
                                }
                                : box;
                            allCandidates.push({
                                name: item.name,
                                x: absBox.x,
                                y: absBox.y,
                                w: absBox.w,
                                h: absBox.h
                            });
                        }
                    } catch (e) {
                        log.error(`文本模板匹配失败（name:${item.name}, lvl:${lvl}）：${e.message}`);
                    }
                }
            }
        } catch (error) {
            log.error(`文本识别过程中出现错误：${error.message}`);
        } finally {
            if (searchRegion && searchRegion !== gameRegion) searchRegion.dispose();
            if (gameRegion) gameRegion.dispose();
        }

        const adopted = [];
        for (const c of allCandidates) {
            let overlap = false;
            for (const a of adopted) {
                const xOverlap = Math.max(0, Math.min(c.x + c.w, a.x + a.w) - Math.max(c.x, a.x));
                const yOverlap = Math.max(0, Math.min(c.y + c.h, a.y + a.h) - Math.max(c.y, a.y));
                if (xOverlap > maxOverlap && yOverlap > maxOverlap) {
                    overlap = true;
                    break;
                }
            }
            if (!overlap) adopted.push(c);
        }

        if (adopted.length === 0) return '';
        adopted.sort((a, b) => (sortByX ? a.x - b.x : a.y - b.y));
        return adopted.map(item => item.name).join('');
    }

    /**
     * 为 textTemplateMatch 生成配置对象
     */
    async function buildTextRos(
        pngFilePath,
        region = null,
        thresholds = [0.95, 0.9, 0.85, 0.8],
        use3Channels = false,
        sortRule = 0
    ) {
        const { x = 0, y = 0, width = 1920, height = 1080 } = region || {};

        const files = await readFolder(pngFilePath, 'png');
        if (!files.length) return [];

        function setThreshold(roArr, newThreshold) {
            for (let i = 0; i < roArr.length; i++) {
                roArr[i].Threshold = newThreshold;
                roArr[i].InitTemplate();
            }
        }

        let sortedFiles = [];
        switch (sortRule) {
            case 0:
                sortedFiles = files
                    .map(f => ({ f, mat: file.ReadImageMatSync(f.fullPath) }))
                    .sort((a, b) => b.mat.Width - a.mat.Width)
                    .map(item => {
                        item.mat.Dispose();
                        return item.f;
                    });
                break;
            case 1:
                sortedFiles = files
                    .map(f => ({ f, mat: file.ReadImageMatSync(f.fullPath) }))
                    .sort((a, b) => b.mat.Height - a.mat.Height)
                    .map(item => {
                        item.mat.Dispose();
                        return item.f;
                    });
                break;
            case 2:
                sortedFiles = files;
                break;
            case 3:
                sortedFiles = files.slice().sort((a, b) => a.fileName.localeCompare(b.fileName));
                break;
            default:
                sortedFiles = files;
        }

        const texts = [];
        for (let idx = 0; idx < sortedFiles.length; idx++) {
            const f = sortedFiles[idx];
            const name = f.fileName.replace(/\.png$/i, '');

            const baseRos = region === null
                ? RecognitionObject.TemplateMatch(file.ReadImageMatSync(f.fullPath))
                : RecognitionObject.TemplateMatch(
                    file.ReadImageMatSync(f.fullPath),
                    x, y, width, height
                );

            if (use3Channels) baseRos.Use3Channels = true;

            const ros = [];
            for (const thr of thresholds) {
                setThreshold([baseRos], thr);
                ros.push(baseRos);
            }
            texts.push({ name, index: idx, ros });
        }
        return texts;
    }
}