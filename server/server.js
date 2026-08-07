/*
 * 服务端代码说明
 * 此服务端代码仅用于编辑，不在本地环境运行
 * 请勿尝试在本地安装依赖或执行运行操作，以免生成不必要的文件
 */

// ==================== 1. 模块导入 ====================
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');

// ==================== 2. 常量定义 ====================
// 服务端版本号
const SERVER_VERSION = '1.4.0';

// 错误类型枚举
const ErrorType = {
  VALIDATION: 'VALIDATION',
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  NETWORK: 'NETWORK',
  DATA: 'DATA'
};

// 日志分类常量
const LOG_TYPES = {
  INFO: 'info',
  ERROR: 'error',
  WARN: 'warn',
  DEBUG: 'debug',
  RIDE: 'ride',
  ONLINE: 'online',
  ADMIN: 'admin',
  LOGIN: 'login',
  POINTS: 'points',
  FILE: 'file',
  CLEANUP: 'cleanup',
  TIMER: 'timer',
  SOCKET: 'socket',
  VERSION: 'version',
  CODEHASH: 'codehash'
};

// 连接限制
const MAX_CONNECTIONS = 250;
const DATA_CHANGE_DELAY = 1000;

// 带宽限制配置
const MAX_BANDWIDTH = 2 * 1024 * 1024; // 2Mbps = 2,097,152 bits/s
const MAX_BYTES_PER_SECOND = 350 * 1024; // 350KB/s

// 令牌桶类 - 用于全局带宽限制
class TokenBucket {
  constructor(capacity, fillRate) {
    this.capacity = capacity; // 桶容量（字节）
    this.fillRate = fillRate; // 填充速率（字节/秒）
    this.tokens = capacity; // 当前令牌数
    this.lastFillTime = Date.now(); // 上次填充时间
  }

  // 尝试获取令牌
  consume(amount) {
    this.refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }

  // 填充令牌
  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastFillTime) / 1000; // 秒
    const newTokens = elapsed * this.fillRate;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastFillTime = now;
  }
}

// 创建全局令牌桶（所有请求共享）
const globalTokenBucket = new TokenBucket(MAX_BYTES_PER_SECOND * 2, MAX_BYTES_PER_SECOND); // 容量为2秒的流量

// 带宽限制中间件 - 全局限速版（所有人速度总和）
function bandwidthLimitMiddleware(req, res, next) {
  log(`收到请求: ${req.path}`, LOG_TYPES.INFO, { path: req.path, type: 'bandwidth' });
  
  // 只对静态文件请求进行限速
  const isMojangZipRequest = req.path === '/client/mojang.zip' || 
                           req.path === '/server/client/mojang.zip' ||
                           req.path === '/mojang.zip' ||
                           req.path.includes('mojang.zip'); // 更宽松的匹配
  
  if (isMojangZipRequest) {
    log(`带宽限制应用于: ${req.path}`, LOG_TYPES.INFO, { path: req.path, type: 'bandwidth' });
    log(`限速配置: 350KB/s (全局总和)`, LOG_TYPES.INFO, { speed: '350KB/s', type: 'bandwidth', mode: 'global' });
    
    // 重写 res.write 方法
    const originalWrite = res.write;
    let bytesSent = 0;
    let startTime = Date.now();
    let lastLogTime = Date.now();
    let responseEnded = false;
    
    // 监听响应结束事件
    res.on('finish', () => {
      responseEnded = true;
      log(`响应已结束: ${req.path}`, LOG_TYPES.INFO, { path: req.path, type: 'bandwidth' });
    });
    
    res.write = function(chunk, encoding, callback) {
      // 检查响应是否已经结束
      if (responseEnded) {
        log(`响应已结束，跳过写入: ${req.path}`, LOG_TYPES.WARN, { path: req.path, type: 'bandwidth' });
        if (typeof callback === 'function') {
          callback();
        }
        return false;
      }
      
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const chunkSize = buffer.length;
      
      bytesSent += chunkSize;
      
      // 从全局令牌桶获取令牌
      while (!globalTokenBucket.consume(chunkSize)) {
        // 等待令牌，短暂延迟
        const start = Date.now();
        while (Date.now() - start < 10) {
          // 空循环，等待
        }
        
        // 再次检查响应是否已经结束
        if (responseEnded) {
          log(`响应已结束，跳过写入: ${req.path}`, LOG_TYPES.WARN, { path: req.path, type: 'bandwidth' });
          if (typeof callback === 'function') {
            callback();
          }
          return false;
        }
      }
      
      // 每2秒记录一次速度
      const now = Date.now();
      if (now - lastLogTime > 2000) {
        const elapsed = (now - startTime) / 1000; // 秒
        const currentSpeed = bytesSent / elapsed / 1024; // KB/s
        log(`当前速度: ${currentSpeed.toFixed(2)} KB/s, 已发送: ${(bytesSent/1024/1024).toFixed(2)} MB`, LOG_TYPES.INFO, {
          speed: `${currentSpeed.toFixed(2)} KB/s`,
          sent: `${(bytesSent/1024/1024).toFixed(2)} MB`,
          type: 'bandwidth',
          mode: 'global'
        });
        lastLogTime = now;
      }
      
      return originalWrite.call(this, buffer, encoding, callback);
    };
    
    next();
  } else {
    next();
  }
}

// 数据文件路径
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const USER_ACCOUNTS_FILE = path.join(DATA_DIR, 'user_accounts.json');
const VERSIONS_FILE = path.join(DATA_DIR, 'versions.json');
const ADMIN_ACCOUNTS_FILE = path.join(DATA_DIR, 'adminAccounts.json');
const ASAR_DIR = path.join(__dirname, 'asar'); // 存储各版本 app.asar，用于校验客户端完整性
const logDir = path.join(__dirname, 'log');
const rideRecordsDir = path.join(__dirname, 'rideRecords');
const gainRecordsDir = path.join(__dirname, 'gainRecords');
const ROUTE_TASKS_FILE = path.join(DATA_DIR, 'route_tasks.json');       // 路线测试任务池
const ROUTE_RECORDS_FILE = path.join(DATA_DIR, 'route_test_records.json'); // 路线测试结果记录

// 默认版本号
const DEFAULT_VERSIONS = {
  clientVersion: '1.0.0',
  groupPurchasingVersion: '1.0.0'
};

// 动态版本号（从文件加载）
let versions = { ...DEFAULT_VERSIONS };

// 上传存储（用于分片上传）
const uploadStorage = {
  clientPackage: { chunks: [], totalSize: 0, fileName: '' },
  groupPurchasingPackage: { chunks: [], totalSize: 0, fileName: '' }
};

// 下载锁（上传时锁定下载）
const downloadLocks = {
  client: false,
  groupPurchasing: false
};

// 下载跟踪（用于终止正在进行的下载）
const activeDownloads = new Map();

// 终止指定类型的所有下载
function terminateDownloads(type) {
  const downloadsToTerminate = [];
  
  // 收集要终止的下载
  for (const [downloadId, downloadInfo] of activeDownloads.entries()) {
    if (downloadInfo.type === type) {
      downloadsToTerminate.push(downloadId);
    }
  }
  
  // 终止下载
  for (const downloadId of downloadsToTerminate) {
    const downloadInfo = activeDownloads.get(downloadId);
    if (downloadInfo && downloadInfo.response) {
      try {
        // 向客户端发送终止信号
        downloadInfo.response.writeHead(409, {
          'Content-Type': 'application/json'
        });
        downloadInfo.response.end(JSON.stringify({
          error: 'download-terminated',
          message: '上传开始，下载已终止'
        }));
        log(`终止下载: ${downloadId} (${type})`, LOG_TYPES.INFO);
      } catch (error) {
        log(`终止下载失败: ${downloadId}, 错误: ${error.message}`, LOG_TYPES.ERROR);
      } finally {
        // 从跟踪表中移除
        activeDownloads.delete(downloadId);
      }
    }
  }
  
  return downloadsToTerminate.length;
}

// 上传时间跟踪
let lastUploadTime = 0;

// 管理员账号（从 data/adminAccounts.json 读取）
let adminAccounts = {};

// ==================== 3. 数据结构定义 ====================
let rooms = [];
let userAccounts = {};
let dataChangeTimer = null;

const userConnections = new Map();
const adminConnections = new Map();
const roomUsers = new Map();
const loginKeys = new Map();
const crashTimers = new Map();
const roomRideCheckTimers = new Map();
const rideRecords = [];
const crashReports = [];
// 首程加分用户记录（服务端启动时为空，存储已获得首程加分的用户 accountId）
const firstRideBonusUsers = [];

// ==================== 路线测试任务数据 ====================
let routeTestTasks = [];     // 任务池：[{ taskId, routeFileName, routeContent, routeType, statisticsMode, activatePickup, underwater, timeRule, requiredCount, results, status, createdAt }]
let routeTestRecords = [];   // 结果记录：[{ recordId, taskId, routeFileName, accountId, date, routeTime, monsterNum, itemNum, expectMora, normalNum, eliteNum, reportedAt }]

// ==================== 发车管理模块 ====================
const RideManager = {
  activeRides: new Map(),
  roomLocks: new Map(),
  pendingOnlineRequests: new Map(),
  recentCompletedRides: new Map(),
  STATUS: {
    WAITING_FOR_READY: 'waiting_for_ready',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
  },

  createRideState(roomName, host, teamMembers) {
    const allRiders = [host, ...teamMembers];
    const removedUsersCache = this.removeRidersFromAllRooms(allRiders);
    
    return {
      roomName,
      host,
      teamMembers,
      riders: allRiders,
      status: this.STATUS.WAITING_FOR_READY,
      createdAt: Date.now(),
      timeoutId: null,
      readyStatus: new Map(),
      removedUsersCache,
      memberImages: []
    };
  },

  removeRidersFromAllRooms(riders) {
    const cache = [];
    riders.forEach(rider => {
      for (const [roomName, room] of roomUsers.entries()) {
        const index = room.users.findIndex(u => u.uid === rider.uid);
        if (index !== -1) {
          const removedUser = room.users.splice(index, 1)[0];
          cache.push({
            ...removedUser,
            originalRoom: roomName
          });
          log(`骑手 ${rider.username} (${rider.uid}) 已从房间 ${roomName} 移除`, LOG_TYPES.RIDE, { username: rider.username, uid: rider.uid, room: roomName });
        }
      }
    });
    return cache;
  },

  restoreRiders(ride, onlyReady = false) {
    if (!ride.removedUsersCache || ride.removedUsersCache.length === 0) return;
    
    const readyUids = onlyReady && ride.readyStatus 
      ? new Set([...ride.readyStatus.entries()].filter(([, isReady]) => isReady).map(([uid]) => uid))
      : null;
    
    ride.removedUsersCache.forEach(cachedUser => {
      if (readyUids && !readyUids.has(cachedUser.uid)) {
        return;
      }
      
      const originalRoom = roomUsers.get(cachedUser.originalRoom);
      if (originalRoom) {
        const exists = originalRoom.users.some(u => u.uid === cachedUser.uid);
        if (!exists) {
          const { originalRoom: _, ...userData } = cachedUser;
          originalRoom.users.push(userData);
          log(`用户 ${cachedUser.username} (${cachedUser.uid}) 已恢复到房间 ${cachedUser.originalRoom}`, LOG_TYPES.RIDE, { username: cachedUser.username, uid: cachedUser.uid, room: cachedUser.originalRoom });
        }
      }
    });
  },

  handleRideSuccess(rideId) {
    const ride = this.activeRides.get(rideId);
    if (!ride) return;
    
    ride.riders.forEach(rider => {
      if (this.pendingOnlineRequests.has(rider.uid)) {
        this.pendingOnlineRequests.delete(rider.uid);
        log(`发车成功，丢弃用户 ${rider.uid} 的缓存上线请求`, LOG_TYPES.INFO, { uid: rider.uid });
      }
    });
    
    const cooldownTime = 5 * 60 * 1000;
    ride.riders.forEach(rider => {
      this.recentCompletedRides.set(rider.uid, Date.now() + cooldownTime);
      log(`用户 ${rider.uid} 进入发车冷却期，5分钟内不能再次上线`, LOG_TYPES.RIDE, { uid: rider.uid });
    });
    
    ride.status = this.STATUS.COMPLETED;
    this.activeRides.delete(rideId);
    
    log(`发车 ${rideId} 已完成`, LOG_TYPES.RIDE, { rideId: rideId });
    
    scheduleRideCheck(ride.roomName);
  },

  handleRideCancel(rideId, reason = 'unknown') {
    const ride = this.activeRides.get(rideId);
    if (!ride) return;
    
    this.restoreRiders(ride, true);
    
    ride.riders.forEach(rider => {
      const pending = this.pendingOnlineRequests.get(rider.uid);
      if (pending) {
        log(`处理用户 ${rider.uid} 的缓存上线请求`, LOG_TYPES.INFO, { uid: rider.uid });
        handleUserOnline(pending.data, pending.socket);
        this.pendingOnlineRequests.delete(rider.uid);
      }
    });
    
    ride.status = this.STATUS.CANCELLED;
    this.activeRides.delete(rideId);
    
    updateRideRecordStatus(rideId, 'cancelled');
    
    log(`发车 ${rideId} 已取消: ${reason}`, LOG_TYPES.RIDE, { rideId: rideId, reason: reason });
    
    scheduleRideCheck(ride.roomName);
  },

  isUserInAnyRide(uid) {
    for (const [, ride] of this.activeRides.entries()) {
      if (ride.riders && ride.riders.some(rider => rider.uid === uid)) {
        return true;
      }
    }
    return false;
  },

  cacheOnlineRequest(uid, data, socket) {
    this.pendingOnlineRequests.set(uid, {
      data: { ...data },
      socket,
      timestamp: Date.now()
    });
    log(`用户 ${uid} 正在发车中，缓存上线请求`, LOG_TYPES.INFO, { uid: uid });
  },

  getRoomActiveRide(roomName) {
    for (const [rideId, ride] of this.activeRides.entries()) {
      if (ride.roomName === roomName) {
        return { rideId, ride };
      }
    }
    return null;
  },

  cleanExpiredCooldowns() {
    const now = Date.now();
    for (const [uid, expiry] of this.recentCompletedRides.entries()) {
      if (now >= expiry) {
        this.recentCompletedRides.delete(uid);
      }
    }
  }
};

// ==================== 发车管理模块结束 ====================

// 加载发车记录
function loadRideRecords() {
  try {
    if (fs.existsSync(rideRecordsDir)) {
      const rideFiles = fs.readdirSync(rideRecordsDir).filter(file => file.endsWith('.json'));
      
      // 按文件修改时间排序，最新的在前
      rideFiles.sort((a, b) => {
        const aPath = path.join(rideRecordsDir, a);
        const bPath = path.join(rideRecordsDir, b);
        return fs.statSync(bPath).mtime.getTime() - fs.statSync(aPath).mtime.getTime();
      });
      
      // 只加载最新的两个文件
      const recentFiles = rideFiles.slice(0, 2);
      
      recentFiles.forEach(file => {
        const filePath = path.join(rideRecordsDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (content) {
            const records = JSON.parse(content);
            if (Array.isArray(records)) {
              rideRecords.push(...records);
            }
          }
        } catch (error) {
          log(`加载发车记录文件 ${file} 失败: ${error.message}`, LOG_TYPES.ERROR);
        }
      });
      
      // 限制rideRecords数组大小，只保留最近的1000条记录
      if (rideRecords.length > 1000) {
        // 由于rideRecords是const数组，使用splice方法修改
        rideRecords.splice(0, rideRecords.length - 1000);
      }
      
      log(`加载了 ${rideRecords.length} 条发车记录（来自 ${recentFiles.length} 个最新文件）`, LOG_TYPES.INFO);
    }
  } catch (error) {
    handleError(error, 'loadRideRecords');
  }
}

/**
 * 检查账户是否是首次作为队员发车（服务端启动后）
 * 最简单粗暴的实现：检查用户是否在首程加分记录数组中
 * @param {string} accountId - 账户ID
 * @returns {boolean} 是否首次作为队员发车
 */
function isFirstTeamRideToday(accountId) {
  // 检查用户是否已经获得过首程加分
  if (firstRideBonusUsers.includes(accountId)) {
    // 已经在数组中，不额外加分
    return false;
  }
  
  // 不在数组中，标记为已获得首程加分并返回 true
  firstRideBonusUsers.push(accountId);
  log(`用户 ${accountId} 获得首程额外加分`, LOG_TYPES.RIDE, { accountId: accountId });
  return true;
}

// ==================== 数据持久化模块 ====================
/**
 * 通过socket.id获取连接数据
 * @param {string} socketId - Socket ID
 * @returns {Object|null} 连接数据对象 { accountId, username, isAdmin, roomName, uid, socketId, connection }
 */
function getConnectionBySocketId(socketId) {
  // 先在userConnections中查找
  for (const [accountId, userConn] of userConnections.entries()) {
    const connection = userConn.connections.find(conn => conn.socketId === socketId);
    if (connection) {
      return {
        accountId,
        username: userConn.userInfo.username,
        isAdmin: false,
        roomName: connection.roomName || '',
        uid: connection.uid || '',
        username_current: connection.username || '',
        socketId,
        connectionId: connection.connectionId || '连接',
        connection
      };
    }
  }
  
  // 再在adminConnections中查找
  for (const [accountId, adminConn] of adminConnections.entries()) {
    const connection = adminConn.connections.find(conn => conn.socketId === socketId);
    if (connection) {
      return {
        accountId,
        username: adminConn.adminInfo.username,
        isAdmin: true,
        roomName: connection.roomName || '',
        uid: '',
        username_current: '',
        socketId,
        connectionId: connection.connectionId || '连接',
        connection
      };
    }
  }
  
  return null;
}

/**
 * 根据账户ID和socketID查找连接信息
 * @param {string} accountId - 账户ID
 * @param {string} socketId - Socket ID
 * @returns {Object|null} 连接数据对象 { accountId, username, isAdmin, roomName, uid, socketId, connectionId, connection }
 */
function getConnectionByAccountIdAndSocketId(accountId, socketId) {
  // 在userConnections中查找
  const userConn = userConnections.get(accountId);
  if (userConn) {
    const connection = userConn.connections.find(conn => conn.socketId === socketId);
    if (connection) {
      return {
        accountId,
        username: userConn.userInfo.username,
        isAdmin: false,
        roomName: connection.roomName || '',
        uid: connection.uid || '',
        username_current: connection.username || '',
        socketId,
        connectionId: connection.connectionId || '连接',
        connection
      };
    }
  }
  
  return null;
}

/**
 * 设置连接的userInfo和roomName
 * @param {string} socketId - Socket ID
 * @param {Object} data - 要设置的数据 { username, uid, roomName }
 */
function setConnectionUserInfo(socketId, data) {
  const conn = getConnectionBySocketId(socketId);
  if (conn && conn.connection) {
    if (data.username !== undefined) conn.connection.username = data.username;
    if (data.uid !== undefined) conn.connection.uid = data.uid;
    if (data.roomName !== undefined) conn.connection.roomName = data.roomName;
  }
}

/**
 * 检查socket是否存在
 * @param {string} socketId - Socket ID
 * @returns {boolean}
 */
function hasConnection(socketId) {
  return getConnectionBySocketId(socketId) !== null;
}

/**
 * 计算实际连接数
 * @returns {number} 实际连接数
 */
function getTotalConnections() {
  let total = 0;
  
  // 计算用户连接数
  for (const userConnection of userConnections.values()) {
    total += userConnection.connections.length;
  }
  
  // 计算管理员连接数
  for (const adminConnection of adminConnections.values()) {
    total += adminConnection.connections.length;
  }
  
  return total;
}

/**
 * 删除连接
 * @param {string} socketId - Socket ID
 */
function deleteConnection(socketId) {
  // 从userConnections中删除
  for (const [accountId, userConn] of userConnections.entries()) {
    const index = userConn.connections.findIndex(conn => conn.socketId === socketId);
    if (index !== -1) {
      userConn.connections.splice(index, 1);
      if (userConn.connections.length === 0) {
        userConnections.delete(accountId);
      }
      return;
    }
  }
  
  // 从adminConnections中删除
  for (const [accountId, adminConn] of adminConnections.entries()) {
    const index = adminConn.connections.findIndex(conn => conn.socketId === socketId);
    if (index !== -1) {
      adminConn.connections.splice(index, 1);
      if (adminConn.connections.length === 0) {
        adminConnections.delete(accountId);
      }
      return;
    }
  }
}

/**
 * 获取所有连接
 * @returns {Array} 连接数据数组
 */
function getAllConnections() {
  const connections = [];
  
  for (const [accountId, userConn] of userConnections.entries()) {
    for (const conn of userConn.connections) {
      connections.push({
        socketId: conn.socketId,
        accountId,
        username: userConn.userInfo.username,
        isAdmin: false,
        roomName: conn.roomName || '',
        uid: conn.uid || '',
        username_current: conn.username || '',
        connectionId: conn.connectionId || '连接'
      });
    }
  }
  
  for (const [accountId, adminConn] of adminConnections.entries()) {
    for (const conn of adminConn.connections) {
      connections.push({
        socketId: conn.socketId,
        accountId,
        username: adminConn.adminInfo.username,
        isAdmin: true,
        roomName: conn.roomName || '',
        uid: '',
        username_current: '',
        connectionId: conn.connectionId || '连接'
      });
    }
  }
  
  return connections;
}

// 确保目录存在
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
if (!fs.existsSync(rideRecordsDir)) fs.mkdirSync(rideRecordsDir, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(gainRecordsDir)) fs.mkdirSync(gainRecordsDir, { recursive: true });

/**
 * 清理指定目录下超过指定天数的旧文件
 * @param {string} dirPath - 目录路径
 * @param {number} daysToKeep - 保留天数
 * @param {string} [extension='.json'] - 文件扩展名过滤
 */
function cleanupOldRecords(dirPath, daysToKeep, extension = '.json') {
  try {
    if (!fs.existsSync(dirPath)) {
      return;
    }
    
    const files = fs.readdirSync(dirPath).filter(file => file.endsWith(extension));
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    
    files.forEach(file => {
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          log(`清理旧记录文件: ${file}`, LOG_TYPES.INFO);
        }
      } catch (error) {
        log(`清理旧记录文件失败: ${file} - ${error.message}`, LOG_TYPES.ERROR);
      }
    });
  } catch (error) {
    log(`清理旧记录失败: ${error.message}`, LOG_TYPES.ERROR);
  }
}

// ==================== 4. 错误处理 ====================
// 自定义错误类
class AppError extends Error {
  constructor(message, type = ErrorType.INTERNAL, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.type = type;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

// ==================== 5. 工具函数 ====================
/**
 * 处理错误
 * @param {Error} error - 错误对象
 * @param {string} [context=''] - 错误上下文
 * @returns {Object} 错误信息对象
 * @example
 * // 处理错误
 * handleError(new Error('数据库连接失败'), '数据库操作');
 */
function handleError(error, context = '') {
  const errorInfo = {
    message: error.message || '未知错误',
    type: error.type || ErrorType.INTERNAL,
    statusCode: error.statusCode || 500,
    details: error.details || null,
    context: context,
    stack: error.stack,
    timestamp: new Date().toISOString()
  };

  // 记录错误日志
  log(`错误 [${errorInfo.type}]: ${errorInfo.message} ${context ? `(${context})` : ''}`, LOG_TYPES.ERROR);

  if (error.stack) {
    log(`错误堆栈: ${error.stack}`, LOG_TYPES.ERROR);
  }

  if (errorInfo.details) {
    log(`错误详情: ${JSON.stringify(errorInfo.details)}`, LOG_TYPES.ERROR);
  }

  return errorInfo;
}

/**
 * 获取北京时间（UTC+8）
 * @param {Date} [date] - 要转换的日期对象，默认使用当前时间
 * @returns {Date} 北京时间的Date对象
 * @example
 * // 获取当前北京时间
 * const now = getBeijingTime();
 * console.log(now.toLocaleString());
 * 
 * // 转换指定日期为北京时间
 * const recordDate = getBeijingTime(new Date(record.createdAt));
 */
function getBeijingTime(date = new Date()) {
  const utcTime = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utcTime + 8 * 60 * 60 * 1000);
}

/**
 * 日志函数
 * @param {string} message - 日志消息
 * @param {string} [eventType=LOG_TYPES.INFO] - 日志类型
 * @param {Object} [context={}] - 上下文信息对象
 * @example
 * // 记录普通信息日志
 * log('用户登录成功', LOG_TYPES.LOGIN, { username: '张三', uid: '123456' });
 * 
 * // 记录错误日志
 * log('操作失败', LOG_TYPES.ERROR, { error: '权限不足' });
 */
function log(message, eventType = LOG_TYPES.INFO, context = {}) {
  const date = getBeijingTime();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD
  const timeStr = date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 构建上下文信息（限制长度，最多3个字段）
  let contextStr = '';
  if (Object.keys(context).length > 0) {
    const contextParts = [];
    // 按照重要性排序添加上下文信息
    if (context.rideId) contextParts.push(`ride=${context.rideId}`);
    if (context.room) contextParts.push(`room=${context.room}`);
    if (context.uid) contextParts.push(`uid=${context.uid}`);
    if (contextParts.length < 3 && context.username) contextParts.push(`user=${context.username}`);
    if (contextParts.length < 3 && context.accountId) contextParts.push(`account=${context.accountId}`);
    if (contextParts.length < 3 && context.socketId) contextParts.push(`socket=${context.socketId}`);

    // 限制上下文信息长度
    const limitedParts = contextParts.slice(0, 3);
    if (limitedParts.length > 0) {
      contextStr = ` [${limitedParts.join(', ')}]`;
    }
  }

  const logMessage = `[${timeStr}] [${eventType.toUpperCase()}] ${message}${contextStr}`;

  // 输出到控制台
  console.log(logMessage);

  // 写入日志文件
  const logFilePath = path.join(logDir, `${dateStr}.log`);
  fs.appendFile(logFilePath, logMessage + '\n', (err) => {
    if (err) {
      console.error('写入日志文件失败:', err);
    }
  });

  // 每100次调用清理一次旧日志文件（避免频繁清理）
  if (logCallCount % 100 === 0) {
    cleanupOldRecords(logDir, 42, '.log');
  }
  logCallCount++;
}

// 日志调用计数器（用于控制清理频率）
let logCallCount = 0;

/**
 * 生成随机六位密钥
 * @returns {string} 六位数字的随机密钥
 * @example
 * // 生成登录密钥
 * const key = generateRandomKey();
 * console.log(key); // 输出类似 "123456"
 */
function generateRandomKey() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 比较两个版本号
 * @param {string} v1 版本号1
 * @param {string} v2 版本号2
 * @returns {number} -1: v1 < v2, 0: v1 == v2, 1: v1 > v2
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

// ==================== 6. 数据管理函数 ====================
/**
 * 重置数据变更定时器
 * @returns {void}
 * @example
 * // 重置数据变更定时器
 * resetDataChangeTimer();
 */
function resetDataChangeTimer() {
  if (dataChangeTimer) {
    clearTimeout(dataChangeTimer);
  }
  dataChangeTimer = setTimeout(async () => {
    try {
      await saveAllData();
      log('自动保存数据完成', LOG_TYPES.CLEANUP);
    } catch (error) {
      handleError(error, 'resetDataChangeTimer');
    }
  }, DATA_CHANGE_DELAY);
}

/**
 * 清理在线数据
 * @returns {Promise<void>}
 * @example
 * // 清理在线数据
 * await cleanupOnlineData();
 */
async function cleanupOnlineData() {
  try {
    // 清理过期的登录密钥
    const now = Date.now();
    for (const [socketId, { timestamp }] of loginKeys.entries()) {
      if (now - timestamp > 5 * 60 * 1000) { // 5分钟过期
        loginKeys.delete(socketId);
      }
    }

    // 清理空房间
    for (const [roomName, room] of roomUsers.entries()) {
      if (room.users.length === 0) {
        roomUsers.delete(roomName);
      }
    }

    log('清理在线数据完成', LOG_TYPES.CLEANUP);
  } catch (error) {
    handleError(error, 'cleanupOnlineData');
  }
}

/**
 * 处理清理在线数据请求
 * @param {Object} data - 清理数据请求数据
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理清理在线数据请求
 * await handleCleanupOnlineData({}, socket);
 */
async function handleCleanupOnlineData(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  await cleanupOnlineData();
  socket.emit('message', {
    type: 'cleanup-success',
    message: '清理在线数据完成'
  });
  log('管理员手动清理在线数据', LOG_TYPES.ADMIN);
}

/**
 * 加载数据
 * @param {string} filePath - 文件路径
 * @param {*} defaultValue - 默认值
 * @returns {Promise<*>} 加载的数据
 * @example
 * // 加载房间数据
 * const rooms = await loadData(ROOMS_FILE, []);
 */
async function loadData(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
    return defaultValue;
  } catch (error) {
    handleError(error, 'loadData');
    return defaultValue;
  }
}

