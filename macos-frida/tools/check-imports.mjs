#!/usr/bin/env node
// ============ 构建前静态校验: 具名导入必须真的被导出 ============
// 为什么需要 (2026-09-25 实证): `frida-compile` **不校验具名导出** ——
//   一次 `makeIdVersionPair` 从错模块导入, 打包"成功", 直到 Frida 加载脚本才报
//   `the requested module './session.js' does not provide an export named ...` ⇒ 白跑一轮实测。
// 用法: node tools/check-imports.mjs   (退出码非 0 = 有问题)
// 自测 (红/绿): 复制 src 到别处、在拷贝里删掉某个函数定义, 再 `SRC_DIR=<拷贝> node tools/check-imports.mjs`
//   期望: 只报那一处"调用了未定义的 x("; 而真源码应当 0 报 (2026-09-28 用 pickPage 做过红/绿验证)。
// 覆盖: export function/class/var/let/const (含多声明符 `export var a = 1, b = 2`)、
//       export { a, b as c } (按**别名**记)、export * from (该模块视为"未知导出", 跳过名字检查)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 注意: 不能用 `new URL(...).pathname` —— 路径里有空格时它给的是 %20 编码 (本仓库路径就带空格)
const SRC = process.env.SRC_DIR
    ? resolve(process.env.SRC_DIR)                    // 测试用: 对一份拷贝跑 (见下方"怎么自测")
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (name.endsWith(".js")) out.push(p);
    }
    return out;
}

function exportsOf(src) {
    const names = new Set();
    const fnNames = new Set();   // 只收 export function/class —— 反向检查用它, 避免 var 多声明符解析出的噪音
    let hasStar = false;
    // export function/class NAME
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) { names.add(m[1]); fnNames.add(m[1]); }
    // export var/let/const a = 1, b = 2, {c} = ...;  (逐个声明符取名字, 跳过解构花括号)
    for (const m of src.matchAll(/export\s+(?:var|let|const)\s+([^;\n]+)/g)) {
        let depth = 0, started = true, ident = "";
        for (const ch of m[1]) {
            if (ch === "{" || ch === "[") depth++;
            else if (ch === "}" || ch === "]") depth--;
            else if (ch === "=" && depth === 0) { started = false; }
            else if (ch === "," && depth === 0) { started = true; ident = ""; }
            else if (started && /[\w$]/.test(ch)) { ident += ch; if (ident && /^[A-Za-z_$][\w$]*$/.test(ident)) names.add(ident); }
        }
    }
    // export { a, b as c }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (let part of m[1].split(",")) {
            part = part.trim();
            if (!part) continue;
            const as = part.split(/\s+as\s+/);
            const exported = (as[1] || as[0]).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported);
        }
    }
    if (/export\s+default\b/.test(src)) names.add("default");
    if (/export\s*\*\s*from/.test(src)) hasStar = true;
    return { names, fnNames, hasStar };
}

const files = walk(SRC);
const table = new Map();                       // 绝对路径 -> {names, hasStar}
for (const f of files) table.set(f, exportsOf(readFileSync(f, "utf8")));

const problems = [];
let checked = 0;
for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
        const target = resolve(dirname(f), m[2]);
        const info = table.get(target);
        if (!info) { problems.push(`${relative(SRC, f)} → 找不到模块 ${m[2]}`); continue; }
        if (info.hasStar) continue;             // export * from ⇒ 名字交给被再导出的模块, 这里不判
        for (let part of m[1].split(",")) {
            part = part.trim();
            if (!part) continue;
            const orig = part.split(/\s+as\s+/)[0].trim();
            checked++;
            if (!info.names.has(orig)) problems.push(`${relative(SRC, f)} → ${m[2]} 未导出 \`${orig}\``);
        }
    }
}

// ============ 反向检查: 用了 utils.js 的导出却没 import ============
// 为什么需要 (2026-09-28 实证): 我在 selftest.js 里用了 `findAllObjectOfType`, 但 import 列表里
// 只有 `findAllObjectOfTypeAll` —— 打包"成功", 到游戏里才 ReferenceError, 而且被 catch 吞掉,
// 表现成"哨兵什么都没探到"。frida-compile 不报, ESLint 没接, 于是只能靠这种针对性扫描。
// 只对 utils.js 的导出做 (名字都很有特征, 误报率低); 判定"裸用": 前面不是 . / 引号, 后面不是 : (对象键)
const UTILS = join(SRC, "utils.js");
const utilsNames = [...(table.get(UTILS)?.fnNames || [])];
const usedNotImported = [];
for (const f of files) {
    if (f === UTILS) continue;
    let src = readFileSync(f, "utf8");
    // 先剥注释再找"裸用" —— 否则注释里提到的 `directCall`/`findSvc` 会被当成真调用 (实测 2 例误报)
    src = src.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => {
        const i = l.indexOf("//");
        return i < 0 ? l : l.slice(0, i);
    }).join("\n");
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
        for (let part of m[1].split(",")) {
            part = part.trim();
            if (part) imported.add((part.split(/\s+as\s+/)[1] || part.split(/\s+as\s+/)[0]).trim());
        }
    }
    for (const name of utilsNames) {
        if (imported.has(name)) continue;
        // 本文件自己声明了同名 (function/var/let/const/class, 含 `name: function`)
        if (new RegExp(`(?:function|class|var|let|const)\\s+${name}\\b|\\b${name}\\s*:\\s*function`).test(src)) continue;
        // 裸用 (调用/赋值/传参), 排除 obj.name、字符串、对象键
        const bare = new RegExp(`(^|[^\\w$.'"\`])${name}\\s*(\\(|[,)\\]}=.]|$)`, "m");
        const asKey = new RegExp(`\\b${name}\\s*:`, "m");
        if (bare.test(src) && !asKey.test(src)) usedNotImported.push(`${relative(SRC, f)} → 用了 utils.js 的 \`${name}\` 但没 import 它`);
    }
}
problems.push(...usedNotImported);

