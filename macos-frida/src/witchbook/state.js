// ============ WitchBook 共享状态 (数据/分类表/会话标记/类表/覆写表) ============
// 分类表 wbCats 在 data.js (其 addr 引用 data.js 的纹理地址构建函数)
import { wbCats } from "./data.js";

export var wbData = {
  clue: {},       // id -> {key, versions:{ver:{name,desc}}, path}
  profile: {},    // id -> {key, versions:{ver:{desc}}, path}
  rule: {},       // id -> {key, versions:{ver:{numbering,subtitle,desc}}}
  note: {},       // id -> {key, versions:{ver:{title,desc}}}
  characters: {}, // 角色Id -> {key, name:{}, familyName:{}, color, age, height, weight}
  states: {},     // catName -> {id: ver}
  pendingStates: {}, // catName -> {id: ver}
  texCache: {},   // id -> Texture2D
  texPaths: {}    // id -> path (clue/profile)
};
export var wbCurrentMod = null;   // 当前激活的 mod key (经 ScriptLoader.Load 匹配 Enter 得到; null=未知, __vanilla__=原版)
export var wbPrevMod = null;      // 上次注入时的 mod key (用于切换检测)
export var wbCls = null;          // 解析好的类表 (index.js resolveWitchBookClasses)
export var wbReady = false;
// 覆写换血记账: catName -> id -> {page: 页面实例地址, e: 我们注入的 VersionedItem 地址, ivp: 该条目的 IdVersionPair 地址}
// 用途: 幂等判定 —— 页面 map 里那条还是不是我们注入的那一个。地址只做身份比较, 不解引用;
// 条目由 map 持有, 只要还命中就必然存活 (与 wbVanillaMap 存值的理由不同: 那里存包装对象指针会悬空)。
export var wbOverrides = { clue: {}, profile: {}, rule: {}, note: {} };
export var wbVanillaMap = {};   // catName -> {page: 页面指针, items: [{id, ver, item}]} (整页重建基座快照)
                                // items 只存值; item 由 Data 资产持有, 悬空时按 id 从 Data 重取 (见 session.js)
export var wbPageDefaults = {};       // pageClass ptr -> {labels:{字段:文本}} (默认纹理不缓存, 用得时候现读, 见 session.js)
export var wbDefaultsCaptured = false;

// setter (ES modules import 绑定只读, 赋值必须在模块内)
export function setWbCurrentMod(v) { wbCurrentMod = v; }
export function setWbPrevMod(v) { wbPrevMod = v; }
export function setWbCls(c) { wbCls = c; }
export function setWbReady(r) { wbReady = r; }
export function setWbDefaultsCaptured(v) { wbDefaultsCaptured = v; }

export function initCatStateMaps() {
    var cn = Object.keys(wbCats);
    for (var i = 0; i < cn.length; i++) {
        if (!wbData.states[cn[i]]) wbData.states[cn[i]] = {};
        if (!wbData.pendingStates[cn[i]]) wbData.pendingStates[cn[i]] = {};
    }
}
// 清空覆写记账 (原地换掉每个分类的对象, 保持导出绑定不变)。会话/剧本切换时调用:
// 上一会话的条目地址在新页面里不再命中 → 换血会重新执行 (判定本就以命中为准, 这里只是防地址复用误命中)
export function resetWbOverrides() {
    var cn = Object.keys(wbOverrides);
    for (var i = 0; i < cn.length; i++) wbOverrides[cn[i]] = {};
}
