// ============ WitchBook 读档探针 (2026-10-07) ============
// 目的: 把"@AutoSave 存 → 读档 → mod 图鉴条目只剩原版"这条推断链变成实锤, **全只读**。
//   开: MOD_WB_PROBE=1 ./run_mod.sh      (默认关, 不设 = 一行都不装, 零开销)
//   关: 去掉环境变量
//   读: grep '\[WBPROBE\]' <游戏目录>/modlog.log
//
// 为什么要探针 (2026-10-06 静态推断, 未验证): 存档 .nson 解出来是 raw deflate JSON, 里面
//   `VersionedState InstanceID=ClueState` 等**确实带着 mod 条目和版本号**, 自定义变量 modKey 也在 →
//   "存"没问题, 嫌疑全在"读"侧。读侧有两处疑似断点, 探针就是拿来二选一定案的:
//     A. 身份断点: 本移植版判定当前 mod 只靠 ScriptLoader.Load 的 path **全等** info.json 的 Enter;
//        读档恢复时 path 是存档所在的**子剧本**(实测 1919180_02/Trial01), Enter 是 1919180_02/Main_02
//        → 失配 → wbCurrentMod=null → currentModIds() 空 → injectPage 一个条目都不注入。
//     B. 状态断点: 回标题 resetWitchBookSession() 清空 wbData.states, 且游戏 DeserializeState
//        可能把页面 _state 覆盖/过滤掉 → 就算条目注入了也没有版本 → 显示层滤掉。
//
// 采集四类事实 (每类对应上面一个环节):
//   ① 读档动作何时发生   — StateManager.LoadGame/SaveGame/QuickLoad/QuickSave/AutoSaveAsync
//   ② 读档加载了哪条剧本 — ScriptLoader.Load(path) vs 各 mod 的 Enter (探针自己比对, 不改 detectCurrentMod)
//   ③ 变量 modKey 此刻值 — 上游 Windows 用它判定当前 mod(存档持久化), 本移植版没读它
//   ④ 图鉴页面运行时布局 — _itemIds / _state._list / _loadedDataItemMap / _localizedTextData
//                          + JS 侧 wbCurrentMod / wbPrevMod / wbData.states
// 时序: 行内带相对本探针第一条事件的毫秒数, 用来读"什么先发生"。
//
// 只读保证: 只有 Interceptor.attach + 读内存。唯一的托管调用是 CustomVariableManager.GetVariableValue
//   (纯查询, 不改状态); 值类型返回值按 invoke 的 boxed 约定读 (+0x10 载荷, 见 utils.invokeBool 注释)。
// 空 catch 说明 (与项目"空 catch 留痕"约定的例外, 有意为之): 本文件所有读内存的 catch 都**故意静默** ——
//   ① plog 的 catch 不能再调 swallowed (日志失败再走日志 = 递归);
//   ② dumpCat 的 4 处读失败在输出里以 -1 / <未读到> 呈现, 本身就是给排查看的信号, 再打 WARN 只会刷屏。
import { A, dbg, error, findAllObjectOfType, findClassAcrossImages, fieldOffset, findSvc, invokeOk, makeS, readStr, swallowed, warn, wblog } from "./utils.js";
import { wbCats } from "./witchbook/data.js";
import { wbCls, wbCurrentMod, wbData, wbPrevMod } from "./witchbook/state.js";

var ON = (typeof MOD_WB_PROBE !== "undefined") && MOD_WB_PROBE;
var _t0 = 0, _seq = 0;
function stamp() {
    var now = Date.now();
    if (!_t0) _t0 = now;
    return "+" + (now - _t0) + "ms";
}
function plog(msg) {
    try { wblog("[WBPROBE] " + stamp() + " " + msg); } catch (e) { }
}

