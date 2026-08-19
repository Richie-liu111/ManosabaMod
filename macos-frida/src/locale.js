// ============ 当前游戏语言跟踪 ============
// 以 Naninovel ResourceLoader<T>.HandleLocaleChanged(locale) 的实参为准:
// 引擎切语言和启动初始化都会触发 (modlog 实证 'ja'/'zh-Hans'), 与 mod 的
// @print/@toast/@choice 双语 (追加式 |#ID|) 共用同一套语言判定。
// 2026-08-19: 试过 findSvc("LocalizationManager") + get_SelectedLocale 静默失败
// (回退 zh-Hans), 该方案被 HandleLocaleChanged 跟踪取代。
import { A, dbg, fieldOffset, findClassAcrossImages, invokeOk, readStr, wblog, warn } from "./utils.js";

var _locale = "zh-Hans";
export function setCurrentLocale(l) { if (l) _locale = l; }
export function getCurrentLocale() { return _locale || "zh-Hans"; }

// ============ 引擎级语言同步 (LocalizationManager 自身) ============
// 背景: HandleLocaleChanged 只在"语言实际改变"时触发 (modlog 实证) —
// 以日语启动 (从未切语言) 时引擎启动初始化不触发它, _locale 停在 zh-Hans,
// 图鉴姓名在"启动即日语"场景下仍显示中文注册名 (用户实测)。
// 修复: spawn 注入早于引擎初始化 → hook LocalizationManager 自身方法,
//   引擎初始化/读语言/切语言任一路径都会同步 _locale:
//   get_SelectedLocale onLeave — 任何读语言 (启动加载本地化资源必经) → 读返回 String
//   set_SelectedLocale / SelectLocale onEnter — 任何设语言 (切语言入口) → 读参数字符串
//   InitializeService onEnter — 拿实例, 供 syncLocaleFromEngine 主动 invoke 兜底
// (Windows C# 版镜像: Engine.GetService<ILocalizationManager>().SelectedLocale;
//  类结构 Windows dump 实证: <SelectedLocale>k__BackingField @0x20, 方法均存在)
var _lmInst = null;
var _lmHooked = false;
var _synced = false;

export function hookLocaleAccessors() {
    try {
        if (_lmHooked) return;
        var cls = findClassAcrossImages("Naninovel", "LocalizationManager");
        if (!cls || cls.isNull()) { warn("[locale] LocalizationManager class NOT FOUND"); return; }
        var found = { get: false, set: false, sel: false, init: false };

        var getMi = A.cgm(cls, Memory.allocUtf8String("get_SelectedLocale"), 0);
        if (getMi && !getMi.isNull() && getMi.readPointer() && !getMi.readPointer().isNull()) {
            Interceptor.attach(getMi.readPointer(), {
                onLeave: function (ret) {
                    try { if (ret && !ret.isNull()) setCurrentLocale(readStr(ret)); } catch (e) {}
                }
            });
            found.get = true;
        }
        var setMi = A.cgm(cls, Memory.allocUtf8String("set_SelectedLocale"), 1);
        if (setMi && !setMi.isNull() && setMi.readPointer() && !setMi.readPointer().isNull()) {
            Interceptor.attach(setMi.readPointer(), {
                onEnter: function (a) { try { setCurrentLocale(readStr(a[1])); } catch (e) {} }
            });
            found.set = true;
        }
        var selMi = A.cgm(cls, Memory.allocUtf8String("SelectLocale"), 1);
        if (selMi && !selMi.isNull() && selMi.readPointer() && !selMi.readPointer().isNull()) {
            Interceptor.attach(selMi.readPointer(), {
                onEnter: function (a) { try { setCurrentLocale(readStr(a[1])); } catch (e) {} }
            });
            found.sel = true;
        }
        var initMi = A.cgm(cls, Memory.allocUtf8String("InitializeService"), 0);
        if (initMi && !initMi.isNull() && initMi.readPointer() && !initMi.readPointer().isNull()) {
            Interceptor.attach(initMi.readPointer(), {
                onEnter: function (a) { _lmInst = a[0]; }
            });
            found.init = true;
        }
        _lmHooked = found.get || found.set || found.sel;
        if (_lmHooked) wblog("[locale] LocalizationManager hooks 就绪: get=" + found.get + " set=" + found.set + " sel=" + found.sel + " init=" + found.init);
        else warn("[locale] LocalizationManager hooks NONE 找到 (class=" + A.cgn(cls).readCString() + ")");
    } catch (e) { warn("[locale] hookLocaleAccessors err: " + e); }
}

// 兜底: 图鉴渲染姓名前用实例主动查询一次 (幂等)。优先 invoke getter, 失败读 backing field。
export function syncLocaleFromEngine() {
    if (_synced) return _locale;
    if (!_lmInst || _lmInst.isNull()) return _locale;
    try {
        var cls = A.ogc(_lmInst);
        var getMi = A.cgm(cls, Memory.allocUtf8String("get_SelectedLocale"), 0);
        if (getMi && !getMi.isNull()) {
            var r = invokeOk(getMi, _lmInst, []);
            if (r.ok && r.ret && !r.ret.isNull()) {
                var loc = readStr(r.ret);
                if (loc) { setCurrentLocale(loc); _synced = true; dbg("[locale] syncLocaleFromEngine → '" + loc + "'"); return loc; }
            }
        }
        // invoke 失败 (调用链坑) → 直接读 backing field (动态查偏移, 回退 Windows dump 实证 0x20)
        var fo = fieldOffset(cls, "<SelectedLocale>k__BackingField", 0x20);
        var p = _lmInst.add(fo).readPointer();
        if (p && !p.isNull()) {
            var loc2 = readStr(p);
            if (loc2) { setCurrentLocale(loc2); _synced = true; dbg("[locale] syncLocaleFromEngine(字段@" + fo.toString(16) + ") → '" + loc2 + "'"); return loc2; }
        }
    } catch (e) { warn("[locale] syncLocaleFromEngine err: " + e); }
    return _locale;
}
