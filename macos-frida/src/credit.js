// ============ 自定义致谢演出控制器 (PLAN.md 实现阶段; 蓝本 probe_credit.js v4, 探针 P1-P5 全裁决) ============
// 协议: 用户的 nani 用 @set 触发 (转义双引号写法), 本控制器在 SetVariableValue hook (主线程) 里
//   调用原版组件方法 fire-and-forget, 动画由原版组件状态机在 PlayerLoop 自己跑, nani @Wait 编排节奏:
//   @set "g_modCreditRoll = \"data.json\""   → trigger: 读 json 缓存 + arm
//   @set "g_modCreditRollPhase = 1"          → staff:  文本/布局/归零 → 写 g_staffDuration → ScrollAsync
//   @set "g_modCreditRollPhase = 2"          → thanks: dict/order → 写 g_thanksDuration → ShowAsync
//   @set "g_modCreditRollPhase = 3"          → end:    SpecialThanks.Clear + DisableCanvas + 还原祖先 + disarm
// 探针裁决落点 (2026-08-20 run-4):
//   * F1 根治: 只启用 roll 自身不够, 必须沿 Transform 链激活 inactive 祖先 (ensureHierarchy) —
//     run-4 实证 canvas 0→1, 我方 ScrollAsync 完美线性动画 (0.990→0.000 @98.4s)
//   * 多标签: staff content 里多个 TMP 标签 (ContentSizeFitter[]), 原版残留文本在非当前语种标签上
//     主导高度 (29513.1px 恒定实证) → 必须枚举全部标签: active 填文本, inactive 清空, 再强制布局
//   * 数组类免偷: string[] = il2cpp_array_new(System.String); string[][] = array_new(string[] 类)
//   * 时长公式: staff = height/speed (json), g_staffDuration = 滚动+endPause;
//     thanks 墙钟实测 8 组 = 13.47s → 1.68s/组 (fade=0.4/display=2.0 硬编码) → 1.68*nG + 2.4
//   * 指针生命周期: run-3 实证跨回标题存活 (同地址), 每次使用前字段探针复核, 失效则惰性重抓
// 实现阶段首跑实测修正 (2026-08-20, 全黑屏无演出):
//   * utils.invoke 返回裸指针 (探针 invoke 返回 {ok,ret,ex}) — 本文件原按探针契约查 .ok → 恒假,
//     FindObjectsOfType 兜底从未执行 → 一律改用 invokeOk (成功语义)
//   * 全新会话无原版 credit → rolls/dictCls 均不可得 (实锤): dict 类改 metadata 自解析
//     (CreditsDirectorAct2._specialThanksCredits = Dictionary<LocaleKind,string[][]> dump.cs:481224,
//     field_get_type + class_from_type 开机可得零依赖); rolls 用 UIManager.GetUI(CreditsUI)
//     懒加载工厂自建 + GCI 子树扫描 + 全程分阶段日志
// 原则 (项目惯例): 只做加法+自清理, 不改任何游戏现有对象; 全程 try/catch 不崩。
//   错误路径一律写安全默认时长 → nani @Wait 永不悬挂 (R4)。
import { A, dbg, directCall, findClassAcrossImages, findSvc, findAllObjectOfType, getSystemClass, invoke, invokeOk, makeS, nv, readStr, warn, error } from "./utils.js";
import { getIO } from "./io.js";   // run-24-2: 写文件走 io.js 绑定 (Module.findExportByName 在 bundle 内不可用, io.js 的 findGlobalExportByName 实证可用)
import { readJSONFile, openForWrite, writeString, fileSync } from "./io.js";
import { info } from "./log.js";
import { getCurrentLocale } from "./locale.js";
import { wbCurrentMod } from "./witchbook/state.js";

// ============ 状态 ============
var creditHooksReady = false;
var comp = {           // 捕获的组件 (跨回标题保留 — 探针实证指针常驻; 每次使用前字段探针复核)
    creditsUI: null,   // CreditsUI 实例 (UIManager.GetUI 自建 / 原版 PlayAsync 捕获)
    director: null,    // run-15: CreditsDirectorAct2 实例 (_creditsDirectors[act] — 原版 @credit 复刻诊断)
    rollScroll: null, rollThanks: null,      // CreditRollVerticalScroll / CreditRollSpecialThanks 实例
    scrollRect: null, canvas: null, content: null,
    sArrCls: null, gArrCls: null,            // string[] / string[][] 类 (免偷构建)
    dictCls: null,                           // Dictionary<LocaleKind,string[][]> 类 (metadata 自解析)
    labels: [],                              // staff content 全部 TMP 标签 {tmp, go, active, font}
    stills: null, stillTimer: null,          // run-26: Act2 Stills 显示 (EndingStill[] + fade 定时器)
    stillIdx: 0, stillState: "idle", stillStepStart: 0,
    stillT: { delay: 2000, fade: 2000, display: 26000 },   // run-27: 动态时序 (キャスト 偏移 + 原版 units)
    timing: null,                            // run-27: 原版 director 时序参数缓存 (_scrollSpeed/units/bpm)
    thanksTiming: null,                      // run-29: 共犯翻页原版参数 (fade/display 拍数 + 标题延迟系数)
    thanksPaging: null                       // run-28: 共犯自翻页状态机 (不调原版 ShowAsync, 防 level 数组越界)
};
var creditState = {
    armed: false,        // trigger arm / end disarm / ScriptLoader.Load 中止 (F3 存档回放防御)
    phase: 0,            // 1/2/3 当前阶段
    json: null,          // 解析后的数据 json
    jsonPath: null,      // json 路径 (日志)
    original: false,     // run-15: 原版复刻模式 (g_modCreditRoll="original" → 直接调 CreditsUI.PlayAsync(2))
    extract: false,      // run-24: 素材提取模式 (trigger "extract" → 原版全流程 + stills PNG/名单 json → mod 文件夹)
    pendingProduction: false   // run-30f: 共犯完成后置位 → 由 g_creditTick 主线程泵执行 doProduction
};
var mgr = null;                  // CustomVariableManager 实例 (首个 SetVariableValue 缓存, 写回变量用 — F13)
var activatedAncestors = [];     // phase=1 激活的祖先 GO (phase=3/中止 还原)
var deactivatedLabels = [];      // run-11: 单标签模式停用的非当前语种标签 GO (结束还原)
var cls = {};                    // 类表

// ============ 基础工具 (与探针一致) ============
function cn(p) { try { return (p && !p.isNull()) ? (A.cgn(A.ogc(p)).readCString() || "?") : "null"; } catch (e) { return "?unreadable"; } }
function clsName(c) { try { return (c && !c.isNull()) ? (A.cgn(c).readCString() || "?") : "null"; } catch (e) { return "?unreadable"; } }
function cgmChain(c, name, argc) {
    var cur = c;
    // run-24-4: A.gn 不能在模块顶层修 (A 表由 entry.js 在加载完成后填充, 顶层时 A.cgp 还是 undefined);
    //   必须运行时取 — 找不到父类函数就直接放弃回退 (避免 TypeError)
    var gn = (typeof A.gn === "function") ? A.gn : (typeof A.cgp === "function" ? A.cgp : null);
    for (var d = 0; cur && !cur.isNull() && d < 8; d++) {
        var mi = A.cgm(cur, Memory.allocUtf8String(name), argc);
        if (mi && !mi.isNull()) return mi;
        if (!gn) break;
        cur = gn(cur);
    }
    return ptr(0);
}
function dcFloat(mi, inst) { try { if (!mi || mi.isNull()) return NaN; return new NativeFunction(mi.readPointer(), 'float', ['pointer'])(inst); } catch (e) { return NaN; } }
function dcBool(mi, inst) { try { if (!mi || mi.isNull()) return false; return new NativeFunction(mi.readPointer(), 'bool', ['pointer'])(inst); } catch (e) { return false; } }
function dcInt(mi, inst) { try { if (!mi || mi.isNull()) return -1; return new NativeFunction(mi.readPointer(), 'int', ['pointer'])(inst); } catch (e) { return -1; } }
function fPtr(v) { var p = Memory.alloc(4); p.writeFloat(v); return p; }
function iPtr(v) { var p = Memory.alloc(4); p.writeS32(v); return p; }
function boolPtr(v) { var p = Memory.alloc(4); p.writeS32(v ? 1 : 0); return p; }
function zeroCT() { var p = Memory.alloc(16); p.writeU64(0); p.add(8).writeU64(0); return p; }
// il2cpp_field_get_type / il2cpp_method_get_param — 导出在 GameAssembly.dylib (entry.js E 表同源)。
// run-6 实证 findExportByName(null) 只搜主程序 → 绑定失败 → 一律用 A.fgt/A.mgp (entry.js 已绑) + dylib 兜底
var fgt = null, mgp = null;
try { fgt = A.fgt; } catch (e) {}
try { mgp = A.mgp; } catch (e) {}
// run-12 修复: A.gn 从未在 entry.js 绑定 (只有 A.cgp=class_get_parent) — cgmChain 继承链回退必崩
try { if (!A.gn && A.cgp) A.gn = A.cgp; } catch (e) {}
if (!fgt || !mgp) {
    try {
        var gaMod = Process.findModuleByName("GameAssembly.dylib");
        if (gaMod) {
            if (!fgt) { var fE = gaMod.findExportByName("il2cpp_field_get_type"); if (fE) fgt = new NativeFunction(fE, 'pointer', ['pointer']); }
            if (!mgp) { var mE = gaMod.findExportByName("il2cpp_method_get_param"); if (mE) mgp = new NativeFunction(mE, 'pointer', ['pointer', 'uint32']); }
        }
    } catch (e) {}
}

// ============ 类解析 ============
function resolveCreditClasses() {
    var defs = [
        ["customVarMgr", "Naninovel", "CustomVariableManager"],
        ["uiMgr", "Naninovel", "UIManager"],
        ["canvasGroup", "UnityEngine", "CanvasGroup"],
        ["creditRoll", "WitchTrials.Views", "CreditRoll"],
        ["rollScroll", "WitchTrials.Views", "CreditRollVerticalScroll"],
        ["rollThanks", "WitchTrials.Views", "CreditRollSpecialThanks"],
        ["director", "WitchTrials.Views", "CreditsDirectorAct2"],
        ["endingStill", "WitchTrials.Views", "EndingStill"],
        ["creditsUI", "WitchTrials.Views", "CreditsUI"],
        ["scrollRect", "UnityEngine.UI", "ScrollRect"],
        ["canvas", "UnityEngine", "Canvas"],
        ["gameObject", "UnityEngine", "GameObject"],
        ["tmpText", "TMPro", "TMP_Text"],
        ["tmpFontAsset", "TMPro", "TMP_FontAsset"],
        ["layoutRebuilder", "UnityEngine.UI", "LayoutRebuilder"],
        ["localeKind", "GigaCreation.Essentials.Localization", "LocaleKind"],
        ["scriptLoader", "Naninovel", "ScriptLoader"],
        ["image", "UnityEngine.UI", "Image"],
        ["sprite", "UnityEngine", "Sprite"],
        ["texture2D", "UnityEngine", "Texture2D"],
        ["renderTexture", "UnityEngine", "RenderTexture"],
        ["graphics", "UnityEngine", "Graphics"]
    ];
    var all = true;
    for (var i = 0; i < defs.length; i++) {
        var c = findClassAcrossImages(defs[i][1], defs[i][2]);
        cls[defs[i][0]] = c;
        if (!c || c.isNull()) { warn("[v3][Credit] 类未找到: " + defs[i][1] + "." + defs[i][2]); all = false; }
    }
    return all;
}

// ============ 字段探针类型识别 (类名通道优先, 字段探针兜底 — run-7 教训) ============
// rollThanks._labels@0x70 在 ShowAsync 前是 null → 纯字段探针会把有效实例判成"不可得" (phase=2 跳过根因)
// rollScroll 独有 _scrollRect@0x30→ScrollRect; rollThanks 独有 _labels@0x70→Dictionary
function isScrollRoll(inst) {
    try {
        if (!inst || inst.isNull()) return false;
        var k = clsName(A.ogc(inst));
        if (k === "CreditRollVerticalScroll") return true;
        return cn(inst.add(0x30).readPointer()).indexOf("ScrollRect") >= 0;
    } catch (e) { return false; }
}
function isThanksRoll(inst) {
    try {
        if (!inst || inst.isNull()) return false;
        var k = clsName(A.ogc(inst));
        if (k === "CreditRollSpecialThanks") return true;
        return cn(inst.add(0x70).readPointer()).indexOf("Dictionary") >= 0;
    } catch (e) { return false; }
}

// ============ 组件抓取 (多路: GetUI 自建 / UI 子树 / 全场景扫 / 原版钩子) ============
function getFontName(tmp) {
    try {
        var f = invokeOk(cgmChain(A.ogc(tmp), "get_font", 0), tmp, []);
        if (f.ok && f.ret && !f.ret.isNull()) {
            var nm = invokeOk(cgmChain(A.ogc(f.ret), "get_name", 0), f.ret, []);
            if (nm.ok && nm.ret && !nm.ret.isNull()) return readStr(nm.ret) || "?";
        }
    } catch (e) {}
    return "?";
}
// 枚举 staff content 下全部 TMP 标签 (含 inactive — GetComponentsInChildren(Type,bool))
// run-26: Label 名后缀 → key 段 (与 build_credit_data.py label_suffix 同一规则)
function labelSuffix(nm) {
    if (nm === "Label") return "";
    if (nm && nm.indexOf("Label") === 0) return nm.slice(5);   // Label_1 → "_1"
    return nm || "";
}
function enumerateLabels() {
    try {
        comp.labels = [];
        if (!comp.content || comp.content.isNull()) return 0;
        var go = invokeOk(cgmChain(A.ogc(comp.content), "get_gameObject", 0), comp.content, []);
        if (!go.ok || go.ret.isNull()) return 0;
        var typeObj = A.tgo(A.cgt(cls.tmpText));
        var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [typeObj, boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) { warn("[v3][Credit] staff TMP 枚举失败 (content 下无 TMP?)"); return 0; }
        var len = arr.ret.add(0x18).readS32();
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull()) continue;
            var eGo = null;
            try {
                var gg = invokeOk(cgmChain(A.ogc(e), "get_gameObject", 0), e, []);
                if (gg.ok) eGo = gg.ret;
            } catch (e2) {}
            var active = eGo ? dcBool(cgmChain(A.ogc(eGo), "get_activeSelf", 0), eGo) : false;
            var nm = eGo ? getGoName(eGo) : "?";
            // run-12: 标签自身名全叫 "Label", 语种标识可能在父包装节点 (thanks 侧就是 Label_Ja/Label_ZhHans 风格)
            var pn = "?", gn = "?";
            if (eGo) {
                try {
                    var t2 = invokeOk(cgmChain(A.ogc(eGo), "get_transform", 0), eGo, []);
                    if (t2.ok && t2.ret) {
                        var p2 = invokeOk(cgmChain(A.ogc(t2.ret), "get_parent", 0), t2.ret, []);
                        if (p2.ok && p2.ret) {
                            var pgo = invokeOk(cgmChain(A.ogc(p2.ret), "get_gameObject", 0), p2.ret, []);
                            if (pgo.ok && pgo.ret) pn = getGoName(pgo.ret);
                            // run-26: 再上一级 = grand (Content 直接子级: TopSpace/Full/Separator/Left/BottomSpace)
                            var p3 = invokeOk(cgmChain(A.ogc(p2.ret), "get_parent", 0), p2.ret, []);
                            if (p3.ok && p3.ret) {
                                var pgo2 = invokeOk(cgmChain(A.ogc(p3.ret), "get_gameObject", 0), p3.ret, []);
                                if (pgo2.ok && pgo2.ret) gn = getGoName(pgo2.ret);
                            }
                        }
                    }
                } catch (e3) {}
            }
            comp.labels.push({ tmp: e, go: eGo, name: nm, parent: pn, grand: gn, active: active, font: getFontName(e) });
        }
        var parts = [];
        for (var j = 0; j < comp.labels.length; j++) parts.push("#" + j + ":" + (comp.labels[j].name || "?") + "(" + (comp.labels[j].parent || "?") + ")" + (comp.labels[j].active ? "活" : "隐") + ":" + (comp.labels[j].font || "?"));
        dbg("[v3][Credit] staff TMP 标签 " + comp.labels.length + " 个: " + parts.join(" | "));
        return comp.labels.length;
    } catch (e) { warn("[v3][Credit] enumerateLabels err: " + e); return 0; }
}
// run-11: thanks 语种→标签映射 (dump.cs:11229 LabelByLocale{_localeKind@0x10,_label@0x18}, _labelsByLocale@0x38)
//   序列化数组开机即有 (不依赖 ShowAsync); zh 标签的 TMP 字体 = 游戏官方简中字体 (staff 换装来源)
function enumerateThanksLabels() {
    try {
        comp.thanksByLocale = {};
        if (!comp.rollThanks || comp.rollThanks.isNull()) { warn("[v3][Credit] thanks 标签枚举: rollThanks 未捕获"); return 0; }
        var arr = comp.rollThanks.add(0x38).readPointer();
        if (!arr || arr.isNull()) { warn("[v3][Credit] thanks _labelsByLocale@0x38 为空"); return 0; }
        var len = arr.add(0x18).readS32();
        if (len < 1 || len > 16) { warn("[v3][Credit] thanks _labelsByLocale 长度异常 " + len); return 0; }
        var n = 0;
        for (var i = 0; i < len; i++) {
            var entry = arr.add(0x20 + i * 8).readPointer();
            if (!entry || entry.isNull()) continue;
            var lk = entry.add(0x10).readS32();
            var lbl = entry.add(0x18).readPointer();
            if (!lbl || lbl.isNull()) continue;
            var tmp = lbl.add(0x30).readPointer();
            if (!tmp || tmp.isNull()) continue;
            var cg = lbl.add(0x28).readPointer();   // run-28: SpecialThanksLabel._canvasGroup@0x28 (翻页 fade 用)
            comp.thanksByLocale[lk] = { label: lbl, tmp: tmp, cg: cg, name: getGoName(lbl), font: getFontName(tmp) };
            info("[v3][Credit] thanks 标签 localeKind=" + lk + " name=" + comp.thanksByLocale[lk].name + " font=" + comp.thanksByLocale[lk].font);
            n++;
        }
        return n;
    } catch (e) { warn("[v3][Credit] enumerateThanksLabels err: " + e); return 0; }
}
function grabScrollDetails() {
    try {
        if (!comp.rollScroll || comp.rollScroll.isNull()) return;
        comp.scrollRect = comp.rollScroll.add(0x30).readPointer();   // _scrollRect@0x30
        comp.canvas = comp.rollScroll.add(0x28).readPointer();       // _canvas@0x28
        var rr = invokeOk(A.cgm(cls.scrollRect, Memory.allocUtf8String("get_content"), 0), comp.scrollRect, []);
        comp.content = rr.ok ? rr.ret : null;
        enumerateLabels();
        dbg("[v3][Credit] 组件链: scrollRect=" + comp.scrollRect + " canvas=" + comp.canvas + " content=" + comp.content);
    } catch (e) { warn("[v3][Credit] grabScrollDetails err: " + e); }
}
// 双通道捕获 (类名 / 字段探针); rollThanks 在导演入口 _labels 可能尚 null (ShowAsync 才填) — 类名通道覆盖
function captureRolls(roll, tag) {
    try {
        if (!roll || roll.isNull()) return;
        var k = clsName(A.ogc(roll));
        var sr = roll.add(0x30).readPointer();
        var lbl = roll.add(0x70).readPointer();
        if (k === "CreditRollVerticalScroll" || cn(sr).indexOf("ScrollRect") >= 0) {
            if (!comp.rollScroll || comp.rollScroll.isNull()) {
                comp.rollScroll = roll;
                info("[v3][Credit] rollScroll 已捕获 (" + (k === "CreditRollVerticalScroll" ? "类名" : "字段探针") + ", " + (tag || "?") + ") = " + roll);
                grabScrollDetails();
            }
        } else if (k === "CreditRollSpecialThanks" || cn(lbl).indexOf("Dictionary") >= 0) {
            if (!comp.rollThanks || comp.rollThanks.isNull()) {
                comp.rollThanks = roll;
                info("[v3][Credit] rollThanks 已捕获 (" + (k === "CreditRollSpecialThanks" ? "类名" : "字段探针") + ", " + (tag || "?") + ") = " + roll);
            }
        }
    } catch (e) { warn("[v3][Credit] captureRolls err: " + e); }
}
// 在 CreditsUI 实例子树里扫 roll 组件 (GCI includeInactive — 只拿真实实例, 不会误抓 prefab 模板)
function scanUiRolls(uiComp, tag) {
    try {
        if (!uiComp || uiComp.isNull()) return false;
        var go = invokeOk(cgmChain(A.ogc(uiComp), "get_gameObject", 0), uiComp, []);
        if (!go.ok || go.ret.isNull()) return false;
        var got = false;
        if (!comp.rollScroll || !isScrollRoll(comp.rollScroll)) {
            var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.rollScroll)), boolPtr(true)]);
            if (arr.ok && arr.ret && !arr.ret.isNull()) {
                var len = arr.ret.add(0x18).readS32();
                for (var i = 0; i < len && !comp.rollScroll; i++) {
                    var e = arr.ret.add(0x20 + i * 8).readPointer();
                    if (e && !e.isNull() && isScrollRoll(e)) captureRolls(e, tag + ".GCI");
                }
            }
            got = !!comp.rollScroll;
        }
        if (!comp.rollThanks || !isThanksRoll(comp.rollThanks)) {
            var arr2 = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.rollThanks)), boolPtr(true)]);
            if (arr2.ok && arr2.ret && !arr2.ret.isNull()) {
                var len2 = arr2.ret.add(0x18).readS32();
                for (var i2 = 0; i2 < len2 && !comp.rollThanks; i2++) {
                    var e2 = arr2.ret.add(0x20 + i2 * 8).readPointer();
                    if (e2 && !e2.isNull() && isThanksRoll(e2)) captureRolls(e2, tag + ".GCI");
                }
            }
            got = got || !!comp.rollThanks;
        }
        return got;
    } catch (e) { warn("[v3][Credit] scanUiRolls err: " + e); return false; }
}
// 服务表全量 dump (UIManager 找不到时的裁决日志 — run-7: 服务表 23 个但按名匹配无果)
function dumpServices() {
    try {
        var el = A.cfn(nv, Memory.allocUtf8String("Naninovel"), Memory.allocUtf8String("Engine"));
        if (!el || el.isNull()) { warn("[v3][Credit] dumpServices: Naninovel.Engine 类不可得"); return; }
        var f = A.gf(el, Memory.allocUtf8String("services"));
        if (!f || f.isNull()) { warn("[v3][Credit] dumpServices: services 字段不可得"); return; }
        var l = A.sdf(el).add(A.fo(f)).readPointer();
        var its = l.add(0x10).readPointer(); var sz = l.add(0x18).readS32();
        var parts = [];
        for (var i = 0; i < sz && i < 40; i++) {
            var ep = its.add(0x20 + i * 8).readPointer();
            if (!ep || ep.isNull()) continue;
            parts.push(A.cgn(A.ogc(ep)).readCString() || "?");
        }
        warn("[v3][Credit] 服务表 " + sz + " 个: " + parts.join(", "));
    } catch (e) { warn("[v3][Credit] dumpServices err: " + e); }
}
// UIManager.GetUI(CreditsUI) — Naninovel 懒加载工厂 (原版 @credit 也走这里); 自建 UI 供无原版 credit 的全新会话
function spawnCreditsUI() {
    try {
        if (comp.creditsUI && !comp.creditsUI.isNull()) { scanUiRolls(comp.creditsUI, "已有UI"); return comp.creditsUI; }
        // run-16 修复: 服务类被覆盖为 UiManagerExtended — findSvc("Naninovel.UIManager") 后缀匹配不上
        //   ("UIManager" ≠ "UiManagerExtended"; 服务表 23 个实类名, 日志实证 UiManagerExtended 在表里)
        var uiMgr = findSvc("UiManagerExtended", true);
        if (!uiMgr) uiMgr = findSvc("UIManager", true);
        if (!uiMgr) {
            // 服务表兜底: 引擎已初始化时 UIManager MonoBehaviour 必在场景 — 直接场景扫
            var mgrs = findAllObjectOfType(cls.uiMgr);
            if (mgrs.length) uiMgr = mgrs[0];
        }
        if (!uiMgr) {
            // run-16: 场景直接扫 CreditsUI 本身 (rollScroll 全场景扫实证可得 — CreditsUI 是它的祖先必在场景)
            var uis = findAllObjectOfType(cls.creditsUI);
            if (uis.length) {
                comp.creditsUI = uis[0];
                info("[v3][Credit] CreditsUI 已捕获 (场景直扫): " + uis[0] + " (" + clsName(A.ogc(uis[0])) + ")");
                scanUiRolls(uis[0], "场景直扫");
                return uis[0];
            }
            warn("[v3][Credit] UIManager 不可得 (服务表+场景扫均无) — 无法自建 CreditsUI");
            dumpServices();   // 裁决: UIManager 是否在服务表里 (类名 vs 预期)
            return null;
        }
        var mi = A.cgm(A.ogc(uiMgr), Memory.allocUtf8String("GetUI"), 1);
        if (!mi || mi.isNull()) { warn("[v3][Credit] UIManager.GetUI(Type/String) NOT FOUND"); return null; }
        // GetUI(Type) 与 GetUI(string) 同为 1 参 — 用参数类型反查确定重载
        var isTypeArg = true;
        try {
            var pt = mgp(mi, 0);
            var pcls = pt.add(0x8).readPointer();
            var ptn = (pcls && !pcls.isNull()) ? A.cgn(pcls).readCString() : "?";
            isTypeArg = (ptn === "System.Type");
            dbg("[v3][Credit] GetUI 参数类型: " + ptn + " → " + (isTypeArg ? "Type 重载" : "string 重载"));
        } catch (e) {}
        var r = invokeOk(mi, uiMgr, isTypeArg ? [A.tgo(A.cgt(cls.creditsUI))] : [makeS("CreditsUI")]);
        if (r.ok && r.ret && !r.ret.isNull()) {
            var rn = clsName(A.ogc(r.ret));
            if (rn.indexOf("CreditsUI") >= 0) {
                comp.creditsUI = r.ret;
                info("[v3][Credit] UIManager.GetUI → CreditsUI 已创建: " + r.ret + " (" + rn + ")");
                scanUiRolls(r.ret, "GetUI");
                return r.ret;
            }
            warn("[v3][Credit] GetUI 返回 " + rn + " (非 CreditsUI) — 重载匹配异常");
        } else {
            warn("[v3][Credit] UIManager.GetUI 未返回 CreditsUI (异步创建中?) — 首次跑若失败, 再次触发即命中缓存");
        }
        return null;
    } catch (e) { warn("[v3][Credit] spawnCreditsUI err: " + e); return null; }
}
// 分阶段类型扫描: stage 1 = FindObjectsOfType(active) → stage 2 = FindObjectsOfType(includeInactive=true)
// → stage 3 = FindObjectsOfTypeAll (含资产/prefab)。返回 {stage, objs}。
// 语义 (run-7 实证): 阶段1/2 只返回 LIVE 场景对象; 阶段3 才含资产 — 资产上跑动画不可见
// (run-7 实锤: "3 填 / 0 清" 全 active 标签 = prefab 序列化默认, 滚动无显示)。
// 阶段日志用 info (MOD_DEBUG=false 时 dbg 不可见, run-7 的 LIVE/资产判定无从看起)。
function findRollsStaged(targetCls, tag) {
    try {
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        if (!objCls || objCls.isNull()) return { stage: 0, objs: [] };
        var typeObj = A.tgo(A.cgt(targetCls));
        function collect(arr) {
            if (!arr || arr.isNull()) return [];
            var len = arr.add(0x18).readS32(), out = [];
            for (var i = 0; i < len; i++) { var e = arr.add(0x20 + i * 8).readPointer(); if (e && !e.isNull()) out.push(e); }
            return out;
        }
        var mi = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 1);
        if (mi && !mi.isNull() && mi.readPointer() && !mi.readPointer().isNull()) {
            var a1 = collect(invoke(mi, ptr(0), [typeObj]));
            if (a1.length) { info("[v3][Credit] " + tag + " 命中: FindObjectsOfType(active) " + a1.length + " 个 (LIVE)"); return { stage: 1, objs: a1 }; }
        }
        var mi2 = A.cgm(objCls, Memory.allocUtf8String("FindObjectsOfType"), 2);
        if (mi2 && !mi2.isNull()) {
            var fb = Memory.alloc(4); fb.writeS32(1);   // includeInactive=true — 区别 utils 链 (漏 inactive live)
            var a2 = collect(invoke(mi2, ptr(0), [typeObj, fb]));
            if (a2.length) { info("[v3][Credit] " + tag + " 命中: FindObjectsOfType(includeInactive) " + a2.length + " 个 (LIVE 含隐藏)"); return { stage: 2, objs: a2 }; }
        }
        var resCls = findClassAcrossImages("UnityEngine", "Resources");
        var mia = A.cgm(resCls, Memory.allocUtf8String("FindObjectsOfTypeAll"), 1);
        if (mia && !mia.isNull() && mia.readPointer() && !mia.readPointer().isNull()) {
            var a3 = collect(invoke(mia, ptr(0), [typeObj]));
            if (a3.length) { info("[v3][Credit] " + tag + " 命中: FindObjectsOfTypeAll " + a3.length + " 个 (资产/prefab — 需实例化才可见)"); return { stage: 3, objs: a3 }; }
        }
        return { stage: 0, objs: [] };
    } catch (e) { warn("[v3][Credit] findRollsStaged err: " + e); return { stage: 0, objs: [] }; }
}
// ---- 资产 → 场景实例化 (run-7 核心修复: 全新会话无 live CreditsUI, 资产动画不可见) ----
function getGoName(go) { try { var n = invokeOk(cgmChain(A.ogc(go), "get_name", 0), go, []); return n.ok && n.ret ? (readStr(n.ret) || "?") : "?"; } catch (e) { return "?"; } }
// 组件 → 所在 GO → Transform 链走到根 → 根 GO (prefab 根)
function rootGoOf(comp) {
    try {
        var g = invokeOk(cgmChain(A.ogc(comp), "get_gameObject", 0), comp, []);
        if (!g.ok || !g.ret || g.ret.isNull()) return null;
        var t = invokeOk(cgmChain(A.ogc(g.ret), "get_transform", 0), g.ret, []);
        var cur = t.ok ? t.ret : null, steps = 0;
        while (cur && !cur.isNull() && steps++ < 32) {
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull()) break;
            cur = p.ret;
        }
        if (!cur || cur.isNull()) return null;
        var rg = invokeOk(cgmChain(A.ogc(cur), "get_gameObject", 0), cur, []);
        return rg.ok && !rg.ret.isNull() ? rg.ret : null;
    } catch (e) { warn("[v3][Credit] rootGoOf err: " + e); return null; }
}
// 在 GO 子树里收集目标 roll 并捕获 (GetComponentsInChildren includeInactive)
function collectAndCapture(go, targetCls, checkFn, tag) {
    try {
        var arr = invokeOk(cgmChain(A.ogc(go), "GetComponentsInChildren", 2), go, [A.tgo(A.cgt(targetCls)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) return false;
        var len = arr.ret.add(0x18).readS32(), got = false;
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull()) continue;
            if (checkFn(e)) { captureRolls(e, tag); got = true; }
        }
        return got;
    } catch (e) { warn("[v3][Credit] collectAndCapture err: " + e); return false; }
}
// 资产 roll → 先扫已有副本 (跨阶段复用, staff/thanks 同 prefab 时只实例化一次) → 否则
// Object.Instantiate(prefab 根) 造 live 副本 → 从副本捕获
function ensureRollFromAsset(assetComp, targetCls, checkFn, tag) {
    try {
        if (comp.liveRoot && !comp.liveRoot.isNull()) {
            if (collectAndCapture(comp.liveRoot, targetCls, checkFn, tag + ".已有副本")) return true;
        }
        var root = rootGoOf(assetComp);
        if (!root || root.isNull()) { warn("[v3][Credit] " + tag + ": prefab 根 GO 不可得"); return false; }
        var objCls = findClassAcrossImages("UnityEngine", "Object");
        var mi = A.cgm(objCls, Memory.allocUtf8String("Instantiate"), 1);
        if (!mi || mi.isNull() || !mi.readPointer() || mi.readPointer().isNull()) { warn("[v3][Credit] Object.Instantiate NOT FOUND"); return false; }
        var cp = invokeOk(mi, ptr(0), [root]);
        if (!cp.ok || !cp.ret || cp.ret.isNull()) { warn("[v3][Credit] Instantiate FAIL (" + tag + ", 根='" + getGoName(root) + "')"); return false; }
        if (!comp.liveRoot || comp.liveRoot.isNull()) comp.liveRoot = cp.ret;
        info("[v3][Credit] prefab 资产 → 场景实例化副本 = " + cp.ret + " (根='" + getGoName(root) + "', " + tag + ")");
        return collectAndCapture(cp.ret, targetCls, checkFn, tag + ".副本");
    } catch (e) { warn("[v3][Credit] ensureRollFromAsset err: " + e); return false; }
}
// 分门控捕获 (run-6 教训: 共用一个全量门会把 staff/thanks 一起拖死 — rollScroll 已捕获却因
// rollThanks 缺失整体跳过)。顺序: UI 子树 → GetUI 自建 → 全场景扫殿后 (明确标记 LIVE/资产)
function ensureScroll() {
    try {
        if (comp.rollScroll && isScrollRoll(comp.rollScroll)) return true;
        if (comp.creditsUI && !comp.creditsUI.isNull()) scanUiRolls(comp.creditsUI, "已有UI");
        if (!comp.rollScroll) spawnCreditsUI();
        if (!comp.rollScroll) {
            var r = findRollsStaged(cls.rollScroll, "rollScroll");
            if (r.stage === 1 || r.stage === 2) { for (var i = 0; i < r.objs.length && !comp.rollScroll; i++) captureRolls(r.objs[i], "全场景扫"); }
            else if (r.stage === 3) { if (r.objs.length) ensureRollFromAsset(r.objs[0], cls.rollScroll, isScrollRoll, "scroll"); else warn("[v3][Credit] rollScroll: 场景与资产均无"); }
        }
        if (!comp.rollScroll || !isScrollRoll(comp.rollScroll)) {
            warn("[v3][Credit] rollScroll 不可得 (UI=" + (comp.creditsUI ? "有但无 roll 子树" : "无") + ") — director 由原版 PlayAsync 初始化, 全新会话首次需先跑一次原版 @credit (之后本会话常驻)");
            return false;
        }
        return true;
    } catch (e) { warn("[v3][Credit] ensureScroll err: " + e); return false; }
}
function ensureThanks() {
    try {
        if (comp.rollThanks && isThanksRoll(comp.rollThanks)) return true;
        if (comp.creditsUI && !comp.creditsUI.isNull()) scanUiRolls(comp.creditsUI, "已有UI");
        if (!comp.rollThanks && !comp.creditsUI) spawnCreditsUI();
        if (!comp.rollThanks) {
            var r = findRollsStaged(cls.rollThanks, "rollThanks");
            if (r.stage === 1 || r.stage === 2) { for (var j = 0; j < r.objs.length && !comp.rollThanks; j++) captureRolls(r.objs[j], "全场景扫"); }
            else if (r.stage === 3) { if (r.objs.length) ensureRollFromAsset(r.objs[0], cls.rollThanks, isThanksRoll, "thanks"); else warn("[v3][Credit] rollThanks: 场景与资产均无"); }
        }
        if (!comp.rollThanks || !isThanksRoll(comp.rollThanks)) {
            warn("[v3][Credit] rollThanks 不可得 (UI=" + (comp.creditsUI ? "有但无 roll 子树" : "无") + ") — director 由原版 PlayAsync 初始化, 全新会话首次需先跑一次原版 @credit (之后本会话常驻)");
            return false;
        }
        return true;
    } catch (e) { warn("[v3][Credit] ensureThanks err: " + e); return false; }
}
function captureFromDirector(dir, tag) {
    try {
        if (!dir || dir.isNull()) return;
        var rolls = dir.add(0x60).readPointer();   // _creditRolls@0x60 (prefab 序列化, Awake 已填)
        if (!rolls || rolls.isNull()) return;
        var rl = rolls.add(0x18).readS32();
        if (rl < 1 || rl > 16) return;
        for (var j = 0; j < rl; j++) {
            var r = rolls.add(0x20 + j * 8).readPointer();
            if (r.isNull()) continue;
            captureRolls(r, tag);
        }
    } catch (e) { warn("[v3][Credit] captureFromDirector err: " + e); }
}

