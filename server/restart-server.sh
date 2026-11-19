#!/bin/bash

# 脚本随 server.js 部署，兼容原有的 /server 安装位置和手动启动方式。
set -u
SERVER_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
cd -- "$SERVER_DIR" || exit 1
SERVER_FILE="$SERVER_DIR/server.js"
LOG_FILE="$SERVER_DIR/restart.log"
PORT=41013

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

fail() {
    log "$*"
    printf '%s\n' "$*" >&2
    exit 1
}

# 同一次部署只允许一个重启流程。启动子进程时要关闭锁文件描述符。
exec 9>"$SERVER_DIR/.restart.lock" || exit 1
flock -n 9 || fail '已有重启任务，或无法取得重启锁'
NODE_BIN="$(command -v node)" || fail '找不到 node'
[[ -r "$SERVER_FILE" && -r /proc/self/cmdline ]] || fail '无法读取服务入口或 Linux 进程信息'
log '开始重启服务'

is_this_server() {
    local proc_dir="/proc/$1" exe entry
    local -a args
    exe=$(readlink "$proc_dir/exe") || return 1
    [[ "${exe##*/}" == node || "${exe##*/}" == nodejs ]] || return 1
    mapfile -d '' -t args < "$proc_dir/cmdline" || return 1
    entry="${args[1]:-}"
    [[ -n "$entry" ]] || return 1
    if [[ "$entry" != /* ]]; then entry="$proc_dir/cwd/$entry"; fi
    [[ "$(readlink -f -- "$entry")" == "$SERVER_FILE" ]]
}

old_pid=''
for proc_dir in /proc/[0-9]*; do
    pid="${proc_dir##*/}"
    if is_this_server "$pid" 2>/dev/null; then
        [[ -z "$old_pid" ]] || fail '找到多个本目录的服务进程，已停止重启'
        old_pid="$pid"
    fi
done

if [[ -n "$old_pid" ]] && is_this_server "$old_pid"; then
    kill -TERM "$old_pid" || fail "无法停止服务 PID=$old_pid"
    for ((i=0; i<15; i++)); do
        is_this_server "$old_pid" 2>/dev/null || break
        sleep 1
    done
    is_this_server "$old_pid" 2>/dev/null && fail "服务 PID=$old_pid 未按时退出"
fi

# 端口可能由其他实例占用，不能仅凭 HTTP 有响应判断新进程启动成功。
owns_listener() {
    local pid="$1" fd inode
    inode=$(awk -v port="$(printf '%04X' "$PORT")" '$2 ~ (":" port "$") && $4 == "0A" {print $10; exit}' /proc/net/tcp)
    [[ -n "$inode" ]] || return 1
    for fd in /proc/"$pid"/fd/*; do
        [[ "$(readlink "$fd")" == "socket:[$inode]" ]] && return 0
    done
    return 1
}

healthy() (
    local status
    exec 8<>"/dev/tcp/127.0.0.1/$PORT" || exit 1
    printf 'GET /api/version HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&8 || exit 1
    IFS= read -r -t 1 status <&8 && [[ "$status" == HTTP/*' 200 '* ]]
)

setsid "$NODE_BIN" "$SERVER_FILE" 9>&- </dev/null >server.log 2>&1 &
new_pid=$!
for ((i=0; i<30; i++)); do
    kill -0 "$new_pid" 2>/dev/null || fail '服务启动失败，详见 server.log'
    if owns_listener "$new_pid" && healthy 2>/dev/null; then
        log "服务重启成功 PID=$new_pid"
        exit 0
    fi
    sleep 1
done
if is_this_server "$new_pid"; then kill -TERM "$new_pid"; fi
fail '服务未通过启动检查，详见 server.log'
