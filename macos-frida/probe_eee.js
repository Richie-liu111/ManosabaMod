// probe_eee.js — 定位 LocalResourceProvider.ctor 的 EEE 根因
// 目标:
//   1. 确认 macOS 上 LRP.ctor 的 methodPointer(+0x00) / invoker(+0x10) 是否为空
//   2. 读取 EEE 异常的 _message (+0x18) 原文 — 区分 "no AOT code" vs 其它
//   3. 若 methodPointer 非空 → 反汇编 ctor 体, 判断是真方法体还是 raise-EEE 的 stub
//   4. 检查游戏启动期间是否真的构造过 LocalResourceProvider (证明 vanilla 用没用它)
//   5. 对照: Script.FromText (已知工作) 的 methodPointer/invoker 作为基准
'use strict';

// ===== Steam 绕过 =====
try { var dl = Module.findGlobalExportByName("dlopen"); if (dl) { var h = false; Interceptor.attach(dl, { onEnter: function (a) { this.p = a[0].readCString(); }, onLeave: function (r) { if (h || r.isNull() || !this.p || this.p.indexOf("libsteam_api") === -1) return; var r2 = Module.findGlobalExportByName("SteamAPI_RestartAppIfNecessary"); if (r2) Interceptor.replace(r2, new NativeCallback(function () { return 0; }, 'bool', ['uint32'])); var i2 = Module.findGlobalExportByName("SteamInternal_SteamAPI_Init"); if (i2) Interceptor.replace(i2, new NativeCallback(function () { return 2; }, 'int', [])); h = true; } }); } } catch (e) { }

var A = {}, E = {}, nv = null, allImgs = [];

function readStr(p) {
    if (!p || p.isNull()) return null;
    try {
        var l = p.add(0x10).readS32();
        if (l <= 0 || l > 9999) return null;
        var s = "";
        for (var i = 0; i < l; i++) s += String.fromCharCode(p.add(0x14 + i * 2).readU16());
        return s;
    } catch (e) { return null; }
}
function makeS(v) { return A.sn(Memory.allocUtf8String(v || "")); }

function invokeRaw(mi, obj, args) {
    var params = args.length ? Memory.alloc(Process.pointerSize * args.length) : ptr(0);
    for (var i = 0; i < args.length; i++) params.add(i * Process.pointerSize).writePointer(args[i]);
    var exc = Memory.alloc(8); exc.writePointer(ptr(0));
    var ret = A.ri(mi, obj, params, exc);
    return { ret: ret, exc: exc.readPointer() };
}

// 读异常: _className +0x10, _message +0x18 (都是 string 指针)
function readExc(ex) {
    if (!ex || ex.isNull()) return "null";
    try {
        var cn = A.cgn(A.ogc(ex)).readCString();
        var msg = readStr(ex.add(0x18).readPointer());
        return "{class=" + cn + ", message='" + msg + "'}";
    } catch (e) { return "exc-parse-err: " + e; }
}

// 打印 Il2CppMethodInfo 关键字段
function dumpMethodInfo(mi, tag) {
    if (!mi || mi.isNull()) { console.log("[eee] " + tag + ": NULL"); return; }
    var mp = mi.readPointer();                 // +0x00 methodPointer
    var inv = mi.add(0x10).readPointer();      // +0x10 invoker_method
    var nm = readStr(mi.add(0x18).readPointer()); // +0x18 name
    var pc = mi.add(0x52).readU8();            // +0x52 parameters_count
    var fl = mi.add(0x50).readU16();           // +0x50 flags (含 virtual/static)
    var virt = (fl & 0x40) !== 0;              // METHOD_ATTRIBUTE_VIRTUAL = 0x40
    var stat = (fl & 0x10) !== 0;              // METHOD_ATTRIBUTE_STATIC = 0x10
    console.log("[eee] " + tag + ": name='" + nm + "' methodPointer=" + mp + " invoker=" + inv +
                " params=" + pc + " flags=0x" + fl.toString(16) +
                (virt ? " [virtual]" : "") + (stat ? " [static]" : ""));
    return { mp: mp, inv: inv };
}

// 反汇编 n 条指令
function disasm(addr, n) {
    try {
        var out = [], ip = addr;
        for (var i = 0; i < n; i++) {
            var ins = Instruction.parse(ip);
            out.push(ins.address.toString() + ": " + ins.mnemonic + "  " + ins.opStr);
            ip = ins.next;
        }
        return out.join("\n");
    } catch (e) { return "disasm err: " + e; }
}

function findClassAllImages(ns, name) {
    var nsStr = Memory.allocUtf8String(ns), nmStr = Memory.allocUtf8String(name);
    var hits = [];
    for (var i = 0; i < allImgs.length; i++) {
        if (!allImgs[i] || allImgs[i].isNull()) continue;
        var c = A.cfn(allImgs[i], nsStr, nmStr);
        if (c && !c.isNull()) {
            var imgName = null; try { imgName = A.ign(allImgs[i]).readCString(); } catch (e) {}
            hits.push({ cls: c, img: imgName });
        }
    }
    return hits;
}