// ===== 读 Naninovel 自定义变量 modKey (只读查询) =====
// CustomVariableValue 是值类型 → il2cpp_runtime_invoke 返回 boxed 对象, 载荷在 +0x10:
//   type@+0x10 (String=0), stringValue@+0x18, numeric@+0x20, bool@+0x24
// (与 cutin.js 记的"传参struct: type@0x0/stringValue@0x8"是同一布局, 差一个 box 头)
// 首跑 (2026-10-07) 现象: 同一个调用时好时坏 —— 坏的时刻集中在"游戏正在序列化/反序列化状态"期间
// (SerializeState onLeave、某些 DeserializeState 后的下一个事件), 说明此刻重入变量管理器会抛异常。
// 对策: 成功值缓存 + 失败时回报缓存 (标 <缓存>), 避免"取证时刻刚好读不到"变成盲区。
var _cvSvc = null, _cvMi = null, _cvWarned = false, _lastModKey = null, _lastModKeyAt = 0;
var _lateEnough = false;   // 首个 ScriptLoader.Load 之前引擎服务表还没就绪 → 别碰 findSvc (会刷 ERROR 噪音)
export function readModKey() {
    var why = null;
    if (!_lateEnough) return "<引擎未就绪>";
    try {
        if (!_cvSvc || _cvSvc.isNull()) _cvSvc = findSvc("CustomVariableManager", true);
        if (!_cvSvc || _cvSvc.isNull()) why = "<无服务>";
        else {
            if (!_cvMi || _cvMi.isNull()) {
                _cvMi = A.cgm(A.ogc(_cvSvc), Memory.allocUtf8String("GetVariableValue"), 1);
                if (!_cvMi || _cvMi.isNull()) why = "<无方法>";
            }
            if (!why) {
                var r = invokeOk(_cvMi, _cvSvc, [makeS("modKey")]);
                if (!r.ok) why = "<invoke失败>";
                else {
                    var ret = r.ret;
                    if (!ret || ret.isNull()) why = "<null>";
                    else {
                        var cn = "";
                        try { cn = A.cgn(A.ogc(ret)).readCString() || ""; } catch (e0) { }
                        // 按类型名判定"确实是 boxed CustomVariableValue"再解引用 —— 读错结构比读不到更糟
                        if (cn.indexOf("CustomVariableValue") < 0) why = "<非CustomVariableValue:" + cn + ">";
                        else {
                            var pay = ret.add(0x10);
                            var t = pay.readS32();
                            if (t !== 0) why = "<非String type=" + t + ">";
                            else {
                                var v = readStr(pay.add(0x8).readPointer());
                                if (v === null) why = "<空串>";
                                else { _lastModKey = v; _lastModKeyAt = Date.now(); return v; }
                            }
                        }
                    }
                }
            }
        }
    } catch (e) { why = "<err " + e + ">"; }
    if (_lastModKey !== null) return _lastModKey + "<缓存" + (Date.now() - _lastModKeyAt) + "ms前>";
    if (!_cvWarned) { _cvWarned = true; plog("modKey 读取失败(" + why + "): 尚无成功值可缓存"); }
    return why;
}

// ===== mod 条目集合 (来自 info.json 的 wbData) =====
// all[cat][id]=1 全部 mod 条目; byKey[cat][id]=modKey 归属。用集合判定"页面里这条是不是 mod 的"。
function modIdSets() {
    var all = {}, byKey = {}, counts = {};
    var names = Object.keys(wbCats);
    for (var i = 0; i < names.length; i++) {
        var cn = wbCats[names[i]].name;
        all[cn] = {}; byKey[cn] = {}; counts[cn] = 0;
        var src = wbData[cn] || {};
        // 键统一加 "|" 前缀: 判定用的集合是普通对象, 若 id 撞上 Object.prototype 的键
        // (constructor/toString/…) 会误判成命中 —— 首跑 profile 行 "127 条全是 mod" 的头号嫌疑
        for (var id in src) { all[cn]["|" + id] = 1; byKey[cn]["|" + id] = src[id].key; counts[cn]++; }
    }
    return { all: all, byKey: byKey, counts: counts };
}

