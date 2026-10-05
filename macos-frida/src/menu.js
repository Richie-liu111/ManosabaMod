// ============ 菜单域: 菜单文本 (含翻页, 回迁自 16h 版) + 剧本注册 + StartGame @goto 重定向 ============
// 镜像 Windows AddModStartMenu (ModResourceLoader.cs) + HookStartGame
import { A, churnManagedStrings, dbg, findClassAcrossImages, findSvc, findUnityImg, gcCollect, gcDisable, gcEnable, gcIsDisabled, gotoModifiedCls, invoke, invokeOk, makeLocalResourceProvider, makeNamedStringCtor, makeS, makeUnityObject, readStr, shortStr, swallowed, swallowedWarn, warn, wblog, withGcDisabled } from "./utils.js";

var modScriptPrefix = "ModLoader";
var modMenuScript = "ModStart";

// ============ P0/P1 诊断: 菜单剧本 path 采样 / 症状注入 / GC 窗口放大 (2026-10-05) ============
// 故障链 (日志实证): 合成菜单剧本的 path 若为空, 它的**全部选项文本**会跟着失去剧本路径 →
//   ① 每个选项按空路径找本地化文档 → 逐条 `Failed to load 'zh-Hans' localization document for '' scenario script`
//   ② 兜底"从剧本本身取原文"按空路径读剧本 → `Naninovel.Error: Failed to load '' resource of type 'Naninovel.Script'`
//   ③ 剧本预载中断 → 菜单演不起来; 此时标题已按 StartGame 的演出淡黑 → 表现为"New Game 黑屏"
// 本模块只加探针, **默认全关** —— 对玩家来说这些是纯噪音。三个开关都由 run_mod.sh 注入:
//   MOD_MENU_PROBE=1      path 采样 + 文档/loader 查找探针 (排查时才开)
//   MOD_GC_PROBE=1        构造窗口内强制 GC (复现"托管字符串无根")
//   MOD_FAULT=menu-nopath 症状注入 (确定性复现空路径失败, 给兜底层做回归)
// 常开的只剩两条健康指纹 (7.13③ 起): "已把标题 StartGame 重定向 → …" 与 "菜单剧本已注册 … 选项数=N"。
var _menuProbe = (typeof MOD_MENU_PROBE !== "undefined" && !!MOD_MENU_PROBE);
var _menuScript = null;          // 最近一次 registerMenu 构造的 Script 指针 (供后续采样)
var _menuPathAtBuild = undefined; // 构造时刻读回的 path (和点击时刻对比, 判断"何时丢的")

// 读回菜单剧本的 path 字段 (Naninovel.Script.path @0x18; lines @0x30 已由 hookStartGame 实证)
// 悬垂指针时 readStr 自带长度上限 + try/catch, 只报"不可读", 不把游戏带崩。
// isBuild=true 表示这是"刚构造完"的那次采样 (它负责登记基准值, 不跟自己比)。
export function sampleMenuScriptPath(tag, isBuild) {
    try {
        if (!_menuScript || _menuScript.isNull()) {
            if (_menuProbe) wblog("[菜单][探针] " + tag + ": 菜单剧本未注册, 无可采样");
            return null;
        }
        var pp = _menuScript.add(0x18).readPointer();
        var s = (pp && !pp.isNull()) ? readStr(pp) : null;
        if (_menuProbe) {   // 默认静默: 只在 MOD_MENU_PROBE=1 时打 (玩家视角这就是噪音)
            var okMark = (s === modMenuScript) ? " ✓" : " ✗ ← 与期望不符 (这就是黑屏的直接原因)";
            var cmp = "";
            if (!isBuild && _menuPathAtBuild !== undefined)
                cmp = " | 构造时=" + shortStr(_menuPathAtBuild) + (_menuPathAtBuild === s ? " (未变)" : " ← 变了!");
            wblog("[菜单][探针] " + tag + ": Script.path=" + shortStr(s) + " (期望 " + JSON.stringify(modMenuScript) + ")" + okMark + cmp);
        }
        return s;
    } catch (e) { swallowed("menu.js:sampleMenuScriptPath", e); return null; }
}