// ============ dict 类: metadata 自解析 (实现阶段修正 — 全新会话无原版 ShowAsync 可偷) ============
// CreditsDirectorAct2._specialThanksCredits = Dictionary<LocaleKind, string[][]> (dump.cs:481224 实锤)
// field_get_type → 泛型实例化 Il2CppType → class_from_type → Il2CppClass — 开机可得, 零依赖
// run-8 修正: il2cpp_field_get_type / il2cpp_method_get_param 不在 GameAssembly.dylib 导出表
//   (nm/strings 双证, A 表里也没有) → 路径B 改托管反射 (MakeGenericType → TypeHandle → class_from_type)
// 托管反射: typeof(Dictionary<,>).MakeGenericType([LocaleKind, string[][]]) → RuntimeTypeHandle.value
//   (= Il2CppType*) → A.cft — 全程只用已绑定的导出 (class_get_type/type_get_object/array_new/invoke/directCall)
function dictClsViaReflection() {
    try {
        // run-10: 每步日志二分 — 崩溃在哨兵前, 嫌疑 A.tgo(开放泛型)/A.an(Type)
        var typeCls = getSystemClass("Type");
        if (!typeCls || typeCls.isNull()) { warn("[v3][Credit] 反射 1/8 System.Type 未找到"); return null; }
        info("[v3][Credit] 反射 1/8 System.Type ok");
        var gtMi = A.cgm(typeCls, Memory.allocUtf8String("GetType"), 1);
        if (!gtMi || gtMi.isNull()) { warn("[v3][Credit] 反射 2/8 Type.GetType NOT FOUND"); return null; }
        // run-14: 2a — GetType(closed 泛型全名) 一步拿 Dictionary<LocaleKind,string[][]> 具体 Type,
        //   绕过 MakeGenericType/typeArr (run-13 崩在 3/8-4/8 构造区)。
        //   LocaleKind assembly 定位: dump.cs Image 74 = GigaCreation.Essentials.Localization
        //   (TypeDefIndex 17606-17630, LocaleKind=17615)。嵌套泛型名语法: `2[[T1,Asm1],[T2,Asm2]]。
        //   run-12 修复: 静态方法实例传 ptr(0) 而非 JS null — Frida NativeFunction 指针参数不接受 null
        var closedName = "System.Collections.Generic.Dictionary`2[[GigaCreation.Essentials.Localization.LocaleKind, GigaCreation.Essentials.Localization],[System.String[][], mscorlib]]";
        var cg = invokeOk(gtMi, ptr(0), [makeS(closedName)]);
        if (cg.ok && cg.ret && !cg.ret.isNull()) {
            info("[v3][Credit] 反射 2a/8 GetType(closed) ok");
            var closed = cg.ret;
            if (A.csyst) {
                var c0 = A.csyst(closed);
                if (c0 && !c0.isNull()) { info("[v3][Credit] 反射 2b/8 dict 类 = " + clsName(c0)); return c0; }
                warn("[v3][Credit] 反射 2b/8 csyst 失败 — 走 TypeHandle");
            }
            var thMi = cgmChain(A.ogc(closed), "get_TypeHandle", 0);
            if (!thMi || thMi.isNull()) { warn("[v3][Credit] 反射 2c/8 closed get_TypeHandle NOT FOUND"); return null; }
            var it2 = directCall(thMi, 'pointer', [closed]);
            if (it2 && !it2.isNull()) {
                var c2 = A.cft(it2);
                if (c2 && !c2.isNull()) { info("[v3][Credit] 反射 2d/8 dict 类 (closed TypeHandle) = " + clsName(c2)); return c2; }
            }
            warn("[v3][Credit] 反射 2c/8 closed TypeHandle 失败 — 走开放泛型路径");
        } else {
            info("[v3][Credit] 反射 2a/8 GetType(closed) 失败 (类型名错误/未加载?) — 走开放泛型 MakeGenericType 路径");
        }
        // ---- 开放泛型路径 (原 2/8-8/8) ----
        var openType = null;
        var gt = invokeOk(gtMi, ptr(0), [makeS("System.Collections.Generic.Dictionary`2")]);
        if (gt.ok && gt.ret && !gt.ret.isNull()) { openType = gt.ret; info("[v3][Credit] 反射 3/8 Type.GetType(开放) ok"); }
        if (!openType || openType.isNull()) {
            var openCls = findClassAcrossImages("System.Collections.Generic", "Dictionary`2");
            if (!openCls || openCls.isNull()) { warn("[v3][Credit] 反射 3/8 Dictionary`2 类未找到 (GetType 也失败)"); return null; }
            openType = A.tgo(A.cgt(openCls));   // typeof(Dictionary<,>) — run-10 崩溃嫌疑点, 兜底路径
            info("[v3][Credit] 反射 3/8 tgo(开放泛型) ok (GetType 失败, 兜底)");
        }
        // run-14: 4a/4b/4c/4d 细分 — run-13 崩在 3/8-4/8 之间, 哨兵精确到每步定位
        var sArrCls = stringArrayCls();
        if (!sArrCls || sArrCls.isNull()) { warn("[v3][Credit] 反射 4a/8 string[] 类未找到"); return null; }
        info("[v3][Credit] 反射 4a/8 string[] 类 ok");
        if (!comp.gArrCls || comp.gArrCls.isNull()) {
            var t = A.an(sArrCls, 1);
            if (!t || t.isNull()) { warn("[v3][Credit] 反射 4b/8 gArrCls 实例失败"); return null; }
            comp.gArrCls = A.ogc(t);
            info("[v3][Credit] 反射 4b/8 gArrCls (string[][]) ok");
        }
        // Type[] 参数 (array_new 元素类 = System.Type; IL2CPP 64 位布局: 数据从 0x20 起)
        var typeArr = A.an(A.cgt(typeCls), 2);
        if (!typeArr || typeArr.isNull()) { warn("[v3][Credit] 反射 4c/8 Type[] array_new 失败"); return null; }
        info("[v3][Credit] 反射 4c/8 Type[] array_new ok");
        typeArr.add(0x20).writePointer(A.tgo(A.cgt(cls.localeKind)));
        typeArr.add(0x28).writePointer(A.tgo(A.cgt(comp.gArrCls)));
        info("[v3][Credit] 反射 4d/8 Type[] 写入 ok");
        // run-9 修复: MakeGenericType/get_TypeHandle 在 System.Type 上是抽象方法, methodPointer 是 thunk
        //   directCall → 垃圾指针 → access violation (启动卡死根因)。必须 cgmChain 在具体类
        //   (RuntimeType) 上找实现 — invokeOk 对虚方法经 vtable 分派可接受, directCall 不行
        var mgtMi = cgmChain(A.ogc(openType), "MakeGenericType", 1);
        if (!mgtMi || mgtMi.isNull()) { warn("[v3][Credit] 反射 5/8 Type.MakeGenericType NOT FOUND"); return null; }
        info("[v3][Credit] 反射 5/8 MakeGenericType 方法 ok — 若此后无日志则是此处卡住");
        var closed = invokeOk(mgtMi, openType, [typeArr]);
        if (!closed.ok || !closed.ret || closed.ret.isNull()) { warn("[v3][Credit] 反射 5/8 MakeGenericType FAIL"); return null; }
        info("[v3][Credit] 反射 6/8 MakeGenericType 调用 ok");
        // 首选: il2cpp_class_from_system_type (entry.js A.csyst) — Type 对象 → Il2CppClass 直读
        if (A.csyst) {
            var c0 = A.csyst(closed.ret);
            if (c0 && !c0.isNull()) { info("[v3][Credit] dict 类 metadata 自解析 (csyst) = " + clsName(c0)); return c0; }
        }
        // TypeHandle 是 8B 结构体返回 — invoke 缓冲失效, 必须 directCall (utils 实证规矩);
        // get_TypeHandle 同样在具体类上找 (cgmChain), 抽象类 thunk 会读到垃圾指针
        var thMi = cgmChain(A.ogc(closed.ret), "get_TypeHandle", 0);
        if (!thMi || thMi.isNull()) { warn("[v3][Credit] 反射 7/8 Type.get_TypeHandle NOT FOUND"); return null; }
        var il2cppType = directCall(thMi, 'pointer', [closed.ret]);   // RuntimeTypeHandle.value = Il2CppType*
        if (!il2cppType || il2cppType.isNull()) { warn("[v3][Credit] 反射 7/8 TypeHandle 直调失败"); return null; }
        var c = A.cft(il2cppType);
        if (c && !c.isNull()) { info("[v3][Credit] 反射 8/8 class_from_type ok"); return c; }
        warn("[v3][Credit] 反射 8/8 class_from_type(TypeHandle) 失败");
        return null;
    } catch (e) { warn("[v3][Credit] dictClsViaReflection err: " + e); return null; }
}
function resolveDictCls() {
    try {
        if (comp.dictCls && !comp.dictCls.isNull()) return comp.dictCls;
        // 路径A: 字段类型 (metadata 自解析, 首选) — director._specialThanksCredits@0xA0 = Dictionary<LocaleKind,string[][]>
        if (fgt) {
            var f = A.gf(cls.director, Memory.allocUtf8String("_specialThanksCredits"));
            if (f && !f.isNull()) {
                var ft = fgt(f);
                if (ft && !ft.isNull()) {
                    var c = A.cft(ft);
                    if (c && !c.isNull()) {
                        comp.dictCls = c;
                        info("[v3][Credit] dict 类 metadata 自解析 (字段) = " + clsName(c));
                        return c;
                    }
                }
            }
        }
        // 路径B: ShowAsync 参数0 类型 (闭式泛型参数, mgp 反查同效)
        if (mgp) {
            var mi = A.cgm(cls.rollThanks, Memory.allocUtf8String("ShowAsync"), 5);
            if (mi && !mi.isNull()) {
                var pt = mgp(mi, 0);
                if (pt && !pt.isNull()) {
                    var c2 = A.cft(pt);
                    if (c2 && !c2.isNull()) {
                        comp.dictCls = c2;
                        info("[v3][Credit] dict 类 metadata 自解析 (ShowAsync 参数) = " + clsName(c2));
                        return c2;
                    }
                }
            }
        }
        // 路径C: 托管反射 (run-8 主路径 — fgt/mgp 不在导出表)
        var c3 = dictClsViaReflection();
        if (c3 && !c3.isNull()) {
            comp.dictCls = c3;
            info("[v3][Credit] dict 类 metadata 自解析 (MakeGenericType) = " + clsName(c3));
            return c3;
        }
        warn("[v3][Credit] dict 类 metadata 自解析失败 (fgt=" + !!fgt + " mgp=" + !!mgp + " 反射=" + !!c3 + ") — 走偷取回退");
        return null;
    } catch (e) { warn("[v3][Credit] resolveDictCls err: " + e); return null; }
}