/**
 * 保存数据
 * @param {string} filePath - 文件路径
 * @param {*} data - 要保存的数据
 * @returns {Promise<void>}
 * @example
 * // 保存房间数据
 * await saveData(ROOMS_FILE, rooms);
 */
async function saveData(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    handleError(error, 'saveData');
    throw error;
  }
}

/**
 * 保存所有数据
 * @returns {Promise<void>}
 * @example
 * // 保存所有数据
 * await saveAllData();
 */
async function saveAllData() {
  try {
    await saveData(ROOMS_FILE, rooms);
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
  } catch (error) {
    handleError(error, 'saveAllData');
    throw error;
  }
}

/**
 * 清理数据
 * @returns {void}
 * @example
 * // 清理数据
 * cleanupData();
 */
function cleanupData() {
  try {
        // 清理过期的炸车定时器
    const now = Date.now();
    for (const [rideKey, timerInfo] of crashTimers.entries()) {
      const { startTime, delay } = timerInfo;
      // 检查定时器是否到期
      if (now >= startTime + delay) {
        timerManager.clearTimeout(timerInfo.timeoutId);
        crashTimers.delete(rideKey);
        log(`清理到期的炸车定时器: ${rideKey}`, LOG_TYPES.CLEANUP, { rideKey: rideKey });
      }
    }

    // 清理过期的房间发车锁
    for (const [roomName, isLocked] of RideManager.roomLocks.entries()) {
      if (isLocked) {
        // 清除所有被锁定的房间，防止死锁
        RideManager.roomLocks.delete(roomName);
      }
    }

    // 清理过期的发车检查计时器
    for (const [roomName, timerId] of roomRideCheckTimers.entries()) {
      timerManager.clearTimeout(timerId);
      roomRideCheckTimers.delete(roomName);
      log(`清理过期的发车检查计时器: ${roomName}`, LOG_TYPES.CLEANUP, { room: roomName });
    }

    log('清理数据完成', LOG_TYPES.CLEANUP);
  } catch (error) {
    handleError(error, 'cleanupData');
  }
}

/**
 * 初始化数据
 * @returns {Promise<void>}
 * @example
 * // 初始化数据
 * await initData();
 */
async function initData() {
  try {
    // 加载房间数据
    rooms = await loadData(ROOMS_FILE, []);

    // 加载用户账户数据
    userAccounts = await loadData(USER_ACCOUNTS_FILE, {});

    // 初始化旧数据：确保所有用户有 lastRide 字段
    let lastRideInited = false;
    for (const account of Object.values(userAccounts)) {
      if (account.lastRide === undefined || account.lastRide === null || typeof account.lastRide !== 'number') {
        account.lastRide = null;
        lastRideInited = true;
      }
    }
    if (lastRideInited) {
      await saveData(USER_ACCOUNTS_FILE, userAccounts);
      log(`已初始化部分用户账户的 lastRide 字段`, LOG_TYPES.INFO);
    }

    // 加载版本数据
    versions = await loadData(VERSIONS_FILE, DEFAULT_VERSIONS);

    // 加载管理员账号
    adminAccounts = await loadData(ADMIN_ACCOUNTS_FILE, {});

    // 确保大澡堂和待机房间存在
    if (!rooms.some(room => room.name === '大澡堂')) {
      rooms.push({ name: '大澡堂', mode: 'points', count: 4 });
    }
    if (!rooms.some(room => room.name === '待机')) {
      rooms.push({ name: '待机', mode: 'none', count: 4 });
    }

    // 确保大澡堂和待机房间的属性正确
    rooms = rooms.map(room => {
      if (room.name === '大澡堂') {
        return { name: room.name, mode: 'points', count: 4 };
      } else if (room.name === '待机') {
        return { name: room.name, mode: 'none', count: 4 };
      } else {
        return room;
      }
    });

    await saveData(ROOMS_FILE, rooms);

    // 确保 asar 目录存在
    if (!fs.existsSync(ASAR_DIR)) {
      fs.mkdirSync(ASAR_DIR, { recursive: true });
      log(`创建 asar 目录: ${ASAR_DIR}`, LOG_TYPES.INFO);
    }

    // 加载路线测试任务与结果记录
    routeTestTasks = await loadData(ROUTE_TASKS_FILE, []);
    routeTestRecords = await loadData(ROUTE_RECORDS_FILE, []);

    log(`初始化数据完成，加载了 ${rooms.length} 个房间，${Object.keys(userAccounts).length} 个用户账户，${routeTestTasks.length} 个路线测试任务`, LOG_TYPES.INFO);
  } catch (error) {
    handleError(error, 'initData');
    throw error;
  }
}

// ==================== 7. 用户认证函数 ====================
/**
 * 处理用户登录
 * @param {Object} data - 登录数据
 * @param {string} data.accountId - 账户ID
 * @param {string} data.password - 密码
 * @param {string} [data.key] - 登录密钥
 * @param {boolean} [data.isAdminLogin] - 是否管理员登录
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 首次登录请求
 * handleUserLogin({ accountId: 'user1', password: '123456' }, socket);
 * 
 * // 第二次登录请求（带密钥）
 * handleUserLogin({ accountId: 'user1', password: 'hashedPassword', key: '123456' }, socket);
 */
function handleUserLogin(data, socket) {
  try {
    log(`收到登录请求: ${JSON.stringify(data)}`, LOG_TYPES.INFO);
    const { accountId, password, key, isAdminLogin, version, codeHash } = data;

    // 验证输入参数
    if (!accountId) {
      throw new AppError('登录参数不完整', ErrorType.VALIDATION, 400, { accountId: !!accountId });
    }

    if (!key) {
      // 验证版本号（仅对非管理员且非移动端用户）
      if (!isAdminLogin && !data.isMobile) {
        const minVersion = '1.8.2';
        if (!version) {
          socket.emit('message', {
            type: 'login-error',
            message: '版本号信息缺失，请前往群文件更新后重试'
          });
          log(`用户 ${accountId} 登录失败: 版本号信息缺失`, LOG_TYPES.LOGIN, { accountId: accountId });
          return;
        }
        if (compareVersions(version, minVersion) < 0) {
          socket.emit('message', {
            type: 'login-error',
            message: `客户端版本过低（当前: ${version}，要求: ${minVersion}），请更新客户端后重试`
          });
          log(`用户 ${accountId} 登录失败: 版本号过低（当前: ${version}，要求: ${minVersion}）`, LOG_TYPES.LOGIN, { accountId: accountId, version: version, minVersion: minVersion });
          return;
        }
      }

      // 首次登录请求，返回随机密钥
      const randomKey = generateRandomKey();
      loginKeys.set(socket.id, {
        accountId: accountId,
        key: randomKey,
        isAdminLogin: isAdminLogin,
        connectionName: data.connectionName, // 存储连接名称
        version: version || '未知', // 存储版本号
        timestamp: Date.now()
      });

      socket.emit('message', {
        type: 'login-key',
        key: randomKey
      });
      log(`向用户 ${accountId} 发送登录密钥，版本号: ${version || '未知'}`, LOG_TYPES.LOGIN, { accountId: accountId, version: version });
    } else {
      // 第二次登录请求，验证哈希密码
      const loginInfo = loginKeys.get(socket.id);
      if (!loginInfo || loginInfo.accountId !== accountId || loginInfo.isAdminLogin !== isAdminLogin) {
        socket.emit('message', {
          type: 'login-error',
          message: '登录请求无效，请重新登录'
        });
        log(`用户 ${accountId} 登录失败: 登录请求无效`, LOG_TYPES.LOGIN, { accountId: accountId, reason: '登录请求无效' });
        return;
      }

      // 检查密钥是否过期（5分钟）
      if (Date.now() - loginInfo.timestamp > 5 * 60 * 1000) {
        socket.emit('message', {
          type: 'login-error',
          message: '登录密钥已过期，请重新登录'
        });
        loginKeys.delete(socket.id);
        log(`用户 ${accountId} 登录失败: 密钥已过期`, LOG_TYPES.LOGIN, { accountId: accountId, reason: '密钥已过期' });
        return;
      }

      if (isAdminLogin) {
        // 管理员登录
        const adminAccount = adminAccounts[accountId];
        if (adminAccount) {
          // 计算存储密码+密钥的哈希
          const storedHash = require('crypto').createHash('sha256').update(adminAccount.password + loginInfo.key).digest('hex');
          if (storedHash === password) {
            // 更新管理员连接管理
            if (!adminConnections.has(accountId)) {
              adminConnections.set(accountId, {
                adminInfo: {
                  username: adminAccount.username,
                  accountId: accountId
                },
                connections: []
              });
            }
            
            // 安全检查：确保当前socket.id没有被其他管理员账户使用
            for (const [otherAccountId, otherAdminConn] of adminConnections.entries()) {
              if (otherAccountId !== accountId) {
                const existingConnIndex = otherAdminConn.connections.findIndex(conn => conn.socketId === socket.id);
                if (existingConnIndex !== -1) {
                  log(`检测到socket.id ${socket.id} 被管理员账户 ${otherAccountId} 使用，已清理`, LOG_TYPES.WARN);
                  otherAdminConn.connections.splice(existingConnIndex, 1);
                  if (otherAdminConn.connections.length === 0) {
                    adminConnections.delete(otherAccountId);
                  }
                }
              }
            }
            
            adminConnections.get(accountId).connections.push({
              socketId: socket.id,
              roomName: ''
            });
            log(`管理员认证成功: socketId=${socket.id}, accountId=${accountId}`, LOG_TYPES.ADMIN);

            if (socket.authTimeout) {
              timerManager.clearTimeout(socket.authTimeout);
              socket.authTimeout = null;
            }

            // 计算连接ID（当前连接数）
            const adminConnection = adminConnections.get(accountId);
            const connectionId = adminConnection ? adminConnection.connections.length : 1;

            // 更新最后添加的连接，存储 connectionId
            const connections = adminConnection.connections;
            if (connections.length > 0) {
              connections[connections.length - 1].connectionId = connectionId;
            }

            socket.emit('message', {
              type: 'login-success',
              isAdmin: true,
              accountId: accountId,
              username: adminAccount.username,
              connectionId: connectionId
            });
            loginKeys.delete(socket.id);
            log(`管理员 ${accountId} 登录成功，连接ID: ${connectionId}`, LOG_TYPES.ADMIN, { accountId: accountId, connectionId: connectionId });
          } else {
            socket.emit('message', {
              type: 'login-error',
              message: '账号或密码错误'
            });
            log(`管理员登录失败: ${accountId}`, LOG_TYPES.ADMIN, { accountId: accountId, reason: '账号或密码错误' });
          }
        } else {
          socket.emit('message', {
            type: 'login-error',
            message: '账号或密码错误'
          });
          log(`管理员登录失败: ${accountId}`, LOG_TYPES.ADMIN, { accountId: accountId, reason: '账号不存在' });
        }
      } else {
        // 普通用户登录
        const account = userAccounts[accountId];
        if (account) {
          // 常规密码验证（与之前相同）
          const storedHash = require('crypto').createHash('sha256').update(account.password + loginInfo.key).digest('hex');
          if (storedHash === password) {
            // 密码匹配后，检查客户端代码完整性（仅记录，不阻止登录）
            if (data.isMobile) {
              // 移动端不进行代码完整性校验
            } else if (!codeHash || !loginInfo.version) {
              const missingFields = [];
              if (!codeHash) missingFields.push('codeHash');
              if (!loginInfo.version) missingFields.push('version');
              log(`客户端代码完整性校验失败: 用户 ${accountId} 的登录请求缺少字段 ${missingFields.join('、')}`, LOG_TYPES.CODEHASH, {
                accountId: accountId,
                missingFields: missingFields.join(',')
              });
            } else {
              const sourcePath = path.join(ASAR_DIR, loginInfo.version, 'source.txt');
              if (fs.existsSync(sourcePath)) {
                try {
                  const crypto = require('crypto');
                  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
                  // 与客户端一致：SHA256(源码文本 + key)
                  const expectedCodeHash = crypto.createHash('sha256').update(Buffer.concat([
                    Buffer.from(sourceContent, 'utf8'),
                    Buffer.from(loginInfo.key || '')
                  ])).digest('hex');
                  if (codeHash !== expectedCodeHash) {
                    log(`检测到客户端篡改: 用户 ${accountId}（版本 ${loginInfo.version}）的代码哈希不匹配`, LOG_TYPES.CODEHASH, {
                      accountId: accountId,
                      version: loginInfo.version,
                      expected: expectedCodeHash,
                      received: codeHash
                    });
                  } else {
                    log(`客户端代码完整性校验通过: 用户 ${accountId}（版本 ${loginInfo.version}）`, LOG_TYPES.CODEHASH, {
                      accountId: accountId,
                      version: loginInfo.version
                    });
                  }
                } catch (e) {
                  log(`读取 source.txt 文件失败: ${e.message}`, LOG_TYPES.ERROR);
                }
              } else {
                log(`客户端代码完整性校验失败: 用户 ${accountId}（版本 ${loginInfo.version}）的服务端未上传对应版本 app.asar`, LOG_TYPES.CODEHASH, {
                  accountId: accountId,
                  version: loginInfo.version
                });
              }
            }
            // 更新用户连接管理
            if (!userConnections.has(accountId)) {
              userConnections.set(accountId, {
                userInfo: {
                  username: account.username,
                  accountId: accountId
                },
                connections: []
              });
            }
            
            // 计算连接ID（支持自定义名称和自动重命名）
            const userConnection = userConnections.get(accountId);
            const userConnectionName = loginInfo.connectionName || undefined;
            let connectionId;
            
            if (userConnectionName === undefined || userConnectionName === '') {
              // 未填写自定义名称，使用默认格式：连接1、连接2、连接3
              connectionId = `连接${userConnection.connections.length + 1}`;
            } else {
              // 用户填写了自定义名称，检查是否有重名
              const existingNames = userConnection.connections.map(conn => conn.connectionId);
              let baseName = userConnectionName;
              let counter = 1;
              connectionId = baseName;
              
              // 如果名称已存在，自动重命名为 名字2、名字3...
              while (existingNames.includes(connectionId)) {
                connectionId = `${baseName}${counter}`;
                counter++;
              }
            }
            
            // 安全检查：确保当前socket.id没有被其他账户使用
            // 这是防止连接串线的关键检查
            for (const [otherAccountId, otherUserConn] of userConnections.entries()) {
              if (otherAccountId !== accountId) {
                const existingConnIndex = otherUserConn.connections.findIndex(conn => conn.socketId === socket.id);
                if (existingConnIndex !== -1) {
                  log(`检测到socket.id ${socket.id} 被账户 ${otherAccountId} 使用，已清理`, LOG_TYPES.SOCKET);
                  otherUserConn.connections.splice(existingConnIndex, 1);
                  if (otherUserConn.connections.length === 0) {
                    userConnections.delete(otherAccountId);
                  }
                }
              }
            }
            
            userConnections.get(accountId).connections.push({
              socketId: socket.id,
              roomName: '',
              username: account.username,
              uid: '',
              connectionId: connectionId,
              isMobile: data.isMobile || false
            });
            log(`用户认证成功: socketId=${socket.id}, accountId=${accountId}`, LOG_TYPES.LOGIN, { accountId: accountId });

            // 初始化账户连接信息

            socket.emit('message', {
              type: 'login-success',
              isAdmin: false,
              accountId: accountId,
              username: account.username,
              connectionId: connectionId
            });
            loginKeys.delete(socket.id);
            log(`用户 ${accountId} 登录成功，连接ID: ${connectionId}`, LOG_TYPES.LOGIN, { accountId: accountId, connectionId: connectionId });
          } else {
            socket.emit('message', {
              type: 'login-error',
              message: '账号或密码错误'
            });
            log(`用户登录失败: ${accountId}`, LOG_TYPES.ERROR, { accountId: accountId, reason: '账号或密码错误' });
          }
        } else {
          socket.emit('message', {
            type: 'login-error',
            message: '账号或密码错误'
          });
          log(`用户登录失败: ${accountId}`, LOG_TYPES.LOGIN, { accountId: accountId, reason: '账号不存在' });
        }
      }
    }
  } catch (error) {
    handleError(error, 'handleUserLogin');
    socket.emit('message', {
      type: 'login-error',
      message: '登录过程中发生错误，请稍后重试'
    });
  }
}

/**
 * 处理管理员登录
 * @param {Object} data - 登录数据
 * @param {string} data.account - 管理员账户
 * @param {string} data.password - 管理员密码
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 管理员登录
 * handleAdminLogin({ account: 'mno', password: '144466' }, socket);
 */
function handleAdminLogin(data, socket) {
  const { account, password } = data;

  const adminAccount = adminAccounts[account];
  if (adminAccount && adminAccount.password === password) {
    // 更新管理员连接管理
    if (!adminConnections.has(account)) {
      adminConnections.set(account, {
        adminInfo: {
          username: adminAccount.username,
          accountId: account
        },
        connections: []
      });
    }
    adminConnections.get(account).connections.push({
      socketId: socket.id,
      roomName: ''
    });

    // 计算连接ID（当前连接数）
    const adminConnection = adminConnections.get(account);
    const connectionId = adminConnection ? adminConnection.connections.length : 1;

    socket.emit('message', {
      type: 'login-success',
      isAdmin: true,
      accountId: account,
      username: adminAccount.username,
      connectionId: connectionId
    });
    log(`管理员 ${account} 登录成功，连接ID: ${connectionId}`, LOG_TYPES.ADMIN, { accountId: account, connectionId: connectionId });
  } else {
    socket.emit('message', {
      type: 'login-failed',
      message: '账号或密码错误'
    });
  }
}

// ==================== 8. 用户管理函数 ====================
/**
 * 收集用户在线项
 * @param {string} accountId - 账户ID
 * @param {string} [currentSocketId=null] - 当前socket ID
 * @returns {Array} 用户在线项数组
 * @example
 * // 收集用户在线项
 * const onlineItems = collectUserOnlineItems('user1');
 */
function collectUserOnlineItems(accountId, currentSocketId = null) {
  const onlineItems = [];

  // 遍历所有房间
  roomUsers.forEach((room, roomName) => {
    // 查找该账户在房间中的所有用户项
    const userItems = room.users.filter(item => item.accountId === accountId);
    userItems.forEach(item => {
      onlineItems.push({
        accountId: item.accountId,
        username: item.username,
        uid: item.uid,
        room: roomName,
        notHost: item.notHost,
        isCurrentSocket: item.socketId === currentSocketId
      });
    });
  });

  return onlineItems;
}

/**
 * 根据socket ID查找用户
 * @param {string} socketId - Socket ID
 * @returns {Array} 用户数组
 * @example
 * // 根据socket ID查找用户
 * const users = findUsersBySocketId('socket123');
 */
function findUsersBySocketId(socketId) {
  const users = [];

  // 遍历所有房间
  roomUsers.forEach((room, roomName) => {
    // 查找使用该socket的用户
    const userItems = room.users.filter(item => item.socketId === socketId);
    userItems.forEach(item => {
      users.push({
        ...item,
        roomName: roomName
      });
    });
  });

  return users;
}

/**
 * 获取或创建房间
 * @param {string} roomName - 房间名称
 * @returns {Object} 房间对象
 * @example
 * // 获取或创建房间
 * const room = getOrCreateRoom('大澡堂');
 */
function getOrCreateRoom(roomName) {
  if (!roomUsers.has(roomName)) {
    // 查找房间配置
    const roomConfig = rooms.find(room => room.name === roomName);
    const mode = roomConfig ? roomConfig.mode : 'random';
    const count = roomConfig ? roomConfig.count : 4;

    roomUsers.set(roomName, {
      mode: mode,
      count: count,
      users: []
    });
  }
  return roomUsers.get(roomName);
}

/**
 * 添加用户到房间
 * @param {Object} room - 房间对象
 * @param {Object} userItem - 用户项
 * @returns {Object} 更新后的房间对象
 * @example
 * // 添加用户到房间
 * const updatedRoom = addUserToRoom(room, userItem);
 */
function addUserToRoom(room, userItem) {
  room.users.push(userItem);
  return room;
}

/**
 * 初始化房间用户Map
 * @returns {Promise<void>}
 * @example
 * // 初始化房间用户
 * await initRoomUsers();
 */
async function initRoomUsers() {
  // 确保大澡堂和待机房间存在
  if (!rooms.some(room => room.name === '大澡堂')) {
    rooms.push({ name: '大澡堂', mode: 'points', count: 4 });
  }
  if (!rooms.some(room => room.name === '待机')) {
    rooms.push({ name: '待机', mode: 'none', count: 4 });
  }

  // 确保大澡堂和待机房间的属性正确
  rooms = rooms.map(room => {
    if (room.name === '大澡堂') {
      return { name: room.name, mode: 'points', count: 4 };
    } else if (room.name === '待机') {
      return { name: room.name, mode: 'none', count: 4 };
    } else {
      return room;
    }
  });

  await saveData(ROOMS_FILE, rooms);

  // 初始化roomUsers - 从userAccounts加载所有用户的房间权限
  rooms.forEach(room => {
    const roomName = room.name;
    getOrCreateRoom(roomName);
  });

  log(`初始化 roomUsers 完成，共 ${rooms.length} 个房间`, LOG_TYPES.INFO, { rooms: rooms.length });
}

/**
 * 处理用户注册（管理员功能）
 * @param {Object} data - 注册数据
 * @param {string} data.accountId - 账户ID
 * @param {string} data.username - 用户名
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 注册新用户
 * await handleRegisterUser({ accountId: 'user1', username: '张三' }, socket);
 */
async function handleRegisterUser(data, socket) {
  const { accountId, username } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (!userAccounts[accountId]) {
    userAccounts[accountId] = {
      username,
      password: '123456', // 默认密码
      isFrozen: false,
      safe: false, // 新增：信任状态，默认为false
      rooms: ['大澡堂'], // 默认只有大澡堂权限
      lastRide: null // 从未发车
    };
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
    socket.emit('message', {
      type: 'register-success',
      accountId: accountId,
      username: username
    });
    log(`注册新用户 ${accountId} (${username})`, LOG_TYPES.INFO, { accountId: accountId, username: username });
  } else {
    socket.emit('message', {
      type: 'register-error',
      message: '账号已存在'
    });
  }
}

// 处理子用户注册
// 子用户相关功能已移除，改为本地预设管理

/**
 * 处理密码修改
 * @param {Object} data - 密码修改数据
 * @param {string} data.oldPassword - 旧密码
 * @param {string} data.newPassword - 新密码
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 修改密码
 * await handleChangePassword({ oldPassword: '123456', newPassword: '654321' }, socket);
 */
async function handleChangePassword(data, socket) {
  const { oldPassword, newPassword } = data;

  // 检查是否已登录
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', {
      type: 'error',
      message: '请先登录'
    });
    return;
  }

  const accountId = socketData.accountId;
  const account = userAccounts[accountId];

  if (account.password === oldPassword) {
    account.password = newPassword;
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    socket.emit('message', {
      type: 'password-change-success',
      message: '密码修改成功'
    });
    log(`用户 ${accountId} 修改密码`, LOG_TYPES.INFO, { accountId: accountId });
  } else {
    socket.emit('message', {
      type: 'password-change-error',
      message: '原密码错误'
    });
  }
}

/**
 * 处理重置密码（管理员功能）
 * @param {Object} data - 重置密码数据
 * @param {string} data.accountId - 要重置密码的账户ID
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 重置用户密码
 * await handleResetPassword({ accountId: 'user1' }, socket);
 */
async function handleResetPassword(data, socket) {
  const { accountId } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (userAccounts[accountId]) {
    userAccounts[accountId].password = '123456'; // 重置为默认密码
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
    socket.emit('message', {
      type: 'reset-password-success',
      accountId: accountId
    });
    log(`管理员重置用户 ${accountId} 的密码`, LOG_TYPES.ADMIN, { accountId: accountId });
  } else {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
  }
}

/**
 * 处理冻结/解冻用户（管理员功能）
 * @param {Object} data - 冻结/解冻数据
 * @param {string} data.accountId - 要冻结/解冻的账户ID
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 冻结/解冻用户
 * await handleToggleFreezeUser({ accountId: 'user1' }, socket);
 */
