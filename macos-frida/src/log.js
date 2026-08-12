// ============ 日志系统: 级别 / 颜色 / 时间戳 / 文件写入 / 崩溃前 flush ============
// 机制: bundle 内所有日志 (wblog/dbg/Unity dumpObj) 经此模块统一输出。
//   console 彩色 (ERROR红/WARN黄/INFO青/DEBUG灰), 文件明文逐行同步写 (崩溃不丢已写行)。
//   文件路径: MOD_LOG fragment (run_mod.sh 注入) 或可执行文件上溯到游戏根; 每运行截断重开。
// 约束: 所有日志调用在 initLog 之后 (entry.js 顶层先 initLog 再装 crash handler)。
import { openForWrite, writeString, fileSync } from "./io.js";

export var LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
var LEVEL_TAG = ["ERROR", "WARN", "INFO", "DEBUG"];
var LEVEL_COLOR = ["31", "33", "36", "90"];   // 红 / 黄 / 青 / 灰

var _fd = -1, _path = null, _noColor = false, _initDone = false, _handlerFired = false;

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
// 若 Frida 提供了 CPU 上下文 (details.context), 顺带写原生回溯 — 定位 invoke 内访问违例的决定性手段。
function crashLine(details) {
    if (_fd < 0) return;
    try {
        var type = details && details.type, addr = details && details.address;
        var line = "[v3][" + ts() + "][FATAL] !!! CRASH signal=" + (type || "?") + " address=" + (addr ? addr.toString() : "0x0") + "\n";
        writeString(_fd, line);
        if (details && details.context) {
            try {
                // 寄存器转储 — macOS .ips 不生成时 (异常被 handler 接过) 也能拿到崩溃上下文
                var c = details.context;
                var regs = [];
                for (var ri = 0; ri <= 28; ri++) {
                    try { var rn = c["x" + ri]; regs.push("x" + ri + "=0x" + rn.toString(16)); } catch (e) {}
                }
                try { regs.push("fp=0x" + c.fp.toString(16)); } catch (e) {}
                try { regs.push("lr=0x" + c.lr.toString(16)); } catch (e) {}
                try { regs.push("sp=0x" + c.sp.toString(16)); } catch (e) {}
                try { regs.push("pc=0x" + c.pc.toString(16)); } catch (e) {}
                writeString(_fd, "    regs: " + regs.join(" ") + "\n");
            } catch (e) {}
            try {
                var frames = Thread.backtrace(details.context, Backtracer.ACCURATE).slice(0, 24);
                for (var i = 0; i < frames.length; i++) {
                    var sym = "";
                    try { var d = DebugSymbol.fromAddress(frames[i]); sym = d ? d.name : ""; } catch (e) {}
                    writeString(_fd, "    #" + i + " 0x" + frames[i].toString(16) + (sym ? "  " + sym : "") + "\n");
                }
            } catch (e) {}
        }
        fileSync(_fd);
    } catch (e) {}
}
// 通用崩溃兜底: 模块可注册一个 fixer, 在异常上下文中先尝试修复再决定放行/恢复。
// fixer(details) 返回 true = 已处理 (已改 details.context, 让 Frida return true 恢复执行);
// 返回 false/undefined = 未处理 → 照常写 CRASH 行 + 放行崩溃。
// 约束: fixer 运行在异常上下文, 禁 console/RPC/分配 — 只读预缓存 + 改 context 寄存器。
var _crashFixer = null;
export function setCrashFixer(fn) { _crashFixer = fn; }
export function installCrashHandler() {
    if (typeof Process === "undefined" || !Process.setExceptionHandler) { installCrashHandlerFallback(); return; }
    try {
        Process.setExceptionHandler(function (details) {
            // 落盘标记 (capture-once, 文件直写不走 console — 异常上下文安全) — 判断 handler 是否真正触发
            try {
                if (!_handlerFired) {
                    _handlerFired = true;
                    var _fa = (details && details.address) ? details.address.toString() : "?";
                    writeString(_fd, "[v3][FATAL][handler] setExceptionHandler FIRED address=" + _fa + "\n");
                }
            } catch (e) {}
            if (_crashFixer) {
                try {
                    if (_crashFixer(details)) {
                        try { writeString(_fd, "[v3][FATAL][handler] fixer HANDLED address=" + ((details && details.address) ? details.address.toString() : "?") + "\n"); } catch (e) {}
                        return true;
                    }
                } catch (e) {}
            }
            try { crashLine(details); } catch (e) {}
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
