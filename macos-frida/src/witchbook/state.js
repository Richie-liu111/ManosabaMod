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
export var wbOverrides = { clue: {}, profile: {}, rule: {}, note: {} };  // 当前 mod 覆写的原版 id
export var wbVanillaMap = {};   // catName -> {page: 页面指针, items: [原版 VersionedItem 指针]} (整页重建基座快照)
export var wbPageDefaults = {};       // pageClass ptr -> {labels:{字段:文本}, defaultTex:ptr}
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