async function handleToggleFreezeUser(data, socket) {
  const { accountId } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (userAccounts[accountId]) {
    const isFrozen = !userAccounts[accountId].isFrozen;
    userAccounts[accountId].isFrozen = isFrozen;

    // 如果是解冻用户，增加一次豁免次数
    if (!isFrozen) {
      userAccounts[accountId].freezeExemption = (userAccounts[accountId].freezeExemption || 0) + 1;
      log(`解冻用户 ${accountId}，增加豁免次数至 ${userAccounts[accountId].freezeExemption}`, LOG_TYPES.ADMIN, { accountId: accountId, freezeExemption: userAccounts[accountId].freezeExemption });
    }

    // 如果是冻结用户，下线该用户在所有房间的所有游戏名称-uid对
    if (isFrozen) {
      // 遍历所有房间
      roomUsers.forEach((room, roomName) => {
        // 查找该账户在房间中的所有用户项
        const userItems = room.users.filter(item => item.accountId === accountId);
        userItems.forEach(item => {
          handleUserOffline({
            type: 'user-offline',
            uid: item.uid,
            room: roomName,
            operatorAccountId: accountId,
            reason: '账户冻结自动下线'
          }, null);
        });
      });
    }

    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
    socket.emit('message', {
      type: 'freeze-user-success',
      accountId: accountId,
      isFrozen: isFrozen
    });
    log(`${isFrozen ? '冻结' : '解冻'} 用户 ${accountId}`, LOG_TYPES.ADMIN, { accountId: accountId, action: isFrozen ? '冻结' : '解冻' });
  } else {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
  }
}

/**
 * 处理切换用户信任状态（管理员功能）
 * @param {Object} data - 切换信任状态数据
 * @param {string} data.accountId - 要切换信任状态的账户ID
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 切换用户信任状态
 * await handleToggleSafeUser({ accountId: 'user1' }, socket);
 */
async function handleToggleSafeUser(data, socket) {
  const { accountId } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (userAccounts[accountId]) {
    const safe = !userAccounts[accountId].safe;
    userAccounts[accountId].safe = safe;

    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
    socket.emit('message', {
      type: 'safe-user-success',
      accountId: accountId,
      safe: safe
    });
    log(`${safe ? '设为信任' : '取消信任'} 用户 ${accountId}`, LOG_TYPES.ADMIN, { accountId: accountId, action: safe ? '设为信任' : '取消信任' });
  } else {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
  }
}

/**
 * 处理删除用户（管理员功能）
 * @param {Object} data - 删除用户数据
 * @param {string} data.accountId - 要删除的账户ID
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 删除用户
 * await handleDeleteUser({ accountId: 'user1' }, socket);
 */
async function handleDeleteUser(data, socket) {
  const { accountId } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (userAccounts[accountId]) {
    // 从所有房间中移除该用户
    roomUsers.forEach((room, roomName) => {
      // roomName 未被使用，保留以提高代码可读性
      room.users = room.users.filter(item => item.accountId !== accountId);
    });

    // 从userAccounts中删除用户
    delete userAccounts[accountId];

    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
    socket.emit('message', {
      type: 'delete-user-success',
      accountId: accountId
    });
    log(`删除用户 ${accountId}`, LOG_TYPES.ADMIN, { accountId: accountId });
  } else {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
  }
}

/**
 * 处理获取用户信息（管理员功能）
 * @param {Object} data - 获取用户信息数据
 * @param {string} data.accountId - 要获取信息的账户ID
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 获取用户信息
 * handleGetUserInfo({ accountId: 'user1' }, socket);
 */
function handleGetUserInfo(data, socket) {
  const { accountId } = data;

  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  if (userAccounts[accountId]) {
    const account = userAccounts[accountId];
    socket.emit('message', {
      type: 'user-info',
      data: {
        account: accountId,
        isFrozen: account.isFrozen,
        safe: account.safe || false, // 新增：信任状态，默认为false
        points: account.points || 0,
        rooms: account.rooms || []
      }
    });
  } else {
    socket.emit('message', {
      type: 'user-info',
      data: null
    });
  }
}

/**
 * 处理获取当前用户信息（普通用户功能）
 * @param {Object} data - 数据参数
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 获取当前用户信息
 * handleGetCurrentUserInfo({}, socket);
 */
function handleGetCurrentUserInfo(data, socket) {
  // 检查是否已登录
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', {
      type: 'error',
      message: '未登录'
    });
    return;
  }

  const accountId = socketData.accountId;
  if (userAccounts[accountId]) {
    const account = userAccounts[accountId];
    socket.emit('message', {
      type: 'user-info',
      data: {
        account: accountId,
        frozen: account.isFrozen,
        points: account.points || 0,
        rooms: account.rooms || []
      }
    });
  } else {
    socket.emit('message', {
      type: 'user-info',
      data: null
    });
  }
}

// 处理用户下线（从房间中删除对应项）
function handleUserOffline(data, socket) {
  const uid = data.uid;
  const roomName = data.room;
  const providedAccountId = data.operatorAccountId;
  const reason = data.reason || '未知原因';

  // 验证必要参数
  if (!uid || !roomName) {
    const missingParams = [];
    if (!uid) missingParams.push('uid');
    if (!roomName) missingParams.push('room');
    
    log(`用户下线失败: 缺少必要参数 ${missingParams.join(', ')}`, LOG_TYPES.ONLINE, { 
      uid: uid || 'undefined', 
      room: roomName || 'undefined',
      missingParams: missingParams 
    });
    
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: `缺少必要参数: ${missingParams.join(', ')}`
      });
    }
    return;
  }

  // 判断是否是服务端自动操作
  const isServerOperation = !socket;

  if (isServerOperation) {
    log(`服务端自动操作: 用户 ${uid} 从房间 ${roomName} 下线，原因: ${reason}`, LOG_TYPES.ONLINE, { uid: uid, room: roomName, reason: reason });
  } else {
    log(`用户操作: 用户 ${uid} 从房间 ${roomName} 下线，原因: ${reason}`, LOG_TYPES.ONLINE, { uid: uid, room: roomName, reason: reason });
  }

  // 获取当前操作用户的accountId
  let operatorAccountId = providedAccountId;
  if (!operatorAccountId && socket) {
    const socketData = getConnectionBySocketId(socket.id);
    if (socketData) {
      operatorAccountId = socketData.accountId;
    }
  }

  if (!operatorAccountId) {
    log(`操作者未认证`, LOG_TYPES.ONLINE, { reason: '操作者未认证' });
    return;
  }

  // 查找目标UID所在的房间和账户
  let targetAccountId = null;
  let targetRoomName = roomName;

  // 首先在指定房间查找
  if (roomUsers.has(roomName)) {
    const room = roomUsers.get(roomName);
    const userItem = room.users.find(item => item.uid === uid);
    if (userItem) {
      targetAccountId = userItem.accountId;
    }
  }

  // 如果在指定房间没找到，遍历所有房间查找
  if (!targetAccountId) {
    for (const [rName, room] of roomUsers.entries()) {
      const userItem = room.users.find(item => item.uid === uid);
      if (userItem) {
        targetAccountId = userItem.accountId;
        targetRoomName = rName;
        break;
      }
    }
  }

  if (!targetAccountId) {
    if (isServerOperation) {
      log(`服务端自动下线失败: 用户 ${uid} 不在任何房间中`, LOG_TYPES.ONLINE, { uid: uid, reason: '用户不在任何房间中' });
    } else {
      log(`用户 ${uid} 不在任何房间中`, LOG_TYPES.ONLINE, { uid: uid, reason: '用户不在任何房间中' });
    }
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '该用户已不在线'
      });
    }
    return;
  }

  // 检查权限：只能下线同一账户的UID，但管理员可以下线任何用户
  let isAdmin = false;
  if (socket) {
    const socketData = getConnectionBySocketId(socket.id);
    if (socketData) {
      // 检查是否是管理员账户
      isAdmin = socketData.isAdmin;
    }
  }

  // 当socket为null时，跳过权限检查（系统自动执行的操作）
  if (socket && !isAdmin && targetAccountId !== operatorAccountId) {
    log(`用户 ${operatorAccountId} 无权下线 ${targetAccountId} 的UID ${uid}`, LOG_TYPES.ONLINE, { operatorAccountId: operatorAccountId, targetAccountId: targetAccountId, uid: uid, reason: '权限不足' });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '无权下线其他用户的UID'
      });
    }
    return;
  }

  // 获取房间
  if (!roomUsers.has(targetRoomName)) {
    if (isServerOperation) {
      log(`服务端自动下线失败: 房间 ${targetRoomName} 不存在`, LOG_TYPES.ONLINE, { room: targetRoomName, reason: '房间不存在' });
    } else {
      log(`房间 ${targetRoomName} 不存在`, LOG_TYPES.ONLINE, { room: targetRoomName, reason: '房间不存在' });
    }
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '房间不存在'
      });
    }
    return;
  }

  const room = roomUsers.get(targetRoomName);

  // 从房间中移除用户
  const initialCount = room.users.length;
  const removedUser = room.users.find(item => item.uid === uid);
  room.users = room.users.filter(item => item.uid !== uid);

  if (room.users.length === initialCount) {
    if (isServerOperation) {
      log(`服务端自动下线失败: 用户 ${uid} 不在房间 ${targetRoomName} 中`, LOG_TYPES.ONLINE, { uid: uid, room: targetRoomName, reason: '用户不在房间中' });
    } else {
      log(`用户 ${uid} 不在房间 ${targetRoomName} 中`, LOG_TYPES.ONLINE, { uid: uid, room: targetRoomName, reason: '用户不在房间中' });
    }
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '该用户已不在房间中'
      });
    }
    return;
  }

  // 清除连接的userInfo（如果该用户是该socket唯一上线的用户）
  if (removedUser && removedUser.socketId) {
    const socketData = getConnectionBySocketId(removedUser.socketId);
    if (socketData && socketData.uid === uid) {
      // 重置userInfo为初始状态（保留连接，但清除上线信息）
      setConnectionUserInfo(removedUser.socketId, {
        username: socketData.username_current || socketData.username,
        uid: '',
        roomName: ''
      });
    }
  }

  // 发送用户下线事件到房间内的所有其他用户
  const remainingUsers = room.users;
  remainingUsers.forEach(user => {
    if (user.socketId) {
      const userSocket = io.sockets.sockets.get(user.socketId);
      if (userSocket) {
        userSocket.emit('message', {
          type: 'user-left',
          data: {
            room: targetRoomName,
            uid: uid,
            reason: reason
          }
        });
      }
    }
  });

  // 通知操作发起人
  if (socket) {
    socket.emit('message', {
      type: 'user-offline-success',
      data: {
        room: targetRoomName,
        uid: uid
      }
    });
  }

  // 检查房间是否为空，为空则删除房间
  if (room.users.length === 0) {
    roomUsers.delete(targetRoomName);
    log(`房间 ${targetRoomName} 已空，自动删除`, LOG_TYPES.INFO, { room: targetRoomName, reason: '房间为空' });
  }

  // 清理用户在活跃发车中的状态
  for (const [rideId, ride] of RideManager.activeRides.entries()) {
    if (ride.riders) {
      // 检查用户是否在发车列表中
      const riderIndex = ride.riders.findIndex(r => r.uid === uid);
      if (riderIndex !== -1) {
        // 从发车列表中移除用户
        ride.riders.splice(riderIndex, 1);
        log(`用户 ${uid} 已从发车 ${rideId} 中移除`, LOG_TYPES.RIDE, { uid: uid, rideId: rideId, room: targetRoomName });
        
        // 如果发车列表为空，取消发车
        if (ride.riders.length === 0) {
          if (ride.timeoutId) {
            timerManager.clearTimeout(ride.timeoutId);
          }
          RideManager.activeRides.delete(rideId);
          // 只有当发车不是因为成功完成而下线时，才更新状态为取消
          // 检查是否是因为发车成功下线
          if (reason !== '发车成功下线') {
            updateRideRecordStatus(rideId, 'cancelled');
            log(`发车 ${rideId} 因所有骑手下线而取消`, LOG_TYPES.RIDE, { rideId: rideId, room: targetRoomName });
          }
        } else if (ride.readyStatus) {
          // 清理就绪状态
          ride.readyStatus.delete(uid);
        }
      }
    }
  }

  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();

  resetDataChangeTimer();
}

// 处理用户上线（添加到房间）
function handleUserOnline(data, socket) {
  const { username, uid, room: roomName, operatorAccountId, notHost } = data;

  // 验证必要参数
  if (!username || !uid || !roomName) {
    const missingParams = [];
    if (!username) missingParams.push('username');
    if (!uid) missingParams.push('uid');
    if (!roomName) missingParams.push('room');
    
    log(`用户上线失败: 缺少必要参数 ${missingParams.join(', ')}`, LOG_TYPES.ONLINE, { 
      username: username || 'undefined', 
      uid: uid || 'undefined', 
      room: roomName || 'undefined',
      missingParams: missingParams 
    });
    
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: `缺少必要参数: ${missingParams.join(', ')}`
      });
    }
    return;
  }

  // 获取socket数据
  const socketData = socket ? getConnectionBySocketId(socket.id) : null;

  // 确定有效的账户ID
  let effectiveAccountId = operatorAccountId;
  if (!effectiveAccountId && socketData) {
    effectiveAccountId = socketData.accountId;
  }

  // 检查用户是否被冻结
  if (effectiveAccountId && userAccounts[effectiveAccountId] && userAccounts[effectiveAccountId].isFrozen) {
    log(`用户 ${username} 上线失败: 账号已被冻结`, LOG_TYPES.ERROR, { username: username, uid: uid, accountId: effectiveAccountId });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '账号已被冻结'
      });
    }
    return;
  }

  // 如果无法确定账户ID，拒绝上线
  if (!effectiveAccountId) {
    log(`用户 ${username} 上线失败: 无法确定账户ID`, LOG_TYPES.ERROR, { username: username, uid: uid });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '无法确定账户信息'
      });
    }
    return;
  }

  log(`用户 ${username} (${uid}) 加入房间 ${roomName}`, LOG_TYPES.ONLINE, { username: username, uid: uid, room: roomName });

  // 检查用户权限：只能为同一账户的UID上线，但管理员可以为任何用户上线
  let isAdmin = false;
  if (socket && socketData) {
    isAdmin = socketData.isAdmin;
  }

  // 当operatorAccountId未传递时，使用当前登录用户的accountId作为默认值
  let effectiveOperatorAccountId = operatorAccountId;
  if (!effectiveOperatorAccountId && socketData) {
    effectiveOperatorAccountId = socketData.accountId;
  }

  // 当socket为null时，跳过权限检查（系统自动执行的操作）
  if (socket && !isAdmin && (!socketData || socketData.accountId !== effectiveOperatorAccountId)) {
    log(`用户 ${socketData ? socketData.accountId : '未知'} 无权为 ${effectiveOperatorAccountId} 的UID ${uid} 上线`, LOG_TYPES.ERROR, { operatorAccountId: effectiveOperatorAccountId, targetAccountId: socketData ? socketData.accountId : '未知', uid: uid, reason: '权限不足' });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '无权为其他用户的UID上线'
      });
    }
    return;
  }

  // 检查用户是否有房间权限
  if (socket && !isAdmin && socketData) {
    const userAccount = userAccounts[socketData.accountId];
    if (userAccount && userAccount.rooms && !userAccount.rooms.includes(roomName)) {
      log(`用户 ${socketData.accountId} 无权进入房间 ${roomName}`, LOG_TYPES.ERROR, { accountId: socketData.accountId, room: roomName, reason: '房间权限不足' });
      if (socket) {
        socket.emit('message', {
          type: 'error',
          message: '无权进入该房间'
        });
      }
      return;
    }
  }

  // 检查房间是否存在
  const roomExists = rooms.some(room => room.name === roomName);
  if (!roomExists) {
    // 检查用户是否有创建房间的权限（只有管理员可以创建新房间）
    if (socket && !isAdmin) {
      log(`用户 ${socketData ? socketData.accountId : '未知'} 无权创建新房间 ${roomName}`, LOG_TYPES.ONLINE, { accountId: socketData ? socketData.accountId : '未知', room: roomName, reason: '无创建房间权限' });
      if (socket) {
        socket.emit('message', {
          type: 'error',
          message: '无权创建新房间'
        });
      }
      return;
    }
    log(`房间 ${roomName} 不存在，创建新房间`, LOG_TYPES.INFO, { room: roomName, reason: '房间不存在' });
    getOrCreateRoom(roomName);
  }
  
  // 确保房间在roomUsers中存在
  if (!roomUsers.has(roomName)) {
    getOrCreateRoom(roomName);
  }

  const room = roomUsers.get(roomName);

  // 检查用户是否正在发车中
  const isInRide = RideManager.isUserInAnyRide(uid);
  
  if (isInRide) {
    // 用户正在发车中，缓存上线请求
    RideManager.cacheOnlineRequest(uid, data, socket);
    
    if (socket) {
      socket.emit('message', {
        type: 'info',
        message: '用户正在发车中，将在发车结束后处理上线请求'
      });
    }
    return;
  }
  
  // 检查用户是否在发车冷却期内（5分钟内不能再次上线）
  const cooldownExpiry = RideManager.recentCompletedRides.get(uid);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainingSeconds = Math.ceil((cooldownExpiry - Date.now()) / 1000);
    log(`用户 ${uid} 在发车冷却期内，剩余 ${remainingSeconds} 秒`, LOG_TYPES.INFO, { uid: uid, remaining: remainingSeconds });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: `发车后冷却中，请 ${remainingSeconds} 秒后再试`
      });
    }
    return;
  } else if (cooldownExpiry) {
    // 已过期，清理记录
    RideManager.recentCompletedRides.delete(uid);
  }
  
  // 检查用户是否已经在房间中
  if (room.users.some(user => user.uid === uid)) {
    log(`用户 ${uid} 已经在房间 ${roomName} 中`, LOG_TYPES.ERROR, { uid: uid, room: roomName, reason: '用户已在房间中' });
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '该用户已在房间中'
      });
    }
    return;
  }

  // 检查用户是否在其他房间中（notHost用户允许在多个房间上线）
  if (!notHost) {
    for (const [rName, r] of roomUsers.entries()) {
      if (rName !== roomName && r.users.some(user => user.uid === uid)) {
        log(`用户 ${uid} 已经在房间 ${rName} 中，不能同时在多个房间上线`, LOG_TYPES.ONLINE, { uid: uid, currentRoom: rName, targetRoom: roomName, reason: '用户已在其他房间' });
        if (socket) {
          socket.emit('message', {
            type: 'error',
            message: `该用户已在房间 ${rName} 中`
          });
        }
        return;
      }
    }
  }



  // 添加用户到房间
  room.users.push({
    username,
    uid,
    accountId: effectiveOperatorAccountId,
    socketId: socket ? socket.id : null,
    joinedAt: Date.now(),
    disconnected: false,
    notHost: notHost || false
  });

  // 更新连接中的userInfo
  if (socket) {
    setConnectionUserInfo(socket.id, {
      username: username,
      uid: uid,
      roomName: roomName
    });
  }

  // 发送用户上线事件到房间内的所有其他用户
  room.users.forEach(user => {
    if (user.socketId && user.uid !== uid) {
      const userSocket = io.sockets.sockets.get(user.socketId);
      if (userSocket) {
        userSocket.emit('message', {
          type: 'user-joined',
          data: {
            room: roomName,
            username,
            uid
          }
        });
      }
    }
  });

  // 通知操作发起人
  if (socket) {
    socket.emit('message', {
      type: 'user-online-success',
      data: {
        room: roomName,
        uid,
        username
      }
    });
  }

  log(`用户 ${username} 加入房间 ${roomName}`);
  log(`当前 ${roomName} 在线用户数: ${countOnlineUsers(roomName)}`);

  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();

  // 检查是否满足发车条件
  log(`检查房间 ${roomName} 的发车条件`, LOG_TYPES.RIDE, { room: roomName });
  scheduleRideCheck(roomName);

  resetDataChangeTimer();
}

// 计算房间中的在线用户数量
function countOnlineUsers(roomName) {
  const room = roomUsers.get(roomName);
  if (!room) return 0;

  return room.users.length;
}
// 处理子用户注册
// 子用户相关功能已移除，改为本地预设管理

// ==================== 9. 发车管理函数 ====================
/**
 * 保存发车记录到文件
 * @param {Object} rideRecord - 发车记录对象
 * @example
 * // 保存发车记录
 * const rideRecord = {
 *   rideId: '2024-01-01-大澡堂-1',
 *   roomName: '大澡堂',
 *   riders: [{ username: '张三', uid: '123456' }],
 *   status: 'completed'
 * };
 * saveRideRecord(rideRecord);
 */
function saveRideRecord(rideRecord) {
  try {
    const date = getBeijingTime();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const filePath = path.join(rideRecordsDir, `${dateStr}.json`);

    let records = [];
    if (fs.existsSync(filePath)) {
      const existingContent = fs.readFileSync(filePath, 'utf8');
      if (existingContent) {
        try {
          records = JSON.parse(existingContent);
        } catch (parseError) {
          log(`解析发车记录文件失败: ${parseError.message}`, LOG_TYPES.RIDE);
          records = [];
        }
      }
    }

    // 检查是否已存在相同rideId的记录
    const existingIndex = records.findIndex(record => record.rideId === rideRecord.rideId);
    if (existingIndex !== -1) {
      // 更新现有记录
      records[existingIndex] = rideRecord;
    } else {
      // 添加新记录
      records.push(rideRecord);
    }

    // 确保rideRecords目录存在
    if (!fs.existsSync(rideRecordsDir)) {
      fs.mkdirSync(rideRecordsDir, { recursive: true });
      log(`创建发车记录目录: ${rideRecordsDir}`, LOG_TYPES.INFO);
    }
    
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    log(`发车记录已保存到 ${filePath}`, LOG_TYPES.FILE, { filePath: filePath });

    // 清理42天前的发车记录文件
    cleanupOldRecords(rideRecordsDir, 42);
  } catch (error) {
    handleError(error, 'saveRideRecord');
  }
}

/**
 * 更新发车记录状态
 * @param {string} rideId - 发车记录ID
 * @param {string} status - 新状态
 * @param {Array} [crashReports=[]] - 炸车报告数组
 * @example
 * // 更新发车记录状态为完成
 * updateRideRecordStatus('2024-01-01-大澡堂-1', 'completed');
 * 
 * // 更新发车记录状态为炸车并添加炸车报告
 * updateRideRecordStatus('2024-01-01-大澡堂-1', 'crashed', [{ crashType: '超时' }]);
 */
function updateRideRecordStatus(rideId, status, crashReports = []) {
  try {
    // 更新内存中的记录
    const rideRecordIndex = rideRecords.findIndex(record => record.rideId === rideId);
    if (rideRecordIndex !== -1) {
      rideRecords[rideRecordIndex].status = status;
      if (crashReports && crashReports.length > 0) {
        rideRecords[rideRecordIndex].crashReports = crashReports;
      }

      // 保存到文件
      saveRideRecord(rideRecords[rideRecordIndex]);
      log(`更新发车记录状态: ${rideId} -> ${status}`, LOG_TYPES.RIDE, { rideId: rideId, status: status });
    } else {
      log(`未找到发车记录: ${rideId}`, LOG_TYPES.RIDE, { rideId: rideId });
    }
  } catch (error) {
    handleError(error, 'updateRideRecordStatus');
  }
}