(function () {
    var attempts = 0, hooked = false;
    function doInit() {
        attempts++;
        var ga = Process.findModuleByName("GameAssembly.dylib");
        if (!ga) return false;
        Thread.sleep(0.3);
        var ex = ga.enumerateExports();
        for (var i = 0; i < ex.length; i++) E[ex[i].name] = ex[i].address;
        if (!E.il2cpp_domain_get || !E.il2cpp_class_from_name || !E.il2cpp_runtime_invoke || !E.il2cpp_thread_attach) return false;

        A.dg  = new NativeFunction(E.il2cpp_domain_get, 'pointer', []);
        A.dga = new NativeFunction(E.il2cpp_domain_get_assemblies, 'pointer', ['pointer', 'pointer']);
        A.agi = new NativeFunction(E.il2cpp_assembly_get_image, 'pointer', ['pointer']);
        A.ign = new NativeFunction(E.il2cpp_image_get_name, 'pointer', ['pointer']);
        A.cfn = new NativeFunction(E.il2cpp_class_from_name, 'pointer', ['pointer', 'pointer', 'pointer']);
        A.cgm = new NativeFunction(E.il2cpp_class_get_method_from_name, 'pointer', ['pointer', 'pointer', 'int']);
        A.sn  = new NativeFunction(E.il2cpp_string_new, 'pointer', ['pointer']);
        A.ri  = new NativeFunction(E.il2cpp_runtime_invoke, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']);
        A.ogc = new NativeFunction(E.il2cpp_object_get_class, 'pointer', ['pointer']);
        A.cgn = new NativeFunction(E.il2cpp_class_get_name, 'pointer', ['pointer']);
        A.on  = new NativeFunction(E.il2cpp_object_new, 'pointer', ['pointer']);
        A.cgb = new NativeFunction(E.il2cpp_class_get_image, 'pointer', ['pointer']);

        A.ta  = new NativeFunction(E.il2cpp_thread_attach, 'pointer', ['pointer']);
        var dom = A.dg();
        try { A.ta(dom); console.log("[eee] 线程已 attach"); } catch (e) { console.log("[eee] attach err: " + e); }

        // 枚举全部 image
        var cp = Memory.alloc(8);
        var asms = A.dga(dom, cp); var cnt = cp.readPointer().toInt32();
        for (var i = 0; i < cnt; i++) {
            var a = asms.add(i * 8).readPointer();
            var img = A.agi(a); if (img.isNull()) continue;
            var inm = A.ign(img).readCString();
            if (inm.indexOf("Naninovel.Runtime") >= 0) nv = img;
            allImgs.push(img);
        }
        console.log("[eee] images=" + allImgs.length + " nv=" + (nv ? A.ign(nv).readCString() : "?"));

        // ===== 1. LocalResourceProvider 全 image 定位 =====
        var hits = findClassAllImages("Naninovel", "LocalResourceProvider");
        if (!hits.length) { console.log("[eee] LocalResourceProvider NOT FOUND in any image"); return true; }
        for (var k = 0; k < hits.length; k++)
            console.log("[eee] LRP 命中: image='" + hits[k].img + "' class=" + hits[k].cls);
        var cls = hits[0].cls;

        // ===== 2. ctor MethodInfo 关键字段 =====
        var ctorMi = A.cgm(cls, Memory.allocUtf8String(".ctor"), 1);
        var ci = dumpMethodInfo(ctorMi, "LRP.ctor(1)");

        // ===== 3. runtime_invoke 触发 + 读 EEE 消息 =====
        try {
            var o = A.on(cls);
            var r = invokeRaw(ctorMi, o, [makeS("probe_root")]);
            if (r.exc && !r.exc.isNull())
                console.log("[eee] invoke → 异常: " + readExc(r.exc));
            else
                console.log("[eee] invoke OK, ret=" + r.ret + "  ← ctor 竟然成功了");
        } catch (e) { console.log("[eee] invoke JS err: " + e); }

        // ===== 4. 若 methodPointer 非空: 反汇编 ctor 体 =====
        if (ci.mp && !ci.mp.isNull()) {
            console.log("[eee] ---- LRP.ctor 方法体反汇编 (前 120 字节) ----");
            console.log(disasm(ci.mp, 30));
            console.log("[eee] ---- 结束 ----");
            // 顺带 hook 它, 看游戏启动时是否真的构造 LRP
            if (!hooked) {
                hooked = true;
                try {
                    Interceptor.attach(ci.mp, {
                        onEnter: function (args) {
                            console.log("[eee] >>> 游戏调用了 LRP.ctor! this=" + args[0] + " rootPath='" + readStr(args[1]) + "'");
                        }
                    });
                    console.log("[eee] 已 hook LRP.ctor, 等待游戏构造 (若 30s 内无日志 = vanilla 不用 Local 类型)");
                } catch (e) { console.log("[eee] hook LRP.ctor err: " + e); }
            }
        } else {
            console.log("[eee] methodPointer 为 NULL → 'no AOT code' 方向实锤, 但直调失败是 SIGSEGV 而非 EEE, 需要复核 EEE 消息");
        }

        // ===== 5. 对照基准: Script.FromText (已知工作) =====
        try {
            var sc = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Script"));
            var ft = A.cgm(sc, Memory.allocUtf8String("FromText"), 3);
            dumpMethodInfo(ft, "Script.FromText(3) [对照]");
        } catch (e) { console.log("[eee] 对照 err: " + e); }

        // ===== 6. AddConverter 的 invoker 状态 (为修复做准备) =====
        try {
            var ac = A.cgm(cls, Memory.allocUtf8String("AddConverter"), 1);
            dumpMethodInfo(ac, "LRP.AddConverter(1)");
            // AddConverter 是 virtual generic → 可能 FSG; 打印其 FSG 特征
            if (ac && !ac.isNull()) {
                var acr = ac.add(0x8).readPointer();  // +0x08 methodPointerFlags?
                console.log("[eee] AddConverter +0x08=" + acr + " +0x38(return_type)=" + ac.add(0x38).readPointer());
            }
        } catch (e) { console.log("[eee] AddConverter err: " + e); }

        return true;
    }

    var chk = setInterval(function () {
        try { var ok = doInit(); if (ok) { clearInterval(chk); console.log("[eee] probe done"); } }
        catch (e) { console.log("[eee] ERR: " + e); }
    }, 200);
})();
