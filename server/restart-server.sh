#!/bin/bash

# 定义变量
SERVER_DIR="/server"
LOG_FILE="$SERVER_DIR/restart.log"
NODE_BIN="node"
SERVER_FILE="server.js"

# 记录重启时间
echo "========================================" >> $LOG_FILE
echo "Restarting server at $(date '+%Y-%m-%d %H:%M:%S')" >> $LOG_FILE

# 停止现有进程
echo "Stopping existing server process..." >> $LOG_FILE
# 使用pkill杀掉所有包含server.js的进程
pkill -f "$SERVER_FILE" || echo "No existing process found" >> $LOG_FILE

# 等待进程完全停止
sleep 3

# 启动新进程
echo "Starting new server process..." >> $LOG_FILE
cd "$SERVER_DIR" && setsid "$NODE_BIN" "$SERVER_FILE" > server.log 2>&1 &

# 记录启动状态
echo "Server restarted successfully at $(date '+%Y-%m-%d %H:%M:%S')" >> $LOG_FILE
echo "========================================" >> $LOG_FILE