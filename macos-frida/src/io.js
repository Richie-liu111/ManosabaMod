// ============ 原生文件 I/O (Frida 运行时无 File/readFileSync, 用 libc open/read/lseek) ============
import { dbg } from "./utils.js";

var ioApi = null;
export function getIO() {
    if (ioApi) return ioApi;
    var mk = function (name, ret, args) {
        var a = Module.findGlobalExportByName(name);
        return a ? new NativeFunction(a, ret, args) : null;
    };
    ioApi = {
        open:   mk("open", 'int', ['pointer', 'int']),
        close:  mk("close", 'int', ['int']),
        read:   mk("read", 'int', ['int', 'pointer', 'uint']),
        lseek:  mk("lseek", 'long', ['int', 'long', 'int']),
        access: mk("access", 'int', ['pointer', 'int'])
    };
    return ioApi;
}
export function fileReadString(path) {
    try {
        var io = getIO();
        if (!io.open) return null;
        var fd = io.open(Memory.allocUtf8String(path), 0);
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
        var fd = io.open(Memory.allocUtf8String(path), 0);
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
        if (s === null) { dbg("readJSONFile 读取失败 '" + path + "'"); return null; }
        return JSON.parse(s);
    } catch (e) { dbg("readJSONFile 解析失败 '" + path + "': " + e); return null; }
}