// ============ F1 根治: 祖先链激活 (探针 run-4 实证 canvas 0→1, 动画恢复) ============
// run-8 升级: CanvasGroup alpha=1 — Naninovel 用 CanvasGroup 控制 UI 显隐 (隐藏态 alpha=0);
//   只激活 GO 链不够, 原版 PlayAsync 的 fade 才置 1 — LIVE roll + canvas active 仍不可见的头号嫌疑
function setCanvasGroupAlpha(go, alpha) {
    try {
        var mi = cgmChain(A.ogc(go), "GetComponent", 1);   // GetComponent 属于 GO 类, 非 CanvasGroup
        var cg = invokeOk(mi, go, [A.tgo(A.cgt(cls.canvasGroup))]);
        if (!cg.ok || !cg.ret || cg.ret.isNull()) return false;
        var a = dcFloat(cgmChain(A.ogc(cg.ret), "get_alpha", 0), cg.ret);
        if (a !== alpha) {
            invoke(cgmChain(A.ogc(cg.ret), "set_alpha", 1), cg.ret, [fPtr(alpha)]);
            dbg("[v3][Credit] CanvasGroup alpha " + a + " → " + alpha + " (" + getGoName(go) + ")");
        }
        return true;
    } catch (e) { return false; }
}
function ensureHierarchy() {
    try {
        var anchor = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        var go = anchor.add(0x20).readPointer();   // CreditRoll._gameObject@0x20
        if (!go || go.isNull()) { warn("[v3][Credit] roll _gameObject@0x20 为空"); return false; }
        var gt = invokeOk(cgmChain(A.ogc(go), "get_transform", 0), go, []);
        var chain = [];
        var cur = gt.ok ? gt.ret : null;
        while (cur && !cur.isNull()) {
            chain.push(cur);
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull()) break;
            cur = p.ret;
        }
        var n = 0, cgN = 0, cgParts = [];
        for (var i = chain.length - 1; i >= 0; i--) {   // 从最上层祖先往下激活
            var t = chain[i];
            var g = invokeOk(cgmChain(A.ogc(t), "get_gameObject", 0), t, []);
            if (!g.ok || g.ret.isNull()) continue;
            var as = dcBool(cgmChain(A.ogc(g.ret), "get_activeSelf", 0), g.ret);
            if (!as) {
                invoke(cgmChain(A.ogc(g.ret), "SetActive", 1), g.ret, [boolPtr(true)]);
                activatedAncestors.push(g.ret);
                n++;
            }
            if (setCanvasGroupAlpha(g.ret, 1.0)) { cgN++; cgParts.push(getGoName(g.ret)); }
        }
        info("[v3][Credit] 祖先链激活 " + n + " 个 GO / CanvasGroup 置 1 共 " + cgN + " 个 (" + cgParts.join(", ") + ") (链深 " + chain.length + ")");
        return n > 0 || cgN > 0;
    } catch (e) { warn("[v3][Credit] ensureHierarchy err: " + e); return false; }
}
// run-10 修复: 渲染栈 — alpha=1 后仍不可见 → sortingOrder/renderMode 嫌疑
//   (Naninovel UIManager 显示 UI 时会注册排序; 开机自建实例未走注册, sortingOrder 可能压在别的 canvas 下面;
//   ScreenSpaceCamera + 相机为空 = Unity 必不渲染的组合)
function ensureCanvasRenderable() {
    try {
        var anchor = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        var go = anchor.add(0x20).readPointer();   // CreditRoll._gameObject@0x20
        if (!go || go.isNull()) { warn("[v3][Credit] 渲染修复: roll _gameObject@0x20 为空"); return false; }
        var gt = invokeOk(cgmChain(A.ogc(go), "get_transform", 0), go, []);
        var cur = gt.ok ? gt.ret : null;
        var canvases = [], rootCanvas = null;
        while (cur && !cur.isNull()) {
            var g = invokeOk(cgmChain(A.ogc(cur), "get_gameObject", 0), cur, []);
            if (g.ok && g.ret) {
                var cv = invokeOk(cgmChain(A.ogc(g.ret), "GetComponent", 1), g.ret, [A.tgo(A.cgt(cls.canvas))]);
                if (cv.ok && cv.ret && !cv.ret.isNull()) { canvases.push(cv.ret); rootCanvas = cv.ret; }
            }
            var p = invokeOk(cgmChain(A.ogc(cur), "get_parent", 0), cur, []);
            if (!p.ok || p.ret.isNull()) break;
            cur = p.ret;
        }
        if (!canvases.length) { warn("[v3][Credit] 渲染修复: 链上无 Canvas 组件"); return false; }
        for (var i = 0; i < canvases.length; i++) {
            var c = canvases[i];
            var rm = dcInt(cgmChain(A.ogc(c), "get_renderMode", 0), c);
            var so = dcInt(cgmChain(A.ogc(c), "get_sortingOrder", 0), c);
            if (!dcBool(cgmChain(A.ogc(c), "get_isActiveAndEnabled", 0), c)) invoke(cgmChain(A.ogc(c), "set_enabled", 1), c, [boolPtr(true)]);
            invoke(A.cgm(cls.canvas, Memory.allocUtf8String("set_sortingOrder"), 1), c, [iPtr(10000)]);
            var lay = -1;
            var ggo = invokeOk(cgmChain(A.ogc(c), "get_gameObject", 0), c, []);
            if (ggo.ok && ggo.ret) lay = dcInt(cgmChain(A.ogc(ggo.ret), "get_layer", 0), ggo.ret);
            info("[v3][Credit] canvas[" + i + "] " + getGoName(c) + ": renderMode=" + rm + " sortingOrder " + so + "→10000 enabled=1 layer=" + lay);
        }
        if (rootCanvas) {
            var rm2 = dcInt(cgmChain(A.ogc(rootCanvas), "get_renderMode", 0), rootCanvas);
            if (rm2 === 1) {
                var cam = invokeOk(cgmChain(A.ogc(rootCanvas), "get_camera", 0), rootCanvas, []);
                if (!cam.ok || cam.ret.isNull()) {
                    warn("[v3][Credit] 根 canvas 为 ScreenSpaceCamera 且相机为空 → 改 ScreenSpaceOverlay");
                    invoke(A.cgm(cls.canvas, Memory.allocUtf8String("set_renderMode"), 1), rootCanvas, [iPtr(0)]);
                } else {
                    info("[v3][Credit] 根 canvas: ScreenSpaceCamera, 相机=" + getGoName(cam.ret));
                }
            }
        }
        return true;
    } catch (e) { warn("[v3][Credit] ensureCanvasRenderable err: " + e); return false; }
}
function restoreAncestors() {
    for (var i = 0; i < activatedAncestors.length; i++) {
        try { invoke(cgmChain(A.ogc(activatedAncestors[i]), "SetActive", 1), activatedAncestors[i], [boolPtr(false)]); } catch (e) {}
    }
    activatedAncestors = [];
}

// ============ 写回变量 (F13: 缓存 manager 实例; 与触发同一 SetVariableValue 机制) ============
function writeVar(name, num) {
    try {
        if (!mgr || mgr.isNull()) { warn("[v3][Credit] writeVar(" + name + ") FAIL: 无 CustomVariableManager 实例"); return false; }
        var mi = A.cgm(cls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        var v = Memory.alloc(0x18);
        v.writeS32(1);                                   // type: Numeric
        v.add(0x8).writePointer(ptr(0));
        v.add(0x10).writeFloat(num);
        v.add(0x14).writeS32(0);
        var r = invokeOk(mi, mgr, [makeS(name), v]);
        if (!r.ok) warn("[v3][Credit] writeVar(" + name + ") FAIL");
        return r.ok;
    } catch (e) { warn("[v3][Credit] writeVar err: " + e); return false; }
}

// ============ run-30: 原版致谢完整数据探针 (trigger "probe-thanks") ============
// 背景: staff-samples.json 的 42 条 = 运行时轮询采样窗口的不完整快照 (采样抓 Text 属性,
//   轮询间隔错过大量行) → mod 名单远少于原版 (SpecialThanksData asset 实证:
//   4544 ja + 420 zh 赞助者, 课程分档)。完全还原 = 原版实际显示的每行富文本 + 时序。
// 数据源:
//   ① director._specialThanksCredits@0xA0 = Dictionary<LocaleKind,string[][]> (PlayAsync 前已构建)
//      → 每语种 页[] (页 = 行[]), 行 = 富文本 (格式实证: <size=1.7em>名</size><space=80>...)
//   ② hook SpecialThanksLabel.set_Text → 实际播放序列 (行 + 时间戳) — 时序/顺序验证
// 输出: TestCredit/Assets/special-credits.json (①全量) + thanks-rows.json (②序列)
var thanksProbe = { attached: false, rows: [], flushTimer: null, t0: 0 };
function thanksProbeRoot() {
    return (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? MOD_ROOT + "/TestCredit/Assets" : "/tmp";
}
function thanksProbeWrite(obj, fname) {
    try {
        var path = thanksProbeRoot() + "/" + fname;
        var fd = openForWrite(path);
        if (fd < 0) { warn("[v3][Credit] 探针: 写文件失败 " + path); return; }
        // 用 io.js writeString (Memory.allocUtf8String + 扫 NUL 计长, 日志系统实证) —
        //   Frida writeUtf8String 返回值不可靠 (实测写出 800KB 全零)
        var wrote = writeString(fd, JSON.stringify(obj, null, 1));
        fileSync(fd);
        try { var ch = Module.findGlobalExportByName("chmod"); if (ch) new NativeFunction(ch, "int", ["pointer", "int"])(Memory.allocUtf8String(path), 0o644); } catch (e2) {}
        info("[v3][Credit] 探针: 已写出 " + fname + " (" + (wrote / 1024).toFixed(0) + "KB)");
    } catch (e) { warn("[v3][Credit] 探针写盘 err: " + e); }
}
// ① 完整页/行数据 — director._specialThanksCredits@0xA0 (Dictionary<LocaleKind,string[][]>,
//   IL2CPP 字典布局: m_entries@0x18, Entry stride 24, 空槽 hashCode==-1 — choice.js 实证)
function thanksProbeDict() {
    try {
        var d = comp.director;
        if (!d || d.isNull()) { warn("[v3][Credit] 探针: 无 director"); return; }
        var dict = d.add(0xA0).readPointer();
        if (!dict || dict.isNull()) { warn("[v3][Credit] 探针: _specialThanksCredits=null"); return; }
        var ents = dict.add(0x18).readPointer();
        if (!ents || ents.isNull()) { warn("[v3][Credit] 探针: m_entries 不可得"); return; }
        var al = ents.add(0x18).readS32();
        if (al < 0 || al > 32) { warn("[v3][Credit] 探针: entries 数量异常 " + al); return; }
        var names = ["ja", "en-US", "zh-Hans", "zh-Hant", "ko", "fr", "es"];
        var out = { localeKeys: [] };
        for (var e = 0; e < al; e++) {
            var eb = ents.add(0x20 + e * 24);
            if (eb.readS32() === -1) continue;          // 空槽
            var key = eb.add(8).readS32();              // LocaleKind
            if (key < 0 || key > 6) continue;
            var val = eb.add(0x10).readPointer();       // string[][]
            if (!val || val.isNull()) continue;
            var glen = val.add(0x18).readS32();
            if (glen < 0 || glen > 2000) { warn("[v3][Credit] 探针: '" + names[key] + "' 页数异常 " + glen); continue; }
            var pages = [];
            for (var g = 0; g < glen; g++) {
                var arr = val.add(0x20 + g * 8).readPointer();
                if (!arr || arr.isNull()) continue;
                var alen = arr.add(0x18).readS32();
                if (alen < 0 || alen > 2000) continue;
                var lines = [];
                for (var l = 0; l < alen; l++) {
                    var s = arr.add(0x20 + l * 8).readPointer();
                    if (s && !s.isNull()) lines.push(readStr(s));
                }
                pages.push(lines);
            }
            var nr = 0;
            for (var g2 = 0; g2 < pages.length; g2++) nr += pages[g2].length;
            out[names[key]] = { pages: pages, nRows: nr };
            out.localeKeys.push(names[key]);
            info("[v3][Credit] 探针: 语种 '" + names[key] + "' " + pages.length + " 页 " + nr + " 行");
        }
        thanksProbeWrite(out, "special-credits.json");
    } catch (e) { warn("[v3][Credit] thanksProbeDict err: " + e); }
}
// ② 实际播放序列 — SpecialThanksLabel.set_Text/Clear (行 + 时间戳)
function installThanksProbe() {
    try {
        if (thanksProbe.attached) return;
        // run-30c: TMP 级全局 hook (set_text/SetText) — 共犯页显示路径不一定是 SpecialThanksLabel.set_Text
        //   (16:52 实证: 共犯页播了但包装 set_Text 零触发)。全量收集 + 时间戳, 事后按内容区分
        //   (共犯行 = 富文本 <size=/<br>, staff 滚动 = 纯文本; 顺序即演出顺序)。
        var tmpCls = findClassAcrossImages("TMPro", "TextMeshProUGUI");
        if (!tmpCls || tmpCls.isNull()) { warn("[v3][Credit] 探针: TextMeshProUGUI 类 NOT FOUND"); return; }
        var tmpSet = A.cgm(tmpCls, Memory.allocUtf8String("set_text"), 1);
        var tmpSetTxt = A.cgm(tmpCls, Memory.allocUtf8String("SetText"), 1);
        thanksProbe.t0 = Date.now();
        var tmpEnter = function (a) {
            try {
                var s = readStr(a[1]);
                if (!s || s.length < 2 || s.length > 20000) return;
                var last = thanksProbe.rows[thanksProbe.rows.length - 1];
                var now = Date.now() - thanksProbe.t0;
                if (last && last.k === 1 && last.text === s && now - last.t < 80) { last.t = now; return; }
                thanksProbe.rows.push({ k: 1, t: now, text: s });
            } catch (e2) {}
        };
        var attached = 0;
        if (tmpSet && !tmpSet.isNull() && !tmpSet.readPointer().isNull()) { Interceptor.attach(tmpSet.readPointer(), { onEnter: tmpEnter }); attached++; }
        if (tmpSetTxt && !tmpSetTxt.isNull() && !tmpSetTxt.readPointer().isNull()) { Interceptor.attach(tmpSetTxt.readPointer(), { onEnter: tmpEnter }); attached++; }
        // 对照: SpecialThanksLabel.set_Text (16:52 零触发 — 保留以确认路径)
        var cl = findClassAcrossImages("WitchTrials.Views", "SpecialThanksLabel");
        if (cl && !cl.isNull()) {
            var mi = A.cgm(cl, Memory.allocUtf8String("set_Text"), 1);
            if (mi && !mi.isNull() && !mi.readPointer().isNull()) {
                Interceptor.attach(mi.readPointer(), { onEnter: function (a) { try { var s = readStr(a[1]); if (s && s.length > 1) info("[v3][Credit] 探针[set_Text]: " + s.slice(0, 60)); } catch (e2) {} } });
                attached++;
            }
        }
        var miClear = A.cgm(cl, Memory.allocUtf8String("Clear"), 0);
        if (miClear && !miClear.isNull() && !miClear.readPointer().isNull()) {
            Interceptor.attach(miClear.readPointer(), { onEnter: function () { try { thanksProbe.rows.push({ k: 0, t: Date.now() - thanksProbe.t0 }); } catch (e2) {} } });
        }
        // run-30b: hook CreditRollSpecialThanks.ShowAsync — 共犯页在 PlayAsync 链路哪一环触发 (调用时机)
        try {
            var clsRoll = findClassAcrossImages("WitchTrials.Views", "CreditRollSpecialThanks");
            if (clsRoll && !clsRoll.isNull()) {
                var miSA = A.cgm(clsRoll, Memory.allocUtf8String("ShowAsync"), 5);
                if (miSA && !miSA.isNull() && !miSA.readPointer().isNull()) {
                    Interceptor.attach(miSA.readPointer(), {
                        onEnter: function () {
                            info("[v3][Credit] 探针: ShowAsync 被调用 @" + ((Date.now() - thanksProbe.t0) / 1000).toFixed(0) + "s (共犯页开始)");
                        }
                    });
                }
            }
        } catch (e3) { warn("[v3][Credit] 探针 ShowAsync hook err: " + e3); }
        thanksProbe.attached = true;
        info("[v3][Credit] 探针已挂 (SpecialThanksLabel.set_Text + Clear + ShowAsync — 逐行富文本 + 时序)");
        if (!thanksProbe.flushTimer) thanksProbe.flushTimer = setInterval(function () { try { thanksProbeFlush(); } catch (e4) {} }, 3000);
    } catch (e) { warn("[v3][Credit] installThanksProbe err: " + e); }
}
function thanksProbeFlush() {
    try {
        if (!thanksProbe.rows.length) return;
        thanksProbeWrite({ n: thanksProbe.rows.length, rows: thanksProbe.rows }, "thanks-rows.json");
    } catch (e) {}
}

// ============ 数据 json ============
function loadCreditData(path) {
    creditState.json = null;
    creditState.original = false;
    // run-15: 原版复刻模式 — 值 "original" 不读 json, 直接调原版 CreditsUI.PlayAsync(2)
    //   (= nani @credit 2 命令全流程: stills + staff 滚动 + SpecialThanks, 内容/语种/时序全原版)
    // run-30: "probe-thanks" = 原版全流程 + 共犯完整数据探针 (字典全量 + set_Text 逐行时序)
    if (path === "original" || path === "extract" || path === "probe-thanks") {
        creditState.original = true;
        creditState.extract = (path === "extract" || path === "probe-thanks");   // run-30: probe-thanks 复用 extract 分支挂探针
        writeVar("g_creditDone", 0);   // run-19: trigger 即重置 — CustomVariableManager 变量持久化, 防上次会话残留 1
        if (creditState.extract) { writeVar("g_extractDone", 0); }
        info("[v3][Credit] trigger '" + path + "' → 原版复刻模式已武装 (phase=2 将调 CreditsUI.PlayAsync(2)" + (creditState.extract ? (path === "probe-thanks" ? " + 共犯完整数据探针" : " + 演出素材提取") : "") + ")");
        return true;
    }
    if (typeof MOD_ROOT === "undefined" || !MOD_ROOT) { warn("[v3][Credit] MOD_ROOT 未定义"); return false; }
    var modKey = wbCurrentMod;
    var p = modKey ? (MOD_ROOT + "/" + modKey + "/" + path) : (MOD_ROOT + "/" + path);
    var j = readJSONFile(p);
    if (!j) { warn("[v3][Credit] json 读取失败 '" + p + "'" + (modKey ? "" : " (当前 mod 未知, 回退 mod 根)")); return false; }
    creditState.json = j;
    // run-30c: thanks 数据覆盖 — Assets/thanks-pages.json (原版运行捕获的 36 屏全量:
    //   zh 420 + ja 4544 合并名单, 页内行富文本原样) 优先于 data.json 的旧 42 行采样
    try {
        var tp = modKey ? (MOD_ROOT + "/" + modKey + "/Assets/thanks-pages.json") : (MOD_ROOT + "/Assets/thanks-pages.json");
        var tpj = readJSONFile(tp);
        // 兼容两种结构: {thanks:{...}} 包裹 或 直接 {order, "<locale>": {...}}
        var src = (tpj && tpj.thanks) ? tpj.thanks : (tpj && tpj.order ? tpj : null);
        if (src) {
            var nP = 0;
            for (var k3 in src) { if (k3 !== "order" && src[k3] && src[k3].pages) nP += src[k3].pages.length; }
            if (nP > 0) {
                j.thanks = src;
                info("[v3][Credit] thanks 数据已覆盖: " + tp + " (" + nP + " 页全量)");
            }
        } else { dbg("[v3][Credit] thanks-pages.json 无 thanks 字段或缺失 — 用 data.json 旧数据"); }
    } catch (eC) { warn("[v3][Credit] thanks 覆盖 err: " + eC); }
    creditState.jsonPath = p;
    // 校验: staff 至少一个语种有内容; thanks 至少一个语种有 groups
    var staffOk = false, thanksOk = false;
    if (j.staff && typeof j.staff === "object") {
        for (var k in j.staff) { if (k !== "speed" && k !== "endPause" && Array.isArray(j.staff[k]) && j.staff[k].length) staffOk = true; }
    }
    if (j.thanks && typeof j.thanks === "object") {
        for (var k2 in j.thanks) { if (k2 !== "order" && j.thanks[k2] && Array.isArray(j.thanks[k2].pages) && j.thanks[k2].pages.length) thanksOk = true; }   // run-29: pages
    }
    var stats = [];
    if (staffOk) stats.push("staff 有内容");
    if (thanksOk) stats.push("thanks 有内容");
    info("[v3][Credit] json 加载 '" + p + "' (" + (stats.join(", ") || "空!") + ")");
    return staffOk || thanksOk;   // 至少一部分可用才 arm; 否则 phase 走安全默认时长
}
// staff 行: 当前语种 → ja 回退 → zh-Hans 回退
function staffLinesForLocale() {
    var j = creditState.json;
    if (!j || !j.staff) return [];
    var loc = getCurrentLocale();
    if (Array.isArray(j.staff[loc]) && j.staff[loc].length) return j.staff[loc];
    if (loc !== "ja" && Array.isArray(j.staff.ja) && j.staff.ja.length) return j.staff.ja;
    if (loc !== "zh-Hans" && Array.isArray(j.staff["zh-Hans"]) && j.staff["zh-Hans"].length) return j.staff["zh-Hans"];
    for (var k in j.staff) { if (k !== "speed" && k !== "endPause" && Array.isArray(j.staff[k]) && j.staff[k].length) return j.staff[k]; }
    return [];
}

// ============ 免偷数组构建 (string[] = array_new(String); string[][] = array_new(string[] 类)) ============
function stringArrayCls() {
    if (!comp.sArrCls || comp.sArrCls.isNull()) {
        var strCls = getSystemClass("String");
        if (!strCls || strCls.isNull()) { warn("[v3][Credit] System.String 类未找到"); return ptr(0); }
        var arr = A.an(strCls, 1);
        if (!arr || arr.isNull()) { warn("[v3][Credit] string[] 创建失败"); return ptr(0); }
        comp.sArrCls = A.ogc(arr);
    }
    return comp.sArrCls;
}
function makeGroups(groups) {
    try {
        var sArrCls = stringArrayCls();
        if (!sArrCls || sArrCls.isNull()) return null;
        if (!comp.gArrCls || comp.gArrCls.isNull()) {
            var t = A.an(sArrCls, 1);
            if (!t || t.isNull()) { warn("[v3][Credit] string[][] 创建失败"); return null; }
            comp.gArrCls = A.ogc(t);
        }
        var gArr = A.an(comp.gArrCls, groups.length);
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            var sArr = A.an(sArrCls, g.length);
            for (var j = 0; j < g.length; j++) sArr.add(0x20 + j * 8).writePointer(makeS(g[j]));
            gArr.add(0x20 + i * 8).writePointer(sArr);
        }
        return gArr;
    } catch (e) { warn("[v3][Credit] makeGroups err: " + e); return null; }
}
// LocaleKind 枚举 (dump.cs 实证: Ja=0, ZhHans=2); 未知语种 warn+跳过
var LOCALE_KIND = { "ja": 0, "zh-Hans": 2 };
function localeKindValue(loc) {
    if (LOCALE_KIND[loc] !== undefined) return LOCALE_KIND[loc];
    warn("[v3][Credit] 未知语种 '" + loc + "' (已知: ja/zh-Hans), 跳过");
    return null;
}
function localeName(lv) {   // run-29: lv→名 (原版 order 数组是 LocaleKind 值)
    for (var k in LOCALE_KIND) { if (LOCALE_KIND[k] === lv) return k; }
    return null;
}
function lineEm(text) {     // run-29: 行富文本档位字号 (1.7em→2 / 1.3em→1 / 1.0em→0)
    try {
        var m = /<size=([\d.]+)em>/.exec(text);
        return m ? parseFloat(m[1]) : null;
    } catch (e) { return null; }
}

// ============ run-26/27: still 图片显示 (复刻模式右侧画面) ============
// 原版 Act2: ShowStillsAsync 依次 Present/Dismiss 9 张 EndingStill (Still_1..9 = prefab 静态,
// CanvasGroup+Image; sprite 随 prefab 依赖加载)。复刻: 时序由 run-27 动态决定 —
//   delay   = キャスト 条目滚到屏上的时间 (castLeadOffsetPx/speed; 原版: 名单先滚, キャスト 段图才出现)
//   fade/display = 原版 director units × 60/bpm 换算 (bpm 可得时), 否则 fallback 2s/26s
// 9 张依次 fade (张间无 delay, 逐张 fadeout 切换 — run-28), 播完 fadeout 收尾。phase2 入口 fade 收尾。

function setStillAlpha(st, a) {
    try {
        if (st && st.cg && !st.cg.isNull()) invoke(cgmChain(A.ogc(st.cg), "set_alpha", 1), st.cg, [fPtr(a)]);
    } catch (e) {}
}
function findStills() {
    try {
        comp.stills = [];
        if (!cls.endingStill || cls.endingStill.isNull()) cls.endingStill = findClassAcrossImages("WitchTrials.Views", "EndingStill");
        if (!cls.endingStill || cls.endingStill.isNull()) { warn("[v3][Credit] still: EndingStill 类未找到"); return 0; }
        var all = findAllObjectOfType(cls.endingStill);
        if (!all || !all.length) { warn("[v3][Credit] still: 场景无 EndingStill 组件"); return 0; }
        // run-27: 顺序 — 优先 director._stills@0x58 数组序 (prefab 序列化顺序 = 原版显示顺序),
        //   兜底场景扫 + 名字数字序 (旧: 名字序导致 9→1, 与原版顺序不符)
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull()) d = dR.objs[i];
            }
        }
        var order = null;
        if (d && !d.isNull()) {
            try {
                var stillsArr = d.add(0x58).readPointer();
                if (stillsArr && !stillsArr.isNull()) {
                    var n = stillsArr.add(0x18).readS32();
                    if (n >= 1 && n <= 50) {
                        order = [];
                        for (var ai = 0; ai < n; ai++) {
                            var es2 = stillsArr.add(0x20 + ai * 8).readPointer();
                            if (es2 && !es2.isNull()) order.push(es2);
                        }
                        info("[v3][Credit] still: _stills@0x58 数组 " + order.length + " 个 (原版顺序)");
                    }
                }
            } catch (e4) {}
        }
        function collectOne(es, arr, idx) {
            var go = null;
            try {
                var gg = invokeOk(cgmChain(A.ogc(es), "get_gameObject", 0), es, []);
                if (gg.ok) go = gg.ret;
            } catch (e2) {}
            var nm = go ? getGoName(go) : "?";
            var cg = es.add(0x20).readPointer();     // EndingStill._canvasGroup@0x20
            var sp = "?", act = "?";
            try {
                if (go) act = dcBool(cgmChain(A.ogc(go), "get_activeSelf", 0), go) ? "活" : "隐";
                var comps = invokeOk(cgmChain(A.ogc(go), "GetComponentsInChildren", 2), go, [A.tgo(A.cgt(cls.image)), boolPtr(true)]);
                if (comps.ok && comps.ret) {
                    var clen = comps.ret.add(0x18).readS32();
                    for (var ci = 0; ci < clen; ci++) {
                        var img = comps.ret.add(0x20 + ci * 8).readPointer();
                        if (!img || img.isNull()) continue;
                        var spR = invokeOk(cgmChain(A.ogc(img), "get_sprite", 0), img, []);
                        if (spR.ok && spR.ret && !spR.ret.isNull()) {
                            var nmR = invokeOk(cgmChain(A.ogc(spR.ret), "get_name", 0), spR.ret, []);
                            sp = (nmR.ok && nmR.ret) ? (readStr(nmR.ret) || "?") : "?";
                        }
                        break;
                    }
                }
            } catch (e3) {}
            arr.push({ comp: es, go: go, name: nm, cg: cg });
            info("[v3][Credit] still #" + (idx + 1) + ": " + nm + " active=" + act + " cg=" + (cg && !cg.isNull() ? cg : "null") + " sprite=" + sp);
        }
        var arr = [];
        if (order) {
            // 数组序: 去重 (场景同组件可能重复), 按原版顺序
            var seen = {};
            for (var oi = 0; oi < order.length; oi++) {
                var key = order[oi].toString();
                if (seen[key]) continue;
                seen[key] = 1;
                collectOne(order[oi], arr, arr.length);
            }
            if (arr.length) { comp.stills = arr; return arr.length; }
            warn("[v3][Credit] still: _stills 数组元素不可用 — 兜底场景扫+名字序");
        }
        for (var si = 0; si < all.length; si++) collectOne(all[si], arr, arr.length);
        arr.sort(function (a, b) {
            var na = parseInt((a.name || "").replace(/\D/g, ""), 10) || 0;
            var nb = parseInt((b.name || "").replace(/\D/g, ""), 10) || 0;
            return na - nb;
        });
        comp.stills = arr;
        return arr.length;
    } catch (e) { warn("[v3][Credit] findStills err: " + e); return 0; }
}
function stillTick() {
    try {
        var st = comp.stills[comp.stillIdx];
        if (!st) return;
        var now = Date.now();
        var el = now - comp.stillStepStart;
        if (comp.stillState === "delay") {
            if (el >= comp.stillT.delay) { comp.stillState = "fade"; comp.stillStepStart = now; el = 0; }
        }
        if (comp.stillState === "fade") {
            var a = Math.min(1, el / comp.stillT.fade);
            setStillAlpha(st, a);
            if (el >= comp.stillT.fade) { comp.stillState = "display"; comp.stillStepStart = now; setStillAlpha(st, 1); }
        } else if (comp.stillState === "display") {
            if (el >= comp.stillT.display) {
                // run-28: 张间不再回 delay — 原版 delay(18拍) 只对齐首张キャスト出现; 逐张 fadeout 后切换
                //   (旧: 每张都等 12.3s delay → 9×22.2=200s > phase1 119s → 后几张没播)
                comp.stillState = "fadeout"; comp.stillStepStart = now;
            }
        } else if (comp.stillState === "fadeout") {
            var a2 = Math.max(0, 1 - el / comp.stillT.fade);
            setStillAlpha(st, a2);
            if (el >= comp.stillT.fade) {
                setStillAlpha(st, 0);
                comp.stillIdx++;
                if (comp.stillIdx >= comp.stills.length) {
                    info("[v3][Credit] still: " + comp.stills.length + " 张播完 (末张 fadeout 收尾)");
                    comp.stillState = "done";
                    if (comp.stillTimer) { clearInterval(comp.stillTimer); comp.stillTimer = null; }
                    return;
                }
                comp.stillT.delay = 0;   // 首张后才置 0 — 张间无 delay (下轮 showStills 参数重设)
                comp.stillState = "delay"; comp.stillStepStart = now;
            }
        }
    } catch (e) { warn("[v3][Credit] stillTick err: " + e); stopStills(); }
}
function showStills(delayMs, fadeMs, displayMs) {
    try {
        if (comp.stillTimer) { clearInterval(comp.stillTimer); comp.stillTimer = null; }
        if (!comp.stills || !comp.stills.length) {
            if (!findStills()) { warn("[v3][Credit] still: 无 EndingStill 组件 — 右侧画面跳过"); return; }
        }
        if (delayMs !== undefined && delayMs >= 0) comp.stillT.delay = delayMs;
        if (fadeMs !== undefined && fadeMs > 0) comp.stillT.fade = fadeMs;
        if (displayMs !== undefined && displayMs > 0) comp.stillT.display = displayMs;
        comp.stillIdx = 0; comp.stillState = "delay"; comp.stillStepStart = Date.now();
        comp.stillTimer = setInterval(stillTick, 50);
        info("[v3][Credit] still: 开始播放 " + comp.stills.length + " 张 (delay " + comp.stillT.delay / 1000
            + "s + fade " + comp.stillT.fade / 1000 + "s + display " + comp.stillT.display / 1000 + "s/张)");
    } catch (e) { warn("[v3][Credit] showStills err: " + e); }
}
// run-27: 原版时序参数 — 场景扫 CreditsDirectorAct2 (CreditsUI prefab 自带组件) 读序列化字段:
//   _scrollSpeed@0x68 float, _stillDelayUnits@0x6C, _stillFadeUnits@0x70, _stillDisplayUnits@0x74 (拍数),
//   _bgmBpm@0x30 float (CreditsDirectorBase) — 拍→秒 = units × 60/bpm
function readDirectorTiming() {
    try {
        if (comp.timing) return comp.timing;
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull()) d = dR.objs[i];
            }
        }
        if (!d) { warn("[v3][Credit] 原版时序: 场景无 CreditsDirectorAct2 实例 — 用固定值 (speed=" + (creditState.json && creditState.json.staff ? creditState.json.staff.speed : "?") + ", fade/display fallback)"); comp.timing = { speed: 0, delayUnits: -1, fadeUnits: -1, displayUnits: -1, bpm: 0 }; return comp.timing; }
        var t = {
            speed: d.add(0x68).readFloat(),
            delayUnits: d.add(0x6C).readFloat(),
            fadeUnits: d.add(0x70).readFloat(),
            displayUnits: d.add(0x74).readFloat(),
            bpm: d.add(0x30).readFloat()
        };
        comp.timing = t;
        info("[v3][Credit] 原版时序: scrollSpeed=" + t.speed.toFixed(2) + " stillUnits(delay/fade/display)="
            + t.delayUnits.toFixed(2) + "/" + t.fadeUnits.toFixed(2) + "/" + t.displayUnits.toFixed(2) + " bpm=" + t.bpm.toFixed(2));
        return t;
    } catch (e) { warn("[v3][Credit] readDirectorTiming err: " + e); comp.timing = { speed: 0, delayUnits: -1, fadeUnits: -1, displayUnits: -1, bpm: 0 }; return comp.timing; }
}
// run-27: キャスト 条目 (Left 首个 Roll_6) 距 Content 顶部的滚动距离 px — 布局后读 Left 容器
//   anchoredPosition.y (Label GO → transform → parent(Roll_6) → parent(Left 容器), Transform==RectTransform 同一对象)
function castLeadOffsetPx() {
    try {
        var hit = null;
        for (var i = 0; i < comp.labels.length && !hit; i++) {
            if (comp.labels[i].grand === "Left" && comp.labels[i].parent === "Roll_6") hit = comp.labels[i];
        }
        if (!hit || !hit.go || hit.go.isNull()) return null;
        var tR = invokeOk(cgmChain(A.ogc(hit.go), "get_transform", 0), hit.go, []);
        if (!tR.ok || !tR.ret || tR.ret.isNull()) return null;
        var pR = invokeOk(cgmChain(A.ogc(tR.ret), "get_parent", 0), tR.ret, []);
        if (!pR.ok || !pR.ret || pR.ret.isNull()) return null;
        var pR2 = invokeOk(cgmChain(A.ogc(pR.ret), "get_parent", 0), pR.ret, []);
        if (!pR2.ok || !pR2.ret || pR2.ret.isNull()) return null;
        var apR = invokeOk(cgmChain(A.ogc(pR2.ret), "get_anchoredPosition", 0), pR2.ret, []);
        if (!apR.ok || !apR.ret || apR.ret.isNull()) return null;
        var y = apR.ret.add(4).readFloat();
        info("[v3][Credit] キャスト Left 容器 anchoredPosition y=" + y.toFixed(0) + " → 滚动距离 " + (-y).toFixed(0) + "px");
        return -y;
    } catch (e) { warn("[v3][Credit] castLeadOffsetPx err: " + e); return null; }
}
function stopStills() {
    try {
        if (comp.stillTimer) { clearInterval(comp.stillTimer); comp.stillTimer = null; }
        for (var i = 0; i < (comp.stills || []).length; i++) setStillAlpha(comp.stills[i], 0);
        comp.stillState = "idle";
    } catch (e) {}
}