// ============ 第三查: 调用了"本文件/任何地方都没有的函数" ============
// 为什么需要 (2026-09-28 实证): 我用脚本重写 selftest.js 时把 `pickPage` 定义删掉了, 调用还在 →
// 打包成功, 进游戏每轮抛 `ReferenceError: pickPage is not defined` (= 断言全无输出)。
// 上面两查都看不到它 (不是导入问题, utils 也没这名字)。这里做"裸调用未定义标识符"扫描。
// 白名单 = JS 内建 + Frida 全局 + 本工程 run_mod.sh 注入的 prelude 变量。
const GLOBALS = new Set(("console Math JSON Object String Number Boolean Array Date RegExp Error TypeError "
    + "isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent setTimeout clearTimeout "
    + "setInterval clearInterval require module exports globalThis Symbol Promise Map Set WeakMap Proxy Reflect "
    + "Memory ptr NULL int64 uint64 Interceptor Process Thread Module NativeFunction NativeCallback "
    + "DebugSymbol Backtracer send recv hexdump hexdump2 Frida rpc WeakRef FinalizationRegistry "
    + "modList MOD_ROOT movieMap chapterNames MOD_LOG MOD_NO_COLOR MOD_DEBUG MOD_SELFTEST MOD_SELFTEST_BREAK NO_UPDATE_HOOK"
).split(/\s+/));
// 关键字/字面量: `if(` `for(` `catch(` `function(` 这些也会被"标识符+("匹配到, 必须先排掉
const KEYWORDS = new Set(("if else for while do switch case default break continue return try catch finally "
    + "throw new delete typeof instanceof in of void yield await async function class extends super this "
    + "var let const true false null undefined NaN Infinity debugger with"
).split(/\s+/));
// 去掉注释 + 字符串字面量 (后者会造出假调用: `wblog("... (err(" ...)` 之类)
function stripNonCode(src) {
    let out = "", i = 0, n = src.length;
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
        if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
        if (c === '"' || c === "'" || c === "`") {
            const q = c; i++;
            while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
            i++; out += '""'; continue;
        }
        out += c; i++;
    }
    return out;
}
const undefinedCalls = [];
for (const f of files) {
    let src = stripNonCode(readFileSync(f, "utf8"));
    const known = new Set();
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
    // var/let/const 的**所有**声明符 (多声明符写法 `var a = 1, b = 2;` 只取第一个会漏, 实测误报过 mgp)
    for (const m of src.matchAll(/(?:var|let|const)\s+([^;\n]+)/g)) {
        let depth = 0, started = true, ident = "";
        for (const ch of m[1]) {
            if (ch === "{" || ch === "[") depth++;
            else if (ch === "}" || ch === "]") depth--;
            else if (ch === "=" && depth === 0) { started = false; }
            else if (ch === "," && depth === 0) { started = true; ident = ""; }
            else if (started && /[\w$]/.test(ch)) { ident += ch; if (/^[A-Za-z_$][\w$]*$/.test(ident)) known.add(ident); }
        }
    }
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*function/g)) known.add(m[1]);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}/g))
        for (let part of m[1].split(",")) { part = part.trim(); if (part) known.add((part.split(/\s+as\s+/)[1] || part.split(/\s+as\s+/)[0]).trim()); }
    // 函数形参 + 解构里的名字 (它们当然可以裸调用)
    for (const m of src.matchAll(/function\s*[A-Za-z_$\w$]*\s*\(([^)]*)\)/g))
        for (const part of m[1].split(",")) { const id = part.trim().split(/[\s=:]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(id)) known.add(id); }
    for (const m of src.matchAll(/\b(?:var|let|const)\s*\{([^}]*)\}/g))
        for (const part of m[1].split(",")) { const id = part.trim().split(/[\s=:]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(id)) known.add(id); }
    for (const m of src.matchAll(/(^|[^\w$.'"])([a-z][A-Za-z0-9_$]*)\s*\(/gm)) {
        const name = m[2];
        if (KEYWORDS.has(name) || known.has(name) || GLOBALS.has(name)) continue;
        undefinedCalls.push(`${relative(SRC, f)} → 调用了未定义的 \`${name}(\` (拼错/被删/忘了 import?)`);
    }
}
problems.push(...undefinedCalls);

if (problems.length) {
    console.error("[check-imports] ✗ " + problems.length + " 处交叉引用问题 (frida-compile 不会替你发现):");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}
console.log(`[check-imports] ✓ ${files.length} 个文件, ${checked} 条具名导入有对应导出, 无"用了没导入", 无未定义调用`);
