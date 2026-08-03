// ============ 菜单域: 菜单文本 (含翻页, 回迁自 16h 版) + 剧本注册 + StartGame @goto 重定向 ============
// 镜像 Windows AddModStartMenu (ModResourceLoader.cs) + HookStartGame
import { A, dbg, findClassAcrossImages, findSvc, findUnityImg, gotoModifiedCls, invoke, invokeOk, makeLocalResourceProvider, makeNamedStringCtor, makeS, makeUnityObject, readStr } from "./utils.js";

var modScriptPrefix = "TaffyModLoader";
var modMenuScript = "TaffyStart";

// ============ 菜单文本 (镜像 Windows AddModStartMenu, 简化) ============
// buildMenuText 采用 16h 版 (含翻页): 每页 perPage 条, # ChoiceList_<页> 标签, 上一页/下一页 + @Stop
// (16h 回迁的唯一功能, 镜像 Windows AddModStartMenu 的 ChoiceList_<页> 方案)
export function buildMenuText(modList) {
    var t = "@ProcessInput false\n@trialMode false\n@HideUI AutoToggle,WitchBookButtonUI AllowToggle:false time:0\n" +
            "@ShowUI ControlPanel time:0\n@back SubId:\"Overlay\" SolidColor tint:\"#000000\" time:0 Lazy:false\n";
    // 值必须带转义引号 (\"...\"), 否则 '/' 被当成除法表达式
    function setline(varName, val) {
        return "    @set \"" + varName + "=\\\"" + val + "\\\"\"\n";
    }
    // 翻页 (镜像 Windows AddModStartMenu: 每页 perPage 条, # ChoiceList_<页> 标签, 上一页/下一页 + @Stop)
    var perPage = 4;
    var page = 0, idx = 0;
    t += "# ChoiceList_" + page + "\n";
    function addChoice(nm, body) {
        return "@choice \"" + nm + "\" Lock:false play:true show:true\n" + body + "    @goto .GoToModScript\n";
    }
    // 原版
    t += addChoice("原版游戏剧情",
         setline("nextScenario", "Act01_Chapter01/Act01_Chapter01_Adv01") + setline("modKey", "__vanilla__"));
    idx++;
    for (var i = 0; i < modList.length; i++) {
        var m = modList[i];
        var enter = (m.Enter || "Act01_Chapter01/Act01_Chapter01_Adv01").replace(/"/g, '\\"');
        var nm = (m.Name || "Mod" + i).replace(/"/g, '\\"');
        // 页满 → 加导航 + @Stop, 翻页
        if (idx >= perPage) {
            if (page > 0) {
                t += "@choice \"上一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page - 1) + "\n";
            }
            t += "@choice \"下一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page + 1) + "\n";
            t += "@Stop\n";
            page++;
            t += "# ChoiceList_" + page + "\n";
            idx = 0;
        }
        t += addChoice(nm, setline("nextScenario", enter) + setline("modKey", m.key));
        idx++;
    }
    // 结尾: 末页加"上一页" (回到上一页) + @Stop
    if (page > 0) {
        t += "@choice \"上一页\" Lock:false play:true show:true\n    @goto .ChoiceList_" + (page - 1) + "\n";
    }
    t += "@Stop\n" +
         "\n# GoToModScript\n" +
         "@ProcessInput true set:Continue.true,Pause.true,Skip.true,ToggleSkip.true,AutoPlay.true,ToggleUI.true,ShowBacklog.true,Rollback.true\n" +
         "@ClearBacklog\n" +
         "@goto {nextScenario}\n";
    return t;
}

// 注册菜单本地化文档 (镜像 Windows: TextManager.textLoader 上 AddLoadedResource TextAsset)
export function registerMenuText() {
    try {
        var tm = findSvc("TextManager");
        if (!tm) { dbg("[v3] TextManager NOT FOUND"); return; }
        var tmKlass = A.ogc(tm);
        var tlField = A.gf(tmKlass, Memory.allocUtf8String("textLoader"));
        var tl = tm.add(A.fo(tlField)).readPointer();
        if (tl.isNull()) { dbg("[v3] textLoader NULL"); return; }
        var tlKlass = A.ogc(tl);
        dbg("[v3] textLoader=" + tl);

        // 偷 Resource<TextAsset> + LoadedResource<TextAsset> 类 (放宽: 任意条目)
        var resClass = null, lrClass = null;
        try {
            var ldlField = A.gf(tlKlass, Memory.allocUtf8String("LoadedByLocalPath"));
            if (!ldlField || ldlField.isNull()) { dbg("[v3] LoadedByLocalPath 字段 NOT FOUND"); }
            var dict = tl.add(A.fo(ldlField)).readPointer();
            dbg("[v3] text dict=" + dict + " (field offset 0x" + A.fo(ldlField).toString(16) + ")");
            if (!dict.isNull()) {
                var ents = dict.add(0x18).readPointer();
                var al = ents.add(0x18).readS32();
                dbg("[v3] text dict count=" + al);
                for (var e = 0; e < al && e < 30; e++) {
                    var eb = ents.add(0x20 + e * 24);
                    if (eb.readS32() === -1) continue;
                    var ks = readStr(eb.add(8).readPointer());
                    if (e < 5) dbg("[v3] text dict[" + e + "] key=" + ks);
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) {
                        resClass = sysRes.readPointer(); lrClass = lr.readPointer();
                        break;
                    }
                }
            }
        } catch (e2) { dbg("[v3] text class-steal err: " + e2); }
        if (!resClass || !lrClass) { dbg("[v3] 无法偷 TextAsset 类"); return; }

        // new TextAsset()
        var ueImg = findUnityImg();
        if (!ueImg) { dbg("[v3] UnityEngine.CoreModule NOT FOUND"); return; }
        var taCls = A.cfn(ueImg, Memory.allocUtf8String("UnityEngine"), Memory.allocUtf8String("TextAsset"));
        if (!taCls || taCls.isNull()) { dbg("[v3] TextAsset class NOT FOUND"); return; }
        var ta = makeUnityObject(taCls);
        dbg("[v3] TextAsset=" + ta);

        // Resource<TextAsset>
        var textPath = modScriptPrefix + "/Text/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(textPath));
        ourRes.add(0x18).writePointer(ta);

        // ProvisionSource + boxed (和 registerMenu 一致)
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Text"));
        var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
        var boxed = ptr(0);
        if (A.vb && psCls && !psCls.isNull()) { try { boxed = A.vb(psCls, psMem); } catch (e3) {} }

        // LoadedResource ctor + AddHolder + AddLoadedResource
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(tlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!lrCtor || lrCtor.isNull() || !addMi || addMi.isNull()) { dbg("[v3] 方法解析失败"); return; }
        // 打印偷到的类名, 确认泛型实例正确
        try {
            dbg("[v3] resClass=" + A.cgn(resClass).readCString() + " lrClass=" + A.cgn(lrClass).readCString());
        } catch (e4) { dbg("[v3] 类名读取失败: " + e4); }

        // 多键注册 (覆盖所有可能路径)
        var keys = ["Text/Scripts/" + modMenuScript, "Scripts/" + modMenuScript, modScriptPrefix + "/Text/Scripts/" + modMenuScript, modMenuScript];
        for (var ki = 0; ki < keys.length; ki++) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(keys[ki]));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull()) invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, tl, [lr]);
            dbg("[v3] >>> 本地化文档已注册: key=" + keys[ki]);
        }
    } catch (e) { dbg("[v3] registerMenuText err: " + e); }
}