// ============ phase=1: staff 滚动 ============
function doStaff() {
    try {
        if (!creditState.armed) { writeVar("g_staffDuration", 3); return; }   // 未 arm (存档回放防御): 安全时长跳过
        if (!ensureScroll()) {
            warn("[v3][Credit] phase=1 跳过: rollScroll 未捕获/失效 (见上方捕获诊断)");
            writeVar("g_staffDuration", 3);
            return;
        }
        var lines = staffLinesForLocale();
        var hasItems = !!(creditState.json && creditState.json.staff && Array.isArray(creditState.json.staff.items) && creditState.json.staff.items.length);
        if (!lines.length && !hasItems) { warn("[v3][Credit] phase=1 跳过: json.staff 无可用语种内容"); writeVar("g_staffDuration", 3); return; }
        // run-27: 速度优先用原版 director._scrollSpeed (序列化配置), 无则 data.json speed, 再兜底 60
        var timing = readDirectorTiming();
        var speed = (timing && timing.speed > 0) ? timing.speed
            : ((creditState.json.staff && creditState.json.staff.speed > 0) ? creditState.json.staff.speed : 60);
        var endPause = (creditState.json.staff && creditState.json.staff.endPause >= 0) ? creditState.json.staff.endPause : 2;
        var ks = A.ogc(comp.rollScroll);
        // 1. 启用 (F1): roll 自身 + 祖先链
        invoke(cgmChain(ks, "SetGameObjectActive", 1), comp.rollScroll, [boolPtr(true)]);
        invoke(cgmChain(ks, "SetCanvasEnabled", 1), comp.rollScroll, [boolPtr(true)]);
        ensureHierarchy();
        ensureCanvasRenderable();   // run-10: sortingOrder 抬高 + 相机兜底 (alpha=1 后仍不可见的嫌疑)
        var cb = dcBool(cgmChain(A.ogc(comp.canvas), "get_isActiveAndEnabled", 0), comp.canvas);
        // 2. 标签填充 (run-11 重写): zh-Hans 时按标签名识别当前语种标签 → 只填它, 其余停用+清空
        //   (run-10 实证: prefab 默认 3 标签全 active → 全填 = 3 份文本叠印/错位 = "字的位置有问题"根因;
        //   原版只激活当前语种标签)。识别失败回退全填 (保持原行为)。
        if (!comp.labels.length) enumerateLabels();
        if (!comp.labels.length) { warn("[v3][Credit] phase=1 跳过: content 下无 TMP 标签"); writeVar("g_staffDuration", 3); return; }
        var text = lines.join("\n");
        var isZh = getCurrentLocale() === "zh-Hans";
        // run-26: 逐条目复刻 — data.json staff.items [{key,text}] → 按 key 匹配填充各条目标签
        //   (原版演出 = Content 下 222 个条目标签各填各的静态文本, 整体滚动 — 不再整段全填叠印。
        //   key = "{grand}|{entry}|{suffix}": grand=Content 直接子级, entry=条目容器, suffix=Label 名后缀
        //   (Label→'', Label_1→'_1') — 与 build_credit_data.py label_suffix 同一规则)
        var itemMap = null;
        if (creditState.json && creditState.json.staff && Array.isArray(creditState.json.staff.items) && creditState.json.staff.items.length) {
            itemMap = {};
            for (var mi = 0; mi < creditState.json.staff.items.length; mi++) {
                var it = creditState.json.staff.items[mi];
                if (it && it.key !== undefined) itemMap[it.key] = it.text;
            }
            info("[v3][Credit] staff 逐条目模式: " + creditState.json.staff.items.length + " 条 key 映射");
        } else {
            warn("[v3][Credit] staff 非 items 格式 — 回退旧单标签模式 (需 fillIdx)");
        }
        var fillIdx = -1;
        if (!itemMap && isZh) {
            for (var i = 0; i < comp.labels.length; i++) {
                var ln = ((comp.labels[i].name || "") + "|" + (comp.labels[i].parent || "")).toLowerCase();
                if (ln.indexOf("zh") >= 0 || ln.indexOf("han") >= 0 || ln.indexOf("chinese") >= 0 || ln.indexOf("简") >= 0 || ln.indexOf("中") >= 0) { fillIdx = i; break; }
            }
            if (fillIdx < 0) {
                // run-14: 名字/父名均无语种标识 (run-13 实证 Label/Roll_49,Label/Name_50,Label/Name_34) —
                // 不再回退全填 (3 份叠印根因), 顺序假设 prefab 标签槽 = [Ja, ZhHans, En] → zh=index 1。
                // 风险: 槽顺序未知 — 同时打颜色/位置诊断 (见下), 若假设错按诊断校准。
                if (comp.labels.length === 3) {
                    fillIdx = 1;
                    warn("[v3][Credit] zh-Hans staff 标签顺序假设 [Ja,ZhHans,En] → 只填 #1 (run-13: 名字/父名无语种标识; 诊断见下)");
                } else {
                    warn("[v3][Credit] zh-Hans 但 staff 标签名无法识别语种 且标签数=" + comp.labels.length + " ≠3 — 回退全填 (标签名+父: " + comp.labels.map(function (l) { return (l.name || "?") + "/" + (l.parent || "?"); }).join(",") + ")");
                }
            }
        }
        // run-14: 语种/位置诊断 — 每个标签 TMP get_color (HFA 16B, invoke 缓冲直读) + RectTransform anchoredPosition
        //   用途: 校准顺序假设 + 复刻原版排版 (颜色差异=prefab 槽配置 [A,B,B])
        {
            var colorInfo = [], posInfo = [];
            for (var di = 0; di < comp.labels.length; di++) {
                try {
                    var tmpD = comp.labels[di].tmp;
                    var colMi = cgmChain(A.ogc(tmpD), "get_color", 0);
                    var colR = invokeOk(colMi, tmpD, []);
                    if (colR.ok && colR.ret && !colR.ret.isNull()) {
                        colorInfo.push("#" + di + "=(" + colR.ret.readFloat().toFixed(2) + "," + colR.ret.add(4).readFloat().toFixed(2) + "," + colR.ret.add(8).readFloat().toFixed(2) + "," + colR.ret.add(12).readFloat().toFixed(2) + ")");
                    } else colorInfo.push("#" + di + "=?");
                    var rtMi = cgmChain(A.ogc(tmpD), "get_rectTransform", 0);
                    var rtR = invokeOk(rtMi, tmpD, []);
                    if (rtR.ok && rtR.ret && !rtR.ret.isNull()) {
                        var apMi = cgmChain(A.ogc(rtR.ret), "get_anchoredPosition", 0);
                        var apR = invokeOk(apMi, rtR.ret, []);
                        if (apR.ok && apR.ret && !apR.ret.isNull()) {
                            posInfo.push("#" + di + "=(" + apR.ret.readFloat().toFixed(1) + "," + apR.ret.add(4).readFloat().toFixed(1) + ")");
                        } else posInfo.push("#" + di + "=?");
                    }
                } catch (e) {}
            }
            dbg("[v3][Credit] staff 标签诊断 color[" + colorInfo.join(" | ") + "] pos[" + posInfo.join(" | ") + "]");
        }
        // run-14: 字体换装来源改"完整简中动态字体" — run-13 实证 SpecialThanks_ZhHans 是静态子集字体
        //   (只含原版 zh 致谢文本字符 → "自动化"→"自化"、剧本全没、魔女裁判 MOD 制作→魔女 MOD; 缺字空白不渲染);
        //   TsukushiMincho 是动态字体但无简中字形 (缺字 □)。遍历全部 TMP_FontAsset 资产,
        //   名字启发式: 排除 tsukushi/specialthanks, 命中 noto|source.?han|heiti|songti|pingfang|hiragino|思源|黑体|宋体|简 选第一个。
        var zhFont = null;
        if (isZh) {
            if (!cls.tmpFontAsset || cls.tmpFontAsset.isNull()) cls.tmpFontAsset = findClassAcrossImages("TMPro", "TMP_FontAsset");
            if (cls.tmpFontAsset && !cls.tmpFontAsset.isNull()) {
                try {
                    var allF = findAllObjectOfType(cls.tmpFontAsset);
                    var namesF = [], pickedF = null, pickedNameF = null;
                    for (var fi = 0; fi < allF.length; fi++) {
                        var fnR = invokeOk(cgmChain(A.ogc(allF[fi]), "get_name", 0), allF[fi], []);
                        var fnm = (fnR.ok && fnR.ret && !fnR.ret.isNull()) ? (readStr(fnR.ret) || "?") : "?";
                        namesF.push(fnm);
                        var low = fnm.toLowerCase();
                        if (low.indexOf("tsukushi") >= 0 || low.indexOf("specialthanks") >= 0) continue;
                        if (/(noto|source.?han|heiti|songti|pingfang|hiragino|思源|黑体|宋体|简)/.test(low) && !pickedF) { pickedF = allF[fi]; pickedNameF = fnm; }
                    }
                    info("[v3][Credit] TMP_FontAsset 资产 " + allF.length + " 个: " + namesF.join(", "));
                    if (pickedF) { zhFont = pickedF; info("[v3][Credit] zh 字体选中: " + pickedNameF); }
                    else warn("[v3][Credit] 完整简中字体未找到 (名单见上) — 回退 thanks zh 标签字体");
                } catch (e) { warn("[v3][Credit] 字体资产枚举 err: " + e); }
            }
            if (!zhFont) {
                // 兜底: thanks zh 标签的字体 (静态子集, 可能缺字 — 但比 TsukushiMincho 强)
                if (!comp.thanksByLocale || !Object.keys(comp.thanksByLocale).length) { ensureThanks(); enumerateThanksLabels(); }
                var zl = comp.thanksByLocale ? comp.thanksByLocale[2] : null;
                if (zl && zl.tmp) {
                    var zf = invokeOk(cgmChain(A.ogc(zl.tmp), "get_font", 0), zl.tmp, []);
                    if (zf.ok && zf.ret && !zf.ret.isNull()) zhFont = zf.ret;
                }
                if (zhFont) warn("[v3][Credit] zh 字体回退: SpecialThanks_ZhHans (静态子集, 可能缺字)");
                else warn("[v3][Credit] zh 字体偷取失败 (thanks zh 标签不可得) — staff 保持原字体");
            }
        }
        var setT = cgmChain(A.ogc(comp.labels[0].tmp), "set_text", 1);
        var setF = isZh ? cgmChain(A.ogc(comp.labels[0].tmp), "set_font", 1) : null;
        var filled = 0, cleared = 0, matchedCount = 0, swappedCount = 0;
        deactivatedLabels = [];
        for (var i = 0; i < comp.labels.length; i++) {
            var lb = comp.labels[i];
            var fillText = null;
            if (itemMap) {
                // run-26: 逐条目 key 匹配 (grand|entry|suffix) — 命中填该条目标签的静态文本, 未命中清空+停用
                var key = (lb.grand || "") + "|" + (lb.parent || "") + "|" + labelSuffix(lb.name);
                if (itemMap[key] !== undefined) { fillText = itemMap[key]; matchedCount++; }
            } else {
                // 回退: 旧单标签模式
                if (fillIdx >= 0 ? (i === fillIdx) : lb.active) fillText = text;
            }
            var r = invokeOk(setT, lb.tmp, [makeS(fillText !== null ? fillText : "")]);
            if (fillText !== null) {
                filled++;
                if (zhFont && setF) {
                    var fr = invokeOk(setF, lb.tmp, [zhFont]);
                    if (!fr.ok) warn("[v3][Credit] set_font #" + i + " FAIL");
                    else swappedCount++;   // 逐条换装不再打日志 (222 条刷屏) — 循环后汇总
                } else if (isZh && lb.font && lb.font.indexOf("Tsukushi") >= 0) {
                    warn("[v3][Credit] zh-Hans 文本写入标签 #" + i + " 但字体=" + lb.font + " (TsukushiMincho 无简中字形 → 可能显示 □)");
                }
                if (lb.go && !lb.active) {
                    invoke(cgmChain(A.ogc(lb.go), "SetActive", 1), lb.go, [boolPtr(true)]);
                }
            } else {
                cleared++;
                if (lb.go && lb.active) {
                    invoke(cgmChain(A.ogc(lb.go), "SetActive", 1), lb.go, [boolPtr(false)]);
                    deactivatedLabels.push(lb.go);
                }
            }
            if (!r.ok) warn("[v3][Credit] set_text #" + i + " FAIL");
        }
        info("[v3][Credit] staff 文本写入: " + filled + " 填 / " + cleared + " 清 (items 匹配 " + matchedCount + "/" + (itemMap ? Object.keys(itemMap).length : 0) + ", 标签 " + comp.labels.length + " 个, 字体换装 " + swappedCount + " 个, speed=" + speed + ", canvas active=" + cb + ")");
        // 3. 同步强制布局 (N1): set_text 只标记 MarkLayoutForRebuild
        invoke(cgmChain(cls.layoutRebuilder, "ForceRebuildLayoutImmediate", 1), ptr(0), [comp.content]);
        invoke(cgmChain(cls.canvas, "ForceUpdateCanvases", 0), ptr(0), []);
        // 4. 位置归零 (R2/N2): 优先 setter
        invoke(A.cgm(cls.scrollRect, Memory.allocUtf8String("set_verticalNormalizedPosition"), 1), comp.scrollRect, [fPtr(1.0)]);
        // run-27: still 时序 — 布局强制后 (anchoredPosition 才有效)。原版锚点 = 硬编码 delayUnits 拍数
        //   (实读: delay=18拍 → 18×60/88 ≈ 12.3s — 正是 Full 大条目滚完、キャスト 出现的时间);
        //   キャスト 偏移 (Left 容器 y/speed) 作校验日志, 取 max 兜底 (キャスト 未出现前不显示图)
        var castOff = castLeadOffsetPx();
        var castDelayMs = (castOff && castOff > 0) ? (castOff / speed * 1000) : 0;
        var fadeMs = 2000, dispMs = 26000, unitsDelayMs = 0;
        if (timing && timing.bpm > 0) {
            var beat = 60 / timing.bpm;
            if (timing.delayUnits >= 0) unitsDelayMs = timing.delayUnits * beat * 1000;
            if (timing.fadeUnits >= 0) fadeMs = Math.max(200, timing.fadeUnits * beat * 1000);
            if (timing.displayUnits >= 0) dispMs = Math.max(1000, timing.displayUnits * beat * 1000);
        }
        var stillDelayMs = Math.max(unitsDelayMs, castDelayMs, 1000);
        info("[v3][Credit] still 时序: units delay=" + (unitsDelayMs / 1000).toFixed(1) + "s キャスト="
            + (castDelayMs / 1000).toFixed(1) + "s → 取 " + (stillDelayMs / 1000).toFixed(1)
            + "s, fade " + (fadeMs / 1000).toFixed(1) + "s display " + (dispMs / 1000).toFixed(1)
            + "s (bpm=" + (timing && timing.bpm ? timing.bpm.toFixed(1) : "?") + ")");
        showStills(stillDelayMs, fadeMs, dispMs);
        // 5. 高度断言 (N1)
        var h = dcFloat(cgmChain(ks, "get_ContentHeight", 0), comp.rollScroll);
        if (!(h > 0)) { warn("[v3][Credit] phase=1 跳过: content 高度=" + h + " (布局未生效?)"); writeVar("g_staffDuration", 3); return; }
        if (h > 60000) warn("[v3][Credit] content 高度异常大 (" + h.toFixed(0) + "px) — 远超原版规格 ~29.5k, 可能残留叠印文本");
        // 6. 时长单一来源 (F2/R3): duration=高度/speed; g_staffDuration=滚动+endPause
        var dur = h / speed;
        var total = dur + endPause;
        writeVar("g_staffDuration", total);
        info("[v3][Credit] staff: 高度=" + h.toFixed(0) + "px duration=" + dur.toFixed(1) + "s g_staffDuration=" + total.toFixed(1) + "s");
        // 7. ScrollAsync fire-and-forget (F8: default token, UniTask 丢弃)
        var saMi = A.cgm(ks, Memory.allocUtf8String("ScrollAsync"), 2);
        var sr = invokeOk(saMi, comp.rollScroll, [fPtr(dur), zeroCT()]);
        if (!sr.ok) warn("[v3][Credit] ScrollAsync FAIL");
        else info("[v3][Credit] ScrollAsync invoke OK");
    } catch (e) { error("[v3][Credit] doStaff err: " + e); writeVar("g_staffDuration", 3); }
}