// 处理接收信息
async function handleReceivedMessage(socket, message) {
  try {
    let username = '未知用户';
    let isAdmin = false;

    // 查找用户信息
    const socketData = getConnectionBySocketId(socket.id);
    if (socketData) {
      // 检查是否是管理员
      if (socketData.isAdmin) {
        const adminAccount = adminAccounts[socketData.accountId];
        if (adminAccount) {
          username = adminAccount.username;
          isAdmin = true;
        }
      } else {
        username = socketData.username_current || '未知用户';
      }
    }

    // 输出日志
    if (isAdmin) {
      let logMessage = '';
      if (message.type === 'ride-image') {
        if (message.hasImage === false) {
          logMessage = `收到管理 ${username} 的图片信息: 无图片`;
        } else if (message.fileName) {
          logMessage = `收到管理 ${username} 的图片信息: ${message.fileName}`;
        } else {
          logMessage = `收到管理 ${username} 的信息: ${message.type}`;
        }
      } else {
        logMessage = `收到管理 ${username} 的信息: ${message.type}`;
      }
      log(logMessage, LOG_TYPES.ADMIN);
    } else {
      let eventType = 'user';
      let logMessage = '';

      if (message.type === 'login' || message.type === 'logout') {
        eventType = 'login';
        logMessage = `用户 ${username} ${message.type === 'login' ? '登录' : '登出'}`;
      } else if (message.type === 'go-online' || message.type === 'go-offline') {
        eventType = 'online';
        logMessage = `用户 ${username} ${message.type === 'go-online' ? '上线' : '下线'}`;
      } else if (message.type === 'ride-ready') {
        eventType = 'ride';
        logMessage = `用户 ${username} 发车准备: ${message.ready ? '就绪' : '未就绪'}`;
      } else if (message.type === 'ride-image') {
        eventType = 'ride';
        if (message.hasImage === false) {
          logMessage = `用户 ${username} 图片信息: 无图片`;
        } else if (message.fileName) {
          logMessage = `用户 ${username} 图片信息: ${message.fileName}`;
        } else {
          logMessage = `用户 ${username} 的信息: ${message.type}`;
        }
      } else if (message.type === 'get-rooms-status') {
        eventType = 'ride';
        logMessage = `用户 ${username} 的信息: ${message.type}`;
      } else {
        logMessage = `用户 ${username} 的信息: ${message.type}`;
      }

      log(logMessage, eventType);
    }

    // 根据type处理不同类型的消息
    if (message.type) {
      switch (message.type) {
        case 'login':
          handleUserLogin(message, socket);
          break;
        case 'admin-login':
          handleAdminLogin(message, socket);
          break;
        case 'user-online':
          await handleUserOnline(message, socket);
          break;
        case 'user-offline':
          handleUserOffline({ ...message, reason: '用户手动下线' }, socket);
          break;
        case 'get-current-user-info':
          handleGetCurrentUserInfo(message, socket);
          break;
        case 'get-rooms-status':
          handleGetRoomsStatus(socket);
          break;
        case 'get-online-users':
          handleGetOnlineUsers(socket);
          break;
        case 'get-points-ranking':
          handleGetPointsRanking(socket);
          break;
        case 'get-my-ride-records':
          handleGetMyRideRecords(message, socket);
          break;
        case 'edit-user-points':
          await handleEditUserPoints(message, socket);
          break;
        case 'check-version':
          handleCheckVersion(socket);
          break;
        case 'ride-ready': {
          // 处理发车准备状态
          const { rideId, ready, uid } = message;
          const ride = RideManager.activeRides.get(rideId);
          if (ride) {
            // 找到房主
            let host = ride.riders.find(rider => rider.uid === ride.host.uid);
            
            // 检查用户是否在发车列表中
            let rider = null;
            if (uid) {
              // 通过uid找到对应的骑手
              rider = ride.riders.find(r => r.uid === uid);
            }
            if (rider) {
              if (!ride.readyStatus) {
                ride.readyStatus = new Map();
              }
              ride.readyStatus.set(rider.uid, ready);

              log(`发车准备: 用户 ${rider.username} (${rider.uid}) 状态: ${ready ? '就绪' : '未就绪'}`, LOG_TYPES.RIDE, { username: rider.username, uid: rider.uid, rideId: rideId, room: ride.roomName, ready: ready });

              // 检查是否所有用户都已回复
              if (ride.readyStatus.size === ride.riders.length) {
                // 处理未就绪的用户
                const notReadyRiders = ride.riders.filter(rider => !ride.readyStatus.get(rider.uid));
                if (notReadyRiders.length > 0) {
                  // 将未就绪的用户下线
                  notReadyRiders.forEach(rider => {
                    log(`发车准备: 用户 ${rider.username} (${rider.uid}) 未就绪，将其从房间下线`, LOG_TYPES.RIDE, { username: rider.username, uid: rider.uid, rideId: rideId, room: ride.roomName });
                    // 使用 handleUserOffline 函数下线用户
                    handleUserOffline({
                      type: 'user-offline',
                      uid: rider.uid,
                      room: ride.roomName,
                      operatorAccountId: rider.accountId,
                      reason: '发车未就绪下线'
                    }, null);
                    // 从发车列表中移除
                    ride.riders = ride.riders.filter(r => r.uid !== rider.uid);
                  });

                  // 清除就绪状态，重新开始
                  ride.readyStatus = new Map();

                  // 发送更新后的房间状态给所有客户端
                  sendRoomsStatusToAll();

                  // 如果还有骑手，继续等待
                  if (ride.riders.length > 0) {
                    log(`发车准备: 还有 ${ride.riders.length} 个骑手就绪，继续等待其他用户`, LOG_TYPES.RIDE, { rideId: rideId, room: ride.roomName, readyCount: ride.riders.length });
                  } else {
                    // 没有骑手了，取消发车
                    if (ride.timeoutId) {
                      timerManager.clearTimeout(ride.timeoutId);
                    }
                    RideManager.handleRideCancel(rideId, '所有骑手都未就绪');
                  }
                } else {
                  // 所有用户都已就绪，发送发车消息2
                  ride.status = 'all_ready';

                  // 清除超时定时器
                  if (ride.timeoutId) {
                    timerManager.clearTimeout(ride.timeoutId);
                  }

                  // 处理积分变动
                  if (host) {
                    const hostAccountId = host.accountId;
                    const hostAccount = userAccounts[hostAccountId];

                    if (hostAccount) {
                      // 统计非房主的队员数量（每个队员都算，不管是否同一账户）
                      const memberRiders = ride.riders.filter(rider => rider.accountId !== hostAccountId);
                      const pointsToConsume = memberRiders.length;

                      // 房主消耗积分 = 队员数量
                      hostAccount.points = (hostAccount.points || 0) - pointsToConsume;
                      log(`积分变动: 房主 ${host.username} (${host.uid}) 消耗 ${pointsToConsume} 积分，当前积分: ${hostAccount.points}`, LOG_TYPES.POINTS, { username: host.username, uid: host.uid, points: hostAccount.points, consumed: pointsToConsume });

                      // 按账户统计队员数量，每个账户获得相应积分
                      const memberAccountPoints = {};
                      memberRiders.forEach(rider => {
                        if (!memberAccountPoints[rider.accountId]) {
                          memberAccountPoints[rider.accountId] = 0;
                        }
                        memberAccountPoints[rider.accountId]++;
                      });

                      // 每个账户获得其队员数量的积分
                      Object.entries(memberAccountPoints).forEach(([accountId, points]) => {
                        const memberAccount = userAccounts[accountId];
                        if (memberAccount) {
                          const isFirstTeamRide = isFirstTeamRideToday(accountId);
                          const bonusPoints = isFirstTeamRide ? 1 : 0;
                          const totalPoints = points + bonusPoints;
                          memberAccount.points = (memberAccount.points || 0) + totalPoints;
                          log(`积分变动: 队员账户 ${accountId} 获得 ${totalPoints} 积分（基础${points} + 首程加成${bonusPoints}），当前积分: ${memberAccount.points}`, LOG_TYPES.POINTS, { accountId: accountId, points: memberAccount.points, gained: totalPoints, base: points, bonus: bonusPoints });
                        }
                      });

                      // 更新所有参与者的 lastRide 时间
                      if (host.accountId && userAccounts[host.accountId]) {
                        userAccounts[host.accountId].lastRide = Date.now();
                      }
                      memberRiders.forEach(rider => {
                        if (rider.accountId && userAccounts[rider.accountId]) {
                          userAccounts[rider.accountId].lastRide = Date.now();
                        }
                      });

                      // 保存积分变动
                      await saveData(USER_ACCOUNTS_FILE, userAccounts);
                    }
                  }
                }

                // 收集队员的图片
                if (!ride.memberImages) {
                  ride.memberImages = [];
                }

                // 检查房主是否存在
                if (host) {
                  const hostSocket = io.sockets.sockets.get(host.socketId);
                  if (hostSocket) {
                    // 将收集到的图片发送给房主（最多发车人数-1张）
                    const maxImages = ride.riders.length - 1;
                    const imagesToSend = ride.memberImages.slice(0, maxImages);

                    if (imagesToSend.length > 0) {
                      hostSocket.emit('message', {
                        type: 'ride-images',
                        rideId: rideId,
                        images: imagesToSend
                      });
                      log(`向房主 ${host.username} 发送 ${imagesToSend.length} 张队员图片`, LOG_TYPES.RIDE, { username: host.username, images: imagesToSend.length });
                    } else {
                      log(`没有队员图片发送给房主`, LOG_TYPES.RIDE);
                    }

                    // 延迟发送发车消息2，给房主时间保存图片
                    setTimeout(() => {
                      // 发送发车消息2
                      ride.riders.forEach(rider => {
                        const riderSocket = io.sockets.sockets.get(rider.socketId);
                        if (riderSocket) {
                          riderSocket.emit('message', {
                            type: 'ride-message-2',
                            rideId: rideId,
                            rideInfo: {
                              host: {
                                username: ride.host.username,
                                uid: ride.host.uid
                              },
                              members: ride.teamMembers.map(member => ({
                                username: member.username,
                                uid: member.uid
                              })),
                              room: ride.roomName
                            }
                          });
                          log(`向用户 ${rider.username} (${rider.uid}) 发送发车消息2`, LOG_TYPES.RIDE, { username: rider.username, uid: rider.uid, rideId: rideId });
                        } else {
                          log(`未找到用户 ${rider.username} (${rider.uid}) 的连接，socketId: ${rider.socketId}`, LOG_TYPES.ERROR, { username: rider.username, uid: rider.uid, socketId: rider.socketId });
                        }
                      });

                      // 更新发车记录状态为完成
                      updateRideRecordStatus(rideId, 'completed');

                      // 处理发车成功
                      RideManager.handleRideSuccess(rideId);
                    }, 2000); // 延迟2秒
                  }
                }
              }
            } else {
              log(`收到未在发车列表中的用户的准备状态，rideId: ${rideId}`, LOG_TYPES.ERROR, { rideId: rideId, uid: uid });
            }
          } else {
            log(`收到不存在的发车ID的准备状态: ${rideId}`, LOG_TYPES.RIDE, { rideId: rideId, uid: uid });
          }
          break;
        }
        case 'ride-image': {
          // 处理队员发送的图片
          const { rideId: imageRideId, username, uid, imageData, fileName, hasImage } = message;
          const imageRide = RideManager.activeRides.get(imageRideId);
          if (imageRide) {
            if (hasImage === false) {
              // 队员没有图片
              log(`队员 ${username} (${uid}) 没有图片`, LOG_TYPES.RIDE, { username: username, uid: uid, rideId: imageRideId });
            } else if (imageData && fileName) {
              // 队员有图片，保存到发车信息中
              if (!imageRide.memberImages) {
                imageRide.memberImages = [];
              }
              imageRide.memberImages.push({
                username: username,
                uid: uid,
                imageData: imageData,
                fileName: fileName
              });
              log(`收到队员 ${username} (${uid}) 的图片: ${fileName}`, LOG_TYPES.RIDE, { username: username, uid: uid, rideId: imageRideId, fileName: fileName });
            }
          } else {
            log(`收到不存在的发车ID的图片: ${imageRideId}`, LOG_TYPES.RIDE, { rideId: imageRideId });
          }
          break;
        }
        case 'change-password':
          await handleChangePassword(message, socket);
          break;
        case 'get-available-rooms':
          // 检查是否已登录
          const socketData = getConnectionBySocketId(socket.id);
          if (!socketData) {
            socket.emit('message', {
              type: 'error',
              message: '请先登录'
            });
            return;
          }

          // 根据当前登录的账号获取可用房间
          const accountId = socketData.accountId;
          const account = userAccounts[accountId];
          const availableRooms = account ? account.rooms : ['大澡堂'];
          socket.emit('message', {
            type: 'available-rooms',
            data: availableRooms
          });
          log(`发送可用房间列表给用户 ${accountId}`, LOG_TYPES.INFO, { accountId: accountId });
          break;
        // 管理员相关事件
        case 'register-user':
          await handleRegisterUser(message, socket);
          break;
        case 'reset-password':
          await handleResetPassword(message, socket);
          break;
        case 'toggle-freeze-user':
          await handleToggleFreezeUser(message, socket);
          break;
        case 'toggle-safe-user':
          await handleToggleSafeUser(message, socket);
          break;
        case 'delete-user':
          await handleDeleteUser(message, socket);
          break;
        case 'get-all-accounts':
          handleGetAllAccounts(socket);
          break;
        case 'get-user-info':
          handleGetUserInfo(message, socket);
          break;
        case 'update-room-permission':
          await handleUpdateRoomPermission(message, socket);
          break;
        case 'cleanup-online-data':
          await handleCleanupOnlineData(message, socket);
          break;
        // 房间相关事件
        case 'get-all-rooms':
          handleGetAllRooms(socket);
          break;
        case 'create-room':
          await handleCreateRoom(message, socket);
          break;
        case 'delete-room':
          await handleDeleteRoom(message, socket);
          break;
        case 'edit-room-name':
          await handleEditRoomName(message, socket);
          break;
        case 'edit-room-properties':
          await handleEditRoomProperties(message, socket);
          break;
        case 'get-room-users':
          handleGetRoomUsers(message, socket);
          break;
        case 'toggle-user-status':
          handleToggleUserStatus(message, socket);
          break;
        case 'move-user':
          await handleMoveUser(message, socket);
          break;
        // 其他事件
        case 'get-online-users':
          // 移动端获取已上线用户
          if (message.data && message.data.targetConnectionId) {
            const { targetConnectionId } = message.data;
            log(`处理移动端获取已上线用户请求，targetConnectionId: ${targetConnectionId}`, LOG_TYPES.INFO);
            // 查找目标连接
            let targetConn = null;
            for (const userConn of userConnections.values()) {
              for (const conn of userConn.connections) {
                if (conn.connectionId === targetConnectionId) {
                  targetConn = conn;
                  log(`找到目标连接: ${conn.connectionName}, socketId: ${conn.socketId}`, LOG_TYPES.INFO);
                  break;
                }
              }
              if (targetConn) break;
            }
            
            if (!targetConn) {
              log(`未找到目标连接: ${targetConnectionId}`, LOG_TYPES.ERROR);
              socket.emit('message', {
                type: 'online-users',
                data: { success: false, message: '目标连接不存在' }
              });
              return;
            }
            
            // 获取该连接的已上线用户
            const onlineUsers = [];
            log(`开始遍历房间查找用户，目标socketId: ${targetConn.socketId}`, LOG_TYPES.INFO);
            for (const [roomName, room] of roomUsers) {
              log(`检查房间: ${roomName}, 用户数: ${room.users.length}`, LOG_TYPES.INFO);
              for (const user of room.users) {
                log(`检查用户: ${user.username}, socketId: ${user.socketId}`, LOG_TYPES.INFO);
                if (user.socketId === targetConn.socketId) {
                  log(`找到匹配用户: ${user.username}`, LOG_TYPES.INFO);
                  onlineUsers.push({
                    username: user.username,
                    uid: user.uid,
                    room: roomName,
                    notHost: user.notHost
                  });
                }
              }
            }
            
            log(`找到 ${onlineUsers.length} 个已上线用户`, LOG_TYPES.INFO);
            socket.emit('message', {
              type: 'online-users',
              data: { success: true, users: onlineUsers }
            });
          } else {
            handleGetOnlineUsers(socket);
          }
          break;
        case 'get-log-files':
          handleGetLogFiles(socket);
          break;
        case 'get-log-file-content':
          await handleGetLogFileContent(message, socket);
          break;
        case 'download-log-file':
          await handleDownloadLogFile(message, socket);
          break;
        case 'report-crash':
          handleReportCrash(message, socket);
          break;
        case 'report-gain':
          handleReportGain(message, socket);
          break;
        case 'get-ride-records':
          await handleGetRideRecords(message, socket);
          break;
        case 'get-gain-records':
          await handleGetGainRecords(message, socket);
          break;
        case 'publish-route-test':
          await handlePublishRouteTest(message, socket);
          break;
        case 'get-route-test-types':
          await handleGetRouteTestTypes(message, socket);
          break;
        case 'apply-route-test':
          await handleApplyRouteTest(message, socket);
          break;
        case 'route-test-result':
          await handleReportRouteTest(message, socket);
          break;
        case 'get-route-test-tasks':
          await handleGetRouteTestTasks(message, socket);
          break;
        case 'get-route-test-records':
          await handleGetRouteTestRecords(message, socket);
          break;
        case 'download-route-test-data':
          await handleDownloadRouteTestData(message, socket);
          break;
        case 'get-user-connections-for-mobile':
          handleGetUserConnectionsForMobile(socket);
          break;
        case 'schedules-list':
          // 转发调度列表给移动端
          if (message.targetSocketId) {
            const mobileSocket = io.sockets.sockets.get(message.targetSocketId);
            if (mobileSocket) {
              mobileSocket.emit('message', message);
            }
          }
          break;
        case 'mobile-command':
          await handleMobileCommand(message, socket);
          break;
        case 'get-versions':
          handleGetVersions(socket);
          break;
        case 'update-versions':
          await handleUpdateVersions(message, socket);
          break;
        case 'upload-client-package':
          await handleUploadClientPackage(message, socket);
          break;
        case 'upload-group-purchasing-package':
          await handleUploadGroupPurchasingPackage(message, socket);
          break;
        case 'upload-asar':
          await handleUploadAsar(message, socket);
          break;
        default:
          log(`未知消息类型: ${message.type}`, LOG_TYPES.ERROR, { messageType: message.type });
          break;
      }
    } else {
      log('收到无类型的消息', LOG_TYPES.SOCKET);
    }
  } catch (error) {
    handleError(error, `handleReceivedMessage - message type: ${message?.type || 'unknown'}`);

    // 向客户端发送错误响应
    if (socket && socket.connected) {
      socket.emit('message', {
        type: 'error',
        message: '服务器处理消息时发生错误，请稍后重试'
      });
    }
  }
}

// ==================== 10. 房间管理函数 ====================
/**
 * 处理创建房间
 * @param {Object} data - 创建房间数据
 * @param {string} data.roomName - 房间名称
 * @param {string} data.roomMode - 房间模式
 * @param {number} data.roomCount - 发车人数
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理创建房间
 * await handleCreateRoom({ roomName: '新房间', roomMode: 'random', roomCount: 4 }, socket);
 */
async function handleCreateRoom(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { roomName, roomMode = 'random', roomCount = 4 } = data; // 'random' 表示顺序发车
  
  if (!roomName) {
    socket.emit('message', {
      type: 'error',
      message: '房间名称不能为空'
    });
    return;
  }
  
  if (rooms.some(room => room.name === roomName)) {
    socket.emit('message', {
      type: 'error',
      message: '房间已存在'
    });
    return;
  }
  
  // 创建新房间对象
  const newRoom = {
    name: roomName,
    mode: roomMode,
    count: parseInt(roomCount)
  };
  
  rooms.push(newRoom);
  await saveData(ROOMS_FILE, rooms);
  resetDataChangeTimer();
  
  socket.emit('message', {
    type: 'room-created',
    message: '房间创建成功'
  });
  log(`创建新房间: ${roomName}, 发车模式: ${roomMode}, 发车人数: ${roomCount}`);
  
  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();
}

/**
 * 处理删除房间
 * @param {Object} data - 删除房间数据
 * @param {string} data.roomName - 房间名称
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理删除房间
 * await handleDeleteRoom({ roomName: '旧房间' }, socket);
 */
async function handleDeleteRoom(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { roomName } = data;
  
  if (!roomName) {
    socket.emit('message', {
      type: 'error',
      message: '房间名称不能为空'
    });
    return;
  }
  
  if (roomName === '大澡堂' || roomName === '待机') {
    socket.emit('message', {
      type: 'error',
      message: '大澡堂和待机房间不能删除'
    });
    return;
  }
  
  const roomIndex = rooms.findIndex(room => room.name === roomName);
  if (roomIndex === -1) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }
  
  // 从房间列表中删除
  rooms.splice(roomIndex, 1);
  await saveData(ROOMS_FILE, rooms);
  resetDataChangeTimer();
  
  // 从所有用户的房间权限中移除
  for (const accountId in userAccounts) {
    const account = userAccounts[accountId];
    const accountRoomIndex = account.rooms.indexOf(roomName);
    if (accountRoomIndex > -1) {
      account.rooms.splice(accountRoomIndex, 1);
    }
  }
  await saveData(USER_ACCOUNTS_FILE, userAccounts);
  resetDataChangeTimer();
  
  // 从roomUsers中删除该房间
  roomUsers.delete(roomName);
  
  socket.emit('message', {
    type: 'room-deleted',
    message: '房间删除成功'
  });
  log(`删除房间: ${roomName}`);
  
  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();
}

/**
 * 处理获取房间用户
 * @param {Object} data - 获取房间用户数据
 * @param {string} data.roomName - 房间名称
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取房间用户
 * handleGetRoomUsers({ roomName: '大澡堂' }, socket);
 */
function handleGetRoomUsers(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { roomName } = data;
  
  if (!roomName) {
    socket.emit('message', {
      type: 'error',
      message: '房间名称不能为空'
    });
    return;
  }
  
  const roomInfo = rooms.find(room => room.name === roomName);
  if (!roomInfo) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }
  
  const room = roomUsers.get(roomName);
  const users = [];
  
  // 首先获取所有具有该房间权限的用户
  Object.entries(userAccounts).forEach(([accountId, account]) => {
    if (account.rooms && account.rooms.includes(roomName)) {
      // 检查该用户是否在房间中有上线记录
      let hasEntry = false;
      
      if (room) {
        // 查找该账户在房间中的所有用户项
        const userItems = room.users.filter(item => item.accountId === accountId);
        userItems.forEach(user => {
          users.push({
            ...user,
            accountId: accountId,
            online: true // 新结构中只存储在线用户
          });
          hasEntry = true;
        });
      }
      
      // 如果用户具有该房间权限但没有在房间中有任何记录，也添加到列表中
      if (!hasEntry) {
        users.push({
          username: account.username,
          uid: '',
          online: false,
          socketId: null,
          notHost: false,
          accountId: accountId
        });
      }
    }
  });
  
  socket.emit('message', {
    type: 'room-users',
    users: users,
    roomProperties: {
      name: roomInfo.name,
      mode: roomInfo.mode,
      count: roomInfo.count
    }
  });
  log(`发送房间 ${roomName} 的用户列表和属性给管理员`);
}

/**
 * 处理移动用户
 * @param {Object} data - 移动用户数据
 * @param {string} data.uid - 用户UID
 * @param {string} data.fromRoom - 源房间名称
 * @param {string} data.toRoom - 目标房间名称
 * @param {boolean} [data.confirmGrantPermission] - 是否确认赋予权限并移动
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理移动用户
 * handleMoveUser({ uid: '123456', fromRoom: '大澡堂', toRoom: '待机' }, socket);
 * // 确认赋予权限并移动
 * handleMoveUser({ uid: '123456', fromRoom: '大澡堂', toRoom: '待机', confirmGrantPermission: true }, socket);
 */
async function handleMoveUser(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { uid, fromRoom, toRoom, confirmGrantPermission } = data;
  
  if (!uid || !fromRoom || !toRoom) {
    socket.emit('message', {
      type: 'error',
      message: '参数不足'
    });
    return;
  }
  
  if (!rooms.some(room => room.name === fromRoom) || !rooms.some(room => room.name === toRoom)) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }
  
  if (fromRoom === toRoom) {
    socket.emit('message', {
      type: 'error',
      message: '源房间和目标房间不能相同'
    });
    return;
  }
  
  const fromRoomObj = roomUsers.get(fromRoom);
  if (!fromRoomObj) {
    socket.emit('message', {
      type: 'error',
      message: '源房间中没有用户'
    });
    return;
  }
  
  // 查找用户
  let userToMove = null;
  let userAccountId = null;
  
  const userItemIndex = fromRoomObj.users.findIndex(item => item.uid === uid);
  if (userItemIndex !== -1) {
    userToMove = fromRoomObj.users[userItemIndex];
    userAccountId = userToMove.accountId;
  }
  
  if (!userToMove) {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
    return;
  }
  
  // 检查用户是否具有目标房间的权限
  const userAccount = userAccounts[userAccountId];
  const hasRoomPermission = userAccount && userAccount.rooms && userAccount.rooms.includes(toRoom);
  
  if (!hasRoomPermission) {
    // 用户没有目标房间权限
    if (!confirmGrantPermission) {
      // 未确认，返回需要确认的消息
      socket.emit('message', {
        type: 'move-user-permission-required',
        uid: uid,
        username: userToMove.username,
        fromRoom: fromRoom,
        toRoom: toRoom,
        message: `用户 ${userToMove.username} (${uid}) 没有房间 ${toRoom} 的权限，是否赋予权限并移动？`
      });
      return;
    }
    // 已确认，先赋予权限
    if (userAccount) {
      if (!userAccount.rooms) {
        userAccount.rooms = [];
      }
      userAccount.rooms.push(toRoom);
      // 保存用户账户数据
      await saveData(USER_ACCOUNTS_FILE, userAccounts);
      log(`管理员为用户 ${userAccountId} 赋予房间 ${toRoom} 的权限`, LOG_TYPES.ADMIN, { accountId: userAccountId, room: toRoom, action: '赋予房间权限' });
    }
  }
  
  // 从源房间中删除
  fromRoomObj.users.splice(userItemIndex, 1);
  
  // 如果房间为空，从roomUsers中移除
  if (fromRoomObj.users.length === 0) {
    roomUsers.delete(fromRoom);
  }
  
  // 确保目标房间存在
  const toRoomObj = getOrCreateRoom(toRoom);
  
  // 添加用户到目标房间
  toRoomObj.users.push(userToMove);
  
  socket.emit('message', {
    type: 'user-moved',
    message: '用户移动成功'
  });
  
  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();
  
  // 检查源房间和目标房间是否需要发车
  scheduleRideCheck(fromRoom);
  scheduleRideCheck(toRoom);
}

/**
 * 处理编辑房间名称
 * @param {Object} data - 编辑房间名称数据
 * @param {string} data.roomName - 当前房间名称
 * @param {string} data.newRoomName - 新房间名称
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理编辑房间名称
 * await handleEditRoomName({ roomName: '旧房间', newRoomName: '新房间' }, socket);
 */
async function handleEditRoomName(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { roomName, newRoomName } = data;
  
  if (!roomName || !newRoomName) {
    socket.emit('message', {
      type: 'error',
      message: '房间名称不能为空'
    });
    return;
  }
  
  if (roomName === '大澡堂' || roomName === '待机') {
    socket.emit('message', {
      type: 'error',
      message: '大澡堂和待机房间不能改名'
    });
    return;
  }
  
  const roomIndex = rooms.findIndex(room => room.name === roomName);
  if (roomIndex === -1) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }
  
  if (rooms.some(room => room.name === newRoomName)) {
    socket.emit('message', {
      type: 'error',
      message: '新房间名称已存在'
    });
    return;
  }
  
  // 从rooms数组中更新名称
  rooms[roomIndex].name = newRoomName;
  await saveData(ROOMS_FILE, rooms);
  resetDataChangeTimer();
  
  // 从roomUsers中更新房间名称
  if (roomUsers.has(roomName)) {
    const roomData = roomUsers.get(roomName);
    roomUsers.delete(roomName);
    roomUsers.set(newRoomName, roomData);
  }
  
  // 更新所有用户的房间权限中的房间名称
  for (const accountId in userAccounts) {
    const account = userAccounts[accountId];
    const roomIndex = account.rooms.indexOf(roomName);
    if (roomIndex > -1) {
      account.rooms[roomIndex] = newRoomName;
    }
  }
  await saveData(USER_ACCOUNTS_FILE, userAccounts);
  resetDataChangeTimer();
  
  socket.emit('message', {
    type: 'room-edited',
    message: '房间名称修改成功'
  });
  
  log(`将房间 ${roomName} 改名为 ${newRoomName}`);
  
  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();
}

/**
 * 处理编辑房间属性
 * @param {Object} data - 编辑房间属性数据
 * @param {string} data.roomName - 当前房间名称
 * @param {string} data.newRoomName - 新房间名称
 * @param {string} data.roomMode - 房间模式
 * @param {number} data.roomCount - 发车人数
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理编辑房间属性
 * await handleEditRoomProperties({ roomName: '旧房间', newRoomName: '新房间', roomMode: 'random', roomCount: 4 }, socket);
 */
async function handleEditRoomProperties(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { roomName, newRoomName, roomMode, roomCount } = data;
  
  if (!roomName || !newRoomName) {
    socket.emit('message', {
      type: 'error',
      message: '房间名称不能为空'
    });
    return;
  }
  
  const roomIndex = rooms.findIndex(room => room.name === roomName);
  if (roomIndex === -1) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }
  
  if (newRoomName !== roomName && rooms.some(room => room.name === newRoomName)) {
    socket.emit('message', {
      type: 'error',
      message: '新房间名称已存在'
    });
    return;
  }
  
  // 更新房间属性
  rooms[roomIndex].name = newRoomName;
  rooms[roomIndex].mode = roomMode;
  rooms[roomIndex].count = parseInt(roomCount);
  await saveData(ROOMS_FILE, rooms);
  resetDataChangeTimer();
  
  // 如果房间名称改变，更新roomUsers中的房间名称
  if (newRoomName !== roomName) {
    if (roomUsers.has(roomName)) {
      const roomData = roomUsers.get(roomName);
      roomUsers.delete(roomName);
      roomUsers.set(newRoomName, roomData);
    }
    
    // 更新所有用户的房间权限中的房间名称
    for (const accountId in userAccounts) {
      const account = userAccounts[accountId];
      const roomIndex = account.rooms.indexOf(roomName);
      if (roomIndex > -1) {
        account.rooms[roomIndex] = newRoomName;
      }
    }
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
  }
  
  socket.emit('message', {
    type: 'room-edited',
    message: '房间属性修改成功'
  });
  
  log(`更新房间 ${roomName} 的属性: 新名称=${newRoomName}, 发车模式=${roomMode}, 发车人数=${roomCount}`);
  
  // 发送更新后的房间状态给所有客户端
  sendRoomsStatusToAll();
}

