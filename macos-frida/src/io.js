// ============ 原生文件 I/O (Frida 运行时无 File/readFileSync, 用 libc open/read/lseek/write) ============
// 读: fileReadString/fileReadBytes/fileExists/readJSONFile
// 写: openForWrite/writeString/fileSync (日志系统 log.js 使用)
// 注: io.js 不再 import utils.js (避免 utils→log→io→utils 环); 本地 iodbg 等价 (MOD_DEBUG 启动时定死)。

var ioApi = null;
function iodbg() { if (typeof globalThis !== "undefined" && globalThis.MOD_DEBUG) console.log.apply(console, arguments); }
export function getIO() {
    if (ioApi) return ioApi;
    var mk = function (name, ret, args) {
        var a = Module.findGlobalExportByName(name);
        return a ? new NativeFunction(a, ret, args) : null;
    };
    ioApi = {
        open:   mk("open", 'int', ['pointer', 'int', 'int']),
        close:  mk("close", 'int', ['int']),
        read:   mk("read", 'int', ['int', 'pointer', 'uint']),
        write:  mk("write", 'long', ['int', 'pointer', 'uint']),
        lseek:  mk("lseek", 'long', ['int', 'long', 'int']),
        access: mk("access", 'int', ['pointer', 'int']),
        fsync:  mk("fsync", 'int', ['int'])
    };
    return ioApi;
}
export function fileReadString(path) {
    try {
        var io = getIO();
        if (!io.open) return null;
        var fd = io.open(Memory.allocUtf8String(path), 0, 0);
        if (fd < 0) return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0) break;
            got += r;
        }
        io.close(fd);
        return buf.readUtf8String(got);
    } catch (e) { return null; }
}
export function fileReadBytes(path) {
    try {
        var io = getIO();
        if (!io.open) return null;
        var fd = io.open(Memory.allocUtf8String(path), 0, 0);
        if (fd < 0) return null;
        var size = io.lseek(fd, 0, 2);
        io.lseek(fd, 0, 0);
        var buf = Memory.alloc(size > 0 ? size : 1);
        var got = 0, r = 0;
        while (got < size) {
            r = io.read(fd, buf.add(got), size - got);
            if (r <= 0) break;
            got += r;
        }
        io.close(fd);
        return { buf: buf, size: got };
    } catch (e) { return null; }
}
export function fileExists(path) {
    try { var io = getIO(); return !!io.access && io.access(Memory.allocUtf8String(path), 0) === 0; } catch (e) { return false; }
}
export function readJSONFile(path) {
    try {
        var s = fileReadString(path);
        if (s === null) { iodbg("readJSONFile 读取失败 '" + path + "'"); return null; }
        var parsed = JSON.parse(s);
        // 诊断: 检测多字节 locale (ja) 是否在解析后被丢失
        // 若 fileReadString 截断或 JSON.parse 静默失败, ja keys 会消失
        var sHasJa = s.indexOf('"ja"') >= 0;
        if (sHasJa) {
            iodbg("readJSONFile '" + path + "' len=" + s.length + " 含'\"ja\"' 但需验证解析后是否保留");
        }
        return parsed;
    } catch (e) { iodbg("readJSONFile 解析失败 '" + path + "': " + e); return null; }
}

// ===== 写入路径 (日志系统) =====
export function openForWrite(path) {
    try {
        var io = getIO();
        if (!io.open) return -1;
        // Darwin fcntl: O_WRONLY=0x0001 O_CREAT=0x0200 O_TRUNC=0x0400
        return io.open(Memory.allocUtf8String(path), 0x0001 | 0x0200 | 0x0400, 0o644);
    } catch (e) { return -1; }
}
export function writeString(fd, s) {
    try {
        var io = getIO();
        if (!io.write || fd < 0) return -1;
        var buf = Memory.allocUtf8String(s);
        var len = 0; while (buf.add(len).readU8() !== 0) len++;   // UTF-8 字节长 (扫 NUL, 免编码坑)
        var off = 0;
        while (off < len) {
            var r = io.write(fd, buf.add(off), len - off);        // 部分写入循环, r<=0 兜底
            if (r <= 0) break;
            off += r;
        }
        return off;
    } catch (e) { return -1; }
}
export function fileSync(fd) {
    try { var io = getIO(); if (io.fsync && fd >= 0) return io.fsync(fd); } catch (e) {}
    return -1;
}