// ============ phase=2 (原版复刻模式): 直接调原版 CreditsUI.PlayAsync(2) ============
// run-15: 原版 @credit 2 全链路复刻 (dump.cs 实证):
//   nani "@credit 2" → ShowCreditsUi{ActNumber=2, Wait} (CommandAlias("credit"), dump.cs:477868)
//     → Execute → CreditsUI.PlayAsync(act=2, AsyncToken) (dump.cs:481423 Slot 96)
//     → _creditsDirectors[2] (CreditsDirectorAct2) → 遍历 _creditRolls 逐个 ScrollAsync/ShowAsync
//     → 播完 goto EndLabelName (# EndCredits2) — NaniScriptPlayer
//   AsyncToken = {CancellationToken@0x0, CancellationToken@0x8} (32B 结构体, dump.cs:142681);
//   全零 = CancellationToken.None ×2 (永不取消) — 与 op_Implicit(CancellationToken.None) 语义一致
// run-23: 主线程 PlayAsync 泵 — pendingPlay 由 doOriginal 设置 (Preload 后挂起),
//   onSVV (g_creditTick) 在主线程同步 hook 里检查资产填充 → doPlayAsyncInvoke 完成 PlayAsync
// ============ 素材提取 (run-24): 原版致谢素材 → mod 文件夹 (TestCredit/Assets/) ============
//   trigger "extract" → doOriginal 全流程 (Preload+Play) → doPlayAsyncInvoke 成功后 extractStep()
//   (PlayAsync 后仍在主线程同步 hook 内, 所有 invoke 安全) → 写出:
//     Assets/stills/still{i}.png   原版 EndingStill 图片 (Sprite → Texture2D → GetPixels32 → PNG)
//     Assets/credit-assets.json    specialthanks 名单 + staff 当前屏快照 + stills 时序参数
//     Assets/staff.json            staff 完整滚动文本 (hook TMP set_text 全演出期收集 — run-24-4:
//                                  滚动块每屏复用 TMP, 任意时刻只能抓到当前屏, 必须全程收集)
//[run-25-废弃] var staffHookAttached = false;
//[run-25-废弃] var collectedStaff = [];
//[run-25-废弃] var staffSeen = {};
//[run-25-废弃] var fullTexCache = {};   // run-24-5: atlas 全图缓存 (tex指针 → {w,h,rgba}) — 多张 still 共享纹理, 只读一次
//[run-25-废弃] var staffPollTimer = null;   // run-24-6: 轮询兜底 — 文本无论如何设置 (set_text/SetText/字段直写),
//[run-25-废弃] var staffPollTmps = [];      //   滚动块 TMP 的 m_text@0xE0 字段最终必然有值 → 采样收集兜底
//[run-25-废弃] var staffPolling = false;
//[run-25-废弃] function installStaffHook() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (staffHookAttached) return;
//[run-25-废弃]         // run-24-6: 双 hook — set_text (property setter, virtual) + SetText(string) (非 virtual 直调)。
//[run-25-废弃]         //   上一轮 set_text 零捕获 → 滚动块文本可能直接走 SetText(string); 去重由 staffSeen 保证。
//[run-25-废弃]         var hookFns = [];
//[run-25-废弃]         var mi = null;
//[run-25-废弃]         if (cls.tmpText && !cls.tmpText.isNull()) mi = A.cgm(cls.tmpText, Memory.allocUtf8String("set_text"), 1);
//[run-25-废弃]         if (!mi || mi.isNull()) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var uguiCls = findClassAcrossImages("TMPro", "TextMeshProUGUI");
//[run-25-废弃]                 if (uguiCls && !uguiCls.isNull()) mi = A.cgm(uguiCls, Memory.allocUtf8String("set_text"), 1);
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }
//[run-25-废弃]         var mi2 = null;
//[run-25-废弃]         if (cls.tmpText && !cls.tmpText.isNull()) mi2 = A.cgm(cls.tmpText, Memory.allocUtf8String("SetText"), 1);
//[run-25-废弃]         if (!mi2 || mi2.isNull()) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var ugui2 = findClassAcrossImages("TMPro", "TextMeshProUGUI");
//[run-25-废弃]                 if (ugui2 && !ugui2.isNull()) mi2 = A.cgm(ugui2, Memory.allocUtf8String("SetText"), 1);
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }
//[run-25-废弃]         var onEnterFn = function (a) {
//[run-25-废弃]             try {
//[run-25-废弃]                 var s = readStr(a[1]);   // a[0]=this TMP, a[1]=string*
//[run-25-废弃]                 if (!s || s.length < 2 || s.length > 500) return;
//[run-25-废弃]                 var key = a[0].toString() + "|" + s;   // 按组件+文本去重 (滚动复用同一 TMP 多屏文本都收)
//[run-25-废弃]                 if (staffSeen[key]) return;
//[run-25-废弃]                 staffSeen[key] = true;
//[run-25-废弃]                 collectedStaff.push({ go: a[0].toString(), text: s });
//[run-25-废弃]             } catch (e2) {}
//[run-25-废弃]         };
//[run-25-废弃]         if (mi && !mi.isNull() && !mi.readPointer().isNull()) {
//[run-25-废弃]             Interceptor.attach(mi.readPointer(), { onEnter: onEnterFn });
//[run-25-废弃]             hookFns.push("set_text");
//[run-25-废弃]         }
//[run-25-废弃]         if (mi2 && !mi2.isNull() && !mi2.readPointer().isNull()) {
//[run-25-废弃]             Interceptor.attach(mi2.readPointer(), { onEnter: onEnterFn });
//[run-25-废弃]             hookFns.push("SetText");
//[run-25-废弃]         }
//[run-25-废弃]         if (!hookFns.length) { warn("[v3][Credit] staff hook: TMP set_text/SetText 均 NOT FOUND"); return; }
//[run-25-废弃]         staffHookAttached = true;
//[run-25-废弃]         info("[v3][Credit] staff hook 已挂 (TMP " + hookFns.join("+") + " 全演出期收集)");
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] installStaffHook err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function flushStaffJson() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (!creditState.extract || !creditState.original) return;
//[run-25-废弃]         if (staffPollTimer) { clearInterval(staffPollTimer); staffPollTimer = null; }   // run-24-6: 停轮询再落盘
//[run-25-废弃]         if (!collectedStaff.length) { warn("[v3][Credit] staff 收集为空 — hook 零捕获且轮询零采样 (或演出异常)"); return; }
//[run-25-废弃]         writeFileBytes(extractOutRoot() + "/staff.json", new Uint8Array(utf8Bytes(JSON.stringify(collectedStaff, null, 1))));
//[run-25-废弃]         info("[v3][Credit] staff.json 已写出 (" + collectedStaff.length + " 条文本)");
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] flushStaffJson err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] // run-24-6: staff 轮询兜底 — 主线程 (extractStep 内) 缓存滚动块全部 TMP 组件指针,
//[run-25-废弃] //   JS 线程 300ms 采样 m_text@0xE0 (TMP_Text 受保护字段, dump.cs 实证) — 纯内存读零 Unity API,
//[run-25-废弃] //   任何设置路径 (set_text/SetText/字段直写) 最终都体现在 m_text 字段 → 采样必得。
//[run-25-废弃] //   组件被回收/销毁 → 读崩 → try/catch 跳过 (不崩游戏)。
//[run-25-废弃] function installStaffPoll() {
//[run-25-废弃]     try {
//[run-25-废弃]         if (staffPolling || !comp.director || comp.director.isNull()) return;
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var rolls = d.add(0x60).readPointer();
//[run-25-废弃]         if (!rolls || rolls.isNull()) return;
//[run-25-废弃]         var n = rolls.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) return;
//[run-25-废弃]         var list = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var roll = rolls.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!roll || roll.isNull()) continue;
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(roll), "get_gameObject", 0), roll, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) continue;
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
//[run-25-废弃]             if (!comps.ok || !comps.ret || comps.ret.isNull()) continue;
//[run-25-废弃]             var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]             for (var ci = 0; ci < clen && ci < 64; ci++) {
//[run-25-废弃]                 var t = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                 if (t && !t.isNull()) list.push(t);
//[run-25-废弃]             }
//[run-25-废弃]         }
//[run-25-废弃]         if (!list.length) { warn("[v3][Credit] staffPoll: 未找到滚动 TMP 组件"); return; }
//[run-25-废弃]         staffPollTmps = list;
//[run-25-废弃]         staffPolling = true;
//[run-25-废弃]         info("[v3][Credit] staffPoll 已启动 (" + list.length + " 个 TMP 组件, 300ms 采样 m_text)");
//[run-25-废弃]         staffPollTimer = setInterval(function () {
//[run-25-废弃]             try {
//[run-25-废弃]                 for (var i = 0; i < staffPollTmps.length; i++) {
//[run-25-废弃]                     var t = staffPollTmps[i];
//[run-25-废弃]                     if (!t || t.isNull()) continue;
//[run-25-废弃]                     var s = readStr(t.add(0xE0).readPointer());
//[run-25-废弃]                     if (!s || s.length < 2 || s.length > 500) continue;
//[run-25-废弃]                     var key = t.toString() + "|" + s;
//[run-25-废弃]                     if (staffSeen[key]) continue;
//[run-25-废弃]                     staffSeen[key] = true;
//[run-25-废弃]                     collectedStaff.push({ go: t.toString(), text: s });
//[run-25-废弃]                 }
//[run-25-废弃]             } catch (e) {}
//[run-25-废弃]         }, 300);
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] installStaffPoll err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function extractOutRoot() {
//[run-25-废弃]     try {
//[run-25-废弃]         var root = (typeof MOD_ROOT !== "undefined" && MOD_ROOT) ? MOD_ROOT : null;
//[run-25-废弃]         if (root) return root + "/TestCredit/Assets";
//[run-25-废弃]         var p = Process.mainModule.path;   // 兜底: 从二进制路径推导 Steam 游戏目录
//[run-25-废弃]         return p.replace(/\/manosaba\.app.*$/, "").replace(/\/[^\/]+$/, "") + "/ManosabaMod/TestCredit/Assets";
//[run-25-废弃]     } catch (e) { return "/tmp/manosaba-credit-extract"; }
//[run-25-废弃] }
//[run-25-废弃] function mkdirs(path) {
//[run-25-废弃]     try {
//[run-25-废弃]         // run-24-2: 用 findGlobalExportByName (io.js 实证可用; findExportByName 在 bundle 内被遮蔽报 TypeError)
//[run-25-废弃]         var mk = new NativeFunction(Module.findGlobalExportByName("mkdir"), "int", ["pointer", "int"]);
//[run-25-废弃]         var parts = path.split("/");
//[run-25-废弃]         var cur = path[0] === "/" ? "/" : "";
//[run-25-废弃]         for (var i = 0; i < parts.length; i++) {
//[run-25-废弃]             if (!parts[i]) continue;
//[run-25-废弃]             cur += parts[i];
//[run-25-废弃]             mk(Memory.allocUtf8String(cur), 0x1ED);   // 0755; 已存在 EEXIST 无害
//[run-25-废弃]             cur += "/";
//[run-25-废弃]         }
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] mkdirs err: " + e); }
//[run-25-废弃] }
//[run-25-废弃] function writeFileBytes(path, u8) {
//[run-25-废弃]     try {
//[run-25-废弃]         // run-24-2: 裸字节写走 io.js getIO (open/write/close 系统调用绑定, Darwin flags 同 openForWrite)
//[run-25-废弃]         var io = getIO();
//[run-25-废弃]         if (!io || !io.open || !io.write || !io.close) { warn("[v3][Credit] writeFileBytes: io 不可用"); return false; }
//[run-25-废弃]         var fd = io.open(Memory.allocUtf8String(path), 0x0001 | 0x0200 | 0x0400, 0o644);   // O_WRONLY|O_CREAT|O_TRUNC
//[run-25-废弃]         if (fd < 0) { warn("[v3][Credit] 写入失败 (open): " + path); return false; }
//[run-25-废弃]         var buf = Memory.alloc(u8.length);
//[run-25-废弃]         buf.writeByteArray(u8);
//[run-25-废弃]         var got = 0, r = 0;
//[run-25-废弃]         while (got < u8.length) {
//[run-25-废弃]             r = io.write(fd, buf.add(got), u8.length - got);   // 部分写入循环, r<=0 兜底
//[run-25-废弃]             if (r <= 0) break;
//[run-25-废弃]             got += r;
//[run-25-废弃]         }
//[run-25-废弃]         io.close(fd);
//[run-25-废弃]         // run-24-7: 实测 open mode 参数落盘权限异常 (0o644 → 0o350, 连 owner 都不可读) —
//[run-25-废弃]         //   chmod 硬补 0644, 保证 IDE/用户可读 (staff.json NoPermissions 根因)
//[run-25-废弃]         try {
//[run-25-废弃]             var ch = Module.findGlobalExportByName("chmod");
//[run-25-废弃]             if (ch) new NativeFunction(ch, "int", ["pointer", "int"])(Memory.allocUtf8String(path), 0o644);
//[run-25-废弃]         } catch (e2) { warn("[v3][Credit] chmod err: " + e2); }
//[run-25-废弃]         info("[v3][Credit] 已写出: " + path + " (" + got + "/" + u8.length + "B)");
//[run-25-废弃]         return got >= u8.length;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] writeFileBytes err: " + e); return false; }
//[run-25-废弃] }
//[run-25-废弃] function utf8Bytes(s) {
//[run-25-废弃]     var out = [];
//[run-25-废弃]     for (var i = 0; i < s.length; i++) {
//[run-25-废弃]         var c = s.charCodeAt(i);
//[run-25-废弃]         if (c < 0x80) out.push(c);
//[run-25-废弃]         else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
//[run-25-废弃]         else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) {
//[run-25-废弃]             var cp = 0x10000 + ((c - 0xD800) << 10) + (s.charCodeAt(i + 1) - 0xDC00);
//[run-25-废弃]             out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); i++;
//[run-25-废弃]         } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
//[run-25-废弃]     }
//[run-25-废弃]     return out;
//[run-25-废弃] }
//[run-25-废弃] // PNG 编码 (RGBA8 → stored-deflate zlib, 无依赖纯 JS) — 返回 Uint8Array
//[run-25-废弃] function pngEncodeRGBA(w, h, rgba) {
//[run-25-废弃]     var crcT = new Int32Array(256);
//[run-25-废弃]     for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcT[n] = c; }
//[run-25-废弃]     function crc32(b, off, len) { var c = 0xFFFFFFFF; for (var i = 0; i < len; i++) c = crcT[(c ^ b[off + i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
//[run-25-废弃]     function adler32(b, off, len) { var a = 1, d = 0; for (var i = 0; i < len; i++) { a = (a + b[off + i]) % 65521; d = (d + a) % 65521; } return ((d << 16) | a) >>> 0; }
//[run-25-废弃]     // 行过滤字节 + 垂直翻转 (GetPixels32 底部行优先 → PNG 顶部行优先)
//[run-25-废弃]     var stride = 1 + w * 4;
//[run-25-废弃]     var raw = new Uint8Array(stride * h);
//[run-25-废弃]     for (var y = 0; y < h; y++) {
//[run-25-废弃]         var src = (h - 1 - y) * w * 4, rOff = y * stride;
//[run-25-废弃]         raw[rOff] = 0;
//[run-25-废弃]         raw.set(rgba.subarray(src, src + w * 4), rOff + 1);
//[run-25-废弃]     }
//[run-25-废弃]     // stored deflate (0x78 0x01): 64KB 分块, 每块 5B 头
//[run-25-废弃]     var chunks = Math.ceil(raw.length / 65535);
//[run-25-废弃]     var idat = new Uint8Array(2 + chunks * 5 + raw.length + 4);
//[run-25-废弃]     idat[0] = 0x78; idat[1] = 0x01;
//[run-25-废弃]     var o = 2, pos = 0;
//[run-25-废弃]     for (var c = 0; c < chunks; c++) {
//[run-25-废弃]         var ln = Math.min(65535, raw.length - pos);
//[run-25-废弃]         var fin = (pos + ln >= raw.length) ? 1 : 0;
//[run-25-废弃]         idat[o++] = fin; idat[o++] = ln & 0xFF; idat[o++] = (ln >> 8) & 0xFF;
//[run-25-废弃]         idat[o++] = (~ln) & 0xFF; idat[o++] = ((~ln) >> 8) & 0xFF;
//[run-25-废弃]         idat.set(raw.subarray(pos, pos + ln), o); o += ln; pos += ln;
//[run-25-废弃]     }
//[run-25-废弃]     var ad = adler32(raw, 0, raw.length);
//[run-25-废弃]     idat[o++] = (ad >> 24) & 0xFF; idat[o++] = (ad >> 16) & 0xFF; idat[o++] = (ad >> 8) & 0xFF; idat[o] = ad & 0xFF;
//[run-25-废弃]     function chunk(type, data) {
//[run-25-废弃]         var b = new Uint8Array(12 + data.length);
//[run-25-废弃]         b[0] = (data.length >> 24) & 0xFF; b[1] = (data.length >> 16) & 0xFF; b[2] = (data.length >> 8) & 0xFF; b[3] = data.length & 0xFF;
//[run-25-废弃]         b[4] = type.charCodeAt(0); b[5] = type.charCodeAt(1); b[6] = type.charCodeAt(2); b[7] = type.charCodeAt(3);
//[run-25-废弃]         b.set(data, 8);
//[run-25-废弃]         var cb = new Uint8Array(4 + data.length);
//[run-25-废弃]         cb.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 0);
//[run-25-废弃]         cb.set(data, 4);
//[run-25-废弃]         var crc = crc32(cb, 0, cb.length);
//[run-25-废弃]         b[8 + data.length] = (crc >> 24) & 0xFF; b[9 + data.length] = (crc >> 16) & 0xFF;
//[run-25-废弃]         b[10 + data.length] = (crc >> 8) & 0xFF; b[11 + data.length] = crc & 0xFF;
//[run-25-废弃]         return b;
//[run-25-废弃]     }
//[run-25-废弃]     var ihdr = new Uint8Array([(w >> 24) & 0xFF, (w >> 16) & 0xFF, (w >> 8) & 0xFF, w & 0xFF, (h >> 24) & 0xFF, (h >> 16) & 0xFF, (h >> 8) & 0xFF, h & 0xFF, 8, 6, 0, 0, 0]);
//[run-25-废弃]     var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
//[run-25-废弃]     var ih = chunk("IHDR", ihdr), id = chunk("IDAT", idat), ie = chunk("IEND", new Uint8Array(0));
//[run-25-废弃]     var png = new Uint8Array(sig.length + ih.length + id.length + ie.length);
//[run-25-废弃]     png.set(sig, 0); png.set(ih, 8); png.set(id, 8 + ih.length); png.set(ie, 8 + ih.length + id.length);
//[run-25-废弃]     return png;
//[run-25-废弃] }
//[run-25-废弃] // SpecialThanks 名单: _specialThanksCredits@0xA0 = Dictionary<LocaleKind, string[][]>
//[run-25-废弃] //   (IL2CPP 字典布局实锤 choice.js: m_entries@0x18, Entry stride 24, 空槽 hashCode==-1)
//[run-25-废弃] function extractDictSpecialThanks() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         if (!d || d.isNull()) { warn("[v3][Credit] extract: 无 director"); return null; }
//[run-25-废弃]         var dict = d.add(0xA0).readPointer();
//[run-25-废弃]         if (!dict || dict.isNull()) { warn("[v3][Credit] extract: _specialThanksCredits=null"); return null; }
//[run-25-废弃]         var ents = dict.add(0x18).readPointer();
//[run-25-废弃]         if (!ents || ents.isNull()) { warn("[v3][Credit] extract: m_entries 不可得"); return null; }
//[run-25-废弃]         var al = ents.add(0x18).readS32();
//[run-25-废弃]         if (al < 0 || al > 64) { warn("[v3][Credit] extract: entries 数量异常 " + al); return null; }
//[run-25-废弃]         var names = ["ja", "en-US", "zh-Hans", "zh-Hant", "ko", "fr", "es"];
//[run-25-废弃]         var out = { order: [] };
//[run-25-废弃]         for (var e = 0; e < al; e++) {
//[run-25-废弃]             var eb = ents.add(0x20 + e * 24);
//[run-25-废弃]             if (eb.readS32() === -1) continue;          // 空槽
//[run-25-废弃]             var key = eb.add(8).readS32();              // LocaleKind
//[run-25-废弃]             if (key < 0 || key > 6) continue;
//[run-25-废弃]             var val = eb.add(0x10).readPointer();       // string[][]
//[run-25-废弃]             if (!val || val.isNull()) continue;
//[run-25-废弃]             var glen = val.add(0x18).readS32();
//[run-25-废弃]             if (glen < 0 || glen > 500) { warn("[v3][Credit] extract: 语种 '" + names[key] + "' groups 异常 " + glen); continue; }
//[run-25-废弃]             var groups = [];
//[run-25-废弃]             for (var g = 0; g < glen; g++) {
//[run-25-废弃]                 var arr = val.add(0x20 + g * 8).readPointer();
//[run-25-废弃]                 if (!arr || arr.isNull()) continue;
//[run-25-废弃]                 var alen = arr.add(0x18).readS32();
//[run-25-废弃]                 if (alen < 0 || alen > 200) continue;
//[run-25-废弃]                 var lines = [];
//[run-25-废弃]                 for (var l = 0; l < alen; l++) {
//[run-25-废弃]                     var s = arr.add(0x20 + l * 8).readPointer();
//[run-25-废弃]                     if (s && !s.isNull()) lines.push(readStr(s));
//[run-25-废弃]                 }
//[run-25-废弃]                 groups.push(lines);
//[run-25-废弃]             }
//[run-25-废弃]             out[names[key]] = { label: "原版 SpecialThanks (" + names[key] + ")", groups: groups };
//[run-25-废弃]             out.order.push(names[key]);
//[run-25-废弃]             info("[v3][Credit] extract: 语种 '" + names[key] + "' 提取 " + glen + " 组名单");
//[run-25-废弃]         }
//[run-25-废弃]         return out;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractDictSpecialThanks err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // stills 图片: _stills@0x58 = EndingStill[] → GameObject → GetComponentsInChildren(Image) → sprite → texture → PNG
//[run-25-废弃] function extractStillsToPng() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var stills = d.add(0x58).readPointer();
//[run-25-废弃]         if (!stills || stills.isNull()) { warn("[v3][Credit] extract: _stills=null"); return []; }
//[run-25-废弃]         var n = stills.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) { warn("[v3][Credit] extract: _stills 数量异常 " + n); return []; }
//[run-25-废弃]         mkdirs(extractOutRoot() + "/stills");
//[run-25-废弃]         var meta = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var st = stills.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!st || st.isNull()) { meta.push({ index: i, sprite: "null-instance" }); continue; }
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(st), "get_gameObject", 0), st, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) { warn("[v3][Credit] extract still#" + i + ": get_gameObject FAIL"); meta.push({ index: i, sprite: "no-go" }); continue; }
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.image)), boolPtr(true)]);
//[run-25-废弃]             var sprite = null;
//[run-25-废弃]             if (comps.ok && comps.ret && !comps.ret.isNull()) {
//[run-25-废弃]                 var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]                 for (var ci = 0; ci < clen && !sprite; ci++) {
//[run-25-废弃]                     var img = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                     if (!img || img.isNull()) continue;
//[run-25-废弃]                     var spR = invokeOk(cgmChain(A.ogc(img), "get_sprite", 0), img, []);
//[run-25-废弃]                     if (spR.ok && spR.ret && !spR.ret.isNull()) sprite = spR.ret;
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             if (!sprite) { warn("[v3][Credit] extract still#" + i + ": 无 Image/Sprite (sprite 可能尚未赋值)"); meta.push({ index: i, sprite: "none" }); continue; }
//[run-25-废弃]             var texR = invokeOk(cgmChain(A.ogc(sprite), "get_texture", 0), sprite, []);
//[run-25-废弃]             if (!texR.ok || !texR.ret || texR.ret.isNull()) { warn("[v3][Credit] extract still#" + i + ": get_texture FAIL"); meta.push({ index: i, sprite: "no-tex" }); continue; }
//[run-25-废弃]             var tex = texR.ret;
//[run-25-废弃]             var wMi = cgmChain(A.ogc(tex), "get_width", 0), hMi = cgmChain(A.ogc(tex), "get_height", 0);
//[run-25-废弃]             // get_width/get_height 返回 int — invoke 对 ≤8B 值类型返回缓冲失效 (utils 实证) → directCall
//[run-25-废弃]             var w = (wMi && !wMi.isNull()) ? directCall(wMi, "int", [tex]) : 0;
//[run-25-废弃]             var h = (hMi && !hMi.isNull()) ? directCall(hMi, "int", [tex]) : 0;
//[run-25-废弃]             if (w < 1 || h < 1 || w * h > 4096 * 4096) { warn("[v3][Credit] extract still#" + i + ": 纹理尺寸异常 " + w + "x" + h); meta.push({ index: i, size: w + "x" + h, sprite: "bad-size" }); continue; }
//[run-25-废弃]             // run-24-3: still 图片打包在 sprite atlas 里 (纹理 4096x4096) —
//[run-25-废弃]             //   get_textureRect 返回 Rect (16B HFA) invoke 缓冲不可靠 (实测读到垃圾被守卫拒绝);
//[run-25-废弃]             //   改用 sprite.get_uv (Vector2[] 引用类型, invoke 安全) 对角 UV 换算纹理像素 region。
//[run-25-废弃]             //   UV 归一化 [0,1] 原点=纹理左下, 与 GetPixels32(x,y,w,h) 坐标一致。
//[run-25-废弃]             var rx = 0, ry = 0, rw = w, rh = h;
//[run-25-废弃]             var rotMi = cgmChain(A.ogc(sprite), "GetPackingRotation", 0);   // internal int — directCall
//[run-25-废弃]             var rot = (rotMi && !rotMi.isNull()) ? directCall(rotMi, "int", [sprite]) : 0;
//[run-25-废弃]             if (rot !== 0) { warn("[v3][Credit] extract still#" + i + ": sprite 旋转打包 rotation=" + rot + " — 跳过"); meta.push({ index: i, sprite: "rotated" }); continue; }
//[run-25-废弃]             var uvR = invokeOk(cgmChain(A.ogc(sprite), "get_uv", 0), sprite, []);
//[run-25-废弃]             if (uvR.ok && uvR.ret && !uvR.ret.isNull()) {
//[run-25-废弃]                 var uvn = uvR.ret.add(0x18).readS32();
//[run-25-废弃]                 if (uvn >= 2) {
//[run-25-废弃]                     // run-24-5: tight-packed sprite 顶点序任意 (实测 uv[0]/uv[2] 相邻 → region 1x4) —
//[run-25-废弃]                     //   遍历全部 uv 顶点取包围盒 min/max (tight 和 simple 都适用)
//[run-25-废弃]                     var u0 = uvR.ret.add(0x20);
//[run-25-废弃]                     var minU = 1, minV = 1, maxU = 0, maxV = 0;
//[run-25-废弃]                     for (var k = 0; k < uvn && k < 64; k++) {
//[run-25-废弃]                         var uu = u0.add(k * 8).readFloat(), vv = u0.add(k * 8 + 4).readFloat();
//[run-25-废弃]                         if (uu < minU) minU = uu; if (uu > maxU) maxU = uu;
//[run-25-废弃]                         if (vv < minV) minV = vv; if (vv > maxV) maxV = vv;
//[run-25-废弃]                     }
//[run-25-废弃]                     if (maxU > minU && maxV > minV) {
//[run-25-废弃]                         var px0 = Math.round(minU * w), py0 = Math.round(minV * h);
//[run-25-废弃]                         var px1 = Math.round(maxU * w), py1 = Math.round(maxV * h);
//[run-25-废弃]                         if (px1 > px0 && py1 > py0 && (px1 - px0) <= 4096 && (py1 - py0) <= 4096) {
//[run-25-废弃]                             rx = px0; ry = py0; rw = px1 - px0; rh = py1 - py0;
//[run-25-废弃]                             info("[v3][Credit] extract still#" + i + ": 纹理 " + w + "x" + h + " → sprite region " + rw + "x" + rh + "@(" + rx + "," + ry + ") (uv bbox " + uvn + " 顶点)");
//[run-25-废弃]                         }
//[run-25-废弃]                     }
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             if (rw < 1 || rh < 1 || rw * rh > 2400 * 2400) { warn("[v3][Credit] extract still#" + i + ": region 尺寸异常 " + rw + "x" + rh); meta.push({ index: i, size: rw + "x" + rh, sprite: "bad-region" }); continue; }
//[run-25-废弃]             var rgba = null;
//[run-25-废弃]             // run-24-5: GetPixels32 只有 0/1 参重载 (dump.cs 实证) — 4 参不存在 (mi=0 invoke 崩 access violation 0x4c);
//[run-25-废弃]             //   必须全图 0 参 + JS 裁剪; 多张 still 共享同一 atlas 纹理 → 全图按 tex 指针缓存只读一次
//[run-25-废弃]             var ck = tex.toString();
//[run-25-废弃]             if (!fullTexCache[ck]) {
//[run-25-废弃]                 var fmi = cgmChain(A.ogc(tex), "GetPixels32", 0);
//[run-25-废弃]                 if (!fmi || fmi.isNull()) { warn("[v3][Credit] extract still#" + i + ": GetPixels32() NOT FOUND"); meta.push({ index: i, sprite: "no-pixels" }); continue; }
//[run-25-废弃]                 var fullR = invokeOk(fmi, tex, []);
//[run-25-废弃]                 if (!fullR.ok || !fullR.ret || fullR.ret.isNull() || fullR.ret.add(0x18).readS32() !== w * h) {
//[run-25-废弃]                     // run-24-6: 细化失败原因 + 不可读纹理兜底 (ReadPixels 链) — 最常见根因:
//[run-25-废弃]                     //   atlas 纹理 m_IsReadable=false → GetPixels32 抛 "not readable" (invoke 异常 → ok=false)
//[run-25-废弃]                     var why = "unknown";
//[run-25-废弃]                     try {
//[run-25-废弃]                         var rdMi2 = cgmChain(A.ogc(tex), "get_isReadable", 0);
//[run-25-废弃]                         var rd2 = (rdMi2 && !rdMi2.isNull()) ? directCall(rdMi2, "bool", [tex]) : "?";
//[run-25-废弃]                         if (!fullR.ok) {
//[run-25-废弃]                             var exc = Memory.alloc(8); exc.writePointer(ptr(0));
//[run-25-废弃]                             A.ri(fmi, tex, ptr(0), exc);   // 重调拿异常详情 (参数忽略, 只为读 exc)
//[run-25-废弃]                             var ex = exc.readPointer();
//[run-25-废弃]                             why = (!ex.isNull()) ? ("throw:" + clsName(A.ogc(ex))) : ("ok-but-invalid readable=" + rd2);
//[run-25-废弃]                         } else if (fullR.ret.isNull()) why = "null-array readable=" + rd2;
//[run-25-废弃]                         else why = "len-mismatch(" + fullR.ret.add(0x18).readS32() + "!=" + (w * h) + ") readable=" + rd2;
//[run-25-废弃]                     } catch (e3) { why = "diag-err:" + e3; }
//[run-25-废弃]                     warn("[v3][Credit] extract still#" + i + ": GetPixels32() FAIL (" + why + ") — 试 ReadPixels 兜底");
//[run-25-废弃]                     var fb = readPixelsFallback(tex, w, h);
//[run-25-废弃]                     if (!fb) {
//[run-25-废弃]                         // run-24-7: 像素不可读 (atlas Crunch 纹理实锤) — region 已拿到, 不丢:
//[run-25-废弃]                         //   图片像素由开发机 AssetRipper 解包的 atlas PNG 提供 (extract_stills.py 按 region 裁图)
//[run-25-废弃]                         warn("[v3][Credit] extract still#" + i + ": 像素提取不可行 — region " + rw + "x" + rh + "@(" + rx + "," + ry + ") 已记录 (图片=AssetRipper atlas)");
//[run-25-废弃]                         meta.push({ index: i, size: rw + "x" + rh, region: [rx, ry], sprite: "assetripper-atlas" });
//[run-25-废弃]                         continue;
//[run-25-废弃]                     }
//[run-25-废弃]                     fullTexCache[ck] = fb;
//[run-25-废弃]                     info("[v3][Credit] extract still#" + i + ": ReadPixels 兜底成功 " + fb.w + "x" + fb.h);
//[run-25-废弃]                 }
//[run-25-废弃]                 fullTexCache[ck] = { w: w, h: h, rgba: new Uint8Array(fullR.ret.add(0x20).readByteArray(w * h * 4)) };
//[run-25-废弃]                 info("[v3][Credit] extract still#" + i + ": 全图已缓存 " + w + "x" + h + " (atlas 共享)");
//[run-25-废弃]             }
//[run-25-废弃]             var full = fullTexCache[ck];
//[run-25-废弃]             rgba = new Uint8Array(rw * rh * 4);
//[run-25-废弃]             for (var yy = 0; yy < rh; yy++) {
//[run-25-废弃]                 var srcOff = ((Math.round(ry) + yy) * full.w + Math.round(rx)) * 4;
//[run-25-废弃]                 rgba.set(full.rgba.subarray(srcOff, srcOff + rw * 4), yy * rw * 4);
//[run-25-废弃]             }
//[run-25-废弃]             var png = pngEncodeRGBA(rw, rh, rgba);
//[run-25-废弃]             var ok = writeFileBytes(extractOutRoot() + "/stills/still" + i + ".png", png);
//[run-25-废弃]             meta.push({ index: i, png: "stills/still" + i + ".png", size: rw + "x" + rh, region: [rx, ry], ok: ok });
//[run-25-废弃]         }
//[run-25-废弃]         return meta;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractStillsToPng err: " + e); return []; }
//[run-25-废弃] }
// run-24-6: 不可读纹理兜底 — atlas 纹理 m_IsReadable=false 时 GetPixels32 抛异常 (实测 FAIL),
//   改走 GPU 拷贝链: GetTemporary RT → Graphics.Blit → active → Texture2D(新, 默认可读).ReadPixels →
//   ReleaseTemporary → dst.GetPixels32 (ReadPixels 已填充 CPU 侧, readable=true 必成)。
//   注意: il2cpp_runtime_invoke 的 8B 参数槽只支持指针/≤8B 值 (Rect 16B 塞不进) →
//   GetTemporary 的 (int,int) 本地写 s32 槽, ReadPixels 的 Rect 用 NativeFunction 'rect' 直调
//   (darwin 平台 CGRect 与 UnityEngine.Rect 同构); 全程 try/catch, 任何一步失败返回 null。
//[run-25-废弃] function readPixelsFallback(tex, w, h) {
//[run-25-废弃]     try {
//[run-25-废弃]         if (!cls.renderTexture || cls.renderTexture.isNull() || !cls.graphics || cls.graphics.isNull()
//[run-25-废弃]             || !cls.texture2D || cls.texture2D.isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: RenderTexture/Graphics/Texture2D 类不可得");
//[run-25-废弃]             return null;
//[run-25-废弃]         }
//[run-25-废弃]         var excBuf = function () { var e = Memory.alloc(8); e.writePointer(ptr(0)); return e; };
//[run-25-废弃]         // 1. rt = RenderTexture.GetTemporary(w, h) — static, int,int → 本地 s32 槽
//[run-25-废弃]         var rtMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("GetTemporary"), 2);
//[run-25-废弃]         if (!rtMi || rtMi.isNull()) { warn("[v3][Credit] readPixelsFallback: GetTemporary(2) NOT FOUND"); return null; }
//[run-25-废弃]         var p2 = Memory.alloc(16); p2.writeS32(w); p2.add(8).writeS32(h);
//[run-25-废弃]         var e1 = excBuf();
//[run-25-废弃]         var rt = A.ri(rtMi, null, p2, e1);
//[run-25-废弃]         if (!e1.readPointer().isNull() || !rt || rt.isNull()) { warn("[v3][Credit] readPixelsFallback: GetTemporary FAIL"); return null; }
//[run-25-废弃]         var rtStr = rt.toString();
//[run-25-废弃]         // 2. Graphics.Blit(tex, rt) — static, 2 pointer
//[run-25-废弃]         var blitMi = A.cgm(cls.graphics, Memory.allocUtf8String("Blit"), 2);
//[run-25-废弃]         if (blitMi && !blitMi.isNull()) {
//[run-25-废弃]             var bargs = Memory.alloc(16); bargs.writePointer(tex); bargs.add(8).writePointer(rt);
//[run-25-废弃]             var e2 = excBuf();
//[run-25-废弃]             A.ri(blitMi, null, bargs, e2);
//[run-25-废弃]             if (!e2.readPointer().isNull()) warn("[v3][Credit] readPixelsFallback: Blit 抛异常 (忽略继续)");
//[run-25-废弃]         } else warn("[v3][Credit] readPixelsFallback: Blit(2) NOT FOUND (忽略)");
//[run-25-废弃]         // 3. RenderTexture.set_active(rt) — static, 1 pointer
//[run-25-废弃]         var actMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("set_active"), 1);
//[run-25-废弃]         if (actMi && !actMi.isNull()) {
//[run-25-废弃]             var aargs = Memory.alloc(8); aargs.writePointer(rt);
//[run-25-废弃]             var e3 = excBuf();
//[run-25-废弃]             A.ri(actMi, null, aargs, e3);
//[run-25-废弃]             if (!e3.readPointer().isNull()) warn("[v3][Credit] readPixelsFallback: set_active 抛异常 (忽略继续)");
//[run-25-废弃]         }
//[run-25-废弃]         // 4. dst = new Texture2D(w, h, DefaultFormat.LDR=0, TextureCreationFlags.None=0) — 4 参 ctor 直调
//[run-25-废弃]         var dst = A.on(cls.texture2D);
//[run-25-废弃]         var ctorMi = A.cgm(cls.texture2D, Memory.allocUtf8String(".ctor"), 4);
//[run-25-废弃]         if (!ctorMi || ctorMi.isNull() || ctorMi.readPointer().isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: Texture2D.ctor(4) NOT FOUND"); A.ri(actMi, null, aargs, excBuf()); return null;
//[run-25-废弃]         }
//[run-25-废弃]         new NativeFunction(ctorMi.readPointer(), "void", ["pointer", "int", "int", "int", "int"])(dst, w, h, 0, 0);
//[run-25-废弃]         // 5. dst.ReadPixels(rect(0,0,w,h), 0, 0) — Rect 16B → NativeFunction 'rect' 直调
//[run-25-废弃]         var rpMi = A.cgm(cls.texture2D, Memory.allocUtf8String("ReadPixels"), 3);
//[run-25-废弃]         if (!rpMi || rpMi.isNull() || rpMi.readPointer().isNull()) {
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: ReadPixels(3) NOT FOUND"); A.ri(actMi, null, aargs, excBuf()); return null;
//[run-25-废弃]         }
//[run-25-废弃]         var rpFn = new NativeFunction(rpMi.readPointer(), "void", ["pointer", "rect", "int", "int"]);
//[run-25-废弃]         var rc = Memory.alloc(16);
//[run-25-废弃]         rc.writeFloat(0); rc.add(4).writeFloat(0); rc.add(8).writeFloat(w); rc.add(12).writeFloat(h);
//[run-25-废弃]         rpFn(dst, rc, 0, 0);
//[run-25-废弃]         // 6. 清理: active 复位 + ReleaseTemporary
//[run-25-废弃]         if (actMi && !actMi.isNull()) A.ri(actMi, null, aargs, excBuf());
//[run-25-废弃]         var relMi = A.cgm(cls.renderTexture, Memory.allocUtf8String("ReleaseTemporary"), 1);
//[run-25-废弃]         if (relMi && !relMi.isNull()) {
//[run-25-废弃]             var rargs = Memory.alloc(8); rargs.writePointer(rt);
//[run-25-废弃]             A.ri(relMi, null, rargs, excBuf());
//[run-25-废弃]         }
//[run-25-废弃]         // 7. dst.GetPixels32() — 0 参, 返回 Color32[] (引用类型 invoke 安全)
//[run-25-废弃]         var g32 = cgmChain(A.ogc(dst), "GetPixels32", 0);
//[run-25-废弃]         if (!g32 || g32.isNull()) { warn("[v3][Credit] readPixelsFallback: dst.GetPixels32 NOT FOUND"); return null; }
//[run-25-废弃]         var r2 = invokeOk(g32, dst, []);
//[run-25-废弃]         if (!r2.ok || !r2.ret || r2.ret.isNull() || r2.ret.add(0x18).readS32() !== w * h) {
//[run-25-废弃]             var ln = (r2.ret && !r2.ret.isNull()) ? r2.ret.add(0x18).readS32() : "null";
//[run-25-废弃]             warn("[v3][Credit] readPixelsFallback: dst.GetPixels32 FAIL (len=" + ln + ") rt=" + rtStr);
//[run-25-废弃]             return null;
//[run-25-废弃]         }
//[run-25-废弃]         return { w: w, h: h, rgba: new Uint8Array(r2.ret.add(0x20).readByteArray(w * h * 4)) };
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] readPixelsFallback err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // staff 滚动名单: _creditRolls@0x60 = CreditRoll[] → GameObject → GetComponentsInChildren(TMP_Text) 文本
//[run-25-废弃] function extractStaffTexts() {
//[run-25-废弃]     try {
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         var rolls = d.add(0x60).readPointer();
//[run-25-废弃]         if (!rolls || rolls.isNull()) { warn("[v3][Credit] extract: _creditRolls=null"); return null; }
//[run-25-废弃]         var n = rolls.add(0x18).readS32();
//[run-25-废弃]         if (n < 1 || n > 50) { warn("[v3][Credit] extract: _creditRolls 数量异常 " + n); return null; }
//[run-25-废弃]         var out = [];
//[run-25-废弃]         for (var i = 0; i < n; i++) {
//[run-25-废弃]             var roll = rolls.add(0x20 + i * 8).readPointer();
//[run-25-废弃]             if (!roll || roll.isNull()) continue;
//[run-25-废弃]             var goR = invokeOk(cgmChain(A.ogc(roll), "get_gameObject", 0), roll, []);
//[run-25-废弃]             if (!goR.ok || !goR.ret || goR.ret.isNull()) continue;
//[run-25-废弃]             var comps = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
//[run-25-废弃]             var texts = [];
//[run-25-废弃]             if (comps.ok && comps.ret && !comps.ret.isNull()) {
//[run-25-废弃]                 var clen = comps.ret.add(0x18).readS32();
//[run-25-废弃]                 for (var ci = 0; ci < clen && ci < 8; ci++) {
//[run-25-废弃]                     var t = comps.ret.add(0x20 + ci * 8).readPointer();
//[run-25-废弃]                     if (!t || t.isNull()) continue;
//[run-25-废弃]                     var txR = invokeOk(cgmChain(A.ogc(t), "get_text", 0), t, []);
//[run-25-废弃]                     if (txR.ok && txR.ret && !txR.ret.isNull()) texts.push(readStr(txR.ret));
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]             out.push({ roll: i, texts: texts });
//[run-25-废弃]         }
//[run-25-废弃]         return out;
//[run-25-废弃]     } catch (e) { warn("[v3][Credit] extractStaffTexts err: " + e); return null; }
//[run-25-废弃] }
//[run-25-废弃] // 主入口: doPlayAsyncInvoke (PlayAsync 成功, 仍处主线程同步 hook) 后调用
//[run-25-废弃] function extractStep() {
//[run-25-废弃]     try {
//[run-25-废弃]         info("[v3][Credit] 素材提取开始 (stills PNG + SpecialThanks 名单 + staff 文本 + 时序)");
//[run-25-废弃]         var d = comp.director;
//[run-25-废弃]         if (!d || d.isNull()) { warn("[v3][Credit] extract: director 不可得"); writeVar("g_extractDone", 1); return; }
//[run-25-废弃]         mkdirs(extractOutRoot());
//[run-25-废弃]         var stMeta = extractStillsToPng();
//[run-25-废弃]         var stJson = extractDictSpecialThanks();
//[run-25-废弃]         var staffJson = extractStaffTexts();
//[run-25-废弃]         // run-24-8: 轮询首采有启动延迟 → 滚动开头 1-2 屏 (企画/Acacia/プロデューサー...) 可能漏 —
//[run-25-废弃]         //   当前屏快照 (extractStaffTexts) 与 collectedStaff 去重合并, 开头屏不丢
//[run-25-废弃]         try {
//[run-25-废弃]             if (staffJson) {
//[run-25-废弃]                 for (var si = 0; si < staffJson.length; si++) {
//[run-25-废弃]                     var rollTxts = staffJson[si].texts || [];
//[run-25-废弃]                     for (var tj = 0; tj < rollTxts.length; tj++) {
//[run-25-废弃]                         var tv = rollTxts[tj];
//[run-25-废弃]                         var key2 = "snap|" + si + "|" + tv;
//[run-25-废弃]                         if (staffSeen[key2] || !tv || tv.length < 2) continue;
//[run-25-废弃]                         staffSeen[key2] = true;
//[run-25-废弃]                         collectedStaff.push({ go: "snap-roll" + si, text: tv });
//[run-25-废弃]                     }
//[run-25-废弃]                 }
//[run-25-废弃]             }
//[run-25-废弃]         } catch (e4) { warn("[v3][Credit] extractStep 快照合并 err: " + e4); }
//[run-25-废弃]         installStaffPoll();   // run-24-6: staff 轮询兜底 (主线程缓存组件 → JS 线程采样 m_text)
//[run-25-废弃]         var out = {
//[run-25-废弃]             stills: stMeta,
//[run-25-废弃]             specialthanks: stJson,
//[run-25-废弃]             staff: staffJson,
//[run-25-废弃]             timing: {
//[run-25-废弃]                 scrollSpeed: d.add(0x68).readFloat(),
//[run-25-废弃]                 stillDelayUnits: d.add(0x6C).readFloat(),
//[run-25-废弃]                 stillFadeUnits: d.add(0x70).readFloat(),
//[run-25-废弃]                 stillDisplayUnits: d.add(0x74).readFloat(),
//[run-25-废弃]                 specialThanksFadeUnits: d.add(0x78).readFloat(),
//[run-25-废弃]                 specialThanksDisplayUnits: d.add(0x7C).readFloat()
//[run-25-废弃]             }
//[run-25-废弃]         };
//[run-25-废弃]         writeFileBytes(extractOutRoot() + "/credit-assets.json", new Uint8Array(utf8Bytes(JSON.stringify(out, null, 2))));
//[run-25-废弃]         writeVar("g_extractDone", 1);
//[run-25-废弃]         info("[v3][Credit] 素材提取完成 — g_extractDone=1");
//[run-25-废弃]     } catch (e) { error("[v3][Credit] extractStep err: " + e); writeVar("g_extractDone", 1); }
//[run-25-废弃] }
var pendingPlay = null;
var creditT0 = 0;
function doPlayAsyncInvoke() {
    try {
        if (!pendingPlay) { dbg("[v3][Credit] doPlayAsyncInvoke: 无 pendingPlay (幂等跳过)"); return; }
        var ui = pendingPlay.ui || comp.creditsUI;
        var tok = pendingPlay.tok;
        var d = comp.director;
        var stc = d ? d.add(0xA0).readPointer() : null;
        if (!(stc && !stc.isNull()) && (Date.now() - pendingPlay.t0) < 8000) {
            dbg("[v3][Credit] 泵: _specialThanksCredits 未填充, 下个泵再试");
            return;   // 资产未就绪且未超时 — 等下一个 tick
        }
        // run-30: probe-thanks — PlayAsync 触发前挂探针 + 提取完整页/行字典 (此时 _specialThanksCredits 已填充)
        if (creditState.extract) {
            try { installThanksProbe(); } catch (e3) { warn("[v3][Credit] 探针安装 err: " + e3); }
            try { thanksProbeDict(); } catch (e4) { warn("[v3][Credit] 字典提取 err: " + e4); }
        }
        var mi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PlayAsync"), 2);
        if (!mi || mi.isNull()) { warn("[v3][Credit] 原版复刻: CreditsUI.PlayAsync(act,AsyncToken) NOT FOUND"); writeVar("g_creditDone", 1); writeVar("g_thanksDuration", 5); pendingPlay = null; return; }
        var r = invokeOk(mi, ui, [iPtr(2), tok]);
        if (!r.ok) { warn("[v3][Credit] 原版复刻: PlayAsync(2) invoke FAIL — 见上方异常"); writeVar("g_creditDone", 1); writeVar("g_thanksDuration", 5); pendingPlay = null; return; }
        pendingPlay = null;
        info("[v3][Credit] 原版复刻: CreditsUI.PlayAsync(2) 已触发 (主线程, _specialThanksCredits=" + (stc && !stc.isNull() ? "填充" : "null") + ") — 原版全流程运行中 (stills+staff+thanks)");
//[run-25-废弃]         if (creditState.extract) {
//[run-25-废弃]             try { extractStep(); } catch (e2) { error("[v3][Credit] extractStep err: " + e2); writeVar("g_extractDone", 1); }
//[run-25-废弃]         }
        startCompletionPoll();
    } catch (e) { error("[v3][Credit] doPlayAsyncInvoke err: " + e); writeVar("g_creditDone", 1); pendingPlay = null; }
}
// 完成信号轮询 (run-23 模块级): canvas disabled → g_creditDone=1; 360s 超时兜底 (run-24: 片尾 5 分钟)
var startCompletionPoll = function () {
    try {
        var ui = comp.creditsUI;
        if (!ui || ui.isNull()) { warn("[v3][Credit] startCompletionPoll: comp.creditsUI 不可得"); return; }
        var t0 = creditT0;
        var polled = 0, lastState = -1;
        var timeoutGuard = setTimeout(function () {
            if (creditState.armed && creditState.original) {
                warn("[v3][Credit] 原版演出 360s 超时兜底 — g_creditDone=1 (演出可能异常未播完)");
//[run-25-废弃]                 flushStaffJson();   // run-24-4: 超时兜底也落盘 (收集到的即全部滚动期文本)
                try { if (creditState.extract) thanksProbeFlush(); } catch (e5) {}
                writeVar("g_creditDone", 1);
            }
        }, (creditState.extract ? 2400000 : 360000));   // run-30: 探针模式原版全流程(共犯 459+420 人拼行)可超 10 分钟; 普通原版 360s (run-24 bloom 片尾)
        var pollFn = function () {
            try {
                if (!creditState.armed || !creditState.original) { clearTimeout(timeoutGuard); return; }
                polled++;
                var d = comp.director;
                if (!d || d.isNull()) {
                    // director 未捕获 (数组空?) — 改查 CreditsUI canvas 自身
                    var cv0 = ui.add(0x28).readPointer();
                    if (!cv0 || cv0.isNull()) { setTimeout(pollFn, 500); return; }
                    d = { canvas: cv0 };
                }
                var cv = d.canvas ? d.canvas : d.add(0x28).readPointer();   // director._canvas@0x28
                var on = cv ? dcBool(cgmChain(A.ogc(cv), "get_enabled", 0), cv) : false;
                var stc2 = (comp.director && !comp.director.isNull()) ? comp.director.add(0xA0).readPointer() : null;
                if (polled === 2 || polled % 10 === 0 || (on !== lastState)) {
                    info("[v3][Credit] 原版轮询 #" + polled + " (+" + ((Date.now() - t0) / 1000).toFixed(0) + "s): canvas=" + (on ? "on" : "OFF") + " _specialThanksCredits=" + (stc2 && !stc2.isNull() ? "填充" : "null"));
                    lastState = on;
                }
                if (!on) {
                    clearTimeout(timeoutGuard);
                    var elapsed = (Date.now() - t0) / 1000;
//[run-25-废弃]                     flushStaffJson();   // run-24-4: 演出自然完, staff 收集完整
                    try { if (creditState.extract) thanksProbeFlush(); } catch (e5) {}
                    writeVar("g_creditDone", 1);
                    writeVar("g_thanksDuration", elapsed + 3);
                    info("[v3][Credit] 原版演出完成 (canvas disabled) +" + elapsed.toFixed(0) + "s — g_creditDone=1, g_thanksDuration=" + (elapsed + 3).toFixed(0));
                    return;
                }
            } catch (e) { if (polled % 10 === 0) warn("[v3][Credit] 原版轮询 err: " + e); }
            setTimeout(pollFn, 500);
        };
        setTimeout(pollFn, 500);   // 500ms 后开始轮询
    } catch (e) { error("[v3][Credit] startCompletionPoll err: " + e); }
};
function doOriginal() {
    try {
        if (!creditState.armed) { writeVar("g_thanksDuration", 5); return; }
        writeVar("g_creditDone", 0);   // run-19: 入口即重置完成信号 — nani @if 轮询读到的是本轮 0 (防上次会话残留 1)
        // run-17 重构: 场景扫 CreditsUI (含 inactive) + 场景/资产扫 CreditsDirectorAct2 —
        //   GetUI 壳实例的 _creditsDirectors@0xE0 可能为 null (prefab 序列化引用场景对象 → 实例化后引用失效)
        //   若 director 实例存在 → 手动组装进壳数组 (原版 @credit 2 的前提)
        var ui = null;
        var dInst = null;   // 场景/资产的 CreditsDirectorAct2 实例
        try {
            // ① 场景 CreditsUI (stage2 includeInactive; stage3 资产 prefab 实例化后引用失效, 仅诊断)
            var uiR = findRollsStaged(cls.creditsUI, "CreditsUI");
            if (uiR.stage >= 1 && uiR.stage <= 2) {
                for (var ui_i = 0; ui_i < uiR.objs.length; ui_i++) {
                    var uiGo = uiR.objs[ui_i];
                    var arrD = uiGo.add(0xE0).readPointer();
                    var hasD = arrD && !arrD.isNull();
                    info("[v3][Credit] 场景 CreditsUI#" + ui_i + " = " + uiGo + " (" + getGoName(uiGo) + ") _creditsDirectors=" + (hasD ? "有" : "null"));
                    if (!ui && hasD) { ui = uiGo; info("[v3][Credit] 原版复刻: 用场景 CreditsUI " + uiGo + " (有 director 数组)"); }
                }
            } else if (uiR.stage === 3) {
                warn("[v3][Credit] CreditsUI 只有资产 prefab (" + uiR.objs.length + " 个) — 实例化后 director 引用失效, 需手动组装; 先扫 director 实例");
            } else {
                dbg("[v3][Credit] 场景无 CreditsUI 实例 — 依赖 GetUI 壳 + 手动组装");
            }
            // ② 场景/资产扫 CreditsDirectorAct2 实例
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            if (dR.stage >= 1 && dR.stage <= 2) {
                for (var di = 0; di < dR.objs.length; di++) {
                    var dp = dR.objs[di];
                    var dGoName = getGoName(dp);
                    var stc0 = dp.add(0xA0).readPointer();
                    info("[v3][Credit] 场景 CreditsDirectorAct2#" + di + " = " + dp + " (" + dGoName + ") _specialThanksCredits=" + (stc0 && !stc0.isNull() ? "有" : "null"));
                    if (!dInst) dInst = dp;
                }
            } else if (dR.stage === 3) {
                warn("[v3][Credit] CreditsDirectorAct2 只有资产 prefab (" + dR.objs.length + " 个) — 无场景实例, 无法复刻原版");
            }
        } catch (e) { warn("[v3][Credit] 原版复刻: 场景组件扫描 err: " + e); }
        if (!ui) ui = spawnCreditsUI();
        if (!ui || ui.isNull()) { warn("[v3][Credit] 原版复刻: CreditsUI 不可得 (场景扫+spawnCreditsUI 均失败)"); writeVar("g_creditDone", 1); writeVar("g_thanksDuration", 5); return; }
        // ③ director 数组组装: 壳实例 director=null 且场景有 director 实例 → 手动写入
        var arr = ui.add(0xE0).readPointer();
        if ((!arr || arr.isNull()) && dInst) {
            try {
                var dArr = A.an(A.ogc(dInst), 4);   // 元素类 = director 实例类 (Act2)
                dArr.add(0x20 + 2 * 8).writePointer(dInst);   // act=2 槽位
                ui.add(0xE0).writePointer(dArr);
                comp.director = dInst;
                info("[v3][Credit] 原版复刻: 手动组装 _creditsDirectors[2]=" + dInst + " (" + getGoName(dInst) + ") — 壳实例 + 场景 director");
            } catch (e) { warn("[v3][Credit] 原版复刻: 手动组装 director 数组 err: " + e); }
        }
        // 诊断: _creditsDirectors@0xE0 数组 → act=2 导演实例 + 数据填充状态
        try {
            arr = ui.add(0xE0).readPointer();
            if (!arr || arr.isNull()) { warn("[v3][Credit] 原版 director 诊断: _creditsDirectors@0xE0 = null (场景无 director 实例, 无法复刻原版)"); }
            else {
                var len = arr.add(0x18).readS32();
                if (len < 1 || len > 16) { warn("[v3][Credit] 原版 director 诊断: _creditsDirectors 长度异常 " + len); }
                else {
                    var parts = [];
                    for (var i = 0; i < len; i++) {
                        var p = arr.add(0x20 + i * 8).readPointer();
                        parts.push("#" + i + ":" + (p && !p.isNull() ? clsName(A.ogc(p)) : "null"));
                        if (i === 2 && p && !p.isNull()) {
                            comp.director = p;
                            var stc = p.add(0xA0).readPointer();   // _specialThanksCredits@0xA0
                            var sto = p.add(0x98).readPointer();   // _specialThanksOrders@0x98
                            info("[v3][Credit] 原版 director[2] 数据: _specialThanksCredits@0xA0=" + (stc && !stc.isNull() ? stc : "null") + " _specialThanksOrders@0x98=" + (sto && !sto.isNull() ? sto : "null"));
                        }
                    }
                    info("[v3][Credit] 原版 _creditsDirectors[" + len + "] = " + parts.join(" | "));
                }
            }
        } catch (e) { warn("[v3][Credit] 原版 director 诊断 err: " + e); }
        // 触发原版演出 (run-23): 原版 @credit = Preload → Play, 但 invoke 必须在主线程 —
        //   JS 线程 (setTimeout 回调) 调 Unity API 会 breakpoint triggered; 用 nani 轮询 @set
        //   g_creditTick 作泵, 在 onSVV (主线程同步 hook) 里完成 PlayAsync。
        //   Preload 同步触发 (run-22 已验证: 300ms 内 _specialThanksCredits 填充)。
        writeVar("g_creditDone", 0);
        creditT0 = Date.now();
        var tok = Memory.alloc(32);
        tok.writeU64(0); tok.add(8).writeU64(0); tok.add(16).writeU64(0); tok.add(24).writeU64(0);
        pendingPlay = { ui: ui, tok: tok, t0: creditT0 };
        var preMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PreloadResourcesAsync"), 2);
        if (preMi && !preMi.isNull()) {
            var rp = invokeOk(preMi, ui, [iPtr(2), tok]);
            if (!rp.ok) warn("[v3][Credit] PreloadResourcesAsync(2) invoke FAIL — SpecialThanks 可能空白");
            else info("[v3][Credit] 原版复刻: PreloadResourcesAsync(2) 已触发 (stills/SpecialThanks 资产加载中) — 等 nani 泵触发 PlayAsync(主线程)");
        } else {
            warn("[v3][Credit] 原版复刻: PreloadResourcesAsync NOT FOUND — 跳过 Preload 直接等泵");
        }
        writeVar("g_thanksDuration", 240);   // 兜底参考值 (完成信号才是主协议)
    } catch (e) { error("[v3][Credit] doOriginal err: " + e); writeVar("g_thanksDuration", 5); }
}

