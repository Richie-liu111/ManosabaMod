// ============ 日志系统: 级别 / 颜色 / 时间戳 / 文件写入 / 崩溃前 flush ============
// 机制: bundle 内所有日志 (wblog/dbg/Unity dumpObj) 经此模块统一输出。
//   console 彩色 (ERROR红/WARN黄/INFO青/DEBUG灰), 文件明文逐行同步写 (崩溃不丢已写行)。
//   文件路径: MOD_LOG fragment (run_mod.sh 注入) 或可执行文件上溯到游戏根; 每运行截断重开。
// 约束: 所有日志调用在 initLog 之后 (entry.js 顶层先 initLog 再装 crash handler)。
import { openForWrite, writeString, fileSync } from "./io.js";

export var LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
var LEVEL_TAG = ["ERROR", "WARN", "INFO", "DEBUG"];
var LEVEL_COLOR = ["31", "33", "36", "90"];   // 红 / 黄 / 青 / 灰

var _fd = -1, _path = null, _noColor = false, _initDone = false;

function isDbg() { return typeof MOD_DEBUG !== "undefined" && MOD_DEBUG; }
function ts() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var p3 = function (n) { n = Math.floor(n); return (n < 100 ? "0" : "") + (n < 10 ? "0" : "") + n; };
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds());
}
function isoDate() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}
// 兜底路径 (未走 run_mod.sh, 如 REPL): 从主模块可执行路径上溯 4 级到游戏根
function defaultLogPath() {
    try {
        var p = Process.mainModule ? Process.mainModule.path : "";
        if (p) { var ps = p.split("/"); if (ps.length > 4) return ps.slice(0, ps.length - 4).join("/") + "/modlog.txt"; }
    } catch (e) {}
    return null;
}
export function initLog(path, noColor) {
    if (_initDone) return;
    _initDone = true;
    _noColor = !!noColor;
    var p = path || defaultLogPath();
    if (p) { _fd = openForWrite(p); if (_fd >= 0) _path = p; }
    if (_fd < 0) {
        try { console.log("[v3][log] modlog 文件不可用: " + (p || "<未指定>") + " (仅终端)"); } catch (e) {}
        return;
    }
    // 会话头 (文件明文首段, 自描述)
    var hdr = "[v3][" + isoDate() + " " + ts() + "][session] ==== manosabamod 运行开始 ====\n" +
              "[v3][session] modlog=" + p + " MOD_DEBUG=" + isDbg() + " noColor=" + _noColor + "\n";
    writeString(_fd, hdr);
}
function emit(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
        var v = args[i];
        parts.push(v === undefined ? "undefined" : v === null ? "null" : String(v));
    }
    var msg = parts.join(" ");
    var line = "[v3][" + ts() + "][" + LEVEL_TAG[level] + "] " + msg;
    if (_noColor) console.log(line);
    else console.log("\x1b[" + LEVEL_COLOR[level] + "m" + line + "\x1b[0m");
    if (_fd >= 0) {
        // 文件明文: 无 ANSI; 消息内换行 → 续行缩进 4 格 (每条逻辑记录从列 0 开始, 好 grep)
        var rec = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\n    ");
        writeString(_fd, rec + "\n");
    }
}
export function error() { emit(LEVELS.ERROR, arguments); }
export function warn()  { emit(LEVELS.WARN,  arguments); }
export function info()  { emit(LEVELS.INFO,  arguments); }
export function debug() { if (isDbg()) emit(LEVELS.DEBUG, arguments); }
// dumpObj 等按级别路由的入口: logLevel(lv, ...args)
export function logLevel(level) { emit(level, Array.prototype.slice.call(arguments, 1)); }

// ASCII 横幅 (MOD 初始化阶段): 整块原样输出保持对齐, 不带逐行 [v3][ts][LEVEL] 前缀;
// 终端青色 (36, 与 INFO 同系), 文件明文原样。约束同 emit (initLog 之后调用)。
export function logBanner(art) {
    if (!art) return;
    var lines = String(art).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (_noColor) console.log(ln);
        else console.log("\x1b[36m" + ln + "\x1b[0m");
        if (_fd >= 0) writeString(_fd, ln + "\n");
    }
}

// ===== 崩溃前 flush =====
// 进程将崩溃时 (SIGSEGV/SIGABRT 等) 追加一条尾部标记到文件。回调运行在异常上下文,
// 禁 console/RPC (死锁风险), 只做同步文件 write + fsync; 返回 false 放行 → 游戏崩溃行为不变。
function crashLine(type, addr) {
    if (_fd < 0) return;
    try {
        var line = "[v3][" + ts() + "][FATAL] !!! CRASH signal=" + (type || "?") + " address=" + (addr ? addr.toString() : "0x0") + "\n";
        writeString(_fd, line);
        fileSync(_fd);
    } catch (e) {}
}
export function installCrashHandler() {
    if (typeof Process === "undefined" || !Process.setExceptionHandler) { installCrashHandlerFallback(); return; }
    try {
        Process.setExceptionHandler(function (details) {
            try { crashLine(details && details.type, details && details.address); } catch (e) {}
            return false;   // 不链式转发 (返回语义未承诺), 直接放行崩溃
        });
    } catch (e) { installCrashHandlerFallback(); }
}
function installCrashHandlerFallback() {
    // setExceptionHandler 不可用备选: 钩 abort / __pthread_kill(SIGABRT=6)
    try {
        var a = Module.findGlobalExportByName("abort");
        if (a) Interceptor.attach(a, { onEnter: function () { crashLine("abort", ptr(0)); } });
        var k = Module.findGlobalExportByName("__pthread_kill");
        if (k) Interceptor.attach(k, { onEnter: function (ar) { try { if (ar[1] && ar[1].toInt32() === 6) crashLine("SIGABRT", ptr(0)); } catch (e) {} } });
    } catch (e) {}
}