// 读一个 List<T> 的 (count, 元素基址)。IL2CPP 的 List<T>: items@0x10(指针), size@0x18。
// ⚠ 数组 (T[]) 布局**不同**: bounds@0x10(指针, 常为 null), length@0x18, 元素**紧跟对象头** 0x20 ——
//   2026-10-07 首跑把两者混用 → _itemIds 全读成 -1 (见 arrayOf)。
function listOf(p) {
    try {
        if (!p || p.isNull()) return null;
        var n = p.add(0x18).readS32();
        if (n < 0 || n > 100000) return null;
        var items = p.add(0x10).readPointer();
        if (items.isNull()) return null;
        return { n: n, base: items.add(0x20) };
    } catch (e) { return null; }
}
// 读一个 T[] 的 (length, 元素基址): 基址就是对象自身 +0x20 (与 witchbook/pages.js 同一读法)
function arrayOf(p) {
    try {
        if (!p || p.isNull()) return null;
        var n = p.add(0x18).readS32();
        if (n < 0 || n > 100000) return null;
        return { n: n, base: p.add(0x20) };
    } catch (e) { return null; }
}

// ===== 页面布局 dump (一条分类一行) =====
function dumpCat(cat, sets) {
    var pageCls = (wbCls && wbCls.pages) ? wbCls.pages[cat.name] : null;
    if (!pageCls || pageCls.isNull()) return cat.name + "=<类未解析>";
    var pages = findAllObjectOfType(pageCls);
    if (!pages.length) return cat.name + "=<无实例>";
    var page = pages[0];
    var ids = sets.all[cat.name] || {};

    // _itemIds (string[]): 游戏 UpdateVersion 的 Contains 门
    var idsN = -1, idsMod = 0;
    try {
        var la = page.add(fieldOffset(pageCls, "_itemIds", 0x98)).readPointer();
        var l = arrayOf(la);
        if (l) {
            idsN = l.n;
            for (var i = 0; i < l.n; i++) { var s = readStr(l.base.add(i * 8).readPointer()); if (s && ids["|" + s]) idsMod++; }
        }
    } catch (e) { }

    // _state._list (List<IdVersionPair>: Id@0x10, Version@0x18): 显示层的门 + 存档序列化的来源
    var stN = -1, stMod = [];
    try {
        var st = page.add(fieldOffset(pageCls, "_state", 0x48)).readPointer();
        var lst = listOf(st.add(fieldOffset(wbCls.versionedState, "_list", 0x10)).readPointer());
        if (lst) {
            stN = lst.n;
            for (var r0 = 0; r0 < lst.n; r0++) {
                var e = lst.base.add(r0 * 8).readPointer();
                if (e.isNull()) continue;
                var id = readStr(e.add(0x10).readPointer());
                if (id && ids["|" + id]) stMod.push(id + "@" + e.add(0x18).readS32());
            }
        }
    } catch (e) { }

    // _loadedDataItemMap (List<VersionedItem>: _id@0x10): 读档时被 LoadDataAsync 从这里重建
    // 附带前 2 条原始 id: 判定异常时(例如"整页全算成 mod")靠它区分是"真命中"还是"读错结构"
    var mapN = -1, mapMod = 0, mapSample = [];
    try {
        var ml = listOf(page.add(fieldOffset(pageCls, "_loadedDataItemMap", 0x88)).readPointer());
        if (ml) {
            mapN = ml.n;
            for (var r1 = 0; r1 < ml.n; r1++) {
                var me = ml.base.add(r1 * 8).readPointer();
                if (me.isNull()) continue;
                var mid = readStr(me.add(0x10).readPointer());
                if (r1 < 2) mapSample.push(mid === null ? "<null>" : "'" + mid + "'");
                if (mid && ids["|" + mid]) mapMod++;
            }
        }
    } catch (e) { }

    // _localizedTextData (Dictionary<IdVersionPair,...>): 条目数 @0x20 (与 pages.js 同一读法)
    var locN = -1;
    try {
        var outer = page.add(fieldOffset(pageCls, "_localizedTextData", cat.locOff)).readPointer();
        if (!outer.isNull()) locN = outer.add(0x20).readS32();
    } catch (e) { }

    return cat.name + " ids=" + idsN + "(mod " + idsMod + ")" +
        " state=" + stN + "(mod " + stMod.length + ")" + (stMod.length ? " {" + stMod.slice(0, 12).join(",") + "}" : "") +
        " map=" + mapN + (mapSample.length ? " [" + mapSample.join(",") + "]" : "") + "(mod " + mapMod + ")" +
        " loc=" + locN;
}