export function registerMenu(modList) {
    // 缓存方案 (镜像 Windows AddModStartMenu): FromText + AddHolder + AddLoadedResource
    try {
        var text = buildMenuText(modList);
        var scriptCls = findClassAcrossImages("Naninovel", "Script");
        if (scriptCls.isNull()) { dbg("[v3] Script class NOT FOUND"); return; }
        var ftMi = A.cgm(scriptCls, Memory.allocUtf8String("FromText"), 3);
        if (!ftMi || ftMi.isNull()) { dbg("[v3] Script.FromText NOT FOUND"); return; }
        var script = invoke(ftMi, ptr(0), [makeS(modMenuScript), makeS(text), ptr(0)]);
        if (script.isNull()) { dbg("[v3] FromText returned null"); return; }
        dbg("[v3] FromText OK, script=" + script);

        var sm = findSvc("ScriptManager");
        if (!sm) { dbg("[v3] ScriptManager NOT FOUND"); return; }
        var rl = sm.add(0x28).readPointer();
        if (rl.isNull()) { dbg("[v3] scriptLoader NULL"); return; }
        var rlKlass = A.ogc(rl);

        // 偷类指针
        var resClass = null, lrClass = null;
        try {
            var dict = rl.add(0x30).readPointer();
            var ents = dict.add(0x18).readPointer();
            var al = ents.add(0x18).readS32();
            for (var e = 0; e < al; e++) {
                var eb = ents.add(0x20 + e * 24);
                if (eb.readS32() === -1) continue;
                var ks = readStr(eb.add(8).readPointer());
                if (ks && ks.indexOf("System/System_Title") >= 0) {
                    var lr = eb.add(16).readPointer();
                    var sysRes = lr.add(0x10).readPointer();
                    if (sysRes && !sysRes.isNull()) { resClass = sysRes.readPointer(); lrClass = lr.readPointer(); }
                    break;
                }
            }
        } catch (e2) { dbg("[v3] class-steal err: " + e2); }
        if (!resClass || !lrClass) { dbg("[v3] 无法偷类指针"); return; }

        var resPath = modScriptPrefix + "/Scripts/" + modMenuScript;
        var ourRes = A.on(resClass);
        ourRes.add(0x10).writePointer(makeS(resPath));
        ourRes.add(0x18).writePointer(script);

        // ProvisionSource struct
        var provProvider = makeLocalResourceProvider("");
        var psMem = Memory.alloc(16);
        psMem.writePointer(provProvider);
        psMem.add(8).writePointer(makeS(modScriptPrefix + "/Scripts"));

        // LoadedResource 用 ctor
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        if (!lrCtor || lrCtor.isNull()) { dbg("[v3] LoadedResource.ctor NOT FOUND"); return; }
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(rlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!addMi || addMi.isNull()) { dbg("[v3] AddLoadedResource NOT FOUND"); return; }

        // 装箱 ProvisionSource 供 AddHolder
        var boxed = ptr(0);
        if (A.vb && addHolderMi && !addHolderMi.isNull()) {
            var psCls = findClassAcrossImages("Naninovel", "ProvisionSource");
            if (psCls && !psCls.isNull()) {
                try { boxed = A.vb(psCls, psMem); } catch (e3) { dbg("[v3] value_box err: " + e3); }
            }
        }
        dbg("[v3] 包装完成, boxed=" + boxed + " provider=" + provProvider);

        function buildAndAdd(localPath) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(localPath));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull()) invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, rl, [lr]);
            dbg("[v3] >>> AddLoadedResource('" + localPath + "') 完成 (含 AddHolder)");
        }
        buildAndAdd(resPath);
        buildAndAdd(modMenuScript);
    } catch (e) { dbg("[v3] registerMenu err: " + e); }
}

