// scripttext.js — @print/@choice/@toast 的 `"文本"|#ID|` 引号修复 (2026-08-19 v5)
// 根因链 (probe_quotes.js + 三轮 modlog 实证):
//   * `"文本"`(无打标) = 纯 wrapped → MixedValueParser.UnescapePlain 剥引号 → 干净。
//   * `"文本"|#ID|` 混合值 → 引号留存在 LocalizableTextPart.text@0x18 字段 (ldfld 直读,
//     get_Text getter 从不触发); textMap 值 (GetTextOrNull) 是另一份, 供自动语音等。
//   * 显示链路分三支 (均已实证):
//       print  → RevealableText.set_Text(string)  [实例类 RevealableTextModified]  ← v3 修复点
//       toast  → ToastUI.Show(LocalizableText) → ToastAppearance.SetText(string)
//       choice → AdvChoiceHandlerButton.Initialize(ChoiceState) override (Gapless 真实按钮,
//                内部调 base ChoiceHandlerButton.Initialize; summary LocalizableText@0x20)
//   * 通用转换点: LocalizableText.ToString() 读 parts 拼串 (toast/choice/backlog 都可能走)。
// v5 变化:
//   * AdvChoiceHandlerButton.Initialize 独立 hook (override 直接挂, 早于 base) + ChoiceState
//     结构 dump 诊断 (id + summary parts 每 part id/text), 首触/诊断进 modlog。
//   * 新增 TMP_Text.set_text 基类兜底: v4 无 TMProText.set_text 首触 → choice 标签不是
//     NaninovelTMProText, 是普通 TextMeshProUGUI (不重写 set_text → 全走 TMP_Text 基类)。
// 修法 (输入侧剥 parts + 落点替换入参, 双保险):
//   1. AppendText (Debate/Revealable) + ToastUI.Show + ChoiceHandlerButton.Initialize +
//      AdvChoiceHandlerButton.Initialize + LocalizableText.ToString 的 onEnter: 把 parts 的
//      text@0x18 换剥引号新串 (幂等)。
//   2. RevealableText.set_Text / ToastAppearance.SetText / NaninovelTMProText.set_text /
//      TMP_Text.set_text 的 onEnter: 直接把入参 args[1] 换成剥引号新串 (最终赋值点)。
//   3. FormatMessage (2参/1参) / get_Text / GetTextOrNull onLeave: 剥返回串 (兜底)。
// 保护: isWrappedPtr 指针级快判 (首尾 `"` 且长度≥3, 不整串解码); 剥前解码 + isSingleWrapped
//   (全串只允许首尾一对引号, 防 "a""b" 多段误剥); 高频 getter 不拖慢; `""` 空壳不碰。
'use strict';

import { A, dbg, findClassAcrossImages, makeS, readStr, wblog } from "./utils.js";

var hooked = false;
var cnt = { append: 0, fmt: 0, gto: 0, getText: 0, display: 0, tostr: 0 };

function isWrapped(s) {
    return s.length >= 3 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"';
}
// 整串只含首尾一对引号 (单段包裹; "a""b" 多段拼接不剥)
function isSingleWrapped(s) {
    if (!isWrapped(s)) return false;
    for (var i = 1; i < s.length - 1; i++) if (s.charAt(i) === '"') return false;
    return true;
}
// 指针级快速判定: 串是否整串 `"…"` 包裹? (只读长度 + 首/尾字符, 不整串解码)
function isWrappedPtr(p) {
    if (!p || p.isNull()) return false;
    try {
        var l = p.add(0x10).readS32();
        if (l < 3 || l > 9999) return false;
        var base = p.add(0x14);
        if (base.readU16() !== 0x22) return false;            // 首 != '"'
        return base.add((l - 1) * 2).readU16() === 0x22;      // 尾 == '"'
    } catch (e) { return false; }
}
function logStrip(tag, s, inner, n) {
    if (n === 1) wblog("剧本引号修复: 首个剥引号 [" + tag + "] \"" + s + "\" → \"" + inner + "\"");
    else dbg("[v3] scripttext: 剥引号 [" + tag + "] \"" + s + "\" → \"" + inner + "\" (累计 " + n + ")");
}
// 判定指针是 LocalizableTextPart[] 数组 (LocalizableText 结构体可能按值/按指针传参, 双重形态都验)
function looksLikePartArray(p) {
    if (!p || p.isNull()) return false;
    try {
        var c = A.ogc(p);
        if (c.isNull()) return false;
        var n = A.cgn(c).readCString() || "";
        if (n.indexOf("LocalizableTextPart") < 0) return false;
        var ml = p.add(0x18).readS32();
        return ml >= 0 && ml <= 64;
    } catch (e) { return false; }
}
function whoAmI(self) { try { return A.cgn(A.ogc(self)).readCString() || "?"; } catch (e) { return "?"; } }
var firstSeen = {};
function noteCaller(tag, self) {
    if (firstSeen[tag]) return;
    firstSeen[tag] = 1;
    wblog("剧本引号修复: 首触 [" + tag + "] 实例类=" + whoAmI(self));
}