// JS 侧状态一行: 身份 (wbCurrentMod) + 变量 modKey + 各分类"当前 mod 条目数 / wbData.states 条数"
function dumpJsState() {
    var sets = modIdSets();
    var mk = readModKey();
    var per = [];
    var names = Object.keys(wbCats);
    for (var i = 0; i < names.length; i++) {
        var cn = wbCats[names[i]].name;
        var owned = 0;
        for (var id in (wbData[cn] || {})) if (wbData[cn][id].key === wbCurrentMod) owned++;
        var st = (wbData.states[cn] || {});
        per.push(cn + ":" + owned + "/st" + Object.keys(st).length);
    }
    return "JS wbCurrentMod=" + (wbCurrentMod || "<null>") + " wbPrevMod=" + (wbPrevMod || "<null>") +
        " | 变量modKey=" + mk + " | mod条目数 clue/profile/rule/note=" + sets.counts.clue + "/" + sets.counts.profile + "/" + sets.counts.rule + "/" + sets.counts.note +
        " | 本mod条目/状态 " + per.join(" ");
}

// 完整快照: 第一行身份, 之后每分类一行
// 节流: 游戏可能在**每次回滚快照**(≈每行剧本)都调 SerializeState —— 那种点位的快照是噪音且会拖慢
//   主线程, 所以标 chatty 的按 1s 间隔丢弃; 关键点位(读档恢复后/开图鉴)不节流。另有总量上限兜底。
var _dumpSeq = 0, _lastChattyAt = 0, DUMP_CAP = 300;
function dumpBook(tag, chatty) {
    if (_dumpSeq >= DUMP_CAP) {
        if (_dumpSeq === DUMP_CAP) { _dumpSeq++; plog("快照已达上限 " + DUMP_CAP + " 次, 后续静默 (防刷爆日志/拖慢主线程)"); }
        return;
    }
    if (chatty) {
        var now = Date.now();
        if (now - _lastChattyAt < 1000) return;   // 1s 内的重复 chatty 快照丢弃 (不记日志, 免得噪音换噪音)
        _lastChattyAt = now;
    }
    _dumpSeq++;
    try {
        if (!wbCls || !wbCls.pages || !wbCls.versionedState) { plog(tag + " | 快照跳过: 图鉴类未解析"); return; }
        var sets = modIdSets();
        plog(tag + " | " + dumpJsState());
        var names = Object.keys(wbCats);
        for (var i = 0; i < names.length; i++) plog("    " + dumpCat(wbCats[names[i]], sets));
    } catch (e) { plog(tag + " | 快照异常: " + e); }
}