// ============ P0-3 诊断: 把"本地化文档查找"的真实路径打出来 (2026-10-05) ============
// 起因: 空 scriptPath 时文档查询路径连猜三次 (Text/Scripts / Text/Scripts/ / "") 都没命中 ——
// 与其继续猜 ToL10nPath 的实现, 直接钩 TextManager 自己:
//   · GetDocument(documentPath)           文档缓存查询入口 (返回 null = 未命中 → 随后会去加载/报错)
//   · IsScriptL10nDocument(documentPath)  判定"这份文档算不算剧本本地化文档"
// 只对"短路径或含 Scripts 的路径"打 INFO (游戏自身文档路径很长, 不刷屏)。挂在初始化早期。
export function setupMenuDocProbes() {
    if (!_menuProbe) return;   // 默认不挂: 挂钩子本身也是开销, 排查时才开 (MOD_MENU_PROBE=1)
    try {
        var tmCls = findClassAcrossImages("Naninovel", "TextManager");
        if (!tmCls || tmCls.isNull()) { warn("[菜单][探针] TextManager 类未找到, 文档探针不可用"); return; }
        // 只关心"剧本相关"的路径 (含 Scripts 或空) —— 游戏平时刷的 DefaultUI/CustomUI/Tips 等
        // 管理文本路径噪声太大 (实测 100+ 行/秒)。GetDocument 额外把"任何未命中"也报出来 (罕见且有价值)。
        var isDocish = function (p) { return !!(p !== null && (p.length === 0 || p.indexOf("Scripts") >= 0)); };
        var hook1 = function (name) {
            var mi = A.cgm(tmCls, Memory.allocUtf8String(name), 1);
            if (!mi || mi.isNull()) { warn("[菜单][探针] TextManager." + name + " NOT FOUND"); return false; }
            Interceptor.attach(mi.readPointer(), {
                onEnter: function (a) { try { this.p = readStr(a[1]); } catch (e) { this.p = null; } },
                onLeave: function (ret) {
                    try {
                        if (name === "GetDocument") {
                            var miss = ret.isNull();
                            if (!miss && !isDocish(this.p)) return;
                            wblog("[菜单][探针] GetDocument('" + this.p + "') = " + (miss ? "null ← 未命中" : "命中"));
                        } else {
                            if (!isDocish(this.p)) return;
                            wblog("[菜单][探针] IsScriptL10nDocument('" + this.p + "') = " + (ret.toInt32() === 1));
                        }
                    } catch (e) { swallowed("menu.js:" + name + ".onLeave", e); }
                }
            });
            dbg("[菜单][探针] TextManager." + name + " hooked");
            return true;
        };
        hook1("GetDocument");
        hook1("IsScriptL10nDocument");
        // 再挂 textLoader / scriptLoader 的 Load(path, holder): 空路径时到底向哪个 loader、查什么字符串。
        // 只报"短路径或含 Scripts 的路径", 平时安静。
        var hookLoader = function (loaderPtr, tag) {
            try {
                if (!loaderPtr || loaderPtr.isNull()) { warn("[菜单][探针] " + tag + " 实例为空"); return; }
                var mi = A.cgm(A.ogc(loaderPtr), Memory.allocUtf8String("Load"), 2);
                if (!mi || mi.isNull()) { warn("[菜单][探针] " + tag + ".Load NOT FOUND"); return; }
                Interceptor.attach(mi.readPointer(), {
                    onEnter: function (a) {
                        try { var p = readStr(a[1]); if (isDocish(p)) wblog("[菜单][探针] " + tag + ".Load('" + p + "')"); }
                        catch (e) { swallowed("menu.js:" + tag + ".Load.onEnter", e); }
                    }
                });
                dbg("[菜单][探针] " + tag + ".Load hooked");
            } catch (e) { swallowed("menu.js:hookLoader", e); }
        };
        var tmx = findSvc("TextManager");
        if (tmx) {
            var tlField = A.gf(A.ogc(tmx), Memory.allocUtf8String("textLoader"));
            if (tlField && !tlField.isNull()) hookLoader(tmx.add(A.fo(tlField)).readPointer(), "textLoader");
            else warn("[菜单][探针] TextManager.textLoader 字段未找到");
        }
        var smx = findSvc("ScriptManager");
        if (smx) hookLoader(smx.add(0x28).readPointer(), "scriptLoader");
    } catch (e) { swallowedWarn("menu.js:setupMenuDocProbes", e); }
}