// ============ phase=2: special thanks ============
function thanksLocales() {
    var j = creditState.json;
    if (!j || !j.thanks) return [];
    var out = [];
    for (var k in j.thanks) { if (k !== "order" && j.thanks[k] && Array.isArray(j.thanks[k].pages) && j.thanks[k].pages.length) out.push(k); }   // run-29: pages (页=富文本行[])
    return out;
}
// run-29: 共犯翻页原版参数 (场景实例即 prefab 克隆, 字段直读):
//   rollThanks._delayBeforeCreditsCoefficient@0x60 — 标题"共犯者"展示时长 (单位=拍)
//   director._specialThanksFadeUnits@0x78 / _specialThanksDisplayUnits@0x7C — 翻页 fade/display (拍)
//   director._specialThanksOrderData@0x80 — 每语种播放顺序 (SpecialThanksOrderData{_localeKind@0x10,_order@0x18 LocaleKind[]})
//   拍→秒 = units × 60/bpm (_bgmBpm@0x30)
function readThanksTiming() {
    try {
        if (comp.thanksTiming) return comp.thanksTiming;
        var t = { delayCoef: -1, fadeUnits: -1, displayUnits: -1, bpm: 0, orders: null };
        var d = (comp.director && !comp.director.isNull()) ? comp.director : null;
        if (!d) {
            var dR = findRollsStaged(cls.director, "CreditsDirectorAct2");
            for (var i = 0; i < (dR.objs || []).length && !d; i++) {
                if (dR.objs[i] && !dR.objs[i].isNull()) d = dR.objs[i];
            }
        }
        if (d) {
            t.fadeUnits = d.add(0x78).readFloat();
            t.displayUnits = d.add(0x7C).readFloat();
            t.bpm = d.add(0x30).readFloat();
            // _specialThanksOrderData@0x80: 每语种 {_localeKind, _order: LocaleKind[]}
            try {
                var arr = d.add(0x80).readPointer();
                if (arr && !arr.isNull()) {
                    var len = arr.add(0x18).readS32();
                    if (len > 0 && len < 8) {
                        t.orders = {};
                        for (var i2 = 0; i2 < len; i2++) {
                            var e = arr.add(0x20 + i2 * 8).readPointer();
                            if (!e || e.isNull()) continue;
                            var lv = e.add(0x10).readS32();
                            var oarr = e.add(0x18).readPointer();
                            if (!oarr || oarr.isNull()) continue;
                            var olen = oarr.add(0x18).readS32();
                            var seq = [];
                            for (var j = 0; j < olen && j < 8; j++) seq.push(oarr.add(0x20 + j * 4).readS32());
                            t.orders[lv] = seq;
                        }
                    }
                }
            } catch (e2) { warn("[v3][Credit] order 读取 err: " + e2); }
        }
        if (comp.rollThanks && !comp.rollThanks.isNull()) {
            t.delayCoef = comp.rollThanks.add(0x60).readFloat();
            // _lineSpacingsByLevel@0x50 float[] (行距, 静态实证 [-25,10,100])
            try {
                var larr = comp.rollThanks.add(0x50).readPointer();
                if (larr && !larr.isNull()) {
                    var llen = larr.add(0x18).readS32();
                    if (llen > 0 && llen < 16) {
                        t.lineSpacings = [];
                        for (var li = 0; li < llen; li++) t.lineSpacings.push(larr.add(0x20 + li * 4).readFloat());
                    }
                }
            } catch (eL) { warn("[v3][Credit] lineSpacings 读取 err: " + eL); }
        }
        comp.thanksTiming = t;
        var orderStr = "?";
        if (t.orders) {
            var ps = [];
            for (var lk in t.orders) ps.push(lk + "→[" + t.orders[lk].join(",") + "]");
            orderStr = ps.join(" ");
        }
        info("[v3][Credit] 共犯原版参数: thanksUnits(fade/display)=" + t.fadeUnits.toFixed(2) + "/" + t.displayUnits.toFixed(2)
            + " bpm=" + t.bpm.toFixed(2) + " delayCoef=" + t.delayCoef.toFixed(2)
            + " lineSpacings=[" + (t.lineSpacings ? t.lineSpacings.join(",") : "?") + "] orders=" + orderStr);
        return t;
    } catch (e) { warn("[v3][Credit] readThanksTiming err: " + e); comp.thanksTiming = { delayCoef: -1, fadeUnits: -1, displayUnits: -1, bpm: 0, orders: null }; return comp.thanksTiming; }
}
// run-29: 共犯翻页自实现 (不调原版 ShowAsync) — 原版 ShowAsync 内部按课程档位索引
//   _maxLabelSizesByLevel@0x40 等数组 (dump.cs:11233 CreditRollSpecialThanks), mod 页数 (72) 远超
//   原版档位数 → 播几页后 IndexOutOfRangeException → 演出中断 (共犯者消失/无名单, 14:58:58 实证);
//   且原版只操作当前语种标签, prefab 两语种标签默认全 active → 双 Special Thanks 叠印。
// 自翻页 (run-29 按原版实证重构):
//   标题时序: _startLabel@0x30 (共犯者) fade in → display (delayCoef 拍) → fade out → 才开始翻页
//   (用户实测: 标题展示完成后即消失, 非全程常驻);
//   名单呈现 = 逐行累积追加 (运行时采样 42 条 = 42 行实证): 每行 = 完整富文本
//   (<size=1.7em>名字</size><space=80>... 同行多名字, <br> 换行), 行内排版由富文本原样复刻;
//   只激活当前语种标签 (防叠印)。节奏 = 原版拍数换算 (fadeUnits/displayUnits × 拍长)。
function activateThanksLocale(lv) {
    try {
        for (var lk in comp.thanksByLocale) {
            var entry = comp.thanksByLocale[lk];
            if (!entry || !entry.label || entry.label.isNull()) continue;
            var on = (parseInt(lk, 10) === lv);
            var goR = invokeOk(cgmChain(A.ogc(entry.label), "get_gameObject", 0), entry.label, []);
            if (goR.ok && goR.ret && !goR.ret.isNull()) {
                invoke(cgmChain(A.ogc(goR.ret), "SetActive", 1), goR.ret, [boolPtr(on)]);
                if (!on) { if (deactivatedLabels.indexOf(goR.ret) < 0) deactivatedLabels.push(goR.ret); }   // 结束还原
            }
        }
    } catch (e) { warn("[v3][Credit] activateThanksLocale err: " + e); }
}
function thanksTick() {
    try {
        var p = comp.thanksPaging;
        if (!p) return;
        var now = Date.now();
        var el = now - p.stepStart;
        if (p.state === "title_fadein") {                       // 共犯者标题 fade in
            if (!p.cg || p.cg.isNull()) { p.state = "title_display"; p.stepStart = now; return; }
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.min(1, el / p.fadeMs))]);
            if (el >= p.fadeMs) { p.state = "title_display"; p.stepStart = now; }
        } else if (p.state === "title_display") {               // 标题展示 (delayCoef 拍)
            if (el >= p.titleMs) { p.state = "title_fadeout"; p.stepStart = now; }
        } else if (p.state === "title_fadeout") {               // 标题 fade out → 开始翻页
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.max(0, 1 - el / p.fadeMs))]);
            if (el >= p.fadeMs) { p.idx = 0; thanksEnterPage(p); p.state = "page_fadein"; p.stepStart = now; }
        } else if (p.state === "page_fadein") {                 // run-30c: 整页 fade in (文本已 set)
            if (!p.cg || p.cg.isNull()) { p.state = "page_display"; p.stepStart = now; return; }
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.min(1, el / p.fadeMs))]);
            if (el >= p.fadeMs) { p.state = "page_display"; p.stepStart = now; }
        } else if (p.state === "page_display") {                // 整页展示 → fade out
            if (el >= p.displayMs) { p.state = "page_fadeout"; p.stepStart = now; }
        } else if (p.state === "page_fadeout") {                // 整页 fade out → 下一页
            invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(Math.max(0, 1 - el / p.fadeMs))]);
            if (el >= p.fadeMs) {
                p.idx++;
                if (p.idx >= p.pages.length) {
                    info("[v3][Credit] 共犯翻页完成 " + p.nPages + " 页 (zh+ja 合并完整名单)");
                    stopThanks();
                    // run-30f: Production 段改主线程泵 — thanksTick 是 JS 定时器线程, 直接调
                    //   get_ContentHeight/ScrollAsync = "breakpoint triggered" (run-23 同款实证:
                    //   引擎级 Unity API 必须在 onSVV 主线程同步 hook 执行); 置标志, 下一轮
                    //   nani 轮询 @set g_creditTick 时由 onSVV 泵执行 doProduction (完成后写 g_creditDone)
                    creditState.pendingProduction = true;
                    return;
                }
                thanksEnterPage(p);
                p.state = "page_fadein"; p.stepStart = now;
            }
        }
    } catch (e) { warn("[v3][Credit] thanksTick err: " + e); stopThanks(); }
}
// run-30c: 进入整页 — 整页文本 (页内行 join '<br>') 一次 set + 切语种换标签 + 档位行距
function thanksEnterPage(p) {
    try {
        var nx = p.pages[p.idx];
        if (p.idx > 0 && nx.lv !== p.pages[p.idx - 1].lv) activateThanksLocale(nx.lv);   // 切语种 → 换标签
        try {
            thanksSetLineSpacing(nx.label, nx.firstLine, p.lineSpacings);
            invoke(cgmChain(A.ogc(nx.label), "set_Text", 1), nx.label, [makeS(nx.text)]);
        } catch (e) { warn("[v3][Credit] thanks set_Text err: " + e); }
        p.label = nx.label; p.tmp = nx.tmp; p.cg = nx.cg;
        if (p.cg && !p.cg.isNull()) {
            try { invoke(cgmChain(A.ogc(p.cg), "set_alpha", 1), p.cg, [fPtr(0)]); } catch (e) {}
        }
    } catch (e) { warn("[v3][Credit] thanksEnterPage err: " + e); }
}
// run-30e: Production 段 (製作・販売/Acacia/© 2024) — 共犯 36 屏之后的最后一段滚动。
//   原版 PlayAsync 遍历 _creditRolls@0x60 (CreditRoll[]): Staffs/Production 都是
//   CreditRollVerticalScroll, 依次 ScrollAsync(ContentHeight/_scrollSpeed)。
//   Production 的 3 条文本 = prefab 静态默认 (credits-tree 实证: Roll_49/Name_50/Name_34),
//   不需要运行时填充 — 只激活 + 滚动。
function findProductionRoll() {
    try {
        var ui = comp.creditsUI;
        if (!ui || ui.isNull()) { warn("[v3][Credit] findProductionRoll: creditsUI 不可得"); return null; }
        var goR = invokeOk(cgmChain(A.ogc(ui), "get_gameObject", 0), ui, []);
        if (!goR.ok || goR.ret.isNull()) { warn("[v3][Credit] findProductionRoll: GO 不可得"); return null; }
        var arr = invokeOk(cgmChain(A.ogc(goR.ret), "GetComponentsInChildren", 2), goR.ret, [A.tgo(A.cgt(cls.rollScroll)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) { warn("[v3][Credit] findProductionRoll: GCI 失败"); return null; }
        var len = arr.ret.add(0x18).readS32();
        var names = [];
        for (var i = 0; i < len; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull()) continue;
            var go = invokeOk(cgmChain(A.ogc(e), "get_gameObject", 0), e, []);
            var nm = (go.ok && !go.ret.isNull()) ? getGoName(go.ret) : "?";
            names.push(nm);
            if (nm === "Production") {
                info("[v3][Credit] Production roll 找到: " + e + " (ScrollRect 全部: " + names.join(",") + ")");
                return e;
            }
        }
        warn("[v3][Credit] findProductionRoll: 未找到 Production GO, ScrollRect 组件 GO 名: " + names.join(","));
        return null;
    } catch (e) { warn("[v3][Credit] findProductionRoll err: " + e); return null; }
}
function doProduction() {
    try {
        if (!creditState.armed) { writeVar("g_creditDone", 1); return; }
        var prod = findProductionRoll();
        if (!prod || prod.isNull()) {
            warn("[v3][Credit] Production 段跳过 (组件未找到) — 直接完成");
            writeVar("g_creditDone", 1);
            return;
        }
        var ks = A.ogc(prod);
        info("[v3][Credit] Production 组件=" + prod + " 类=" + clsName(ks) + " (主线程泵执行)");
        invoke(cgmChain(ks, "SetGameObjectActive", 1), prod, [boolPtr(true)]);
        invoke(cgmChain(ks, "SetCanvasEnabled", 1), prod, [boolPtr(true)]);
        try { ensureHierarchy(); ensureCanvasRenderable(); } catch (e2) {}
        var h = dcFloat(cgmChain(ks, "get_ContentHeight", 0), prod);
        var timing = readDirectorTiming();
        var speed = (timing && timing.speed > 0) ? timing.speed
            : ((creditState.json && creditState.json.staff && creditState.json.staff.speed > 0) ? creditState.json.staff.speed : 248);
        var dur = (h > 0) ? h / speed : 3;
        var saMi = A.cgm(ks, Memory.allocUtf8String("ScrollAsync"), 2);
        var sr = invokeOk(saMi, prod, [fPtr(dur), zeroCT()]);
        info("[v3][Credit] Production 段: 高度=" + h.toFixed(0) + "px duration=" + dur.toFixed(1) + "s speed=" + speed.toFixed(0) + " ScrollAsync=" + (sr.ok ? "OK" : "FAIL"));
        // 完成后写 phase=2 完成信号 (滚动 + 2s 缓冲)
        setTimeout(function () {
            try {
                writeVar("g_creditDone", 1);
                info("[v3][Credit] Production 段完成 — g_creditDone=1");
            } catch (e3) { warn("[v3][Credit] Production 完成信号 err: " + e3); }
        }, (dur + 0.5) * 1000);   // run-30g: 缓冲 2→0.5s (对齐原版连续节奏)
    } catch (e) { error("[v3][Credit] doProduction err: " + e); writeVar("g_creditDone", 1); }
}
// run-29: 行距按档位 — 行富文本 <size=Xem> → 档 (1.7em→2/1.3em→1/1em→0) → _lineSpacingsByLevel
//   (原版每页 SetLineSpacing(档位行距); 富文本里没有行距, 不设则默认行距)
function thanksSetLineSpacing(label, text, lineSpacings) {
    try {
        if (!label || label.isNull() || !lineSpacings || !lineSpacings.length) return;
        var em = lineEm(text);
        if (em === null) return;
        var lvl = em >= 1.6 ? 2 : (em >= 1.2 ? 1 : 0);
        if (lineSpacings[lvl] === undefined) return;
        invoke(cgmChain(A.ogc(label), "SetLineSpacing", 1), label, [fPtr(lineSpacings[lvl])]);
    } catch (e) { warn("[v3][Credit] SetLineSpacing err: " + e); }
}
function stopThanks() {
    try {
        if (comp.thanksPaging && comp.thanksPaging.timer) { clearInterval(comp.thanksPaging.timer); }
        comp.thanksPaging = null;
    } catch (e) {}
}
function doThanks() {
    try {
        if (!creditState.armed) { writeVar("g_thanksDuration", 5); return; }
        stopStills();   // run-26: phase1 滚动结束 → still 收尾 (fade 0 + 停定时器)
        if (!ensureThanks()) {
            warn("[v3][Credit] phase=2 跳过: rollThanks 未捕获/失效 (见上方捕获诊断)");
            writeVar("g_thanksDuration", 5);
            return;
        }
        ensureCanvasRenderable();   // 与 phase=1 共享同一 canvas, 幂等
        var jt = creditState.json.thanks;
        var locales = thanksLocales();
        if (!locales.length) { warn("[v3][Credit] phase=2 跳过: json.thanks 无可用语种"); writeVar("g_thanksDuration", 5); return; }
        // run-29: order — 优先原版 _specialThanksOrderData (每语种一序, 当前语种优先), 兜底 json.order, 再回退当前语言
        var tt = readThanksTiming();
        var orderList = [];
        var curLoc = getCurrentLocale();
        var curLv = localeKindValue(curLoc);
        if (tt && tt.orders && curLv !== null && tt.orders[curLv]) {
            for (var oi0 = 0; oi0 < tt.orders[curLv].length; oi0++) {
                var ln = localeName(tt.orders[curLv][oi0]);
                if (ln && locales.indexOf(ln) >= 0 && orderList.indexOf(ln) < 0) orderList.push(ln);
            }
            if (orderList.length) info("[v3][Credit] order=原版(当前语种 " + curLoc + " 优先): " + orderList.join("→"));
        }
        if (!orderList.length && Array.isArray(jt.order)) {
            for (var i = 0; i < jt.order.length; i++) { if (locales.indexOf(jt.order[i]) >= 0 && orderList.indexOf(jt.order[i]) < 0) orderList.push(jt.order[i]); }
        }
        if (!orderList.length) {
            orderList = locales.indexOf(curLoc) >= 0 ? [curLoc] : [locales[0]];
            dbg("[v3][Credit] order 回退当前语言: " + orderList.join(","));
        }
        // 语种标签 — _labelsByLocale@0x38 序列化数组开机即有 (不依赖 ShowAsync)
        if (!comp.thanksByLocale || !Object.keys(comp.thanksByLocale).length) enumerateThanksLabels();
        // run-30c: 组装页序列 pages [{lv,label,tmp,cg,text,firstLine}] — 页级显示 (原版实证):
        //   每页 = 整屏, 页内行 1-2ms 瞬时构建 (逐条 set_text), 页间 ~3.3s (REPL→REPL 实测 3298-3332ms)。
        //   整页文本 = 页内行 join '<br>' 一次 set — 原版富文本排版原样还原。
        //   缺标签的语种跳过 (枚举日志见上)
        var pages = [], labelInfo = [], nPages = 0;
        for (var oi = 0; oi < orderList.length; oi++) {
            var loc = orderList[oi];
            var lv = localeKindValue(loc);
            if (lv === null) continue;
            var entry = comp.thanksByLocale ? comp.thanksByLocale[lv] : null;
            if (!entry || !entry.label || entry.label.isNull()) { warn("[v3][Credit] 语种标签缺失 localeKind=" + lv + " (见上枚举日志) — 该语种跳过"); continue; }
            var pgList = (jt[loc] && Array.isArray(jt[loc].pages)) ? jt[loc].pages : null;
            if (!pgList) { warn("[v3][Credit] 语种 " + loc + " 无 pages (需 run-29 格式)"); continue; }
            nPages += pgList.length;
            for (var pi = 0; pi < pgList.length; pi++) {
                var pg = pgList[pi];
                if (!Array.isArray(pg)) pg = [String(pg)];
                pages.push({ lv: lv, label: entry.label, tmp: entry.tmp, cg: entry.cg,
                             text: pg.join("<br>"), firstLine: String(pg[0]) });
            }
            if (jt[loc].label) labelInfo.push(loc + "='" + jt[loc].label + "'");
        }
        if (!pages.length) { warn("[v3][Credit] phase=2 跳过: 翻页序列为空"); writeVar("g_thanksDuration", 5); return; }
        // run-29: 原版参数 — fade/display 拍数 + 标题"共犯者"延迟系数 (拍), 异常回退固定值
        var beat = (tt && tt.bpm > 0) ? 60 / tt.bpm : 0.68;
        var fadeMs = 400, displayMs = 1280, titleMs = 4000;
        if (tt && tt.fadeUnits >= 0 && tt.bpm > 0) fadeMs = Math.max(200, tt.fadeUnits * beat * 1000);
        if (tt && tt.displayUnits >= 0 && tt.bpm > 0) displayMs = Math.max(500, tt.displayUnits * beat * 1000);
        if (tt && tt.delayCoef > 0 && tt.bpm > 0) titleMs = tt.delayCoef * beat * 1000;
        titleMs = Math.min(Math.max(titleMs, 1500), 10000);
        var kts = A.ogc(comp.rollThanks);
        invoke(cgmChain(kts, "SetGameObjectActive", 1), comp.rollThanks, [boolPtr(true)]);
        invoke(cgmChain(kts, "SetCanvasEnabled", 1), comp.rollThanks, [boolPtr(true)]);
        ensureHierarchy();
        // run-28: 只激活当前语种标签 (防叠印 — 原版 prefab 两语种全 active)
        activateThanksLocale(pages[0].lv);
        // 标题"共犯者" (_startLabel@0x30 SpecialThanksLabel) — run-29: fade in → display → fade out → 翻页
        var startLbl = comp.rollThanks.add(0x30).readPointer();
        var startCg = (startLbl && !startLbl.isNull()) ? startLbl.add(0x28).readPointer() : null;
        // 诊断: 当前语种翻页标签 rect 尺寸 (对照原版 _maxLabelSizesByLevel 1920-2320 宽)
        try {
            var rtr = invokeOk(cgmChain(A.ogc(pages[0].tmp), "get_rectTransform", 0), pages[0].tmp, []);
            if (rtr.ok && rtr.ret && !rtr.ret.isNull()) {
                var sdr = invokeOk(cgmChain(A.ogc(rtr.ret), "get_sizeDelta", 0), rtr.ret, []);
                if (sdr.ok && sdr.ret && !sdr.ret.isNull()) {
                    info("[v3][Credit] 翻页标签 sizeDelta=" + sdr.ret.add(0).readFloat().toFixed(0) + "x" + sdr.ret.add(4).readFloat().toFixed(0) + " (原版 _maxLabelSizesByLevel 1920-2320 宽)");
                }
            }
        } catch (eR) { warn("[v3][Credit] rect 诊断 err: " + eR); }
        // run-30c: 翻页状态机 (标题阶段 + 页级: 整页一次 set, fade in → display → fade out, ~3.3s/页)
        stopThanks();   // 幂等: 上一轮残留清理
        comp.thanksPaging = { pages: pages, nPages: nPages, idx: -1, acc: "",
                              state: "title_fadein", stepStart: Date.now(),
                              fadeMs: fadeMs, displayMs: displayMs, titleMs: titleMs,
                              lineSpacings: (tt && tt.lineSpacings) ? tt.lineSpacings : null,
                              label: startLbl, cg: startCg, timer: null };
        try {
            if (startCg && !startCg.isNull()) invoke(cgmChain(A.ogc(startCg), "set_alpha", 1), startCg, [fPtr(0)]);
            if (pages[0].cg && !pages[0].cg.isNull()) invoke(cgmChain(A.ogc(pages[0].cg), "set_alpha", 1), pages[0].cg, [fPtr(0)]);
        } catch (e) { warn("[v3][Credit] 标题/首页 alpha 置零 err: " + e); }
        comp.thanksPaging.timer = setInterval(thanksTick, 25);   // run-30g: 50→25ms 粒度 (每屏 tick 误差 ~0.1s→~0.05s)
        var dur = titleMs / 1000 + nPages * (fadeMs + displayMs + fadeMs) / 1000 + 0.5;   // run-30g: 缓冲 2.4→0.5s (对齐原版总长)
        writeVar("g_thanksDuration", dur);
        info("[v3][Credit] 共犯翻页 (自实现, " + orderList.length + " 语种, " + nPages
            + " 页, order=" + orderList.join("→") + (labelInfo.length ? ", label " + labelInfo.join(" ") : "")
            + ", 标题=" + (titleMs / 1000).toFixed(1) + "s, 页间=" + ((fadeMs + displayMs + fadeMs) / 1000).toFixed(2) + "s, fade=" + (fadeMs / 1000).toFixed(2) + "s, display=" + (displayMs / 1000).toFixed(2) + "s)"
            + " 首页='" + pages[0].text.slice(0, 40) + "' g_thanksDuration=" + dur.toFixed(1) + "s");
        dumpThanksTMPs(kts);
    } catch (e) { error("[v3][Credit] doThanks err: " + e); stopThanks(); writeVar("g_thanksDuration", 5); }
}
// 诊断: rollThanks 子树 TMP (原版 label/标题结构 — v1 不写 label 字段, 结构留待后续版本)
function dumpThanksTMPs(kt) {
    try {
        var go = invokeOk(cgmChain(kt, "get_gameObject", 0), comp.rollThanks, []);
        if (!go.ok || go.ret.isNull()) return;
        var arr = invokeOk(cgmChain(A.ogc(go.ret), "GetComponentsInChildren", 2), go.ret, [A.tgo(A.cgt(cls.tmpText)), boolPtr(true)]);
        if (!arr.ok || !arr.ret || arr.ret.isNull()) return;
        var len = arr.ret.add(0x18).readS32();
        var parts = [];
        for (var i = 0; i < len && i < 8; i++) {
            var e = arr.ret.add(0x20 + i * 8).readPointer();
            if (!e || e.isNull()) continue;
            var tx = invokeOk(cgmChain(A.ogc(e), "get_text", 0), e, []);
            var s = tx.ok ? readStr(tx.ret) : null;
            parts.push("#" + i + "='" + (s || "") + "'/" + getFontName(e));
        }
        dbg("[v3][Credit] thanks TMP 子树 (" + len + "): " + parts.join(" | "));
    } catch (e) {}
}

// ============ phase=3: end 清理 ============
function doEnd() {
    try {
        if (!creditState.armed) return;   // 未 arm 无事可清 (存档回放防御)
        if (creditState.original) {
            // run-15: 原版复刻模式 — 原版 PlayAsync 自清理 (ChangeActivity/Stop), 我们什么都没动;
            //   只调原版 CreditsUI.Stop() 兜底 (防演出未播完被脚本切走) + disarm
            if (comp.creditsUI && !comp.creditsUI.isNull()) {
                var stMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("Stop"), 0);
                if (stMi && !stMi.isNull()) invoke(stMi, comp.creditsUI, []);
            }
//[run-25-废弃]             flushStaffJson();   // run-24-5: EndCredits2 标签接管收尾路径也落盘 (Resume 打断轮询循环后走这里)
            creditState.armed = false;
            creditState.phase = 0;
            info("[v3][Credit] end (原版模式): CreditsUI.Stop 兜底 + disarm");
            return;
        }
        if (isThanksRoll(comp.rollThanks)) {
            var lbl = comp.rollThanks.add(0x70).readPointer();
            if (!lbl || lbl.isNull()) { dbg("[v3][Credit] end: _labels 未初始化, 跳过 Clear (run-8: null 时 Clear 抛异常)"); }
            else {
                var kt = A.ogc(comp.rollThanks);
                var cr = invokeOk(cgmChain(kt, "Clear", 0), comp.rollThanks, []);
                if (!cr.ok) warn("[v3][Credit] SpecialThanks.Clear FAIL");
            }
        }
        var roll = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        if (roll && !roll.isNull()) {
            invoke(cgmChain(A.ogc(roll), "DisableCanvas", 0), roll, []);
        }
        // run-11: 还原单标签模式停用的非当前语种标签
        for (var i = 0; i < deactivatedLabels.length; i++) {
            try { invoke(cgmChain(A.ogc(deactivatedLabels[i]), "SetActive", 1), deactivatedLabels[i], [boolPtr(true)]); } catch (e) {}
        }
        deactivatedLabels = [];
        stopStills();   // run-26: still 定时器/alpha 收尾
        stopThanks();   // run-28: 共犯翻页定时器收尾
        restoreAncestors();
        creditState.armed = false;
        creditState.phase = 0;
        info("[v3][Credit] end: 清理完成 (Clear/DisableCanvas/还原祖先, 已 disarm)");
    } catch (e) { error("[v3][Credit] doEnd err: " + e); }
}
// 剧本切换/回标题 → 演出中止 (F3): 清残留 + disarm
function abortCredit(reason) {
    warn("[v3][Credit] 演出中止: " + reason);
    if (creditState.original) {
        // run-15: 原版模式 — 原版演出还在跑, 用原版 CreditsUI.Stop() 中止
        try { if (comp.creditsUI && !comp.creditsUI.isNull()) { var stMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("Stop"), 0); if (stMi && !stMi.isNull()) invoke(stMi, comp.creditsUI, []); } } catch (e) {}
        creditState.armed = false;
        creditState.phase = 0;
        return;
    }
    try { if (isThanksRoll(comp.rollThanks)) { var lbl2 = comp.rollThanks.add(0x70).readPointer(); if (lbl2 && !lbl2.isNull()) invoke(cgmChain(A.ogc(comp.rollThanks), "Clear", 0), comp.rollThanks, []); } } catch (e) {}
    try {
        var roll = (!comp.rollScroll || comp.rollScroll.isNull()) ? comp.rollThanks : comp.rollScroll;
        if (roll && !roll.isNull()) invoke(cgmChain(A.ogc(roll), "DisableCanvas", 0), roll, []);
    } catch (e) {}
    stopStills();   // run-26: still 定时器/alpha 收尾
    stopThanks();   // run-28: 共犯翻页定时器收尾
    restoreAncestors();
    creditState.armed = false;
    creditState.phase = 0;
}