// ===== 挂 hook =====
// 延迟快照: DeserializeState 的 onLeave 只是"异步体开始跑", 状态还没落地 → 不能当场快照。
// JS 线程不能碰 Unity API (见 credit.js 的记录), 所以不在定时器里补拍, 而是记一个待办,
// 由**下一个主线程事件**的 onEnter 兑现 —— 那时恢复已经落地, 且仍在我们关心的时序内。
var _pendingDump = null;
function queueDump(tag) { _pendingDump = tag; }
function flushPendingDump() {
    if (!_pendingDump) return;
    var tag = _pendingDump; _pendingDump = null;
    dumpBook(tag);
}
function hookMethod(cls, name, argc, tag, opts) {
    try {
        if (!cls || cls.isNull()) return false;
        var mi = A.cgm(cls, Memory.allocUtf8String(name), argc);
        if (!mi || mi.isNull() || mi.readPointer().isNull()) return false;
        Interceptor.attach(mi.readPointer(), {
            onEnter: function (args) {
                this._t = Date.now();
                try { flushPendingDump(); } catch (e) { swallowed("wbprobe.js:hookMethod.flush", e); }
                try { if (opts && opts.onEnter) opts.onEnter(args); } catch (e) { swallowed("wbprobe.js:hookMethod.onEnter", e); }
            },
            onLeave: function () {
                try {
                    var dt = Date.now() - this._t;
                    // quiet: 高频点位 (回滚快照级别的 SerializeState/ClearState) 不打这一行, 否则刷屏
                    if (!(opts && opts.quiet)) plog(tag + " 返回 (" + dt + "ms, 异步体此刻才开始跑)");
                    if (opts && opts.onLeave) opts.onLeave(this);
                } catch (e) { swallowed("wbprobe.js:hookMethod.onLeave", e); }
            }
        });
        plog("hook 就绪: " + tag);
        return true;
    } catch (e) { swallowed("wbprobe.js:hookMethod", e); return false; }
}

// ② 剧本加载: 探针自己比对 Enter (不动 detectCurrentMod 的逻辑)
function hookScriptLoader() {
    var cls = findClassAcrossImages("Naninovel", "ScriptLoader");
    hookMethod(cls, "Load", 2, "ScriptLoader.Load", {
        onEnter: function (a) {
            _lateEnough = true;      // 引擎已起来了, 此后的 modKey 查询才安全
            var p = "";
            try { p = readStr(a[1]) || ""; } catch (e) { }
            var hit = "<不匹配任何 Enter>";
            if (typeof modList !== "undefined" && modList) {
                for (var i = 0; i < modList.length; i++) if (modList[i].Enter === p) { hit = "'" + modList[i].key + "'"; break; }
            }
            plog("ScriptLoader.Load path='" + p + "' → " + hit);
        }
    });
}

// ① 读档/存档动作 (服务类懒解析: Engine 服务表可能还没就绪 → 由 ScriptLoader.Load 首次回调再试)
var _loadHooked = false;
function hookStateManager() {
    if (_loadHooked) return;
    try {
        var svc = findSvc("StateManager", true);
        var cls = svc && !svc.isNull() ? A.ogc(svc) : findClassAcrossImages("Naninovel", "StateManager");
        if (!cls || cls.isNull()) return;
        var ext = findClassAcrossImages("Naninovel", "StateManagerExtended");
        var got = 0;
        var targets = [
            ["LoadGame", 1], ["QuickLoad", 0], ["SaveGame", 1], ["QuickSave", 0]
        ];
        for (var i = 0; i < targets.length; i++) {
            var nm = targets[i][0];
            if (hookMethod(cls, nm, targets[i][1], "StateManager." + nm)) got++;
        }
        if (ext && !ext.isNull()) {
            if (hookMethod(ext, "AutoSaveAsync", 0, "StateManagerExtended.AutoSaveAsync")) got++;
            if (hookMethod(ext, "QuickLoadAsync", 1, "StateManagerExtended.QuickLoadAsync")) got++;
        }
        if (got) _loadHooked = true;
    } catch (e) { swallowed("wbprobe.js:hookStateManager", e); }
}

