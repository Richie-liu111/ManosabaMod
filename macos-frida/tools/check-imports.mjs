#!/usr/bin/env node
// ============ 构建前静态校验: 具名导入必须真的被导出 ============
// 为什么需要 (2026-09-25 实证): `frida-compile` **不校验具名导出** ——
//   一次 `makeIdVersionPair` 从错模块导入, 打包"成功", 直到 Frida 加载脚本才报
//   `the requested module './session.js' does not provide an export named ...` ⇒ 白跑一轮实测。
// 用法: node tools/check-imports.mjs   (退出码非 0 = 有问题)
// 覆盖: export function/class/var/let/const (含多声明符 `export var a = 1, b = 2`)、
//       export { a, b as c } (按**别名**记)、export * from (该模块视为"未知导出", 跳过名字检查)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 注意: 不能用 `new URL(...).pathname` —— 路径里有空格时它给的是 %20 编码 (本仓库路径就带空格)
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

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
    let hasStar = false;
    // export function/class NAME
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
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
    return { names, hasStar };
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

if (problems.length) {
    console.error("[check-imports] ✗ " + problems.length + " 处具名导入不存在 (frida-compile 不会替你发现):");
    for (const p of problems) console.error("  " + p);
    process.exit(1);
}
console.log(`[check-imports] ✓ ${files.length} 个文件, ${checked} 条具名导入全部有对应导出`);