/**
 * 检查并处理发车逻辑
 * @param {string} roomName - 房间名称
 * @returns {Promise<void>}
 * @example
 * // 检查并处理发车
 * await checkAndHandleRide('大澡堂');
 */

/**
 * 调度发车检查（带防抖机制）
 * @param {string} roomName - 房间名称
 */
function scheduleRideCheck(roomName) {
  if (roomRideCheckTimers.has(roomName)) {
    const existingTimer = roomRideCheckTimers.get(roomName);
    timerManager.clearTimeout(existingTimer);
    log(`房间 ${roomName} 的发车检查计时器已重置`);
  }

  const timerId = timerManager.setTimeout(async () => {
    roomRideCheckTimers.delete(roomName);
    await checkAndHandleRideInternal(roomName);
  }, 1000);

  roomRideCheckTimers.set(roomName, timerId);
  log(`房间 ${roomName} 的发车检查已安排，1秒后执行`);
}

/**
 * 实际执行发车检查（带锁机制）
 * @param {string} roomName - 房间名称
 */
async function checkAndHandleRideInternal(roomName) {
  if (RideManager.roomLocks.get(roomName)) {
    log(`房间 ${roomName} 正在检查发车中，跳过`);
    return;
  }
  RideManager.roomLocks.set(roomName, true);
  log(`房间 ${roomName} 发车检查已锁定`, LOG_TYPES.RIDE, { room: roomName });

  // 检查房间的发车模式，如果是不发车，则直接返回
  const roomInfo = rooms.find(room => room.name === roomName);
  if (roomInfo && roomInfo.mode === 'none') {
    log(`房间 ${roomName} 设置为不发车模式，跳过发车检查`, LOG_TYPES.RIDE, { room: roomName });
    RideManager.roomLocks.set(roomName, false);
    log(`房间 ${roomName} 发车检查已解锁`, LOG_TYPES.RIDE, { room: roomName });
    return;
  }

  try {
    const room = roomUsers.get(roomName);
    if (!room) {
      RideManager.roomLocks.set(roomName, false);
      log(`房间 ${roomName} 发车检查已解锁（房间不存在）`, LOG_TYPES.RIDE, { room: roomName });
      return;
    }

    // 收集所有在线用户
    const onlineUsers = room.users.filter(item => !item.disconnected);

    // 检查人数是否大于等于房间的发车人数
    if (onlineUsers.length < roomInfo.count) {
      log(`房间 ${roomName} 在线用户数 ${onlineUsers.length}，需要至少 ${roomInfo.count} 人才能发车`, LOG_TYPES.RIDE, { room: roomName, current: onlineUsers.length, required: roomInfo.count });
      RideManager.roomLocks.set(roomName, false);
      log(`房间 ${roomName} 发车检查已解锁（用户不足）`, LOG_TYPES.RIDE, { room: roomName });
      return;
    }

    // 检查是否所有人都不当房主
    const hostEligibleUsers = onlineUsers.filter(user => !user.notHost);
    if (hostEligibleUsers.length === 0) {
      log(`房间 ${roomName} 没有符合条件担任房主的用户`, LOG_TYPES.RIDE, { room: roomName });
      RideManager.roomLocks.set(roomName, false);
      log(`房间 ${roomName} 发车检查已解锁（无合格房主）`, LOG_TYPES.RIDE, { room: roomName });
      return;
    }

    // 根据房间的发车模式选择房主
    let host;
    let teamMembers;
    if (roomInfo.mode === 'random') { // 顺序发车
      // 选择最早进入房间且没有勾选不当房主的用户作为房主
      // 按照用户加入房间的顺序排序（这里假设onlineUsers已经按照加入顺序排序）
      host = hostEligibleUsers[0];

      // 选择其他用户作为队员
      teamMembers = onlineUsers.filter(user => user.uid !== host.uid).slice(0, roomInfo.count - 1);
    } else if (roomInfo.mode === 'points') { // 积分优先
      // 选择积分最高且没有勾选不当房主的用户作为房主
      // 如果积分相同，则选择相同积分中进入房间最早的
      hostEligibleUsers.sort((a, b) => {
        // 首先比较积分
        const pointsA = userAccounts[a.accountId]?.points || 0;
        const pointsB = userAccounts[b.accountId]?.points || 0;
        if (pointsA !== pointsB) {
          return pointsB - pointsA; // 积分高的排前面
        }
        // 积分相同，比较加入时间（这里假设onlineUsers已经按照加入顺序排序）
        return 0; // 保持原顺序
      });
      host = hostEligibleUsers[0];

      // 选择其他用户作为队员
      teamMembers = onlineUsers.filter(user => user.uid !== host.uid).slice(0, roomInfo.count - 1);
    } else if (roomInfo.mode === 'vip') { // VIP包间
      // 分为两组：没勾选不当房主的（第一组，只能当房主），勾选了的（第二组，只能当队员）
      const group1 = onlineUsers.filter(user => !user.notHost); // 只能当房主
      const group2 = onlineUsers.filter(user => user.notHost); // 只能当队员

      // 检查是否满足发车条件：第一组人数>=1，第二组人数>=发车人数-1
      if (group1.length < 1 || group2.length < roomInfo.count - 1) {
        log(`房间 ${roomName} VIP模式条件不满足: 第一组=${group1.length}, 第二组=${group2.length}, 需要第一组>=1且第二组>=${roomInfo.count - 1}`, LOG_TYPES.RIDE, { room: roomName, group1: group1.length, group2: group2.length, required: roomInfo.count - 1 });
        RideManager.roomLocks.set(roomName, false);
        log(`房间 ${roomName} 发车检查已解锁（VIP模式条件不满足）`, LOG_TYPES.RIDE, { room: roomName });
        return;
      }

      // 按照先来后到的原则选择房主（第一组中的第一个）
      host = group1[0];

      // 按照先来后到的原则选择队员（第二组中的前roomInfo.count-1个）
      teamMembers = group2.slice(0, roomInfo.count - 1);
    }

    // 检查是否已经有该房间的活跃发车任务
    const existingRide = RideManager.getRoomActiveRide(roomName);
    if (existingRide) {
      log(`房间 ${roomName} 已有活跃发车 (${existingRide.rideId})，跳过`, LOG_TYPES.RIDE, { room: roomName });
      RideManager.roomLocks.set(roomName, false);
      log(`房间 ${roomName} 发车检查已解锁（已有活跃发车）`, LOG_TYPES.RIDE, { room: roomName });
      return;
    }

    // 检查所有选中的骑手是否已经在其他发车任务中
    const allRiders = [host, ...teamMembers];
    for (const rider of allRiders) {
      if (RideManager.isUserInAnyRide(rider.uid)) {
        // 找到骑手所在的发车
        let existingRoomName = 'unknown';
        for (const [rideId, ride] of RideManager.activeRides.entries()) {
          if (ride.riders && ride.riders.some(r => r.uid === rider.uid)) {
            existingRoomName = ride.roomName;
            break;
          }
        }
        log(`骑手 ${rider.username} (${rider.uid}) 已在房间 ${existingRoomName} 的发车中`, LOG_TYPES.RIDE, { username: rider.username, uid: rider.uid, room: existingRoomName });
        RideManager.roomLocks.set(roomName, false);
        log(`房间 ${roomName} 发车检查已解锁（骑手已在其他发车中）`, LOG_TYPES.RIDE, { room: roomName });
        return;
      }
    }

    // 构建发车信息
    const rideInfo = {
      host: {
        username: host.username,
        uid: host.uid
      },
      members: teamMembers.map(member => ({
        username: member.username,
        uid: member.uid
      })),
      room: roomName
    };

    log(`房间 ${roomName} 开始发车，房主: ${host.username} (${host.uid})`, LOG_TYPES.RIDE, { room: roomName, host: host.username, hostUid: host.uid, members: teamMembers.length });

    // 生成发车标识：日期-房间-第几次发车
    const date = getBeijingTime();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; // 格式：YYYY-MM-DD

    // 计算今天该房间的发车次数
    const todayRides = rideRecords.filter(record => {
      const recordDate = getBeijingTime(new Date(record.createdAt));
      const recordDateStr = `${recordDate.getFullYear()}-${String(recordDate.getMonth() + 1).padStart(2, '0')}-${String(recordDate.getDate()).padStart(2, '0')}`;
      return recordDateStr === dateStr && record.roomName === roomName;
    });
    const rideNumber = todayRides.length + 1;

    // 生成发车ID
    const rideId = `${dateStr}-${roomName}-${rideNumber}`;

    // 创建发车状态并从房间移除骑手
    const rideData = RideManager.createRideState(roomName, host, teamMembers);
    RideManager.activeRides.set(rideId, rideData);

    // 保存发车记录（用于炸车处理）
    const rideRecord = {
      rideId: rideId,
      roomName: roomName,
      riders: allRiders.map(rider => ({
        username: rider.username,
        uid: rider.uid,
        accountId: rider.accountId
      })),
      rideInfo: rideInfo,
      createdAt: Date.now(),
      status: 'waiting_for_ready',
      crashReports: []
    };
    rideRecords.push(rideRecord);

    // 保存到文件
    saveRideRecord(rideRecord);

    // 限制rideRecords数组大小，只保留最近的1000条记录
    if (rideRecords.length > 1000) {
      rideRecords.shift();
    }

    // 发送发车消息
    log(`发送发车消息给所有骑手`);

    allRiders.forEach(rider => {
      const socket = io.sockets.sockets.get(rider.socketId);
      if (socket) {
        socket.emit('message', {
          type: 'ride-message-1',
          rideId: rideId,
          rideInfo: rideInfo,
          rideIdentifier: rideId // 发送发车标识给客户端
        });
        log(`向用户 ${rider.username} (${rider.uid}) 发送发车消息`);
      } else {
        log(`未找到用户 ${rider.username} (${rider.uid}) 的连接，socketId: ${rider.socketId}`);
      }
    });

    // 设置30秒超时
    rideData.timeoutId = timerManager.setTimeout(() => {
      log(`发车超时: ${rideId}`);
      const ride = RideManager.activeRides.get(rideId);
      if (ride && ride.status === RideManager.STATUS.WAITING_FOR_READY) {
        // 超时，发送取消消息
        allRiders.forEach(rider => {
          const socket = io.sockets.sockets.get(rider.socketId);
          if (socket) {
            socket.emit('message', {
              type: 'ride-cancel',
              rideId: rideId,
              reason: '超时未收到所有回复'
            });
            log(`向用户 ${rider.username} (${rider.uid}) 发送取消消息`);
          } else {
            log(`未找到用户 ${rider.username} (${rider.uid}) 的连接，socketId: ${rider.socketId}`);
          }
        });

        // 处理发车取消
        RideManager.handleRideCancel(rideId, '超时未收到所有回复');
      }
    }, 30000);

  } finally {
    // 释放锁
    RideManager.roomLocks.set(roomName, false);
    log(`房间 ${roomName} 发车检查已解锁`, LOG_TYPES.RIDE, { room: roomName });
  }
}

// 处理获取可被移动端控制的连接列表
function handleGetUserConnectionsForMobile(socket) {
  // 获取当前socket的连接信息
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', {
      type: 'mobile-connections-list',
      data: {
        success: false,
        message: '未登录'
      }
    });
    return;
  }

  // 获取当前账户的连接（只获取该移动端账户自己的非移动端连接）
  const userConn = userConnections.get(socketData.accountId);
  if (!userConn) {
    socket.emit('message', {
      type: 'mobile-connections-list',
      data: {
        success: true,
        connections: []
      }
    });
    return;
  }

  const connections = [];
  log(`遍历用户连接，总数: ${userConn.connections.length}`, LOG_TYPES.INFO);
  for (const conn of userConn.connections) {
    log(`检查连接: ${conn.connectionId}, isMobile: ${conn.isMobile}, socketId: ${conn.socketId}`, LOG_TYPES.INFO);
    // 跳过移动端连接本身
    if (conn.isMobile) {
      log(`跳过移动端连接: ${conn.connectionId}`, LOG_TYPES.INFO);
      continue;
    }

    // 检查socket是否有效
    const socketInstance = io.sockets.sockets.get(conn.socketId);
    if (!socketInstance) {
      log(`跳过无效连接: ${conn.connectionId}`, LOG_TYPES.INFO);
      continue;
    }

    // 获取连接状态
    let status = 'offline';
    const room = roomUsers.get(conn.roomName);
    if (room && room.users.some(u => u.uid === conn.uid)) {
      status = 'online';
    }

    connections.push({
      connectionId: conn.connectionId || '连接',
      connectionName: conn.connectionName || conn.connectionId || '连接',
      accountId: socketData.accountId,
      uid: conn.uid || '',
      roomName: conn.roomName || '',
      status: status
    });
  }

  socket.emit('message', {
    type: 'mobile-connections-list',
    data: {
      success: true,
      connections: connections
    }
  });
}

// 处理移动端命令
async function handleMobileCommand(message, socket) {
  const { targetConnectionId, command, params } = message.data || {};
  
  // 获取当前socket的连接信息
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', {
      type: 'mobile-command-result',
      data: {
        success: false,
        message: '未登录'
      }
    });
    return;
  }
  
  // 查找目标连接
  let targetSocket = null;
  let targetConnData = null;
  
  for (const [accountId, userConn] of userConnections.entries()) {
    for (const conn of userConn.connections) {
      if (conn.connectionId === targetConnectionId) {
        targetSocket = io.sockets.sockets.get(conn.socketId);
        targetConnData = {
          accountId,
          connection: conn,
          userInfo: userConn.userInfo
        };
        break;
      }
    }
    if (targetSocket) break;
  }
  
  if (!targetSocket || !targetConnData) {
    socket.emit('message', {
      type: 'mobile-command-result',
      data: {
        success: false,
        message: '未找到目标连接'
      }
    });
    return;
  }
  
  // 执行命令
  switch (command) {
    case 'online': {
      const { uid, roomName, username, notHost } = params || {};
      if (uid && roomName) {
        // 转发上线命令给用户端，由用户端自己执行上线
        targetSocket.emit('message', {
          type: 'mobile-online-command',
          data: {
            uid,
            roomName,
            username: username || '移动端',
            notHost: notHost || false
          }
        });
        socket.emit('message', {
          type: 'mobile-command-result',
          data: {
            success: true,
            message: '上线命令已发送'
          }
        });
      } else {
        socket.emit('message', {
          type: 'mobile-command-result',
          data: {
            success: false,
            message: '该连接未设置UID或房间，无法上线'
          }
        });
      }
      break;
    }
    case 'offline': {
      const { uid, roomName, username } = params || {};
      if (uid && roomName) {
        handleUserOffline({
          type: 'user-offline',
          username: username || '',
          uid: uid,
          room: roomName,
          operatorAccountId: targetConnData.accountId,
          reason: '移动端手动下线'
        }, targetSocket);
        socket.emit('message', {
          type: 'mobile-command-result',
          data: {
            success: true,
            message: '下线命令已发送'
          }
        });
      } else {
        socket.emit('message', {
          type: 'mobile-command-result',
          data: {
            success: false,
            message: '该连接未设置UID或房间，无法下线'
          }
        });
      }
      break;
    }
    case 'yjl':
    case 'close-bgi':
    case 'close-game':
    case 'get-schedules':
    case 'execute-schedule': {
      targetSocket.emit('message', {
        type: 'mobile-control-command',
        command: command,
        params: {
          ...params,
          targetSocketId: socket.id // 传递移动端的socketId
        }
      });
      socket.emit('message', {
        type: 'mobile-command-result',
        data: {
          success: true,
          message: `命令 ${command} 已发送`
        }
      });
      break;
    }
    default:
      socket.emit('message', {
        type: 'mobile-command-result',
        data: {
          success: false,
          message: '未知命令'
        }
      });
  }
}

// 处理获取在线用户连接信息
function handleGetOnlineUsers(socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  // 构建所有socket连接的用户信息（排除管理端）
  const socketUsers = {};
  for (const connData of getAllConnections()) {
    const socketId = connData.socketId;
    // 跳过管理员连接
    if (connData.isAdmin) continue;
    // 验证socket是否仍然有效
    const socketInstance = io.sockets.sockets.get(socketId);
    if (!socketInstance) {
      // Socket已断开，从连接管理中清理
      deleteConnection(socketId);
      log(`清理无效socket连接: ${socketId}`, LOG_TYPES.CLEANUP);
      continue;
    }
    
    // 排除管理端连接
    if (!connData.isAdmin) {
      const accountId = connData.accountId;
      if (!socketUsers[accountId]) {
        socketUsers[accountId] = {
          accountId: accountId,
          username: userAccounts[accountId] ? userAccounts[accountId].username : accountId,
          sockets: []
        };
      }
      socketUsers[accountId].sockets.push({
        socketId: socketId,
        roomName: connData.roomName || '未加入房间',
        uid: connData.uid || '未上线',
        connectionId: connData.connectionId || '连接'
      });
    }
  }

  // 转换为数组并计算连接数（基于sockets数组长度）
  const sortedSocketUsers = Object.values(socketUsers)
    .map(user => ({
      ...user,
      connections: user.sockets.length
    }))
    .filter(user => user.connections > 0)
    .sort((a, b) => b.connections - a.connections);

  socket.emit('message', {
    type: 'online-users',
    data: sortedSocketUsers
  });
  log(`发送在线用户连接信息给客户端，包含 ${sortedSocketUsers.length} 个用户`);
}

// -------------------- 炸车报告处理 --------------------
/**
 * 处理收益报告
 * @param {Object} message - 收益报告消息
 * @param {string} message.gameAccount - 游戏账户名
 * @param {number} message.expGain - 经验收益
 * @param {number} message.moraGain - 摩拉收益
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 处理收益报告
 * handleReportGain({ gameAccount: '旅行者', expGain: 12500, moraGain: 50000 }, socket);
 */
/**
 * 获取或创建收益记录文件
 * @param {string} dateStr - 日期字符串，格式为 YYYY-MM-DD
 * @returns {Object} - 收益记录对象
 */
function getOrCreateGainRecords(dateStr) {
  // 构建文件路径
  const filePath = path.join(gainRecordsDir, `${dateStr}.json`);

  // 确保目录存在
  if (!fs.existsSync(gainRecordsDir)) {
    fs.mkdirSync(gainRecordsDir, { recursive: true });
    log(`创建收益记录目录: ${gainRecordsDir}`, LOG_TYPES.INFO);
  }

  // 读取现有记录
  let records = {};
  const fileExists = fs.existsSync(filePath);
  if (fileExists) {
    const existingContent = fs.readFileSync(filePath, 'utf8');
    if (existingContent) {
      try {
        records = JSON.parse(existingContent);
      } catch (parseError) {
        log(`解析收益记录文件失败: ${parseError.message}`, LOG_TYPES.POINTS);
        records = {};
      }
    }
  } else {
    // 新文件添加兜底记录
    records['莫酱'] = [{
      gameAccount: '莫酱',
      expGain: 0,
      moraGain: 0,
      reportedAt: Date.now()
    }];
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    log(`创建收益记录文件: ${filePath}`, LOG_TYPES.INFO);
  }

  return records;
}

/**
 * 获取今天的日期字符串（考虑凌晨4点分界）
 * @returns {string} - 日期字符串，格式为 YYYY-MM-DD
 */
function getTodayDateStr() {
  const now = getBeijingTime();
  // 如果当前时间在凌晨4点之前，使用前一天的日期
  if (now.getHours() < 4) {
    now.setDate(now.getDate() - 1);
  }
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 处理收益值，如果超过150000则进行处理：
 * 1. 如果各位数字中有1，则去掉最靠后的1
 * 2. 如果没有1，则除以10后向上取整
 * 处理后需要递归回去再检查一次，直到满足要求
 * @param {number} value 原始收益值
 * @returns {number} 处理后的收益值
 */
function processExcessiveGain(value) {
  if (value <= 150000) {
    return value;
  }

  const str = String(value);
  // 从右往左找第一个1（最靠后的1）
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === '1') {
      // 去掉该位置的1
      const newStr = str.slice(0, i) + str.slice(i + 1);
      const newValue = parseInt(newStr, 10);
      // 递归检查
      return processExcessiveGain(newValue);
    }
  }
  // 没有找到1，除以10后向上取整
  const newValue = Math.ceil(value / 10);
  // 递归检查
  return processExcessiveGain(newValue);
}

function handleReportGain(message, socket) {
  try {
    let { gameAccount, expGain, moraGain } = message;

    // 对过高的收益值进行处理
    expGain = processExcessiveGain(expGain);
    moraGain = processExcessiveGain(moraGain);

    // 验证必要参数
    if (!gameAccount || expGain === undefined || moraGain === undefined) {
      log('收益报告参数不完整', LOG_TYPES.ERROR);
      if (socket) {
        socket.emit('message', {
          type: 'error',
          message: '收益报告参数不完整'
        });
      }
      return;
    }

    // 从消息中直接获取accountId
    if (!message.accountId) {
      log('收益报告缺少accountId', LOG_TYPES.POINTS);
      if (socket) {
        socket.emit('message', {
          type: 'error',
          message: '收益报告缺少accountId'
        });
      }
      return;
    }
    const accountId = message.accountId;

    // 获取今天的日期字符串
    const dateStr = getTodayDateStr();

    // 获取或创建收益记录
    let records = getOrCreateGainRecords(dateStr);

    // 构建文件路径（用于保存）
    const filePath = path.join(gainRecordsDir, `${dateStr}.json`);

    // 如果该用户当天没有记录，创建新数组
    if (!records[accountId]) {
      records[accountId] = [];
    }

    // 添加新的收益记录
    const gainRecord = {
      gameAccount: gameAccount,
      expGain: expGain,
      moraGain: moraGain,
      reportedAt: Date.now()
    };
    records[accountId].push(gainRecord);

    // 保存记录
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');

    log(`收益记录已保存: 用户 ${accountId}, 游戏账户 ${gameAccount}, 经验 +${expGain}, 摩拉 +${moraGain}`, LOG_TYPES.INFO, {
      accountId: accountId,
      gameAccount: gameAccount,
      expGain: expGain,
      moraGain: moraGain
    });

    // 清理42天前的收益记录文件
    cleanupOldRecords(gainRecordsDir, 42);

    // 发送成功响应
    if (socket) {
      socket.emit('message', {
        type: 'gain-reported',
        message: '收益报告成功'
      });
    }

  } catch (error) {
    handleError(error, 'handleReportGain');
    if (socket) {
      socket.emit('message', {
        type: 'error',
        message: '收益报告处理失败'
      });
    }
  }
}

// ==================== 路线测试任务管理 ====================

/**
 * 生成任务/记录 ID
 */
function generateRouteTestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 校验路线 JSON 是否合法（需为对象，可含 info/points 等字段）
 */
function isValidRouteContent(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (e) {
    return false;
  }
}

/**
 * 管理端：发布路线测试任务
 * @param {Object} message - { routeFileName, routeContent, routeType, statisticsMode, activatePickup, underwater, timeRule, requiredCount }
 * @param {Object} socket
 */
async function handlePublishRouteTest(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', { type: 'error', message: '权限不足' });
    return;
  }

  const { routeFileName, routeContent, routeType, statisticsMode, activatePickup, underwater, timeRule, requiredCount, points } = message;

  if (!routeFileName || !routeContent) {
    socket.emit('message', { type: 'error', message: '路线文件名和内容不能为空' });
    return;
  }
  if (!isValidRouteContent(routeContent)) {
    socket.emit('message', { type: 'error', message: '路线文件内容不是合法的 JSON 对象' });
    return;
  }

  const task = {
    taskId: generateRouteTestId('rt'),
    routeFileName,
    routeContent,
    routeType: (routeType || '').trim() || '默认',
    statisticsMode: statisticsMode || '识别怪物',
    activatePickup: !!activatePickup,
    underwater: !!underwater,
    timeRule: timeRule || '',
    requiredCount: Math.max(1, parseInt(requiredCount, 10) || 1),
    points: Math.max(0, Number(points) || 0.2), // 完成奖励积分，默认 0.2，支持小数
    results: [],          // 已完成的 recordId 列表
    status: 'active',     // active | completed
    createdAt: Date.now()
  };

  routeTestTasks.push(task);
  await saveData(ROUTE_TASKS_FILE, routeTestTasks);

  log(`发布路线测试任务: ${task.taskId}, 路线 ${routeFileName}, 类型 ${task.routeType}, 需测试 ${task.requiredCount} 次`, LOG_TYPES.ADMIN, { accountId: socketData.accountId, taskId: task.taskId });
  socket.emit('message', {
    type: 'route-test-published',
    taskId: task.taskId,
    message: '路线测试任务发布成功'
  });
}

/**
 * 获取已知路线类型列表（用户端偏好设置使用）
 */
async function handleGetRouteTestTypes(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', { type: 'error', message: '未登录' });
    return;
  }
  const types = [...new Set(routeTestTasks.filter(t => t.status === 'active').map(t => t.routeType).filter(Boolean))];
  socket.emit('message', { type: 'route-test-types', types });
}

/**
 * 用户端：申请路线测试任务
 * 规则：routeType 匹配用户选择的类型 + 任务未满员 + 用户当天未测过该路线（同天可测多条不同路线）
 */
async function handleApplyRouteTest(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', { type: 'route-test-error', message: '未登录，无法申请路线测试' });
    return;
  }
  if (socketData.isAdmin) {
    socket.emit('message', { type: 'route-test-error', message: '管理员无法申请路线测试' });
    return;
  }

  const accountId = socketData.accountId;
  const selectedTypes = Array.isArray(message.selectedTypes) ? message.selectedTypes.map(String).filter(Boolean) : [];

  // 记录用户配队与路线偏好（供管理端查看）
  const routePreferences = Array.isArray(message.routePreferences) ? message.routePreferences.map(String).filter(Boolean) : [];
  const combatTeamName = String(message.combatTeamName || '').trim();
  const collectTeams = Array.isArray(message.collectTeams) ? message.collectTeams : [];
  const account = userAccounts[accountId];
  if (account) {
    account.routeTestProfile = {
      routePreferences,
      selectedTypes,
      combatTeamName,
      collectTeams,
      updatedAt: Date.now()
    };
    await saveData(USER_ACCOUNTS_FILE, userAccounts);
    resetDataChangeTimer();
  }
  if (routePreferences.length > 0) {
    LOG(`[路线测试] 用户 ${accountId} 申请，偏好: ${routePreferences.join('、')}，战斗配队: ${combatTeamName || '未填写'}，采集配队: ${collectTeams.length}个`);
  }

  // 当天已测过的任务（凌晨4点分界）
  const todayStr = getTodayDateStr();
  const testedTaskIds = new Set(
    routeTestRecords.filter(r => r.accountId === accountId && r.date === todayStr).map(r => r.taskId)
  );

  // 候选：active + 类型匹配 + 未满员 + 用户当天未测过
  const candidates = routeTestTasks.filter(t =>
    t.status === 'active' &&
    (selectedTypes.length === 0 || selectedTypes.includes(t.routeType)) &&
    t.results.length < t.requiredCount &&
    !testedTaskIds.has(t.taskId)
  );

  if (candidates.length === 0) {
    socket.emit('message', {
      type: 'route-test-error',
      message: selectedTypes.length > 0 ? '没有符合所选类型的可用路线测试任务' : '暂无可用路线测试任务'
    });
    return;
  }

  // 优先分配完成次数最少（最需要凑齐测试次数）的任务，其次最早的
  candidates.sort((a, b) => a.results.length - b.results.length || a.createdAt - b.createdAt);
  const task = candidates[0];

  socket.emit('message', {
    type: 'route-test-distribute',
    data: {
      taskId: task.taskId,
      routeFileName: task.routeFileName,
      routeContent: task.routeContent,
      routeType: task.routeType,
      statisticsMode: task.statisticsMode,
      activatePickup: task.activatePickup,
      underwater: task.underwater,
      timeRule: task.timeRule
    }
  });

  log(`向用户 ${accountId} 分发路线测试任务: ${task.taskId}, 路线 ${task.routeFileName}, 类型 ${task.routeType}`, LOG_TYPES.INFO, { accountId, taskId: task.taskId });
}