// ---------- parts 剥引号: 给定已验证 LocalizableTextPart[] 指针 ----------
function stripPartsArray(arr, tag) {
    var maxLen = arr.add(0x18).readS32();
    var data = arr.add(0x20);                 // 元素 0x20: id@0x0 spot@0x8 text@0x18
    for (var i = 0; i < maxLen; i++) {
        var part = data.add(i * 0x20);
        var txtPtr = part.add(0x18).readPointer();
        if (!isWrappedPtr(txtPtr)) continue;
        var s = readStr(txtPtr);
        if (!isSingleWrapped(s)) continue;
        var inner = s.substring(1, s.length - 1);
        part.add(0x18).writePointer(makeS(inner));
        cnt.append++;
        logStrip(tag, s, inner, cnt.append);
    }
}
// 诊断: dump ChoiceState 的 summary parts 结构 (id + 每 part id/text), 只打一次
var _choiceDumped = {};
function dumpChoiceState(cs, tag) {
    try {
        var id = readStr(cs.add(0x0).readPointer());
        var arr = cs.add(0x20).readPointer();
        var info = tag + " 诊断 id='" + (id || "") + "' summary";
        if (!arr || arr.isNull()) { info += "=null"; }
        else {
            var cn = A.cgn(A.ogc(arr)).readCString() || "?";
            var ml = arr.add(0x18).readS32();
            info += "=" + cn + " len=" + ml;
            var data = arr.add(0x20);
            for (var i = 0; i < Math.min(ml, 4); i++) {
                var part = data.add(i * 0x20);
                var pid = readStr(part.readPointer());
                var ptxt = readStr(part.add(0x18).readPointer());
                info += " [" + i + "] " + (pid || "") + "='" + (ptxt || "") + "'";
            }
        }
        wblog("剧本引号修复: " + info);
    } catch (e) { dbg("[v3] scripttext dumpChoiceState err: " + e); }
}
// 从参数 idx 解析 LocalizableText → parts 数组并剥 (兼容按值/按指针两种传参形态)
function stripPartsFromArg(args, idx, tag) {
    var arr = args[idx];
    if (!looksLikePartArray(arr)) {
        var alt = arr.readPointer();          // 值类型按指针传时: 8B struct → parts 数组指针
        if (!looksLikePartArray(alt)) return;
        arr = alt;
    }
    stripPartsArray(arr, tag);
}