// ============ SetVariableValue hook (独立 attach, 与 CutIn/其他 handler 分离 — F13) ============
function onSVV(a) {
    try {
        var name = readStr(a[1]);
        if (!name) return;
        if (!mgr || mgr.isNull()) mgr = a[0];
        var vp = a[2];
        var type = vp ? vp.readS32() : -1;
        if (name === "g_modCreditRoll") {
            var str = type === 0 ? readStr(vp.add(0x8).readPointer()) : null;
            if (!str) { warn("[v3][Credit] trigger: g_modCreditRoll 值非字符串, 忽略"); return; }
            var ok = loadCreditData(str);
            creditState.armed = ok;   // json 无效 → 不 arm, phase 走安全时长
            info("[v3][Credit] trigger '" + str + "' → " + (ok ? "已武装" : "json 无效 (时间线将走安全默认时长)") +
                 " | 捕获状态: scroll=" + (comp.rollScroll ? "有" : "无") + " thanks=" + (comp.rollThanks ? "有" : "无") +
                 " dict=" + (comp.dictCls ? "有" : "无") + " ui=" + (comp.creditsUI ? "有" : "无"));
        } else if (name === "g_modCreditRollPhase") {
            var phase = type === 1 ? vp.add(0x10).readFloat() : NaN;
            if (phase !== 1 && phase !== 2 && phase !== 3) return;
            if (!creditState.armed) {
                // 未 arm (json 失败/存档回放/中止后): 仍写安全时长, nani @Wait 永不悬挂 (R4)
                if (phase === 1) writeVar("g_staffDuration", 3);
                else if (phase === 2) writeVar("g_thanksDuration", 5);
                dbg("[v3][Credit] phase=" + phase + " 忽略 (未 arm — 存档回放/json 失败防御)");
                return;
            }
            creditState.phase = phase;
            dbg("[v3][Credit] phase=" + phase + " @" + (Date.now() % 100000) + "ms");
            if (phase === 1) {
                // run-30: 原版模式 phase=1 无自定义 staff — 滚动由 PlayAsync 全流程驱动, 立即进入 phase=2
                if (creditState.original) { writeVar("g_staffDuration", 0); dbg("[v3][Credit] 原版模式 phase=1: PlayAsync 驱动滚动, g_staffDuration=0"); }
                else doStaff();
            }
            else if (phase === 2) { if (creditState.original) doOriginal(); else doThanks(); }
            else if (phase === 3) doEnd();
        } else if (name === "g_creditTick") {
            // run-23: 主线程泵 — nani 轮询每轮 @set g_creditTick, 在同步 hook 里完成 PlayAsync
            if (creditState.original && pendingPlay) doPlayAsyncInvoke();
            // run-30f: Production 段 — 共犯完成置 pendingProduction 后, 主线程执行 doProduction
            //   (JS 线程调 get_ContentHeight/ScrollAsync = breakpoint triggered)
            if (creditState.pendingProduction) { creditState.pendingProduction = false; doProduction(); }
        }
    } catch (e) { error("[v3][Credit] onSVV err: " + e); }
}