/**
 * 用户端：上报路线测试结果
 * 去重：同一用户当天同一路线只能上报一次
 */
async function handleReportRouteTest(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData) {
    socket.emit('message', { type: 'route-test-error', message: '未登录，无法上报结果' });
    return;
  }
  if (socketData.isAdmin) {
    socket.emit('message', { type: 'route-test-error', message: '管理员无法上报路线测试结果' });
    return;
  }

  const accountId = socketData.accountId;
  const { taskId, routeTime, monsterNum, itemNum, expectMora, normalNum, eliteNum, routeFileName } = message;

  if (!taskId || routeTime === undefined || routeTime === null) {
    socket.emit('message', { type: 'route-test-error', message: '路线测试结果参数不完整' });
    return;
  }

  const task = routeTestTasks.find(t => t.taskId === taskId);
  if (!task) {
    socket.emit('message', { type: 'route-test-error', message: '路线测试任务不存在' });
    return;
  }

  const todayStr = getTodayDateStr();

  // 去重：同一用户当天同一路线只能测试一次
  const duplicate = routeTestRecords.find(r => r.accountId === accountId && r.date === todayStr && r.taskId === taskId);
  if (duplicate) {
    log(`路线测试结果去重拒绝: 用户 ${accountId}, 任务 ${taskId}, 当天已测过`, LOG_TYPES.WARN, { accountId, taskId });
    socket.emit('message', { type: 'route-test-error', message: '您今天已经测试过该路线，不能重复上报' });
    return;
  }

  const record = {
    recordId: generateRouteTestId('rtr'),
    taskId,
    routeFileName: routeFileName || task.routeFileName,
    accountId,
    date: todayStr,
    routeTime: Number(routeTime) || 0,
    monsterNum: (monsterNum && typeof monsterNum === 'object') ? monsterNum : {},
    itemNum: (itemNum && typeof itemNum === 'object') ? itemNum : {},
    expectMora: Number(expectMora) || 0,
    normalNum: Number(normalNum) || 0,
    eliteNum: Number(eliteNum) || 0,
    reportedAt: Date.now()
  };

  routeTestRecords.push(record);
  task.results.push(record.recordId);
  if (task.results.length >= task.requiredCount) {
    task.status = 'completed';
  }

  await saveData(ROUTE_RECORDS_FILE, routeTestRecords);
  await saveData(ROUTE_TASKS_FILE, routeTestTasks);

  // 完成路线测试奖励积分（数值由管理端发布时指定，默认 0.2，支持小数）
  const rewardPoints = Number(task.points) || 0;
  if (rewardPoints > 0) {
    const account = userAccounts[accountId];
    if (account) {
      const oldPoints = account.points || 0;
      // 保留两位小数，避免 0.2 累加的浮点精度误差
      account.points = Math.round((oldPoints + rewardPoints) * 100) / 100;
      await saveData(USER_ACCOUNTS_FILE, userAccounts);
      resetDataChangeTimer();
      log(`路线测试奖励积分: 用户 ${accountId} 完成 ${taskId} 获得 ${rewardPoints} 分，当前积分 ${account.points}`, LOG_TYPES.POINTS, { accountId, taskId, points: account.points, gained: rewardPoints });
    }
  }

  log(`路线测试结果上报: 用户 ${accountId}, 任务 ${taskId}, 路线 ${record.routeFileName}, 用时 ${record.routeTime}s, 任务当前 ${task.results.length}/${task.requiredCount} 次`, LOG_TYPES.INFO, { accountId, taskId });
  socket.emit('message', {
    type: 'route-test-result-accepted',
    message: '路线测试结果上报成功'
  });
}

/**
 * 管理端：获取路线测试任务列表
 */
async function handleGetRouteTestTasks(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', { type: 'error', message: '权限不足' });
    return;
  }
  // 附带每条任务的记录数/状态，便于管理端展示
  const tasks = routeTestTasks.map(t => ({
    ...t,
    resultCount: t.results.length
  }));
  socket.emit('message', { type: 'route-test-tasks', tasks });
}

/**
 * 管理端：获取路线测试结果记录
 * @param {Object} message - { taskId? } 可选按任务过滤
 */
async function handleGetRouteTestRecords(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', { type: 'error', message: '权限不足' });
    return;
  }
  const taskId = message && message.taskId;
  const records = taskId
    ? routeTestRecords.filter(r => r.taskId === taskId)
    : routeTestRecords;
  socket.emit('message', { type: 'route-test-records', records });
}

/**
 * 管理端：下载路线测试数据（任务信息 + 测试结果记录，打包为 JSON）
 * @param {Object} message - { taskId? } 可选按任务下载；不传则下载全部
 */
async function handleDownloadRouteTestData(message, socket) {
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', { type: 'error', message: '权限不足' });
    return;
  }

  const taskId = message && message.taskId;
  let tasks = routeTestTasks;
  let records = routeTestRecords;
  if (taskId) {
    tasks = routeTestTasks.filter(t => t.taskId === taskId);
    records = routeTestRecords.filter(r => r.taskId === taskId);
  }

  if (tasks.length === 0 && records.length === 0) {
    socket.emit('message', { type: 'error', message: '没有可下载的路线测试数据' });
    return;
  }

  const exportData = {
    exportedAt: Date.now(),
    exportedAtStr: getBeijingTime().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    tasks: tasks.map(t => ({
      taskId: t.taskId,
      routeFileName: t.routeFileName,
      routeType: t.routeType,
      statisticsMode: t.statisticsMode,
      activatePickup: t.activatePickup,
      underwater: t.underwater,
      timeRule: t.timeRule,
      requiredCount: t.requiredCount,
      points: t.points || 0.2,
      resultCount: t.results.length,
      status: t.status,
      createdAt: t.createdAt
    })),
    records
  };

  const dateStr = getTodayDateStr();
  const fileName = taskId
    ? `路线测试数据_${taskId}_${dateStr}.json`
    : `路线测试数据_全部_${dateStr}.json`;

  socket.emit('message', {
    type: 'route-test-data-file',
    fileName,
    content: JSON.stringify(exportData, null, 2)
  });
  log(`管理员 ${socketData.username} 下载路线测试数据: ${fileName}, 任务 ${tasks.length} 个, 记录 ${records.length} 条`, LOG_TYPES.ADMIN, { accountId: socketData.accountId });
}

/**
 * 处理炸车报告
 * @param {Object} message - 炸车报告消息
 * @param {Object} message.crashInfo - 炸车信息
 * @param {string} [message.rideIdentifier] - 发车标识
 * @param {Object} socket - Socket.io连接对象
 * @example
 * // 处理炸车报告
 * handleReportCrash({ crashInfo: {...}, rideIdentifier: '2024-01-01-大澡堂-1' }, socket);
 */
function handleReportCrash(message, socket) {
  try {
    const { crashInfo, rideIdentifier } = message;

    if (!crashInfo) {
      log('炸车报告信息不完整');
      return;
    }

    // 用户端发送的格式是嵌套的：crashInfo.crashInfo 才是真正的炸车信息
    // crashInfo.rideIdentifier 是联机执行端提供的发车标识
    const actualCrashInfo = crashInfo.crashInfo || crashInfo;
    const actualRideIdentifier = rideIdentifier || crashInfo.rideIdentifier;

    // 找到对应的发车记录
    let relevantRide = null;
    if (actualRideIdentifier) {
      // 使用发车标识直接查找
      relevantRide = rideRecords.find(ride => ride.rideId === actualRideIdentifier);
      if (!relevantRide) {
        log(`未找到对应的发车记录: ${actualRideIdentifier}`);
      }
    } else {
      log('炸车报告缺少发车标识，无法归属到具体发车');
    }

    // 保存炸车报告
    let finalRideIdentifier = actualRideIdentifier;
    if (relevantRide) {
      finalRideIdentifier = relevantRide.rideId;
    }

    crashReports.push({
      ...actualCrashInfo,
      rideIdentifier: finalRideIdentifier,
      reportedAt: Date.now(),
      socketId: socket.id
    });

    // 限制crashReports数组大小，只保留最近的1000条记录
    if (crashReports.length > 1000) {
      crashReports.shift();
    }

    if (relevantRide) {
      // 使用发车ID作为唯一标识
      const rideKey = relevantRide.rideId;

      // 启动或刷新5分钟计时器
      if (crashTimers.has(rideKey)) {
        // 清除现有计时器
        timerManager.clearTimeout(crashTimers.get(rideKey).timeoutId);
      }

      const delay = 2 * 60 * 1000; // 2分钟
      // 设置新的计时器
      const timeoutId = timerManager.setTimeout(() => {
        processCrashReports(rideKey, relevantRide);
        crashTimers.delete(rideKey);
      }, delay);

      crashTimers.set(rideKey, {
        timeoutId,
        startTime: Date.now(),
        delay
      });

      log(`收到炸车报告，已启动2分钟处理计时器 for ride: ${relevantRide.rideId}`);
    } else {
      log('未找到对应的发车记录');
    }

  } catch (error) {
    handleError(error, 'handleReportCrash');
  }
}

/**
 * 处理炸车报告，确定过错方
 * @param {string} rideKey - 发车标识
 * @param {Object} ride - 发车记录对象
 * @example
 * // 处理炸车报告
 * processCrashReports('2024-01-01-大澡堂-1', rideRecord);
 */
function processCrashReports(rideKey, ride) {
  try {
    // 检查ride参数是否有效
    if (!ride) {
      log(`处理炸车报告失败: 发车记录不存在: ${rideKey}`);
      return;
    }

    // 检查ride.riders是否存在
    if (!ride.riders || !Array.isArray(ride.riders)) {
      log(`处理炸车报告失败: 发车记录缺少riders字段: ${rideKey}`);
      return;
    }

    // 收集该次发车的所有炸车报告
    const rideReports = crashReports.filter(report => report.rideIdentifier === rideKey);

    if (rideReports.length === 0) {
      log('没有找到对应的炸车报告');
      return;
    }

    // 分析炸车报告，确定过错方
    let atFaultUids = new Set();

    // 检查是否有房主超时的报告 (客户端发送的是英文 crashType)
    const hostTimeoutReports = rideReports.filter(r => r.crashType === 'waitForExpectedPlayers' || r.crashType === '房主超时未等到预期人数');

    if (hostTimeoutReports.length > 0) {
      // 使用房主报告的信息
      const hostReport = hostTimeoutReports[0];
      const { enteredPlayers, notEnteredPlayers, myPosition } = hostReport;

      if (enteredPlayers && enteredPlayers.length > 0 && notEnteredPlayers && notEnteredPlayers.length > 0) {
        // 所有未进入的玩家记为可疑
        notEnteredPlayers.forEach(player => {
          // 首先从ride对象中根据用户名查找成员，获取其uid
          const member = ride.riders.find(rider => rider.username === player);
          if (member) {
            atFaultUids.add(member.uid);
          }
        });
      } else if (!enteredPlayers || enteredPlayers.length === 0) {
        // 房主自己记为可疑
        // 从ride对象中查找房主，因为ride包含所有骑手的完整信息
        const hostMember = ride.riders.find(rider => {
          // 找到房主：检查所有炸车报告中是否有位置为1的成员
          for (const crashReport of rideReports) {
            const reportMember = crashReport.rideMembers.find(m => m.uid === rider.uid);
            if (reportMember && reportMember.position === '1') {
              return true;
            }
          }
          return false;
        });
        if (hostMember) {
          atFaultUids.add(hostMember.uid);
        }
      }
      // 如果无法确定过错方，atFaultUids保持为空
    } else {
      // 只有队员超时的情况，房主为过错方
      // 从ride对象中查找房主，因为ride包含所有骑手的完整信息
      const hostMember = ride.riders.find(rider => {
        // 查找房主：检查所有炸车报告中是否有位置为1的成员
        for (const crashReport of rideReports) {
          const reportMember = crashReport.rideMembers.find(m => m.uid === rider.uid);
          if (reportMember && reportMember.position === '1') {
            return true;
          }
        }
        return false;
      });
      if (hostMember) {
        atFaultUids.add(hostMember.uid);
      }
      // 如果无法确定房主，atFaultUids保持为空
    }

    // 记录炸车信息日志
    const atFaultUsers = Array.from(atFaultUids).map(uid => {
      const rider = ride.riders.find(r => r.uid === uid);
      return rider ? `${rider.username} (${uid})` : uid;
    });

    log(`炸车处理结果: 发车ID ${ride.rideId}, 过错方: ${atFaultUsers.length > 0 ? atFaultUsers.join(', ') : '无'}`, LOG_TYPES.RIDE, { rideId: ride.rideId, atFault: atFaultUsers });

    // 回退发车时的积分变动并执行补偿
    if (ride.riders && ride.riders.length > 0) {
      const host = ride.riders[0];
      const members = ride.riders.slice(1);

      // 1. 回退房主的-3分（房主加回3分）
      if (host && host.accountId && userAccounts[host.accountId]) {
        userAccounts[host.accountId].points = (userAccounts[host.accountId].points || 0) + 3;
        log(`炸车回退: 房主 ${host.accountId} 加回 3 分，当前积分: ${userAccounts[host.accountId].points}`, LOG_TYPES.POINTS, { accountId: host.accountId, points: userAccounts[host.accountId].points, change: 3 });
      }

      // 2. 回退队员的+1分（队员扣回1分）
      members.forEach(member => {
        if (member.accountId && userAccounts[member.accountId]) {
          userAccounts[member.accountId].points = (userAccounts[member.accountId].points || 0) - 1;
          log(`炸车回退: 队员 ${member.accountId} 扣回 1 分，当前积分: ${userAccounts[member.accountId].points}`, LOG_TYPES.POINTS, { accountId: member.accountId, points: userAccounts[member.accountId].points, change: -1 });
        }
      });

      // 3. 过错方补偿：过错方-6分，其余人+2分
      const atFaultAccountIds = new Set();
      atFaultUids.forEach(uid => {
        const rider = ride.riders.find(r => r.uid === uid);
        if (rider && rider.accountId) {
          atFaultAccountIds.add(rider.accountId);
        }
      });

      // 记录已处理的账户，避免重复扣分
      const processedAccounts = new Set();
      
      ride.riders.forEach(rider => {
        if (rider.accountId && userAccounts[rider.accountId] && !processedAccounts.has(rider.accountId)) {
          processedAccounts.add(rider.accountId);
          
          if (atFaultAccountIds.has(rider.accountId)) {
            // 过错方扣6分
            userAccounts[rider.accountId].points = (userAccounts[rider.accountId].points || 0) - 6;
            log(`炸车补偿: 过错方 ${rider.accountId} 扣除 6 分，当前积分: ${userAccounts[rider.accountId].points}`, LOG_TYPES.POINTS, { accountId: rider.accountId, points: userAccounts[rider.accountId].points, change: -6 });
          } else {
            // 其余人加2分
            userAccounts[rider.accountId].points = (userAccounts[rider.accountId].points || 0) + 2;
            log(`炸车补偿: 非过错方 ${rider.accountId} 获得 2 分，当前积分: ${userAccounts[rider.accountId].points}`, LOG_TYPES.POINTS, { accountId: rider.accountId, points: userAccounts[rider.accountId].points, change: 2 });
          }
        }
      });

      // 保存积分变动
      saveData(USER_ACCOUNTS_FILE, userAccounts);
    }

    // 更新发车记录状态为炸车
    updateRideRecordStatus(ride.rideId, 'crashed', rideReports);

    // 检查是否需要触发自动冻结机制
    checkAutoFreeze(Array.from(atFaultUids));

  } catch (error) {
    handleError(error, 'processCrashReports');
  }
}

/**
 * 检查自动冻结机制
 * @param {Array} atFaultUids - 本次炸车的过错方UID列表
 * @returns {void}
 * @example
 * // 检查自动冻结机制
 * checkAutoFreeze(['123456789']);
 */
function checkAutoFreeze(atFaultUids = []) {
  try {
    // 统计每个账户的炸车次数（当天）
    const today = getBeijingTime();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();

    // 只有当有过错方时才进行统计和冻结检查
    if (atFaultUids.length === 0) {
      return;
    }

    // 统计每个账户作为过错方的炸车次数
    const accountCrashCount = new Map();
    const processedRides = new Set(); // 用于去重，避免同一发车多次统计

    // 统计每个账户作为过错方的炸车次数
    crashReports.forEach(report => {
      if (report.reportedAt >= todayTime && report.rideIdentifier) {
        // 直接使用rideIdentifier查找相关发车记录
        const relevantRide = rideRecords.find(ride => ride.rideId === report.rideIdentifier);

        if (relevantRide && !processedRides.has(report.rideIdentifier)) {
          processedRides.add(report.rideIdentifier);

          // 分析该发车的过错方
          let rideAtFaultUids = new Set();

          // 检查是否有房主超时的报告 (客户端发送的是英文 crashType)
          const hostTimeoutReports = crashReports.filter(r => r.rideIdentifier === report.rideIdentifier && (r.crashType === 'waitForExpectedPlayers' || r.crashType === '房主超时未等到预期人数'));

          if (hostTimeoutReports.length > 0) {
            // 使用房主报告的信息
            const hostReport = hostTimeoutReports[0];
            const { enteredPlayers, notEnteredPlayers } = hostReport;

            if (enteredPlayers && enteredPlayers.length > 0 && notEnteredPlayers && notEnteredPlayers.length > 0) {
              // 所有未进入的玩家记为可疑
              notEnteredPlayers.forEach(player => {
                // 首先从ride对象中根据用户名查找成员，获取其uid
                const member = relevantRide.riders.find(r => r.username === player);
                if (member) {
                  rideAtFaultUids.add(member.uid);
                }
              });
            } else if (!enteredPlayers || enteredPlayers.length === 0) {
              // 房主自己记为可疑
              // 从ride对象中查找房主
              const hostMember = relevantRide.riders.find(rider => {
                // 找到房主：检查所有炸车报告中是否有位置为1的成员
                for (const crashReport of crashReports.filter(cr => cr.rideIdentifier === report.rideIdentifier)) {
                  const reportMember = crashReport.rideMembers.find(m => m.uid === rider.uid);
                  if (reportMember && reportMember.position === '1') {
                    return true;
                  }
                }
                return false;
              });
              if (hostMember) {
                rideAtFaultUids.add(hostMember.uid);
              }
            }
          } else {
            // 只有队员超时的情况，房主为过错方
            // 从ride对象中查找房主
            const hostMember = relevantRide.riders.find(rider => {
              // 查找房主：检查所有炸车报告中是否有位置为1的成员
              for (const crashReport of crashReports.filter(cr => cr.rideIdentifier === report.rideIdentifier)) {
                const reportMember = crashReport.rideMembers.find(m => m.uid === rider.uid);
                if (reportMember && reportMember.position === '1') {
                  return true;
                }
              }
              return false;
            });
            if (hostMember) {
              rideAtFaultUids.add(hostMember.uid);
            }
          }

          // 统计该发车中作为过错方的队员的账户ID（去重，避免同一账户多次统计）
          const rideAtFaultAccounts = new Set();
          rideAtFaultUids.forEach(uid => {
            const rider = relevantRide.riders.find(r => r.uid === uid);
            if (rider && rider.accountId) {
              rideAtFaultAccounts.add(rider.accountId);
            }
          });
          
          // 每个账户在每次发车中只统计一次
          rideAtFaultAccounts.forEach(accountId => {
            accountCrashCount.set(accountId, (accountCrashCount.get(accountId) || 0) + 1);
          });
        }
      }
    });

    // 检查是否有账户需要冻结（当天作为过错方参与炸车）
    for (const [accountId, count] of accountCrashCount.entries()) {
      // 信任用户的临界值为100次，普通用户为2次
      const threshold = userAccounts[accountId]?.safe ? 100 : 2;
      // 获取豁免次数，炸车次数减去豁免次数大于等于临界值时才触发冻结
      const exemption = userAccounts[accountId]?.freezeExemption || 0;
      const effectiveCount = count - exemption;
      if (effectiveCount >= threshold) {
        // 冻结该账户
        if (userAccounts[accountId]) {
          userAccounts[accountId].isFrozen = true; // 使用正确的属性名
          log(`自动冻结账户: ${accountId}，原因: 当天作为过错方参与 ${count} 次炸车（豁免 ${exemption} 次，有效 ${effectiveCount} 次），临界值: ${threshold}`, LOG_TYPES.ADMIN, { accountId: accountId, crashCount: count, exemption: exemption, effectiveCount: effectiveCount, threshold: threshold });

          // 下线该账户的所有在线用户
          for (const [roomName, room] of roomUsers.entries()) {
            // 查找该账户在房间中的所有用户项
            const userItems = room.users.filter(item => item.accountId === accountId);
            userItems.forEach(item => {
              handleUserOffline({
                type: 'user-offline',
                uid: item.uid,
                room: roomName,
                operatorAccountId: accountId,
                reason: '账户冻结自动下线'
              }, null);
            });
          }
        }
      }
    }

  } catch (error) {
    handleError(error, 'checkAutoFreeze');
  }
}

// -------------------- 房间状态查询 --------------------
/**
 * 处理获取房间状态（只返回在线用户）
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取房间状态
 * handleGetRoomsStatus(socket);
 */
function handleGetRoomsStatus(socket) {
  // 构建按房间分组的用户列表（只包含在线用户）
  const roomsStatus = {};

  // 获取socket对应的用户信息
  const socketData = getConnectionBySocketId(socket.id);
  const userAccountId = socketData ? socketData.accountId : null;
  const isAdmin = socketData ? socketData.isAdmin : false;
  const userRooms = userAccountId && userAccounts[userAccountId] ? userAccounts[userAccountId].rooms : [];

  // 遍历所有房间，包括空房间
  rooms.forEach(room => {
    const roomName = room.name;

    // 检查用户是否有权限查看该房间
    if (!isAdmin && !userRooms.includes(roomName)) {
      return; // 跳过用户没有权限的房间
    }

    const roomData = roomUsers.get(roomName);
    const onlineUsers = [];

    if (roomData) {
      // 获取该房间所有在线用户
      roomData.users.forEach(item => {
        // 查找该用户的连接信息，获取 connectionId
        let connectionId = '连接';
        if (item.socketId) {
          const connData = getConnectionByAccountIdAndSocketId(item.accountId, item.socketId);
          if (connData) {
            connectionId = connData.connectionId || '连接';
          }
        }
        
        // 验证用户数据完整性
        if (item.username && item.uid) {
          onlineUsers.push({
            accountId: item.accountId,
            username: item.username,
            uid: item.uid,
            notHost: item.notHost,
            connectionId: connectionId
          });
        } else {
          // 记录不完整的用户数据
          log(`发现不完整的用户数据，跳过`, LOG_TYPES.ERROR, { 
            username: item.username || 'undefined', 
            uid: item.uid || 'undefined',
            accountId: item.accountId || 'undefined',
            room: roomName 
          });
        }
      });
    }

    // 即使没有在线用户，也包含该房间，并添加房间属性
    roomsStatus[roomName] = {
      users: onlineUsers,
      mode: room.mode,
      count: room.count
    };
  });

  // 构建所有在线用户列表
  const allOnlineItems = [];
  for (const [roomName, roomData] of roomUsers.entries()) {
    if (roomData && roomData.users) {
      roomData.users.forEach(user => {
        // 查找该用户的连接信息，获取 connectionId
        let connectionId = '连接';
        if (user.socketId) {
          const connData = getConnectionByAccountIdAndSocketId(user.accountId, user.socketId);
          if (connData) {
            connectionId = connData.connectionId || '连接';
          }
        }
        
        allOnlineItems.push({
          accountId: user.accountId,
          username: user.username,
          uid: user.uid,
          room: roomName,
          notHost: user.notHost,
          connectionId: connectionId,
          socketId: user.socketId,
          isCurrentSocket: user.socketId === socket.id
        });
      });
    }
  }

  socket.emit('message', {
    type: 'rooms-status',
    data: roomsStatus,
    allOnlineItems: allOnlineItems
  });
  log(`发送房间状态给客户端，包含 ${Object.keys(roomsStatus).length} 个房间，${allOnlineItems.length} 个在线用户`);
}

/**
 * 发送更新后的房间状态给所有客户端
 * @returns {void}
 * @example
 * // 发送房间状态给所有客户端
 * sendRoomsStatusToAll();
 */
function sendRoomsStatusToAll() {
  // 向活跃的客户端发送房间状态和已上线用户信息
  for (const connData of getAllConnections()) {
    const socketId = connData.socketId;
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      // 为该socket构建房间状态数据（只包含在线用户）
      const roomsStatus = {};
      const isAdmin = connData.isAdmin;
      const userAccountId = connData.accountId;
      const userRooms = userAccountId && userAccounts[userAccountId] ? userAccounts[userAccountId].rooms : [];

      // 遍历所有房间，包括空房间
      rooms.forEach(room => {
        const roomName = room.name;

        // 检查用户是否有权限查看该房间
        if (!isAdmin && !userRooms.includes(roomName)) {
          return; // 跳过用户没有权限的房间
        }

        const roomData = roomUsers.get(roomName);
        const onlineUsers = [];

        if (roomData) {
          // 获取该房间所有在线用户
          roomData.users.forEach(item => {
            // 查找该用户的连接信息，获取 connectionId
            let connectionId = '连接';
            if (item.socketId) {
              const connData = getConnectionByAccountIdAndSocketId(item.accountId, item.socketId);
              if (connData) {
                connectionId = connData.connectionId || '连接';
              }
            }
            
            onlineUsers.push({
              accountId: item.accountId,
              username: item.username,
              uid: item.uid,
              notHost: item.notHost,
              connectionId: connectionId
            });
          });
        }

        // 即使没有在线用户，也包含该房间，并添加房间属性
        roomsStatus[roomName] = {
          users: onlineUsers,
          mode: room.mode,
          count: room.count
        };
      });

      // 为该socket收集其账户的所有上线信息
      const allOnlineItems = collectUserOnlineItems(connData.accountId, socketId);

      socket.emit('message', {
        type: 'rooms-status',
        data: roomsStatus,
        allOnlineItems: allOnlineItems
      });
    }
  }

  log('发送房间状态给活跃客户端');
}