// ---------- 输入侧 hook: 剥 parts ----------
function makeAppendEnter(tag) {
    return function (args) {
        try { noteCaller(tag, args[0]); stripPartsFromArg(args, 1, tag); }
        catch (e) { dbg("[v3] scripttext " + tag + " err: " + e); }
    };
}
// ChoiceHandlerButton.Initialize(ChoiceState): summary(LocalizableText)@0x20
function onChoiceInitEnter(args) {
    try {
        noteCaller("ChoiceInit", args[0]);
        var cs = args[1];
        if (!cs || cs.isNull()) return;
        dumpChoiceState(cs, "ChoiceInit");
        var arr = cs.add(0x20).readPointer();   // ChoiceState.summary → parts 数组
        if (!looksLikePartArray(arr)) return;
        stripPartsArray(arr, "ChoiceSummary");
    } catch (e) { dbg("[v3] scripttext ChoiceInit err: " + e); }
}
// AdvChoiceHandlerButton.Initialize(ChoiceState) override (Gapless 真实按钮):
// override 内部调 base → 基类 hook 也触发; 这里直接挂在 override 上, 尽早看到 summary 结构。
function onAdvChoiceInitEnter(args) {
    try {
        noteCaller("AdvChoiceInit", args[0]);
        var cs = args[1];
        if (!cs || cs.isNull()) return;
        dumpChoiceState(cs, "AdvChoiceInit");
        var arr = cs.add(0x20).readPointer();
        if (!looksLikePartArray(arr)) {
            var alt = arr.readPointer();        // 值类型按指针传时 8B struct → parts 指针
            if (!looksLikePartArray(alt)) return;
            arr = alt;
        }
        stripPartsArray(arr, "AdvChoiceSummary");
    } catch (e) { dbg("[v3] scripttext AdvChoiceInit err: " + e); }
}
// LocalizableText.ToString(): args[0] = struct 指针 (parts 数组指针@0x0)
function onLTToStringEnter(args) {
    try {
        var arr = args[0];
        if (!looksLikePartArray(arr)) {
            var alt = arr.readPointer();
            if (!looksLikePartArray(alt)) return;
            arr = alt;
        }
        stripPartsArray(arr, "LT.ToString");
    } catch (e) { dbg("[v3] scripttext LT.ToString err: " + e); }
}

// ---------- 落点 hook: 直接替换入参 ----------
function makeArgStripEnter(tag) {
    return function (args) {
        try {
            noteCaller(tag, args[0]);
            var p = args[1];
            if (!isWrappedPtr(p)) return;
            var s = readStr(p);
            if (!isSingleWrapped(s)) return;
            var inner = s.substring(1, s.length - 1);
            args[1] = makeS(inner);
            cnt.display++;
            logStrip(tag, s, inner, cnt.display);
        } catch (e) { dbg("[v3] scripttext " + tag + " err: " + e); }
    };
}

// ---------- 返回串剥引号 (兜底) ----------
function makeFmtOnLeave(tag) {
    return function (ret) {
        try {
            if (!ret || !isWrappedPtr(ret)) return;
            var s = readStr(ret);
            if (!isSingleWrapped(s)) return;
            var inner = s.substring(1, s.length - 1);
            this.returnValue = makeS(inner);
            cnt.fmt++;
            logStrip(tag, s, inner, cnt.fmt);
        } catch (e) { dbg("[v3] scripttext " + tag + " err: " + e); }
    };
}
function onGetTextLeave(ret) {
    try {
        if (!ret || !isWrappedPtr(ret)) return;
        var s = readStr(ret);
        if (!isSingleWrapped(s)) return;
        var inner = s.substring(1, s.length - 1);
        this.returnValue = makeS(inner);
        cnt.getText++;
        logStrip("get_Text", s, inner, cnt.getText);
    } catch (e) {}
}
function onGetTextOrNullLeave(ret) {
    try {
        if (!ret || !isWrappedPtr(ret)) return;
        var s = readStr(ret);
        if (!isSingleWrapped(s)) return;
        var inner = s.substring(1, s.length - 1);
        this.returnValue = makeS(inner);
        cnt.gto++;
        logStrip("GetTextOrNull", s, inner, cnt.gto);
    } catch (e) {}
}

function attachIf(mi, onEnter, onLeave) {
    if (!mi || mi.isNull()) return 0;
    var h = {};
    if (onEnter) h.onEnter = onEnter;
    if (onLeave) h.onLeave = onLeave;
    Interceptor.attach(mi.readPointer(), h);
    return 1;
}