// ③④ 图鉴侧: 序列化/反序列化边界 + 打开边界 + ClearState (看它会不会清掉存档刚恢复的 _state)
function hookWitchBook() {
    try {
        var ui = wbCls && wbCls.witchBookUi;
        var scr = wbCls && wbCls.witchBookScreen;
        hookMethod(ui, "SerializeState", 1, "WitchBookUi.SerializeState(存档写入)", { quiet: true, onLeave: function () { dumpBook("存后", true); } });
        // DeserializeState 是 async: onLeave 只代表"异步体开始跑" → 记待办, 由下一个主线程事件兑现
        hookMethod(ui, "DeserializeState", 1, "WitchBookUi.DeserializeState(读档恢复)",
            { onEnter: function () { plog("--- 读档恢复开始 (DeserializeState 进入) ---"); }, onLeave: function () { queueDump("读档恢复后(下一事件)"); } });
        hookMethod(ui, "ClearState", 1, "WitchBookUi.ClearState", {
            quiet: true,
            onEnter: function (a) { try { this._cat = a[1].toInt32(); } catch (e) { } },
            onLeave: function () { dumpBook("ClearState(cat=" + this._cat + ") 后", true); }
        });
        // @update 原始入参 (判断"读档后游戏有没有重放 @update" —— 正常不会, 脚本是从存档行接着跑的)
        hookMethod(ui, "UpdateVersion", 3, "WitchBookUi.UpdateVersion(@update)", {
            onEnter: function (a) {
                var c = "?", id = "", v = -1;
                try { c = a[1].toInt32(); id = readStr(a[2]) || ""; v = a[3].toInt32(); } catch (e) { }
                plog(">>> @update 到达: category=" + c + " id='" + id + "' version=" + v);
            }
        });
        hookMethod(scr, "BeginToPresent", 0, "WitchBookScreen.BeginToPresent(开图鉴)", { onEnter: function () { dumpBook("BeginToPresent 前"); } });
        hookMethod(scr, "InitializePages", 0, "WitchBookScreen.InitializePages", { onEnter: function () { dumpBook("InitializePages 前"); }, onLeave: function () { dumpBook("InitializePages 后"); } });
        // 页面 ClearState (游戏 @clearBook 的落点)
        var pn = Object.keys(wbCats);
        for (var i = 0; i < pn.length; i++) {
            var pcls = wbCls.pages[wbCats[pn[i]].name];
            hookMethod(pcls, "ClearState", 0, wbCats[pn[i]].name + "Page.ClearState", { onLeave: function () { dumpBook("page.ClearState 后", true); } });
        }
    } catch (e) { swallowed("wbprobe.js:hookWitchBook", e); }
}

export function setupWitchBookProbe() {
    if (!ON) return;
    if (typeof MOD_WB_PROBE === "undefined") return;
    try {
        plog("=== 探针启用 (只读) — 目标: 读档后 mod 图鉴条目为何消失 ===");
        plog("启动时: " + dumpJsState());
        hookScriptLoader();     // ②
        hookStateManager();     // ① (可能此刻 Engine 未就绪 → ScriptLoader.Load 首次触发时补挂)
        hookWitchBook();        // ③④ (依赖 wbCls, 由 setupWitchBookHooks 解析)
        // ① 补挂点: ScriptLoader.Load 一定会跑在 Engine 就绪之后
        try {
            var sl = findClassAcrossImages("Naninovel", "ScriptLoader");
            var mi = sl && !sl.isNull() ? A.cgm(sl, Memory.allocUtf8String("Load"), 2) : null;
            if (mi && !mi.isNull()) Interceptor.attach(mi.readPointer(), { onEnter: function () { try { hookStateManager(); } catch (e) { swallowed("wbprobe.js:retry", e); } } });
        } catch (e) { swallowed("wbprobe.js:setupWitchBookProbe.retry", e); }
        plog("=== 探针挂载完成 ===");
    } catch (e) { error("setupWitchBookProbe err: " + e); }
}
// 供外部手动触发一次快照 (需要时从别的模块调: import { wbProbeSnapshot })
export function wbProbeSnapshot(tag) { if (ON) dumpBook(tag || "手动快照"); }