/**
 * 处理获取积分排行榜
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取积分排行榜
 * handleGetPointsRanking(socket);
 */
function handleGetPointsRanking(socket) {
  // 从userAccounts中获取所有用户的积分
  const ranking = Object.entries(userAccounts)
    .map(([accountId, account]) => ({
      accountId: accountId,
      points: account.points || 0,
      lastRide: account.lastRide || null
    }))
    .sort((a, b) => b.points - a.points); // 按积分从高到低排序

  // 发送排行榜数据给客户端
  socket.emit('message', {
    type: 'points-ranking',
    data: ranking
  });

  log(`发送积分排行榜数据给客户端，包含 ${ranking.length} 个用户`);
}

/**
 * 处理获取用户发车记录
 * @param {Object} message - 获取发车记录消息
 * @param {string} message.accountId - 用户账户ID
 * @param {Object} socket - Socket.io连接对象
 */
function handleGetMyRideRecords(message, socket) {
  const { accountId } = message;

  if (!accountId) {
    socket.emit('message', {
      type: 'my-ride-records',
      success: false,
      message: '缺少账户ID'
    });
    return;
  }

  // 筛选该用户参与的发车记录
  const myRecords = rideRecords.filter(record => {
    if (!record.riders || !Array.isArray(record.riders)) {
      return false;
    }
    // 检查用户是否在发车记录的骑手中
    return record.riders.some(rider => rider.accountId === accountId);
  });

  // 按时间倒序排列（最新的在前）
  myRecords.sort((a, b) => b.createdAt - a.createdAt);

  socket.emit('message', {
    type: 'my-ride-records',
    success: true,
    data: myRecords
  });

  log(`发送发车记录给用户 ${accountId}，共 ${myRecords.length} 条记录`);
}

/**
 * 处理编辑用户积分
 * @param {Object} message - 编辑积分消息
 * @param {string} message.accountId - 用户账户ID
 * @param {number} message.pointsChange - 积分变动值
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理编辑用户积分
 * await handleEditUserPoints({ accountId: 'user123', pointsChange: 10 }, socket);
 */
async function handleEditUserPoints(message, socket) {
  const { accountId, pointsChange } = message;

  // 验证参数
  if (!accountId || pointsChange === undefined) {
    socket.emit('message', {
      type: 'error',
      message: '缺少必要参数'
    });
    return;
  }

  // 检查用户是否存在
  if (!userAccounts[accountId]) {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
    return;
  }

  // 更新用户积分
  const account = userAccounts[accountId];
  const oldPoints = account.points || 0;
  account.points = oldPoints + pointsChange;

  // 保存用户数据
  await saveData(USER_ACCOUNTS_FILE, userAccounts);
  resetDataChangeTimer();

  // 发送成功响应
  socket.emit('message', {
    type: 'success',
    message: `用户 ${accountId} 的积分已更新，从 ${oldPoints} 变为 ${account.points}`
  });

  log(`用户 ${accountId} 的积分已更新，从 ${oldPoints} 变为 ${account.points}`);
}











/**
 * 处理获取所有账户
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取所有账户
 * handleGetAllAccounts(socket);
 */
function handleGetAllAccounts(socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  socket.emit('message', {
    type: 'all-accounts',
    data: userAccounts
  });
  log('发送所有用户列表给管理员');
}

/**
 * 处理更新房间权限
 * @param {Object} data - 更新权限数据
 * @param {string} data.accountId - 用户账户ID
 * @param {string} data.room - 房间名称
 * @param {boolean} data.isGranted - 是否授予权限
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理更新房间权限
 * await handleUpdateRoomPermission({ accountId: 'user123', room: '大澡堂', isGranted: true }, socket);
 */
async function handleUpdateRoomPermission(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { accountId, room, isGranted } = data;

  if (!accountId || !room) {
    socket.emit('message', {
      type: 'error',
      message: '参数不足'
    });
    return;
  }

  if (!userAccounts[accountId]) {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
    return;
  }

  if (room === '大澡堂') {
    socket.emit('message', {
      type: 'error',
      message: '大澡堂权限不能修改'
    });
    return;
  }

  if (!rooms.some(r => r.name === room)) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }

  const account = userAccounts[accountId];

  if (isGranted) {
    // 授予权限
    if (!account.rooms.includes(room)) {
      account.rooms.push(room);
      socket.emit('message', {
        type: 'permission-updated',
        message: '房间权限已添加'
      });
    } else {
      socket.emit('message', {
        type: 'error',
        message: '用户已拥有该房间权限'
      });
    }
  } else {
    // 移除权限
    const roomIndex = account.rooms.indexOf(room);
    if (roomIndex > -1) {
      account.rooms.splice(roomIndex, 1);
      socket.emit('message', {
        type: 'permission-updated',
        message: '房间权限已移除'
      });
    } else {
      socket.emit('message', {
        type: 'error',
        message: '用户没有该房间权限'
      });
    }
  }

  await saveData(USER_ACCOUNTS_FILE, userAccounts);
  resetDataChangeTimer();
  log(`更新用户 ${accountId} 的房间 ${room} 权限为 ${isGranted}`);
}

/**
 * 处理获取所有房间
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取所有房间
 * handleGetAllRooms(socket);
 */
function handleGetAllRooms(socket) {
  // 返回房间名称数组，与现有前端代码兼容
  const roomNames = rooms.map(room => room.name);
  socket.emit('message', {
    type: 'all-rooms',
    data: roomNames
  });
  log('发送所有房间列表给客户端');
}

/**
 * 处理切换用户状态（强制下线）
 * @param {Object} data - 切换用户状态数据
 * @param {string} data.uid - 用户UID
 * @param {string} data.roomName - 房间名称
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理强制用户下线
 * handleToggleUserStatus({ uid: '123456', roomName: '大澡堂' }, socket);
 */
function handleToggleUserStatus(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { uid, roomName } = data;

  if (!uid || !roomName) {
    socket.emit('message', {
      type: 'error',
      message: '参数不足'
    });
    return;
  }

  if (!roomUsers.has(roomName)) {
    socket.emit('message', {
      type: 'error',
      message: '房间不存在'
    });
    return;
  }

  // 查找用户所在的账户
  let targetAccountId = null;
  const room = roomUsers.get(roomName);
  if (room) {
    const userItem = room.users.find(item => item.uid === uid);
    if (userItem) {
      targetAccountId = userItem.accountId;
    }
  }

  if (!targetAccountId) {
    socket.emit('message', {
      type: 'error',
      message: '用户不存在'
    });
    return;
  }

  // 调用下线函数，管理员可以下线任何用户
  handleUserOffline({
    type: 'user-offline',
    uid: uid,
    room: roomName,
    operatorAccountId: targetAccountId,
    reason: '管理员强制下线'
  }, socket);

  log(`管理员强制下线用户 ${uid} 在房间 ${roomName}`);
}

























// ==================== 11. 服务器初始化和配置 ====================
const app = express();
const server = http.createServer(app);

// 添加CORS配置
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});


// 定时器管理器 - 防止定时器泄漏
const timerManager = {
  timers: new Set(),

  setTimeout(callback, delay, ...args) {
    const timer = setTimeout(() => {
      try {
        callback(...args);
      } catch (error) {
        handleError(error, 'timerCallback');
      }
    }, delay, ...args);
    this.timers.add(timer);
    return timer;
  },

  setInterval(callback, interval, ...args) {
    const timer = setInterval(() => {
      try {
        callback(...args);
      } catch (error) {
        handleError(error, 'intervalCallback');
      }
    }, interval, ...args);
    this.timers.add(timer);
    return timer;
  },

  clearTimeout(timer) {
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  },

  clearInterval(timer) {
    if (timer) {
      clearInterval(timer);
      this.timers.delete(timer);
    }
  },

  clearAll() {
    const count = this.timers.size;
    this.timers.forEach(timer => {
      clearTimeout(timer);
      clearInterval(timer);
    });
    this.timers.clear();
    if (count > 0) {
      log(`已清理 ${count} 个定时器`, LOG_TYPES.TIMER, { count: count });
    }
  },

  size() {
    return this.timers.size;
  }
};

/**
 * 重置数据变化计时器
 * @example
 * // 重置数据变化计时器
 * resetDataChangeTimer();
 */


// 房间用户管理：{ roomName: { mode: string, count: number, users: Array<{ username, uid, socketId, accountId, notHost }> } }
// roomUsers: roomName -> { mode, count, users[] }
// userConnections: accountId -> { userInfo, connections: [{ socketId, roomName, username, uid }] }
// adminConnections: accountId -> { adminInfo, connections: [{ socketId, roomName }] }
// rideRecords: 存储每次发车的信息
// crashReports: 存储炸车报告
// crashTimers: { rideKey: timeoutId }

// 启动服务器
async function startServer() {
  try {
    // 初始化数据
    await initData();

    // 初始化房间用户
    await initRoomUsers();

    // 加载发车记录
    loadRideRecords();

    // 输出服务端版本号
    log(`当前服务端版本号为: ${SERVER_VERSION}`, LOG_TYPES.INFO);

    log('服务器初始化完成，开始监听端口...', LOG_TYPES.INFO);
  } catch (error) {
    handleError(error, 'startServer');
    log('服务器初始化失败', LOG_TYPES.ERROR);
  }
}

// 启动服务器
startServer().catch(error => {
  handleError(error, 'startServer');
  process.exit(1);
});

// 清除60天前的日志和发车记录文件
function cleanupOldFiles() {
  try {
    const sixtyDaysAgo = getBeijingTime();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const cutoffTime = sixtyDaysAgo.getTime();

    log(`开始清理60天前的文件，截止时间: ${sixtyDaysAgo.toLocaleString()}`, LOG_TYPES.CLEANUP, { cutoff: sixtyDaysAgo.toLocaleString() });

    // 清理日志文件
    if (fs.existsSync(logDir)) {
      const logFiles = fs.readdirSync(logDir).filter(file => file.endsWith('.log'));
      let deletedLogFiles = 0;

      logFiles.forEach(file => {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          deletedLogFiles++;
          log(`删除60天前的日志文件: ${file}`, LOG_TYPES.CLEANUP, { file: file });
        }
      });

      if (deletedLogFiles > 0) {
        log(`已删除 ${deletedLogFiles} 个60天前的日志文件`, LOG_TYPES.CLEANUP, { count: deletedLogFiles });
      }
    }

    // 清理发车记录文件
    if (fs.existsSync(rideRecordsDir)) {
      const rideFiles = fs.readdirSync(rideRecordsDir).filter(file => file.endsWith('.json'));
      let deletedRideFiles = 0;

      rideFiles.forEach(file => {
        const filePath = path.join(rideRecordsDir, file);
        const stats = fs.statSync(filePath);
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          deletedRideFiles++;
          log(`删除60天前的发车记录文件: ${file}`, LOG_TYPES.CLEANUP, { file: file });
        }
      });

      if (deletedRideFiles > 0) {
        log(`已删除 ${deletedRideFiles} 个60天前的发车记录文件`, LOG_TYPES.CLEANUP, { count: deletedRideFiles });
      }
    }

    log('文件清理完成', LOG_TYPES.CLEANUP);
  } catch (error) {
    handleError(error, 'cleanupOldFiles');
  }
}


// 添加每天凌晨4点自动下线所有用户的定时任务
function setupDailyOfflineTask() {
  // 每天凌晨4点执行
  const scheduleTime = { hour: 4, minute: 0 };

  // 定期清理过期数据的定时器（每5分钟执行一次）
  let cleanupTimer = null;

  function startPeriodicCleanup() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
    }
    cleanupTimer = timerManager.setInterval(() => {
      try {
        cleanupData();
      } catch (error) {
        handleError(error, 'periodicCleanup');
      }
    }, 5 * 60 * 1000); // 5分钟
    log('已启动定期清理任务，每5分钟执行一次', LOG_TYPES.CLEANUP);
  }

  // 计算下次执行时间
  function getNextExecutionTime() {
    const now = getBeijingTime();
    const next = new Date(now);
    next.setHours(scheduleTime.hour, scheduleTime.minute, 0, 0);
    if (next <= now) {
      // 如果今天的时间已过，设置为明天
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // 执行下线任务
  async function executeOfflineTask() {
    log('开始执行每天凌晨4点的自动下线任务', LOG_TYPES.CLEANUP);

    // 清除60天前的日志和发车记录文件
    cleanupOldFiles();

    // 遍历所有房间和用户，执行下线操作
    for (const [roomName, room] of roomUsers.entries()) {
      // 清理房间中的用户项
      for (let i = room.users.length - 1; i >= 0; i--) {
        const userItem = room.users[i];
        // 直接移除所有用户项，因为新结构中只存储在线用户
        room.users.splice(i, 1);
        log(`自动下线用户: ${userItem.username} (UID: ${userItem.uid}) 从房间 ${roomName}`, LOG_TYPES.CLEANUP, { username: userItem.username, uid: userItem.uid, room: roomName });
      }
      // 如果房间为空，从roomUsers中移除
      if (room.users.length === 0) {
        roomUsers.delete(roomName);
        log(`自动下线: 房间 ${roomName} 已清空`, LOG_TYPES.CLEANUP, { room: roomName });
      }
    }

    // 清空发车记录和炸车信息
    rideRecords.length = 0;
    crashReports.length = 0;

    // 清除所有炸车处理计时器
    for (const timerInfo of crashTimers.values()) {
      clearTimeout(timerInfo.timeoutId);
    }
    crashTimers.clear();

    log('已清空发车记录和炸车信息', LOG_TYPES.CLEANUP);

    log('自动下线任务执行完成', LOG_TYPES.CLEANUP);

    // 安排下一次执行
    scheduleNextExecution();
  }

  // 安排下一次执行
  function scheduleNextExecution() {
    const nextTime = getNextExecutionTime();
    const now = getBeijingTime();
    const delay = nextTime - now;
    log(`安排下次自动下线任务在: ${nextTime.toLocaleString()}`, LOG_TYPES.CLEANUP, { nextTime: nextTime.toLocaleString() });
    timerManager.setTimeout(executeOfflineTask, delay);
  }

  // 启动定时任务
  scheduleNextExecution();

  // 启动定期清理任务
  startPeriodicCleanup();
}

// 启动每天自动下线任务
setupDailyOfflineTask();

// 设置定时重启任务
function setupScheduledRestart() {
  // 定义重启时间：3:50
  const restartTimes = [
    { hour: 3, minute: 50 }
  ];

  // 计算下次执行时间
  function getNextRestartTime() {
    const now = getBeijingTime();
    let nextTime = null;
    let minTimeDiff = Infinity;

    // 检查今天的所有重启时间
    for (const time of restartTimes) {
      const candidate = new Date(now);
      candidate.setHours(time.hour, time.minute, 0, 0);

      if (candidate > now) {
        const timeDiff = candidate - now;
        if (timeDiff < minTimeDiff) {
          minTimeDiff = timeDiff;
          nextTime = candidate;
        }
      }
    }

    // 如果今天的时间已过，使用明天的第一个时间
    if (!nextTime) {
      nextTime = new Date(now);
      nextTime.setDate(nextTime.getDate() + 1);
      nextTime.setHours(restartTimes[0].hour, restartTimes[0].minute, 0, 0);
    }

    return nextTime;
  }

  // 执行重启任务
  async function executeRestart() {
    log('开始执行定时重启任务...', LOG_TYPES.INFO);

    // 检查是否有正在进行的发车任务
    if (RideManager.activeRides.size > 0) {
      log(`发现 ${RideManager.activeRides.size} 个正在进行的发车任务，延迟重启`, LOG_TYPES.INFO, { activeRides: RideManager.activeRides.size });

      // 等待30秒后再次检查
      timerManager.setTimeout(async () => {
        await executeRestart();
      }, 30000);

      return;
    }

    // 保存所有数据
    await saveAllData();

    // 执行重启脚本
    const { exec } = require('child_process');
    const restartScript = require('path').join(__dirname, 'restart-server.sh');

    exec(`chmod +x ${restartScript} && ${restartScript}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`执行重启脚本错误: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`重启脚本 stderr: ${stderr}`);
      }
      console.log(`重启脚本 stdout: ${stdout}`);
    });

    // 安排下一次执行
    scheduleNextRestart();
  }

  // 安排下一次执行
  function scheduleNextRestart() {
    const nextTime = getNextRestartTime();
    const now = getBeijingTime();
    const delay = nextTime - now;
    log(`安排下次重启任务在: ${nextTime.toLocaleString()}`, LOG_TYPES.INFO, { nextTime: nextTime.toLocaleString() });
    timerManager.setTimeout(() => {
      executeRestart().catch(error => {
        handleError(error, 'scheduleNextRestart');
      });
    }, delay);
  }

  // 启动定时任务
  scheduleNextRestart();
}

// 启动定时重启任务
setupScheduledRestart();

// Add root path handler
app.get('/', (req, res) => {
  res.send('WebSocket server is running on port 8080');
});

// 版本管理API
app.get('/api/version', (req, res) => {
  // 返回最新版本号
  res.json({
    version: versions.clientVersion,
    groupPurchasingVersion: versions.groupPurchasingVersion
  });
});

/**
 * 处理版本检查请求
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 */
function handleCheckVersion(socket) {
  try {
    log(`处理版本检查请求, socketId: ${socket.id}`, LOG_TYPES.VERSION);
    // 返回最新版本号
    socket.emit('message', {
      type: 'version-check-result',
      data: {
        version: versions.clientVersion,
        groupPurchasingVersion: versions.groupPurchasingVersion,
        serverVersion: SERVER_VERSION
      }
    });
    log(`发送版本信息给客户端, 客户端版本: ${versions.clientVersion}, 团购版本: ${versions.groupPurchasingVersion}`, LOG_TYPES.VERSION);
  } catch (error) {
    handleError(error, 'handleCheckVersion');
  }
}

/**
 * 获取服务器URL
 * @returns {string} 服务器URL
 */
function getServerUrl() {
  // 这里可以根据实际部署情况返回正确的服务器URL
  return 'http://121.41.2.163:41013';
}

/**
 * 处理获取版本信息请求
 * @param {Object} socket - Socket.io连接对象
 */
function handleGetVersions(socket) {
  try {
    log(`处理获取版本信息请求, socketId: ${socket.id}`, LOG_TYPES.INFO);
    socket.emit('message', {
      type: 'versions-result',
      data: {
        clientVersion: versions.clientVersion,
        groupPurchasingVersion: versions.groupPurchasingVersion,
        serverVersion: SERVER_VERSION
      }
    });
  } catch (error) {
    handleError(error, 'handleGetVersions');
  }
}

/**
 * 处理更新版本信息请求
 * @param {Object} data - 更新版本数据
 * @param {string} data.clientVersion - 用户端版本
 * @param {string} data.groupPurchasingVersion - 团购版本
 * @param {Object} socket - Socket.io连接对象
 */
async function handleUpdateVersions(data, socket) {
  try {
    const { clientVersion, groupPurchasingVersion } = data;
    log(`处理更新版本信息请求, socketId: ${socket.id}`, LOG_TYPES.INFO);

    if (clientVersion) {
      versions.clientVersion = clientVersion;
    }
    if (groupPurchasingVersion) {
      versions.groupPurchasingVersion = groupPurchasingVersion;
    }

    await saveData(VERSIONS_FILE, versions);

    socket.emit('message', {
      type: 'update-versions-result',
      data: {
        success: true,
        clientVersion: versions.clientVersion,
        groupPurchasingVersion: versions.groupPurchasingVersion
      }
    });

    log(`版本信息已更新: 用户端=${versions.clientVersion}, 团购=${versions.groupPurchasingVersion}`, LOG_TYPES.INFO);
  } catch (error) {
    handleError(error, 'handleUpdateVersions');
    socket.emit('message', {
      type: 'error',
      message: '更新版本信息失败'
    });
  }
}

/**
 * 处理上传用户端安装包
 * @param {Object} data - 上传数据
 * @param {string} data.fileName - 文件名
 * @param {string} data.fileData - 文件数据（Base64）
 * @param {boolean} data.isFirstChunk - 是否是第一个分片
 * @param {boolean} data.isLastChunk - 是否是最后一个分片
 * @param {number} data.offset - 当前偏移量
 * @param {number} data.totalSize - 总大小
 * @param {Object} socket - Socket.io连接对象
 */
async function handleUploadClientPackage(data, socket) {
  try {
    const { fileName, fileData, isFirstChunk, isLastChunk, offset, totalSize } = data;
    
    // 验证文件名
    if (fileName !== 'mojang.zip') {
      log(`文件名验证失败: ${fileName}, 期望: mojang.zip`, LOG_TYPES.ERROR);
      socket.emit('message', {
        type: 'error',
        message: '文件名必须为 mojang.zip'
      });
      return;
    }
    
    log(`处理上传用户端安装包: ${fileName}, isFirstChunk: ${isFirstChunk}, isLastChunk: ${isLastChunk}, socketId: ${socket.id}`, LOG_TYPES.INFO);

    const storage = uploadStorage.clientPackage;

    if (isFirstChunk) {
      // 终止正在进行的用户端下载
      const terminatedCount = terminateDownloads('client');
      if (terminatedCount > 0) {
        log(`已终止 ${terminatedCount} 个用户端下载`, LOG_TYPES.INFO);
      }
      
      downloadLocks.client = true;
      log(`用户端下载已被锁定`, LOG_TYPES.INFO);
      storage.chunks = [];
      storage.totalSize = totalSize;
      storage.fileName = fileName;
    }

    if (fileData) {
      const buffer = Buffer.from(fileData, 'base64');
      storage.chunks.push({ offset, data: buffer });
    }

    if (isLastChunk) {
      downloadLocks.client = false;
      log(`用户端下载已解锁`, LOG_TYPES.INFO);
      storage.chunks.sort((a, b) => a.offset - b.offset);
      const fullBuffer = Buffer.concat(storage.chunks.map(c => c.data));
      const filePath = path.join(__dirname, 'client', 'mojang.zip');
      fs.writeFileSync(filePath, fullBuffer);

      socket.emit('message', {
        type: 'upload-client-package-result',
        data: {
          success: true,
          message: '用户端安装包上传成功'
        }
      });

      log(`用户端安装包已更新: ${filePath}, 大小: ${fullBuffer.length} bytes`, LOG_TYPES.INFO);
    } else {
      const now = Date.now();
      const timeSinceLastUpload = now - lastUploadTime;
      const minInterval = 1000;
      if (timeSinceLastUpload < minInterval) {
        await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastUpload));
      }
      lastUploadTime = Date.now();

      socket.emit('message', {
        type: 'upload-progress',
        data: {
          progress: Math.round((offset / totalSize) * 100)
        }
      });
    }
  } catch (error) {
    downloadLocks.client = false;
    handleError(error, 'handleUploadClientPackage');
    socket.emit('message', {
      type: 'error',
      message: '上传用户端安装包失败'
    });
  }
}

/**
 * 处理上传团购安装包
 * @param {Object} data - 上传数据
 * @param {string} data.fileName - 文件名
 * @param {string} data.fileData - 文件数据（Base64）
 * @param {boolean} data.isFirstChunk - 是否是第一个分片
 * @param {boolean} data.isLastChunk - 是否是最后一个分片
 * @param {number} data.offset - 当前偏移量
 * @param {number} data.totalSize - 总大小
 * @param {Object} socket - Socket.io连接对象
 */
async function handleUploadGroupPurchasingPackage(data, socket) {
  try {
    const { fileName, fileData, isFirstChunk, isLastChunk, offset, totalSize } = data;
    
    // 验证文件名
    if (fileName !== 'ArtifactsGroupPurchasing.zip') {
      log(`文件名验证失败: ${fileName}, 期望: ArtifactsGroupPurchasing.zip`, LOG_TYPES.ERROR);
      socket.emit('message', {
        type: 'error',
        message: '文件名必须为 ArtifactsGroupPurchasing.zip'
      });
      return;
    }
    
    log(`处理上传团购安装包: ${fileName}, isFirstChunk: ${isFirstChunk}, isLastChunk: ${isLastChunk}, socketId: ${socket.id}`, LOG_TYPES.INFO);

    const storage = uploadStorage.groupPurchasingPackage;

    if (isFirstChunk) {
      // 终止正在进行的团购下载
      const terminatedCount = terminateDownloads('groupPurchasing');
      if (terminatedCount > 0) {
        log(`已终止 ${terminatedCount} 个团购下载`, LOG_TYPES.INFO);
      }
      
      downloadLocks.groupPurchasing = true;
      log(`团购下载已被锁定`, LOG_TYPES.INFO);
      storage.chunks = [];
      storage.totalSize = totalSize;
      storage.fileName = fileName;
    }

    if (fileData) {
      const buffer = Buffer.from(fileData, 'base64');
      storage.chunks.push({ offset, data: buffer });
    }

    if (isLastChunk) {
      downloadLocks.groupPurchasing = false;
      log(`团购下载已解锁`, LOG_TYPES.INFO);
      storage.chunks.sort((a, b) => a.offset - b.offset);
      const fullBuffer = Buffer.concat(storage.chunks.map(c => c.data));
      const filePath = path.join(__dirname, 'JsScript', 'ArtifactsGroupPurchasing.zip');
      fs.writeFileSync(filePath, fullBuffer);

      socket.emit('message', {
        type: 'upload-group-purchasing-package-result',
        data: {
          success: true,
          message: '团购安装包上传成功'
        }
      });

      log(`团购安装包已更新: ${filePath}, 大小: ${fullBuffer.length} bytes`, LOG_TYPES.INFO);
    } else {
      const now = Date.now();
      const timeSinceLastUpload = now - lastUploadTime;
      const minInterval = 1000;
      if (timeSinceLastUpload < minInterval) {
        await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastUpload));
      }
      lastUploadTime = Date.now();

      socket.emit('message', {
        type: 'upload-progress',
        data: {
          progress: Math.round((offset / totalSize) * 100)
        }
      });
    }
  } catch (error) {
    downloadLocks.groupPurchasing = false;
    handleError(error, 'handleUploadGroupPurchasingPackage');
    socket.emit('message', {
      type: 'error',
      message: '上传团购安装包失败'
    });
  }
}

/**
 * 从 asar 二进制中提取指定文件列表的源码内容（无需外部依赖）
 * asar 格式: [4字节 header长度(uint32 LE)][JSON header][padding][文件数据体]
 */