// P1-4: 在"旧布局里 path 字符串所在的窗口"施压 (老代码是 makeS(path) → makeS(菜单文本) → invoke,
// 压力点就在中间那次大分配处)。修复后这里只剩菜单文本, path 还没造 —— 于是压力再大也不该影响它。
// 判读: 修好后构造后的采样应稳定是 "ModStart"; 2026-10-05 修复前的同样压力把 path 打成了 "@Stop"。
function gcProbeWindow() {
    try {
        wblog("[菜单][GC-PROBE] 压力点 = 旧布局中 path 字符串所在的窗口 (现由菜单文本占据); GC disabled=" + gcIsDisabled());
        var ok = gcCollect();
        churnManagedStrings(256, 512);
        wblog("[菜单][GC-PROBE] il2cpp_gc_collect=" + (ok ? "已调用" : "不可用") + " + churn(256×512B) 完成 — 看下面构造后的采样是否仍为 ModStart");
    } catch (e) { swallowed("menu.js:gcProbeWindow", e); }
}

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
    gcDisable();   // 同 registerMenu 的临界区 (7.14): 造的字符串/LoadedResource 交出去之前不许被 GC 回收
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
        if (!resClass || !lrClass) { dbg("[v3] 无法获取 TextAsset 类"); return; }

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
        if (A.vb && psCls && !psCls.isNull()) { try { boxed = A.vb(psCls, psMem); } catch (e3) { swallowed("menu.js:registerMenuText", e3); } }

        // LoadedResource ctor + AddHolder + AddLoadedResource
        var lrCtor = A.cgm(lrClass, Memory.allocUtf8String(".ctor"), 2);
        var addHolderMi = A.cgm(lrClass, Memory.allocUtf8String("AddHolder"), 1);
        var addMi = A.cgm(tlKlass, Memory.allocUtf8String("AddLoadedResource"), 1);
        if (!lrCtor || lrCtor.isNull() || !addMi || addMi.isNull()) { dbg("[v3] 方法解析失败"); return; }
        // 打印偷到的类名, 确认泛型实例正确
        try {
            dbg("[v3] resClass=" + A.cgn(resClass).readCString() + " lrClass=" + A.cgn(lrClass).readCString());
        } catch (e4) { dbg("[v3] 类名读取失败: " + e4); }

        // 多键注册 (覆盖所有可能路径) + 空路径兜底 (7.14)。
        // 两套路径约定要分清 (2026-10-05 用 P0-3 探针在正常跑里实测):
        //   · **文档键** (TextManager.GetDocument / docByPath): `Scripts/<scriptPath>`
        //     —— 正常跑实测 GetDocument('Scripts/ModStart') 命中; 所以空 scriptPath 的键是 `Scripts/`
        //   · **资源路径** (loader 缓存 / Hold): `Text/Scripts/<scriptPath>`
        //     —— "Failed to hold 'Text/Scripts/'" 报错里的就是它
        // 正常跑能工作, 是因为原始 4 键里恰好有 "Scripts/ModStart" (文档) + "Text/Scripts/ModStart" (资源);
        // 空路径兜底两套都要给: 漏了 Scripts/ → 文档查不到 → 文本没加载 → @choice 抛 Failed to hold。
        var keys = ["Text/Scripts/" + modMenuScript, "Scripts/" + modMenuScript,
                    modScriptPrefix + "/Text/Scripts/" + modMenuScript, modMenuScript,
                    "Scripts", "Scripts/", "Text/Scripts", "Text/Scripts/", ""];
        for (var ki = 0; ki < keys.length; ki++) {
            var lr = A.on(lrClass);
            invoke(lrCtor, lr, [ourRes, psMem]);
            lr.add(0x28).writePointer(makeS(keys[ki]));
            if (addHolderMi && !addHolderMi.isNull() && boxed && !boxed.isNull()) invoke(addHolderMi, lr, [boxed]);
            invoke(addMi, tl, [lr]);
            dbg("[v3] >>> 本地化文档已注册: key=" + keys[ki]);
        }
    } catch (e) { dbg("[v3] registerMenuText err: " + e); }
    finally { gcEnable(); }
}

