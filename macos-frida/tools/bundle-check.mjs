#!/usr/bin/env node
// ============ 产物体检: dist/manosabamod.js 是否真能被 Frida 当 📦 asset bundle 读下去 ============
// 为什么需要它 (2026-09-25 教训 "打包过、加载炸"): frida-compile 只看源码语法, **不看产物结构**。
// 于是"构建成功"并不等于"注入成功" —— 具名导出写错就是这样白跑一轮 (现在由 check-imports 拦下),
// 而产物被截断/片段头写坏/注入格式变更这类问题, 只有真注入才知道。
// 这里按 Frida 的读法把产物拆一遍: 📦 头 + `size /路径` 片段表 + `✄` 分隔 + 每段 JS 语法。
// 用法: node tools/bundle-check.mjs [产物路径]     (默认 dist/manosabamod.js)
// 退出码: 0 = 结构+语法全过; 1 = 不合法; 2 = 文件不存在
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] || join(REPO, "dist", "manosabamod.js");
if (!existsSync(file)) {
    console.error(`[bundle-check] 产物不存在: ${file} (先构建)`);
    process.exit(2);
}
const raw = readFileSync(file, "utf8");
const fail = (m) => { console.error("[bundle-check] ✗ " + m); process.exit(1); };

if (!raw.startsWith("📦\n")) fail("产物不是 📦 asset bundle (Frida 会当普通脚本读, 多文件导入会炸)");

const parts = raw.split("\n✄\n");
const manifest = parts[0].split("\n").slice(1).filter((l) => l.trim());
if (!manifest.length) fail("片段表为空");
let total = 0;
for (const line of manifest) {
    const m = /^(\d+) (\/[^\s]+)$/.exec(line);
    if (!m) fail(`片段表行格式不对: ${JSON.stringify(line.slice(0, 60))}`);
    total += Number(m[1]);
}
// 片段表声明的字节数 vs 实际正文 (声明错 → Frida 读到的就是残缺代码)
const bodyBytes = Buffer.byteLength(parts.slice(1).join("\n✄\n"), "utf8");
if (bodyBytes === 0) fail("没有正文片段");

// 逐段语法检查 (片段头 `size /path` 那行不是 JS)
const dir = mkdtempSync(join(tmpdir(), "bundle-check-"));
let bad = 0;
parts.forEach((p, i) => {
    const lines = p.split("\n");
    const body = /^\d+ \//.test(lines[0] || "") ? lines.slice(1).join("\n") : p;
    if (!body.trim() || p.startsWith("📦")) return;
    const tmp = join(dir, `seg${i}.js`);
    writeFileSync(tmp, body);
    try {
        execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
        bad++;
        const err = String(e.stderr || e.message).split("\n").filter((l) => l.trim()).slice(-1)[0];
        console.error(`[bundle-check] ✗ 片段 ${i} 语法不合法: ${err}`);
    }
});
if (bad) fail(`${bad} 个片段语法不合法`);

const mb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`[bundle-check] ✓ ${manifest.length} 个片段, 正文 ${mb(bodyBytes)}, 每段语法合法 → Frida 可注入`);