// ============ 重定向 StartGame 的 @goto (镜像 Windows HookStartGame) ============
export function hookStartGame() {
    try {
        var sp = findSvc("WitchTrialsScriptPlayer");
        if (!sp) sp = findSvc("ScriptPlayer");
        if (!sp) { dbg("[v3] ScriptPlayer NOT FOUND"); return; }
        var played = sp.add(0x58).readPointer();   // PlayedScript
        if (played.isNull()) { dbg("[v3] PlayedScript NULL"); return; }
        var linesArr = played.add(0x30).readPointer(); // Script.lines
        if (linesArr.isNull()) { dbg("[v3] lines NULL"); return; }
        var n = linesArr.add(0x18).readS32();
        var foundLabel = false;
        for (var i = 0; i < n; i++) {
            var lineObj = linesArr.add(0x20 + i * 8).readPointer();
            if (lineObj.isNull()) continue;
            var cls = A.ogc(lineObj);
            var cn = A.cgn(cls).readCString();
            if (cn === "LabelScriptLine") {
                var lt = readStr(lineObj.add(0x20).readPointer());
                if (lt === "StartGame") foundLabel = true;
            } else if (cn === "CommandScriptLine" && foundLabel) {
                var cmd = lineObj.add(0x20).readPointer();
                if (cmd.isNull()) continue;
                var cmdCls = A.ogc(cmd);
                if (gotoModifiedCls && !gotoModifiedCls.isNull() && cmdCls.equals(gotoModifiedCls)) {
                    dbg("[v3] 找到 StartGame 下的 GotoModified @ line " + i + ", cmd=" + cmd);
                    // Path.SetValue(NamedString(value="TaffyStart", name=""))
                    var pathObj = cmd.add(0x30).readPointer();
                    var nspCls = A.ogc(pathObj);
                    var svMi = A.cgm(nspCls, Memory.allocUtf8String("SetValue"), 1);
                    if (!svMi || svMi.isNull()) { dbg("[v3] Path.SetValue NOT FOUND"); return; }
                    // 重定向到完整路径 (缓存键测试)
                    var fullPath = modScriptPrefix + "/Scripts/" + modMenuScript;
                    var nsObj = makeNamedStringCtor(fullPath, "");
                    invoke(svMi, pathObj, [nsObj]);
                    dbg("[v3] >>> Path.SetValue(\"" + fullPath + "\") 完成 (完整路径)");
                    return;
                }
            }
        }
        dbg("[v3] 未在 StartGame 下找到 GotoModified (lines=" + n + ")");
    } catch (e) { dbg("[v3] hookStartGame err: " + e); }
}