// 缓存方案 (镜像 Windows AddModStartMenu): FromText + AddHolder + AddLoadedResource
//
// ⚠ 临界区 (7.14): 这个函数里造出来的托管对象 —— path/文本字符串、Script、Resource<Script>、
// LoadedResource —— 在"交给托管侧"之前都只被 JS 变量引用, 而 Boehm 只扫栈/寄存器/静态数据段,
// **不扫 V8 堆**。期间任何一次自动 GC 都可能把它们回收, 之后就是悬垂指针 (2026-10-05 实测: path 字符串
// 被回收+复用 → script.path 与全部文本的 PlaybackSpot 一起变成垃圾 → New Game 黑屏)。
// 所以: ① 整段 gcDisable(); ② 分配顺序上把 path 字符串放到最后、紧接 invoke。
export function registerMenu(modList) {
    gcDisable();
    try {
        _menuPathAtBuild = undefined;   // 清掉上一轮的基准值 (免得下面对比时拿它当"构造时")
        var text = buildMenuText(modList);
        var scriptCls = findClassAcrossImages("Naninovel", "Script");
        if (scriptCls.isNull()) { dbg("[v3] Script class NOT FOUND"); return; }
        var ftMi = A.cgm(scriptCls, Memory.allocUtf8String("FromText"), 3);
        if (!ftMi || ftMi.isNull()) { warn("[菜单] Script.FromText NOT FOUND —— 菜单剧本注册不了"); return; }
        // P1-3 症状注入 (MOD_FAULT=menu-nopath): 故意用空 path 构造菜单剧本 → 确定性复现黑屏
        // (全部选项文本失去剧本路径)。用于给防御性修法做 A/B: 注入仍在, 菜单也应照常出。
        var faultNoPath = (typeof MOD_FAULT !== "undefined" && MOD_FAULT === "menu-nopath");
        if (faultNoPath) warn("[菜单][FAULT] MOD_FAULT=menu-nopath: 用空 path 构造菜单剧本 (预期: New Game 黑屏 + 空路径的文档/剧本加载报错)");

        var textPtr = makeS(text);                                    // ① 大分配放最前 (原来是夹在中间的)
        if (typeof MOD_GC_PROBE !== "undefined" && MOD_GC_PROBE) gcProbeWindow();
        var pathPtr = makeS(faultNoPath ? "" : modMenuScript);        // ② path 最后造, 紧接 invoke: 中间无托管分配
        var script = invoke(ftMi, ptr(0), [pathPtr, textPtr, ptr(0)]);
        if (script.isNull()) { warn("[菜单] FromText 返回 null —— 菜单剧本注册失败"); return; }
        _menuScript = script;
        _menuPathAtBuild = sampleMenuScriptPath("构造后 (build)", true);
        // 健康指纹 (常开, 一次进标题一行): 选项数是排查时的对账依据 —— 剧本路径丢失那类故障,
        // 游戏侧会按选项数逐条报错, 数量对得上就说明是菜单剧本而不是别的脚本出问题。
        wblog("[菜单] 菜单剧本已注册 (FromText): " + modMenuScript +
              " 选项数=" + (text.split("@choice").length - 1) + (script.isNull() ? " (指针为空!)" : ""));

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
        if (!resClass || !lrClass) { dbg("[v3] 无法获取类指针"); return; }

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
        // 兜底 key "" (7.14): 万一剧本 path 又被毁成空串, Naninovel 的兜底"按空路径读剧本原文"
        // 会来查空路径 —— 让它命中菜单自己, 菜单就能照常显示 (只剩一条 Missing translation 警告)。
        buildAndAdd("");
    } catch (e) { dbg("[v3] registerMenu err: " + e); }
    finally { gcEnable(); }
}

// ============ 重定向 StartGame 的 @goto (镜像 Windows HookStartGame) ============
// 返回 true = 已把标题的 StartGame 重定向到我们的菜单剧本; false = 这次没做成 (调用方会重试)。
// quiet=true 时失败只记 dbg —— 重试期间别刷屏, 最后一次才 warn (见 entry.js 的重试包装)。
export function hookStartGame(quiet) {
    var say = function (m) { if (quiet) dbg(m); else warn(m); };
    try {
        var sp = findSvc("WitchTrialsScriptPlayer", true);
        if (!sp) sp = findSvc("ScriptPlayer");
        if (!sp) { say("[菜单] ScriptPlayer NOT FOUND —— 无法重定向到 ModStart (菜单不会出现)"); return false; }
        var played = sp.add(0x58).readPointer();   // PlayedScript
        if (played.isNull()) { say("[菜单] PlayedScript 为 NULL —— 时刻太早/太晚, 无法重定向 (菜单不会出现)"); return false; }
        var linesArr = played.add(0x30).readPointer(); // Script.lines
        if (linesArr.isNull()) { say("[菜单] 标题剧本 lines 为 NULL —— 无法重定向 (菜单不会出现)"); return false; }
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
                    // Path.SetValue(NamedString(value="ModStart", name=""))
                    var pathObj = cmd.add(0x30).readPointer();
                    var nspCls = A.ogc(pathObj);
                    var svMi = A.cgm(nspCls, Memory.allocUtf8String("SetValue"), 1);
                    if (!svMi || svMi.isNull()) { say("[菜单] Path.SetValue NOT FOUND —— 无法重定向 (菜单不会出现)"); return false; }
                    // 重定向到完整路径 (缓存键测试)
                    // 同样关 GC: NamedString 对象 + 它的字符串在 SetValue 之前只被 JS 引用 (7.14)
                    var fullPath = modScriptPrefix + "/Scripts/" + modMenuScript;
                    withGcDisabled(function () {
                        var nsObj = makeNamedStringCtor(fullPath, "");
                        invoke(svMi, pathObj, [nsObj]);
                    });
                    wblog("[菜单] 已把标题 StartGame 重定向 → " + fullPath);   // INFO: 菜单流程的关键一步, 默认可见 (失败时无从判断)
                    return true;
                    return;
                }
            }
        }
        say("[菜单] 未在 StartGame 下找到 GotoModified (lines=" + n + ") —— 重定向没做, 菜单不会出现");
        return false;
    } catch (e) { say("[菜单] hookStartGame err: " + e); return false; }
}
