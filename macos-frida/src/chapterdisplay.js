// ModChapterDisplay — 存档画面自定义章节名 (镜像 Windows ModChapterDisplay.cs)
// 原理: 存档槽刷新 (SaveLoadPanel → GameStateSlotsGridExtended.BindSlotAsync →
//       slot.SetNonEmptyState) 从 GameStateMap 读 PlaybackSpot, 原版 BuildSubTitleText
//       解析 ChapterKind → 对 mod 脚本路径解析失败 (Windows 上抛 NullReferenceException,
//       C# 蓝本用 Harmony Finalizer 压制 + Postfix 覆写; macOS 无 Finalizer 等价物,
//       改 onEnter 预覆写: 游戏方法内 NRE 若未被接住, onLeave 不执行, 预覆写保证显示仍生效,
//       onLeave 兜底覆写: 原版 SetSubTitleText 正常返回覆盖了我们的文本时再覆写)。
// 数据: run_mod.sh 扫描 info.json 的 ChapterNames 注入全局 chapterNames (脚本路径 → 章节名)。
// 踩坑记录:
//   * 双 hook: 存档槽实例是 WitchTrialsGameStateSlot, 但 C# 蓝本 patch 基类
//     GameStateSlotExtended → 两个类都 hook (谁触发都覆盖, 幂等)。
//   * PlaybackSpot.scriptPath 固定 @0x0: 按名查找和字段类型反查 (A.fgt+A.cft) 在
//     macOS 上都返回 scriptPath@0x10 的错类, 已被实例内存实证 (spot[0]=路径字符串)
//     推翻; 与 Windows dump 及 C# 蓝本注释一致。
//   * 指针守卫: onLeave 时 state 可能已失效、空槽 _subTitleLabel 可能是垃圾值
//     (非 null 但非法), A.ogc/invoke 前必须验证, 小地址 (<0x10000) 视为非法。
//   * set_richText/set_text 用 directCall 直调 methodPointer: il2cpp_runtime_invoke
//     对该调用 access violation at 0x1 (invoke 不可靠的又一样本), directCall 绕开。
//   * 日志重复: 子类未 override 基类虚方法时, 两个类的 cgm 解析到同一 methodPointer,
//     Frida 同地址 attach 两次 → 每次调用 4 条日志 (2 hook × onEnter+onLeave)。
//     修复: hookedAddrs 去重 (同实现只 attach 一次) + 日志只在 onEnter 打 (onLeave 静默)。
// 布局 (运行时读, 不硬编码 Windows dump 偏移):
//   GameStateMap.playbackSpot    (值类型 PlaybackSpot, offset 运行时读)
//   PlaybackSpot.scriptPath      (string @ +0x0)
//   GameStateSlotExtended._subTitleLabel (TMP_Text, offset 运行时读)
'use strict';

import { A, dbg, directCall, findClassAcrossImages, makeS, readStr, wblog } from "./utils.js";

var chapterMap = null;
var offs = null;      // {playbackSpot, scriptPath, subTitleLabel}
var hooked = false;
var hookedAddrs = {}; // methodPointer 去重: 子类未 override 虚方法时两类的 cgm 同指, 只 attach 一次

function resolveOffsets() {
    try {
        var o = {};
        var gsm = findClassAcrossImages("Naninovel", "GameStateMap");
        if (gsm.isNull()) return null;
        var f = A.gf(gsm, Memory.allocUtf8String("playbackSpot"));
        if (!f || f.isNull()) return null;
        o.playbackSpot = A.fo(f);
        o.scriptPath = 0;   // 见头部注释: 实证固定 0
        // _subTitleLabel 定义在基类 GameStateSlotExtended (实例偏移一致)
        var gsse = findClassAcrossImages("GigaCreation.NaninovelExtender.Ui", "GameStateSlotExtended");
        if (gsse.isNull()) return null;
        var f3 = A.gf(gsse, Memory.allocUtf8String("_subTitleLabel"));
        if (!f3 || f3.isNull()) return null;
        o.subTitleLabel = A.fo(f3);
        return o;
    } catch (e) { dbg("[v3] chapterdisplay resolveOffsets err: " + e); return null; }
}