// ============ 捕获钩子 ============
function onDirectorPlay(a) { try { captureFromDirector(a[0], "director.PlayAsync"); } catch (e) {} }
function onDirectorAwake(a) { try { captureFromDirector(a[0], "director.Awake"); } catch (e) {} }
function onCreditsUIPlayEnter(a) {
    try {
        if (!comp.creditsUI || comp.creditsUI.isNull()) {
            comp.creditsUI = a[0];
            info("[v3][Credit] CreditsUI 实例已捕获 (PlayAsync): " + a[0]);
        }
    } catch (e) {}
}
function onCreditsUIPlayLeave() {
    try { scanUiRolls(comp.creditsUI, "PlayAsync后"); } catch (e) {}
}
function onScrollAsync(a) {
    try {
        if (creditState.phase === 1) return;   // 我方 phase=1 的调用
        captureRolls(a[0], "原版 ScrollAsync");
    } catch (e) {}
}
function onShowAsync(a) {
    try {
        // dict 类兜底偷取 (任何 ShowAsync, 含我方 — 我方首次调用也偷得到, 后续 run 自愈)
        if (!comp.dictCls) {
            var d = a[1];
            if (d && !d.isNull()) {
                var dk = A.ogc(d);
                if (clsName(dk).indexOf("ReadOnlyDictionary") >= 0) {
                    var inner = d.add(0x18).readPointer();
                    if (inner && !inner.isNull()) dk = A.ogc(inner);
                }
                comp.dictCls = dk;
                info("[v3][Credit] 偷 dict 类 = " + clsName(dk));
            }
        }
        if (creditState.phase === 2) return;   // 我方 phase=2 的调用
        captureRolls(a[0], "原版 ShowAsync");
    } catch (e) { warn("[v3][Credit] onShowAsync err: " + e); }
}
// ScriptLoader.Load → 剧本切换 (goto/读档回放) = 演出中止 (F3; 存档回放变量如经 SetVariableValue
// 重放, 恢复顺序在 load 前后都会在此被拦 — 探针未实测回放路径, 首次实机验证)
function onScriptLoad(a) {
    try {
        if (creditState.armed) abortCredit("剧本切换 '" + (readStr(a[1]) || "?") + "'");
    } catch (e) {}
}

// ============ 入口 ============
export function setupCreditHooks() {
    try {
        if (creditHooksReady) return;
        if (!resolveCreditClasses()) return;
        // run-9 修复: 不再在启动期解析 dict 类 — dictClsViaReflection 开机执行时 access violation
        //   (访问违规被 catch, 但已损坏 IL2CPP 元数据状态 → 引擎初始化死锁 → 程序未响应)。
        //   dict 类延迟到 doThanks (phase=2, 引擎完全启动后) 首次 resolveDictCls 才解析。
        // P1: SetVariableValue (独立 attach — F13)
        var svvMi = A.cgm(cls.customVarMgr, Memory.allocUtf8String("SetVariableValue"), 2);
        if (svvMi && !svvMi.isNull()) {
            Interceptor.attach(svvMi.readPointer(), { onEnter: function (a) { try { onSVV(a); } catch (e) { warn("[v3][Credit] svv hook err: " + e); } } });
        } else warn("[v3][Credit] SetVariableValue NOT FOUND");
        // 捕获: CreditsUI.PlayAsync (实例+onLeave 子树) + director Awake/PlayAsync + 类级 ScrollAsync/ShowAsync
        var upMi = A.cgm(cls.creditsUI, Memory.allocUtf8String("PlayAsync"), 2);
        if (upMi && !upMi.isNull()) Interceptor.attach(upMi.readPointer(), { onEnter: onCreditsUIPlayEnter, onLeave: onCreditsUIPlayLeave });
        var dpMi = A.cgm(cls.director, Memory.allocUtf8String("PlayAsync"), 1);
        if (dpMi && !dpMi.isNull()) Interceptor.attach(dpMi.readPointer(), { onEnter: onDirectorPlay });
        var awMi = A.cgm(cls.director, Memory.allocUtf8String("Awake"), 0);
        if (awMi && !awMi.isNull()) Interceptor.attach(awMi.readPointer(), { onEnter: onDirectorAwake });
        var scMi = A.cgm(cls.rollScroll, Memory.allocUtf8String("ScrollAsync"), 2);
        if (scMi && !scMi.isNull()) Interceptor.attach(scMi.readPointer(), { onEnter: onScrollAsync });
        var saMi = A.cgm(cls.rollThanks, Memory.allocUtf8String("ShowAsync"), 5);
        if (saMi && !saMi.isNull()) Interceptor.attach(saMi.readPointer(), { onEnter: onShowAsync });
        // ScriptLoader.Load → 中止 (F3)
        var slMi = A.cgm(cls.scriptLoader, Memory.allocUtf8String("Load"), 2);
        if (slMi && !slMi.isNull()) Interceptor.attach(slMi.readPointer(), { onEnter: onScriptLoad });
        creditHooksReady = true;
        info("[v3][Credit] 演出控制器 hooks 就绪 (触发: @set g_modCreditRoll = \"data.json\")");
    } catch (e) { warn("[v3][Credit] setupCreditHooks err: " + e); }
}
// 回标题清状态 (entry.js TitleUi.Activate 调用): disarm + 还原残留祖先; comp 指针保留 —
// 探针 run-3 实证跨回标题存活 (同地址), 每次使用前字段探针复核, 失效则 ensureScroll/ensureThanks 重抓
export function clearCreditCaches() {
    try {
        if (creditState.armed) abortCredit("回标题");
        creditState.armed = false;
        creditState.phase = 0;
        for (var i = 0; i < deactivatedLabels.length; i++) {
            try { invoke(cgmChain(A.ogc(deactivatedLabels[i]), "SetActive", 1), deactivatedLabels[i], [boolPtr(true)]); } catch (e) {}
        }
        deactivatedLabels = [];
        restoreAncestors();
    } catch (e) { warn("[v3][Credit] clearCreditCaches err: " + e); }
}