export function setupScriptTextHooks() {
    try {
        if (hooked) return;
        var ok = 0;
        // ---- 显示输入侧: 剥 parts ----
        // 真实/标准 print 面板
        var debate = findClassAcrossImages("WitchTrials.Views", "DebateTextPrinterPanel");
        if (debate && !debate.isNull()) {
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("AppendText"), 1), makeAppendEnter("DebateAppendText"));
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("SetText"), 1), makeArgStripEnter("SetText"));
            ok += attachIf(A.cgm(debate, Memory.allocUtf8String("AddText"), 1), makeArgStripEnter("AddText"));
        }
        var re = findClassAcrossImages("Naninovel.UI", "RevealableTextPrinterPanel");
        if (re && !re.isNull()) {
            ok += attachIf(A.cgm(re, Memory.allocUtf8String("AppendText"), 1), makeAppendEnter("RevealAppendText"));
            ok += attachIf(A.cgm(re, Memory.allocUtf8String("FormatMessage"), 2), null, makeFmtOnLeave("FormatMessage"));
        }
        // toast
        var tui = findClassAcrossImages("Naninovel.UI", "ToastUI");
        if (tui && !tui.isNull()) {
            ok += attachIf(A.cgm(tui, Memory.allocUtf8String("Show"), 3), makeAppendEnter("ToastShow"));
        }
        // choice: ChoiceHandlerButton.Initialize(ChoiceState) → summary@0x20
        var cbtn = findClassAcrossImages("Naninovel.UI", "ChoiceHandlerButton");
        if (cbtn && !cbtn.isNull()) {
            ok += attachIf(A.cgm(cbtn, Memory.allocUtf8String("Initialize"), 1), onChoiceInitEnter);
        }
        // choice(Gapless): AdvChoiceHandlerButton.Initialize override (WitchTrials.Views)
        var acbtn = findClassAcrossImages("WitchTrials.Views", "AdvChoiceHandlerButton");
        if (acbtn && !acbtn.isNull()) {
            ok += attachIf(A.cgm(acbtn, Memory.allocUtf8String("Initialize"), 1), onAdvChoiceInitEnter);
        }
        // 通用转换: LocalizableText.ToString() (toast/choice/backlog 拼串源头)
        var lt = findClassAcrossImages("Naninovel", "LocalizableText");
        if (lt && !lt.isNull()) {
            ok += attachIf(A.cgm(lt, Memory.allocUtf8String("ToString"), 0), onLTToStringEnter);
        }
        // ---- 显示落点: 替换入参 ----
        var rt = findClassAcrossImages("Naninovel.UI", "RevealableText");
        if (rt && !rt.isNull()) {
            ok += attachIf(A.cgm(rt, Memory.allocUtf8String("set_Text"), 1), makeArgStripEnter("RevealableText.set_Text"));
        }
        var toast = findClassAcrossImages("Naninovel.UI", "ToastAppearance");
        if (toast && !toast.isNull()) {
            ok += attachIf(A.cgm(toast, Memory.allocUtf8String("SetText"), 1), makeArgStripEnter("ToastSetText"));
        }
        // 兜底: 所有 Naninovel 文本组件的最终 text 赋值 (print/toast/choice 标签都可能走)
        var ntt = findClassAcrossImages("", "NaninovelTMProText");
        if (ntt && !ntt.isNull()) {
            ok += attachIf(A.cgm(ntt, Memory.allocUtf8String("set_text"), 1), makeArgStripEnter("TMProText.set_text"));
        }
        // 兜底2: 普通 TMP_Text.set_text 基类 (choice 标签非 NaninovelTMProText, v4 无首触 →
        //        走 TMPro 基类实现; TextMeshProUGUI 不重写 set_text, 全都会被这里截住)
        var tmpText = findClassAcrossImages("TMPro", "TMP_Text");
        if (tmpText && !tmpText.isNull()) {
            ok += attachIf(A.cgm(tmpText, Memory.allocUtf8String("set_text"), 1), makeArgStripEnter("TMP.set_text"));
        }
        // ---- 返回串剥引号 (兜底) ----
        var ui = findClassAcrossImages("Naninovel.UI", "UITextPrinterPanel");
        if (ui && !ui.isNull()) {
            ok += attachIf(A.cgm(ui, Memory.allocUtf8String("FormatMessage"), 1), null, makeFmtOnLeave("FmtBase"));
        }
        var pt = findClassAcrossImages("Naninovel", "LocalizableTextPart");
        if (pt && !pt.isNull()) {
            ok += attachIf(A.cgm(pt, Memory.allocUtf8String("get_Text"), 0), null, onGetTextLeave);
        }
        var map = findClassAcrossImages("Naninovel", "ScriptTextMap");
        if (map && !map.isNull()) {
            ok += attachIf(A.cgm(map, Memory.allocUtf8String("GetTextOrNull"), 1), null, onGetTextOrNullLeave);
        }
        if (!ok) { dbg("[v3] scripttext: 全部目标类未找到, 跳过"); return; }
        hooked = true;
        wblog("剧本引号修复模块已装载 (" + ok + " 个 hook: 显示输入侧+落点+源头)");
    } catch (e) { dbg("[v3] scripttext init err: " + e); }
}