function extractAsarSources(asarBuffer, wantedFiles) {
  try {
    // 新版 asar 格式可能有额外的整数头（多个 uint32），直接扫描 { 定位 JSON
    const jsonStart = asarBuffer.indexOf('{', 0, 'utf8');
    if (jsonStart === -1) {
      log(`extractAsarSources: 未找到 JSON 起始位置`, LOG_TYPES.ERROR);
      return null;
    }
    log(`extractAsarSources: JSON 起始偏移=${jsonStart}, bufferSize=${asarBuffer.length}`, LOG_TYPES.DEBUG);
    
    // 从 JSON 起始位置读取，找到完整的 } 作为结尾
    const jsonStr = asarBuffer.toString('utf8', jsonStart);
    let depth = 0;
    let jsonEnd = -1;
    for (let i = 0; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') depth++;
      else if (jsonStr[i] === '}') {
        depth--;
        if (depth === 0) { jsonEnd = jsonStart + i; break; }
      }
    }
    if (jsonEnd === -1) {
      log(`extractAsarSources: 未找到 JSON 结尾的 }`, LOG_TYPES.ERROR);
      return null;
    }
    log(`extractAsarSources: JSON 结尾偏移=${jsonEnd}`, LOG_TYPES.DEBUG);
    
    // JSON header 按 4 字节对齐
    const headerEnd = ((jsonEnd + 1 + 3) & ~3);
    const header = JSON.parse(jsonStr.substring(0, jsonEnd + 1 - jsonStart));
    
    // body 起始偏移 = headerEnd（按 4 对齐后）
    const bodyOffset = headerEnd;
    log(`extractAsarSources: bodyOffset=${bodyOffset}`, LOG_TYPES.DEBUG);
    
    // 递归查找文件
    function findFiles(node, path = '', files = {}) {
      if (node.files) {
        for (const [name, info] of Object.entries(node.files)) {
          const fullPath = path ? `${path}/${name}` : name;
          if (info.files) {
            findFiles(info, fullPath, files);
          } else {
            const offset = parseInt(info.offset);
            const size = parseInt(info.size);
            files[fullPath] = { offset: bodyOffset + offset, size };
            log(`extractAsarSources: 找到文件 ${fullPath}, offset=${bodyOffset + offset}, size=${size}`, LOG_TYPES.DEBUG);
          }
        }
      }
      return files;
    }
    
    const fileMap = findFiles(header);
    log(`extractAsarSources: 找到文件列表: ${Object.keys(fileMap).join(', ')}`, LOG_TYPES.DEBUG);
    
    let combinedSource = '';
    for (const name of wantedFiles) {
      let info = fileMap[name];
      if (!info) {
        for (const [fullPath, fi] of Object.entries(fileMap)) {
          if (fullPath.endsWith('/' + name) || fullPath === name) {
            info = fi;
            break;
          }
        }
      }
      if (info) {
        const content = asarBuffer.toString('utf8', info.offset, info.offset + info.size);
        log(`extractAsarSources: 读取文件 ${name}, offset=${info.offset}, size=${info.size}, 内容前50字符=${content.substring(0, 50)}`, LOG_TYPES.DEBUG);
        combinedSource += content;
      } else {
        log(`extractAsarSources: 未找到文件 ${name}`, LOG_TYPES.WARN);
      }
    }
    
    if (!combinedSource) {
      return null;
    }
    log(`extractAsarSources: 合并源码长度=${combinedSource.length}`, LOG_TYPES.DEBUG);
    return combinedSource;
  } catch (e) {
    log(`extractAsarSources 异常: ${e.message}`, LOG_TYPES.ERROR);
    return null;
  }
}

/**
 * 处理上传 app.asar
 */
async function handleUploadAsar(data, socket) {
  try {
    const { fileName, fileData, isFirstChunk, isLastChunk, offset, totalSize, version } = data;
    
    if (fileName !== 'app.asar') {
      socket.emit('message', { type: 'error', message: '文件名必须为 app.asar' });
      return;
    }
    
    if (!version) {
      socket.emit('message', { type: 'error', message: '缺少版本号' });
      return;
    }

    const storageKey = `asar_${version}`;
    if (!uploadStorage[storageKey]) {
      uploadStorage[storageKey] = { chunks: [] };
    }
    const storage = uploadStorage[storageKey];

    if (isFirstChunk) {
      storage.chunks = [];
      storage.totalSize = totalSize;
    }

    if (fileData) {
      const buffer = Buffer.from(fileData, 'base64');
      storage.chunks.push({ offset, data: buffer });
    }

    socket.emit('message', {
      type: 'upload-progress',
      data: { progress: Math.round((offset / totalSize) * 100) }
    });

    if (isLastChunk) {
      storage.chunks.sort((a, b) => a.offset - b.offset);
      const fullBuffer = Buffer.concat(storage.chunks.map(c => c.data));
      
      const versionDir = path.join(ASAR_DIR, version);
      if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
      }
      const filePath = path.join(versionDir, 'app.asar');
      fs.writeFileSync(filePath, fullBuffer);
      
      // 从 asar 中提取源码并保存 source.txt（纯 Node.js 解析，无需额外依赖）
      const sourceText = extractAsarSources(fullBuffer, ['index.html', 'main.js', 'preload.js']);
      if (sourceText) {
        const sourcePath = path.join(versionDir, 'source.txt');
        fs.writeFileSync(sourcePath, sourceText, 'utf8');
        log(`从 app.asar 中提取源码成功，保存到 ${sourcePath}，大小: ${sourceText.length} 字符`, LOG_TYPES.INFO);
      } else {
        log(`警告: 无法从版本 ${version} 的 app.asar 中提取源码（extractAsarSources 返回 null）`, LOG_TYPES.ERROR);
      }
      
      delete uploadStorage[storageKey];

      socket.emit('message', {
        type: 'upload-asar-result',
        data: { success: true, message: `版本 ${version} 的 app.asar 上传成功` }
      });
      log(`app.asar 已上传: ${filePath}, 大小: ${fullBuffer.length} bytes`, LOG_TYPES.ADMIN);
    }
  } catch (error) {
    handleError(error, 'handleUploadAsar');
    socket.emit('message', { type: 'error', message: '上传 app.asar 失败' });
  }
}

// 应用带宽限制中间件
app.use(bandwidthLimitMiddleware);

// 静态文件服务，提供其他静态文件
// 注意：带宽限制中间件会优先处理 /client/mojang.zip 和 /server/client/mojang.zip 请求
app.use('/server', express.static(__dirname));

// 用户端下载中间件（带下载锁检查和跟踪）
app.use('/client/mojang.zip', (req, res, next) => {
  if (downloadLocks.client) {
    log(`用户端下载被锁定，拒绝请求`, LOG_TYPES.WARN);
    return res.status(503).json({
      error: 'download-locked',
      message: '正在上传中，请稍后再试'
    });
  }
  
  // 生成唯一下载ID
  const downloadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const downloadInfo = {
    id: downloadId,
    type: 'client',
    startTime: Date.now(),
    response: res
  };
  
  // 存储下载信息
  activeDownloads.set(downloadId, downloadInfo);
  
  // 监听响应结束事件，清理下载信息
  res.on('finish', () => {
    activeDownloads.delete(downloadId);
    log(`用户端下载完成: ${downloadId}`, LOG_TYPES.INFO);
  });
  
  // 监听响应关闭事件，清理下载信息
  res.on('close', () => {
    activeDownloads.delete(downloadId);
    log(`用户端下载中断: ${downloadId}`, LOG_TYPES.INFO);
  });
  
  next();
});

// 团购下载中间件（带下载锁检查和跟踪）
app.use('/JsScript/ArtifactsGroupPurchasing.zip', (req, res, next) => {
  if (downloadLocks.groupPurchasing) {
    log(`团购下载被锁定，拒绝请求`, LOG_TYPES.WARN);
    return res.status(503).json({
      error: 'download-locked',
      message: '正在上传中，请稍后再试'
    });
  }
  
  // 生成唯一下载ID
  const downloadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const downloadInfo = {
    id: downloadId,
    type: 'groupPurchasing',
    startTime: Date.now(),
    response: res
  };
  
  // 存储下载信息
  activeDownloads.set(downloadId, downloadInfo);
  
  // 监听响应结束事件，清理下载信息
  res.on('finish', () => {
    activeDownloads.delete(downloadId);
    log(`团购下载完成: ${downloadId}`, LOG_TYPES.INFO);
  });
  
  // 监听响应关闭事件，清理下载信息
  res.on('close', () => {
    activeDownloads.delete(downloadId);
    log(`团购下载中断: ${downloadId}`, LOG_TYPES.INFO);
  });
  
  next();
});

// 额外的静态文件服务，确保 /client 路径也能访问
app.use('/client', express.static(path.join(__dirname, 'client')));

// 静态文件服务，提供JsScript目录
app.use('/JsScript', express.static(path.join(__dirname, 'JsScript')));

// ==================== 11. 日志和记录管理 ====================
/**
 * 处理获取日志文件列表
 * @param {Object} socket - Socket.io连接对象
 * @returns {void}
 * @example
 * // 处理获取日志文件列表
 * handleGetLogFiles(socket);
 */
function handleGetLogFiles(socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const fs = require('fs');
  const logDir = path.join(__dirname, 'log');

  try {
    // 检查log目录是否存在
    if (!fs.existsSync(logDir)) {
      // 如果目录不存在，创建它
      fs.mkdirSync(logDir, { recursive: true });
      // 发送空列表
      socket.emit('message', {
        type: 'log-files',
        data: []
      });
      log('创建log目录并发送空日志文件列表给管理员');
      return;
    }

    const files = fs.readdirSync(logDir).filter(file => file.endsWith('.log'));
    socket.emit('message', {
      type: 'log-files',
      data: files
    });
    log('发送日志文件列表给管理员');
  } catch (error) {
    socket.emit('message', {
      type: 'error',
      message: '获取日志文件列表失败'
    });
    log(`获取日志文件列表失败: ${error.message}`);
  }
}

/**
 * 处理获取日志文件内容
 * @param {Object} data - 获取日志文件内容数据
 * @param {string} data.fileName - 日志文件名
 * @param {Object} socket - Socket.io连接对象
 * @returns {Promise<void>}
 * @example
 * // 处理获取日志文件内容
 * await handleGetLogFileContent({ fileName: '2024-01-01.log' }, socket);
 */
async function handleGetLogFileContent(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { fileName } = data;

  if (!fileName) {
    socket.emit('message', {
      type: 'error',
      message: '文件名不能为空'
    });
    return;
  }

  const fs = require('fs');
  const logDir = path.join(__dirname, 'log');
  const filePath = path.join(logDir, fileName);

  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    socket.emit('message', {
      type: 'log-file-content',
      fileName: fileName,
      content: content
    });
    log(`发送日志文件 ${fileName} 内容给管理员`);
  } catch (error) {
    socket.emit('message', {
      type: 'error',
      message: '读取日志文件失败'
    });
    log(`读取日志文件 ${fileName} 失败: ${error.message}`);
  }
}

// 处理下载日志文件
async function handleDownloadLogFile(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { fileName } = data;

  if (!fileName) {
    socket.emit('message', {
      type: 'error',
      message: '文件名不能为空'
    });
    return;
  }

  const fs = require('fs');
  const logDir = path.join(__dirname, 'log');
  const filePath = path.join(logDir, fileName);

  try {
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      socket.emit('message', {
        type: 'error',
        message: '日志文件不存在'
      });
      return;
    }

    // 读取文件内容
    const content = await fs.promises.readFile(filePath, 'utf8');

    // 发送文件内容给客户端
    socket.emit('message', {
      type: 'log-file-download',
      fileName: fileName,
      content: content
    });
    log(`发送日志文件 ${fileName} 下载给管理员`);
  } catch (error) {
    socket.emit('message', {
      type: 'error',
      message: '下载日志文件失败'
    });
    log(`下载日志文件 ${fileName} 失败: ${error.message}`);
  }
}

// 处理获取发车记录
async function handleGetRideRecords(data, socket) {
  // 检查是否已登录且是管理员
  const socketData = getConnectionBySocketId(socket.id);
  if (!socketData || !socketData.isAdmin) {
    socket.emit('message', {
      type: 'error',
      message: '权限不足'
    });
    return;
  }

  const { date } = data;

  if (!date) {
    socket.emit('message', {
      type: 'error',
      message: '日期不能为空'
    });
    return;
  }

  try {
    const filePath = path.join(rideRecordsDir, `${date}.json`);

    if (fs.existsSync(filePath)) {
      const content = await fs.promises.readFile(filePath, 'utf8');
      let records = [];
      if (content) {
        try {
          records = JSON.parse(content);
        } catch (parseError) {
          log(`解析发车记录文件失败: ${parseError.message}`, LOG_TYPES.RIDE);
          records = [];
        }
      }
      socket.emit('message', {
        type: 'ride-records',
        data: records
      });
      log(`发送 ${date} 的发车记录给管理员，共 ${records.length} 条`);
    } else {
      socket.emit('message', {
        type: 'ride-records',
        data: []
      });
      log(`未找到 ${date} 的发车记录文件`);
    }
  } catch (error) {
    handleError(error, 'handleGetRideRecords');
    socket.emit('message', {
      type: 'error',
      message: '读取发车记录失败'
    });
  }
}

/**
 * 处理获取收益记录
 * @param {Object} data - 请求数据
 * @param {string} data.type - 类型：day(日榜), week(周榜), version(版本榜)
 * @param {string} [data.date] - 日期（YYYY-MM-DD格式，日榜时必填）
 * @param {string} [data.requestAccountId] - 请求者的账户ID（用于标记"自己"）
 * @param {Object} socket - Socket.io连接对象
 */
async function handleGetGainRecords(data, socket) {
  try {
    const { gainType, date, requestAccountId } = data;
    const type = gainType;

    // 获取指定日期的收益文件路径列表
    function getDateFiles(targetDate) {
      const filePath = path.join(gainRecordsDir, `${targetDate}.json`);
      if (fs.existsSync(filePath)) {
        return [filePath];
      }
      // 如果文件不存在，创建包含兜底记录的文件
      getOrCreateGainRecords(targetDate);
      return [filePath];
    }

    // 获取日期范围内的所有文件
    function getDateRangeFiles(startDate, endDate) {
      const files = [];
      const start = new Date(startDate);
      const end = new Date(endDate);
      const current = new Date(start);

      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        const filePath = path.join(gainRecordsDir, `${dateStr}.json`);
        if (fs.existsSync(filePath)) {
          files.push(filePath);
        }
        current.setDate(current.getDate() + 1);
      }
      return files;
    }

    // 根据类型确定要读取的文件列表
    let filesToRead = [];
    let displayType = '';

    if (type === 'day') {
      // 日榜：指定日期
      if (!date) {
        socket.emit('message', {
          type: 'error',
          message: '日期不能为空'
        });
        return;
      }
      filesToRead = getDateFiles(date);
      displayType = date;
    } else if (type === 'week') {
      // 周榜：最近7天（北京时间凌晨4点分界）
      const now = new Date();
      const today = new Date(now.getTime() - (now.getHours() < 4 ? 1 : 0) * 24 * 60 * 60 * 1000);
      const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
      filesToRead = getDateRangeFiles(weekAgo, today);
      displayType = `最近7天`;
    } else if (type === 'version') {
      // 版本榜：最近42天
      const now = new Date();
      const today = new Date(now.getTime() - (now.getHours() < 4 ? 1 : 0) * 24 * 60 * 60 * 1000);
      const versionAgo = new Date(today.getTime() - 41 * 24 * 60 * 60 * 1000);
      filesToRead = getDateRangeFiles(versionAgo, today);
      displayType = `最近42天版榜`;
    } else {
      socket.emit('message', {
        type: 'error',
        message: '无效的排行榜类型'
      });
      return;
    }

    // 步骤1：读取所有收益记录文件，构建用户-日期的二维数组
    // 数据结构：userDateMap[accountId|gameAccount][date] = { expGain, moraGain }
    const userDateMap = new Map();

    for (const filePath of filesToRead) {
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        if (content) {
          const records = JSON.parse(content);
          const date = path.basename(filePath, '.json'); // 从文件名提取日期

          for (const [accountId, gainList] of Object.entries(records)) {
            for (const gain of gainList) {
              const userKey = `${accountId}|${gain.gameAccount}`;
              
              // 初始化用户数据结构
              if (!userDateMap.has(userKey)) {
                userDateMap.set(userKey, {
                  accountId: accountId,
                  gameAccount: gain.gameAccount,
                  dailyData: new Map() // date -> { expGain, moraGain }
                });
              }
              
              // 累加当日收益
              const userData = userDateMap.get(userKey);
              if (!userData.dailyData.has(date)) {
                userData.dailyData.set(date, { expGain: 0, moraGain: 0 });
              }
              const dailyRecord = userData.dailyData.get(date);
              dailyRecord.expGain += gain.expGain || 0;
              dailyRecord.moraGain += gain.moraGain || 0;
            }
          }
        }
      } catch (parseError) {
        log(`解析收益记录文件失败: ${parseError.message}`, LOG_TYPES.POINTS);
      }
    }

    // 步骤2：处理二维数组
    // 规则：小于0的项归零，经验+摩拉大于26万的双双归零
    for (const [userKey, userData] of userDateMap.entries()) {
      for (const [date, dailyRecord] of userData.dailyData.entries()) {
        // 小于0的项归零
        if (dailyRecord.expGain < 0) {
          log(`用户 ${userKey} ${date} 经验收益(${dailyRecord.expGain})为负数，已归零`, LOG_TYPES.WARN);
          dailyRecord.expGain = 0;
        }
        if (dailyRecord.moraGain < 0) {
          log(`用户 ${userKey} ${date} 摩拉收益(${dailyRecord.moraGain})为负数，已归零`, LOG_TYPES.WARN);
          dailyRecord.moraGain = 0;
        }
        
        // 经验+摩拉大于26万的双双归零
        if (dailyRecord.expGain + dailyRecord.moraGain > 260000) {
          log(`用户 ${userKey} ${date} 单日收益(${dailyRecord.expGain}+${dailyRecord.moraGain}=${dailyRecord.expGain + dailyRecord.moraGain})超过26万，已归零`, LOG_TYPES.WARN);
          dailyRecord.expGain = 0;
          dailyRecord.moraGain = 0;
        }
      }
    }

    // 步骤3：根据请求类型收集对应数据并累加
    // 确定需要包含的日期范围
    let targetDates = new Set();
    for (const filePath of filesToRead) {
      targetDates.add(path.basename(filePath, '.json'));
    }

    // 累加目标日期范围内的收益
    const mergedMap = new Map();
    for (const [userKey, userData] of userDateMap.entries()) {
      let totalExp = 0;
      let totalMora = 0;
      
      for (const [date, dailyRecord] of userData.dailyData.entries()) {
        if (targetDates.has(date)) {
          totalExp += dailyRecord.expGain;
          totalMora += dailyRecord.moraGain;
        }
      }
      
      if (totalExp > 0 || totalMora > 0) {
        mergedMap.set(userKey, {
          accountId: userData.accountId,
          gameAccount: userData.gameAccount,
          expGain: totalExp,
          moraGain: totalMora
        });
      }
    }

    const mergedData = Array.from(mergedMap.values());

    // 按总收益降序排序
    mergedData.sort((a, b) => {
      const totalA = a.expGain + a.moraGain;
      const totalB = b.expGain + b.moraGain;
      return totalB - totalA;
    });

    let isAdmin = false;
    const socketData = getConnectionBySocketId(socket.id);
    if (socketData) {
      isAdmin = socketData.isAdmin || false;
    }

    const resultData = mergedData.map(item => {
      const username = item.accountId;
      const isSelf = requestAccountId && item.accountId === requestAccountId;
      const baseName = `${username}-${item.gameAccount}`;
      return {
        ...item,
        username: username,
        isSelf: isSelf,
        isAdmin: isAdmin,
        displayName: isAdmin ? baseName : (isSelf ? `${baseName}（自己）` : baseName)
      };
    });

    socket.emit('message', {
      type: 'gain-records',
      data: resultData
    });
    log(`发送收益排行榜(${displayType})给客户端，共 ${resultData.length} 条（合并后）`);
  } catch (error) {
    handleError(error, 'handleGetGainRecords');
    socket.emit('message', {
      type: 'error',
      message: '读取收益记录失败'
    });
  }
}

// ==================== 12. WebSocket连接处理 ====================
io.on('connection', (socket) => {
  // 连接限制
  const totalConnections = getTotalConnections();
  log(`新连接: ${socket.id}，当前总数: ${totalConnections + 1}`);

  // 超过最大连接数，拒绝连接
  if (totalConnections >= MAX_CONNECTIONS) {
    log(`连接数已达上限，拒绝连接: ${socket.id}`);
    socket.emit('message', { type: 'error', message: '服务器繁忙，请稍后重试' });
    socket.disconnect();
    return;
  }

  // 初始连接信息，等待登录

  // 设置超时断开
  let authTimeout = timerManager.setTimeout(() => {
    if (!hasConnection(socket.id)) {
      log(`Socket ${socket.id} 认证超时，正在断开连接`);
      socket.disconnect();
    }
  }, 30000); // 30秒内未认证则断开

  // 保存超时ID，以便清除
  socket.authTimeout = authTimeout;

  // 检查是否是管理员重连
  const query = socket.handshake.query;
  if (query.type === 'admin' && query.account) {
    const adminAccount = adminAccounts[query.account];
    if (adminAccount) {
      // 更新管理员连接管理
      if (!adminConnections.has(query.account)) {
        adminConnections.set(query.account, {
          adminInfo: {
            username: adminAccount.username,
            accountId: query.account
          },
          connections: []
        });
      }
      adminConnections.get(query.account).connections.push({
        socketId: socket.id,
        roomName: ''
      });

      log(`管理员 ${query.account} 已重连`);
    }
  }

  // 统一处理消息
  socket.on('message', async (data) => {
    await handleReceivedMessage(socket, data);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    // 从用户连接管理中移除
    const connData = getConnectionBySocketId(socket.id);
    if (connData) {
      const { accountId } = connData;

      // 从userConnections或adminConnections中移除连接
      if (userConnections.has(accountId)) {
        const userConnection = userConnections.get(accountId);
        const connectionIndex = userConnection.connections.findIndex(conn => conn.socketId === socket.id);
        if (connectionIndex !== -1) {
          userConnection.connections.splice(connectionIndex, 1);
          // 如果用户没有其他连接，从userConnections中移除
          if (userConnection.connections.length === 0) {
            userConnections.delete(accountId);
          }
        }
      } else if (adminConnections.has(accountId)) {
        const adminConnection = adminConnections.get(accountId);
        const connectionIndex = adminConnection.connections.findIndex(conn => conn.socketId === socket.id);
        if (connectionIndex !== -1) {
          adminConnection.connections.splice(connectionIndex, 1);
          // 如果管理员没有其他连接，从adminConnections中移除
          if (adminConnection.connections.length === 0) {
            adminConnections.delete(accountId);
          }
        }
      }

      // 计算当前连接数
      const totalConnections = getTotalConnections();
      log(`用户断开连接: ${socket.id}，当前总数: ${totalConnections}`);

      // 清除认证超时
      if (socket.authTimeout) {
        timerManager.clearTimeout(socket.authTimeout);
      }

      // 清理loginKeys
      loginKeys.delete(socket.id);

      // 保存账户ID用于后续操作
      const operatorAccountId = accountId;

      // 查找该socket对应的所有上线用户（从roomUsers）
      const usersToOffline = findUsersBySocketId(socket.id);

      // 同时检查RideManager.activeRides中是否有关联的用户（发车中的用户已从roomUsers移除）
      RideManager.activeRides.forEach((ride, rideId) => {
        if (ride.riders) {
          const offlineRider = ride.riders.find(r => r.socketId === socket.id);
          if (offlineRider) {
            // 发车中断开连接的用户也需要处理
            usersToOffline.push({
              ...offlineRider,
              roomName: ride.roomName
            });
            log(`发现发车中断开连接的用户: ${offlineRider.username} (${offlineRider.uid}) 在发车 ${rideId}`, LOG_TYPES.RIDE);
          }
        }
      });

      // 逐个下线所有用户
      usersToOffline.forEach(user => {
        // 直接调用下线逻辑，不需要通过socket获取accountId
        // 因为连接已经断开，socket可能已经无效
        const offlineData = {
          type: 'user-offline',
          uid: user.uid,
          room: user.roomName,
          operatorAccountId: user.accountId, // 直接传递账户ID
          reason: '用户断开连接自动下线'
        };

        // 执行下线操作，传入null因为socket已断开
        handleUserOffline(offlineData, null);
        log(`用户 ${user.username} (${user.uid}) 因断开连接已自动下线`);
      });

      // 发送更新后的房间状态给所有客户端
      sendRoomsStatusToAll();
    }
  });
});

// ==================== 13. 错误处理和进程管理 ====================
// 全局错误捕获，防止服务端因错误而终止
process.on('uncaughtException', (error) => {
  handleError(error, 'uncaughtException');

  // 不退出进程，继续运行
  log('服务继续运行，未捕获的异常已记录', 'warning');
});

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  handleError(error, 'unhandledRejection');

  log('服务继续运行，未处理的Promise拒绝已记录', 'warning');
});

// 未捕获的异常监听器（Node.js 12+）
process.on('uncaughtExceptionMonitor', (error, origin) => {
  handleError(error, `uncaughtExceptionMonitor - origin: ${origin}`);
});

// 优雅退出处理
process.on('SIGTERM', () => {
  log('收到 SIGTERM 信号，开始优雅退出...');
  cleanupAndExit();
});

process.on('SIGINT', () => {
  log('收到 SIGINT 信号，开始优雅退出...');
  cleanupAndExit();
});

function cleanupAndExit() {
  try {
    timerManager.clearAll();
    log('定时器清理完成');

    io.close(() => {
      log('Socket.IO 服务器已关闭');
      process.exit(0);
    });

    setTimeout(() => {
      log('强制退出');
      process.exit(1);
    }, 5000);
  } catch (error) {
    handleError(error, 'cleanupAndExit');
    process.exit(1);
  }
}

// -------------------- 警告监听器 --------------------
// 警告监听器
process.on('warning', (warning) => {
  log(`[WARNING] ${warning.name}: ${warning.message}`, 'warning');
  if (warning.stack) {
    log(`[WARNING] 堆栈: ${warning.stack}`, 'warning');
  }
});

// ==================== 14. 服务器监听 ====================
const PORT = 41013;

// 服务器启动时，创建当天的收益记录文件（如果不存在）
function initGainRecordsFile() {
  try {
    // 使用通用函数获取或创建收益记录
    getOrCreateGainRecords(getTodayDateStr());
  } catch (error) {
    log(`初始化收益记录文件失败: ${error.message}`, LOG_TYPES.POINTS);
  }
}

// 初始化收益记录文件
initGainRecordsFile();

server.listen(PORT, '0.0.0.0', () => {
  log(`服务器运行于 http://0.0.0.0:${PORT}`);
});