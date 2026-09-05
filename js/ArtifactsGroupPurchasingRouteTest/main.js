const ROUTE_ROOT = "assets/ArtifactsPath";
const REPORT_PATH = "路线运行情况.txt";
const SUCCESS_DISTANCE = 10;
const POSITION_RETRY_COUNT = 3;
const POSITION_RETRY_INTERVAL_MS = 1000;

const RUN_MODE_FULL = "完整运行";
const RUN_MODE_RETRY = "查漏补缺";
const ROUTE_TYPES = ["前执行", "后执行", "占位"];

function getFileName(filePath) {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function combinePath(parent, child) {
  return `${parent.replace(/[\\/]$/, "")}/${child}`;
}

function readPath(path) {
  try {
    // BetterGI 返回的是可枚举的 .NET 集合，不一定具备 JavaScript 数组方法。
    // 先转换为原生数组，再由调用方进行遍历和排序，兼容 ClearScript 运行时。
    const result = [];
    const entries = file.readPathSync(path);
    if (!entries) {
      return result;
    }
    for (const item of entries) {
      result.push(String(item));
    }
    return result;
  } catch (_) {
    return [];
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value) {
  return isFiniteNumber(value) ? value.toFixed(2) : "无法获取";
}

function formatTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sanitizeField(value) {
  return String(value || "").replace(/[\t\r\n]+/g, " ").trim();
}

function getErrorMessage(error) {
  if (!error) {
    return "未知错误";
  }
  return sanitizeField(error.message || error);
}

function isCancellation(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("取消自动任务")
    || message.includes("任务已取消")
    || message.includes("操作已取消")
    || message.includes("a task was canceled")
    || message.includes("taskcanceledexception")
    || message.includes("operationcanceledexception")
    || message.includes("operation was canceled")
    || message.includes("operation was cancelled")
    || message.includes("cancelled")
    || message.includes("canceled");
}

function createRecord(route, status, currentPosition, distance, note, checkedAt) {
  const currentText = currentPosition
    ? `(${formatNumber(currentPosition.x)}, ${formatNumber(currentPosition.y)})`
    : "无法获取";
  const targetText = `(${formatNumber(route.endX)}, ${formatNumber(route.endY)})`;

  return {
    status,
    line: [
      `[${status}]`,
      route.key,
      `终点=${targetText}`,
      `实际=${currentText}`,
      `距离=${formatNumber(distance)}`,
      `检查时间=${checkedAt || "--"}`,
      `备注=${sanitizeField(note) || "--"}`,
    ].join("\t"),
  };
}

function createPendingRecord(route) {
  return createRecord(route, "未运行", null, null, "尚未测试", "--");
}

function loadPreviousRecords() {
  const records = new Map();
  let content;

  try {
    content = file.readTextSync(REPORT_PATH);
  } catch (_) {
    return records;
  }
  if (typeof content !== "string" || content.length === 0) {
    return records;
  }

  for (const line of content.split(/\r?\n/)) {
    const fields = line.split("\t");
    const statusMatch = fields[0] && fields[0].match(/^\[(成功|失败|未运行)\]$/);
    if (!statusMatch || !fields[1]) {
      continue;
    }
    records.set(fields[1], { status: statusMatch[1], line });
  }

  return records;
}

function writeReport(routes, records, runMode, startedAt) {
  let successCount = 0;
  let failedCount = 0;
  let pendingCount = 0;

  for (const route of routes) {
    const status = (records.get(route.key) || createPendingRecord(route)).status;
    if (status === "成功") {
      successCount++;
    } else if (status === "失败") {
      failedCount++;
    } else {
      pendingCount++;
    }
  }

  const lines = [
    "联机团购路线运行测试报告",
    `运行模式：${runMode}`,
    `本轮开始：${formatTime(startedAt)}`,
    `最后更新：${formatTime()}`,
    `成功标准：路线结束后当前位置与路线文件终点的欧氏距离小于 ${SUCCESS_DISTANCE}`,
    `统计：总计 ${routes.length}，成功 ${successCount}，失败 ${failedCount}，未运行 ${pendingCount}`,
    "",
    "状态\t路线\t终点坐标\t实际坐标\t距离\t检查时间\t备注",
  ];

  for (const route of routes) {
    lines.push((records.get(route.key) || createPendingRecord(route)).line);
  }

  const written = file.writeTextSync(REPORT_PATH, `${lines.join("\r\n")}\r\n`);
  if (!written) {
    throw new Error(`写入报告失败：${REPORT_PATH}`);
  }
}

function discoverRoutes() {
  const routes = [];
  const groupPaths = [];
  for (const path of readPath(ROUTE_ROOT)) {
    if (file.isFolder(path)) {
      groupPaths.push(path);
    }
  }
  groupPaths.sort((a, b) => getFileName(a).localeCompare(getFileName(b), "zh-CN"));

  for (const groupPath of groupPaths) {
    const groupName = getFileName(groupPath);
    if (groupName === "额外") {
      continue;
    }

    for (const routeType of ROUTE_TYPES) {
      const typePath = combinePath(groupPath, routeType);
      const routeFiles = [];
      for (const path of readPath(typePath)) {
        if (!file.isFolder(path) && path.toLowerCase().endsWith(".json")) {
          routeFiles.push(path);
        }
      }
      routeFiles.sort((a, b) => getFileName(a).localeCompare(getFileName(b), "zh-CN"));

      for (const fullPath of routeFiles) {
        const routeData = JSON.parse(file.readTextSync(fullPath));
        if (!Array.isArray(routeData.positions) || routeData.positions.length === 0) {
          throw new Error(`路线没有有效点位：${fullPath}`);
        }

        const endPosition = routeData.positions[routeData.positions.length - 1];
        if (!isFiniteNumber(endPosition.x) || !isFiniteNumber(endPosition.y)) {
          throw new Error(`路线终点坐标无效：${fullPath}`);
        }

        const fileName = getFileName(fullPath);
        routes.push({
          key: `${groupName}/${routeType}/${fileName}`,
          fullPath,
          mapName: routeData.info && routeData.info.map_name
            ? routeData.info.map_name
            : "Teyvat",
          endX: endPosition.x,
          endY: endPosition.y,
        });
      }
    }
  }

  return routes;
}

async function getCurrentPosition(route) {
  let lastError = null;

  for (let attempt = 1; attempt <= POSITION_RETRY_COUNT; attempt++) {
    try {
      const position = genshin.getPositionFromMap(route.mapName, route.endX, route.endY);
      if (position && isFiniteNumber(position.x) && isFiniteNumber(position.y)) {
        return { x: position.x, y: position.y };
      }
      lastError = new Error("小地图坐标识别返回空值");
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < POSITION_RETRY_COUNT) {
      await sleep(POSITION_RETRY_INTERVAL_MS);
    }
  }

  throw lastError || new Error("无法获取小地图坐标");
}

async function testRoute(route) {
  let routeError = "";
  let positionError = "";
  let currentPosition = null;

  try {
    await genshin.returnMainUi();
    log.info(`开始测试路线：${route.key}`);
    await pathingScript.runFile(route.fullPath);
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    routeError = `路线执行异常：${getErrorMessage(error)}`;
    log.error(`${route.key} ${routeError}`);
  }

  try {
    await genshin.returnMainUi();
    await sleep(POSITION_RETRY_INTERVAL_MS);
    currentPosition = await getCurrentPosition(route);
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    positionError = `坐标获取异常：${getErrorMessage(error)}`;
    log.error(`${route.key} ${positionError}`);
  }

  const distance = currentPosition
    ? Math.hypot(currentPosition.x - route.endX, currentPosition.y - route.endY)
    : null;
  // BetterGI 路径执行器会在引擎内部处理路线异常，通常不会把路线失败抛回 JS。
  // 按需求仅以路线结束后的终点距离作为成功标准；坐标读取失败时 distance 为 null，自然判为失败。
  const status = isFiniteNumber(distance) && distance < SUCCESS_DISTANCE ? "成功" : "失败";
  const notes = [];
  if (routeError) notes.push(routeError);
  if (positionError) notes.push(positionError);
  const note = notes.join("；") || "--";

  if (status === "成功") {
    log.info(`${route.key} 测试成功，终点距离 ${formatNumber(distance)}`);
  } else {
    log.error(`${route.key} 测试失败，终点距离 ${formatNumber(distance)}`);
  }

  return createRecord(route, status, currentPosition, distance, note, formatTime());
}

(async function main() {
  const runMode = settings.runMode === RUN_MODE_RETRY ? RUN_MODE_RETRY : RUN_MODE_FULL;
  const startedAt = new Date();
  const routes = discoverRoutes();

  if (routes.length === 0) {
    throw new Error("未找到任何收尾路线或占位路线");
  }

  const previousRecords = runMode === RUN_MODE_RETRY ? loadPreviousRecords() : new Map();
  const records = new Map();
  for (const route of routes) {
    records.set(route.key, previousRecords.get(route.key) || createPendingRecord(route));
  }

  const routesToRun = [];
  for (const route of routes) {
    if (records.get(route.key).status !== "成功") {
      routesToRun.push(route);
    }
  }
  writeReport(routes, records, runMode, startedAt);

  log.info(`共发现 ${routes.length} 条路线，本轮需要测试 ${routesToRun.length} 条`);
  if (routesToRun.length === 0) {
    log.info(`没有需要补测的路线，报告路径：${REPORT_PATH}`);
    return;
  }

  for (let index = 0; index < routesToRun.length; index++) {
    const route = routesToRun[index];
    log.info(`测试进度 ${index + 1}/${routesToRun.length}`);

    try {
      records.set(route.key, await testRoute(route));
    } catch (error) {
      if (!isCancellation(error)) {
        throw error;
      }
      records.set(
        route.key,
        createRecord(route, "失败", null, null, `任务已取消：${getErrorMessage(error)}`, formatTime()),
      );
      writeReport(routes, records, runMode, startedAt);
      log.warn(`测试已停止，当前进度已写入 ${REPORT_PATH}`);
      return;
    }

    writeReport(routes, records, runMode, startedAt);
  }

  log.info(`全部待测路线已执行完毕，报告路径：${REPORT_PATH}`);
})();