// 命中映射则覆写 _subTitleLabel; 未命中/指针非法时静默 (原版路径完全走原版行为)
// logIt=false (onLeave 兜底覆写) 不打日志 — 与 onEnter 同一调用, 重复无信息量
function applyChapterName(slotPtr, statePtr, logIt) {
    if (!statePtr || statePtr.isNull() || !slotPtr || slotPtr.isNull()) return;
    if (statePtr.toInt32() < 0x10000 || slotPtr.toInt32() < 0x10000) return;
    var spot = statePtr.add(offs.playbackSpot);
    var sp = spot.add(offs.scriptPath).readPointer();
    if (sp.isNull() || sp.toInt32() < 0x10000) return;
    var path = readStr(sp);
    if (!path) return;
    var name = chapterMap[path];
    if (!name) return;
    var lab = slotPtr.add(offs.subTitleLabel).readPointer();
    if (lab.isNull() || lab.toInt32() < 0x10000) return;
    var labCls = null;
    try { labCls = A.ogc(lab); } catch (e) { return; }
    if (!labCls || labCls.isNull()) return;
    var rt = A.cgm(labCls, Memory.allocUtf8String("set_richText"), 1);
    if (rt && !rt.isNull()) directCall(rt, 'void', [lab, ptr(1)]);
    var st = A.cgm(labCls, Memory.allocUtf8String("set_text"), 1);
    if (st && !st.isNull()) directCall(st, 'void', [lab, makeS(name)]);
    if (logIt) wblog("存档槽章节名: " + path + " → " + name);
}

export function setupChapterDisplayHooks() {
    try {
        if (hooked) return;
        hooked = true;
        if (typeof chapterNames === "undefined" || !chapterNames) {
            dbg("[v3] chapterNames 未注入 (无 mod 声明 ChapterNames), 跳过章节名模块");
            return;
        }
        var keys = Object.keys(chapterNames);
        if (!keys.length) { dbg("[v3] chapterNames 为空, 跳过章节名模块"); return; }
        chapterMap = chapterNames;
        offs = resolveOffsets();
        if (!offs) { dbg("[v3] !! 章节名字段解析失败, 跳过"); return; }
        dbg("[v3] chapter: offsets playbackSpot=" + offs.playbackSpot +
            " scriptPath=" + offs.scriptPath + " subTitleLabel=" + offs.subTitleLabel);
        // 实际实例是 WitchTrialsGameStateSlot (子类), C# 蓝本 patch 基类 → 两个都 hook
        var candidates = [
            ["WitchTrials.Views", "WitchTrialsGameStateSlot"],
            ["GigaCreation.NaninovelExtender.Ui", "GameStateSlotExtended"]
        ];
        var hookCount = 0;
        candidates.forEach(function (c) {
            var cls = findClassAcrossImages(c[0], c[1]);
            if (cls.isNull()) return;
            var mi = A.cgm(cls, Memory.allocUtf8String("SetNonEmptyState"), 2);
            if (!mi || mi.isNull()) return;
            var mp = mi.readPointer();
            if (hookedAddrs[mp.toString()]) {   // 同一实现 (子类未 override) 只 attach 一次, 避免双日志
                dbg("[v3] chapter: " + c[1] + " 与已 hook 实现同址 (" + mp + "), 跳过重复 attach");
                return;
            }
            hookedAddrs[mp.toString()] = true;
            Interceptor.attach(mp, {
                onEnter: function (a) {
                    // 实例方法: a[0]=this(slot), a[1]=slotNumber(int), a[2]=state(GameStateMap)
                    this.self = a[0]; this.state = a[2];
                    try { applyChapterName(a[0], a[2], true); } catch (e) { dbg("[v3] chapter onEnter err: " + e); }
                },
                onLeave: function () {
                    // 兜底覆写: 原版 SetSubTitleText 正常返回把文本改回时再覆写; 静默 (同一调用)
                    try { applyChapterName(this.self, this.state, false); } catch (e) { dbg("[v3] chapter onLeave err: " + e); }
                }
            });
            hookCount++;
            dbg("[v3] chapter: hooked " + c[1] + ".SetNonEmptyState @ " + mp);
        });
        if (!hookCount) { dbg("[v3] !! 存档槽 SetNonEmptyState(2) 均未找到, 跳过章节名模块"); return; }
        wblog("章节名模块已装载 (" + keys.length + " 个条目, " + hookCount + " 个 hook)");
    } catch (e) { dbg("[v3] chapterdisplay init err: " + e); }
}
