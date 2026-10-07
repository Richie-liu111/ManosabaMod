#!/usr/bin/env node
// ============ 防回归闸门: 文档/源码里不许再出现"具体身份信息" ============
// 为什么有它 (2026-09-29): 仓库是公开的, 而文档和注释天然会长出"具体 mod 名 / 本机路径 /
// 私有渠道 / 会话内编号"这类只对当事人有意义的东西。一次性清理会被下一次提交重新污染,
// 所以跟 check-imports 一个套路: 把规则写死在闸门里, 每次构建把关。
//
// 规则分两类:
//   [通用] 写在本文件里 (不涉及任何具体身份, 可以公开):
//     ① 本机绝对路径     /Users/xxx, /home/xxx, ~/.claude
//     ② 私有分发渠道     群文件 / QQ 群 / discord 邀请
//     ③ 会话内迭代编号   run-25 / run-30c 之类, 对外无意义
//   [本机] "具体 mod 名"清单 —— **必须放仓库外** (见下)
//
// 为什么 mod 名清单不在仓库里 (2026-10-07 修的"脱敏反噬"): 这清单本身就是"要藏的词"。
//   把它提交进仓库 = 把要藏的东西写在公开处; 而闸门又必须豁免自己 (否则永远报自己) →
//   等于"闸门永远查不出自己那一份清单", 净效果是**负的**。所以清单改由本机提供, 不进仓库。
//   代价: 没有该文件时规则④不生效 (CI 上跑就是这个情况) —— 所以缺文件时会**大声提示**,
//   并建议本机开发者都建一份。真正的兜底是: 提交前本机闸门全绿 + CI 跑通用规则 + 人眼过 diff。
//
// 清单文件位置 (按优先级, 都不在仓库内 → 不可能被误提交):
//   1. 环境变量 PRIVACY_RULES=<路径>
//   2. ~/.config/manosaba/privacy-rules.json
//   格式: { "modNames": ["名字A", "名字B"], "note": "为什么有这些词 (可选)" }
//
// 豁免:
//   · 含 URL 的行 (署名/链接)
//   · 闸门自身 (它含通用规则的正则字面量)
// 用法: node tools/check-privacy.mjs            (退出码非 0 = 有泄漏)
//       ROOT=<目录> node tools/check-privacy.mjs      (对拷贝做自测)
//       PRIVACY_RULES=<路径> node tools/check-privacy.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = process.env.ROOT ? resolve(process.env.ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");

// —— 通用规则 (不含任何具体身份, 因此可以公开留在仓库里) ——
const RULES = [
    { id: "本机绝对路径", re: /\/Users\/[A-Za-z][\w.-]*|\/home\/[a-z][\w.-]*|~\/\.claude/gi },
    { id: "私有分发渠道", re: /群文件|QQ\s*群|discord\.gg/gi },
    // 会话内编号: 以前只写 run-2[0-9] 且带 \b, 结果 src 里 86 处 run-NN **一处都匹配不到**
    // (run-31 / run-30c / run-13 全漏) → 闸门报"无会话编号"的同时满屏都是它们。
    // 现在覆盖全部 run-<数字>[字母], 让这条规则真的生效。
    { id: "会话内编号", re: /\brun-\d+[a-z]*\b|\[run-\d+废弃\]/gi },
];

const RULES_PATH = process.env.PRIVACY_RULES
    || join(homedir(), ".config", "manosaba", "privacy-rules.json");

// —— 本机清单: 具体 mod 名 ——
let localNames = [], localLoaded = false, localWhy = "";
try {
    const cfg = JSON.parse(readFileSync(RULES_PATH, "utf8"));
    localNames = (Array.isArray(cfg.modNames) ? cfg.modNames : [])
        .filter((s) => typeof s === "string" && s.trim());
    localLoaded = true;
    if (!localNames.length) localWhy = "文件存在但 modNames 为空";
} catch (e) {
    localWhy = (e && e.code === "ENOENT") ? "文件不存在" : ("读取失败: " + ((e && e.message) || e));
}
if (localNames.length) {
    const esc = localNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    RULES.push({ id: "具体 mod 名", re: new RegExp(`\\b(${esc.join("|")})\\b`, "gi") });
}

const SELF = "tools/check-privacy.mjs";                 // 规则表本身含这些词的字面量
const SKIP_LINE = /https?:\/\/|github\.com/;            // 署名/链接行豁免
// 为什么**不**扫 dist (2026-10-07): dist 是 src 的产物, 而本闸门跑在构建**之前** ——
// 扫 dist 会变成"闸门挡住能修好它的那次构建"的死锁 (实测: dist 里还有旧编号时 npm run build
// 直接卡在 check 上)。dist 的洁净由"src 洁净 + CI 校验 dist == build(src)"保证, 不必重复扫。
const SCAN_DIRS = ["src", "docs", "tools", "test-tools"];
const SCAN_FILES = ["README.md",                // 本目录(可能已不存在, 由下方根 README 兜住)
                    join("..", "README.md"),    // 仓库根 README (项目门面, 最容易被写进具体信息)
                    "package.json", "run_mod.sh"];
const EXTS = [".js", ".mjs", ".md", ".json", ".sh", ".py"];

function walk(dir, out = []) {
    let names;
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
        if (n === "node_modules" || n === ".git" || n.startsWith(".")) continue;
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (EXTS.some((e) => n.endsWith(e))) out.push(p);
    }
    return out;
}

const files = [...SCAN_DIRS.flatMap((d) => walk(join(REPO, d))), ...SCAN_FILES.map((f) => join(REPO, f))]
    .filter((f) => !f.includes(SELF));

const found = [];
for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (const rule of RULES) {
        lines.forEach((line, i) => {
            if (SKIP_LINE.test(line)) return;
            rule.re.lastIndex = 0;
            let m, hits = [];
            while ((m = rule.re.exec(line)) !== null) hits.push(m[0]);
            if (hits.length) found.push({ file: relative(REPO, f), line: i + 1, rule: rule.id, hits: [...new Set(hits)].join(",") });
        });
    }
}

if (!localNames.length) {
    console.warn(`[check-privacy] ⚠ 未加载本机 mod 名清单 (${RULES_PATH}: ${localWhy})`);
    console.warn("[check-privacy]   规则「具体 mod 名」本次**未生效**, 只跑了通用规则 (路径/渠道/会话编号)。");
    console.warn("[check-privacy]   本机开发请建这个文件, 内容形如:");
    console.warn("[check-privacy]     { \"modNames\": [\"<要藏的名字>\", \"...\"] }");
}

if (found.length) {
    console.error(`[check-privacy] ✗ ${found.length} 处疑似身份信息 (修掉或加豁免, 别让它上 GitHub):`);
    for (const f of found.slice(0, 40)) console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.hits}`);
    if (found.length > 40) console.error(`  … 其余 ${found.length - 40} 处省略`);
    process.exit(1);
}
const ruleNote = localNames.length ? `, mod 名清单 ${localNames.length} 条` : ", **无 mod 名清单**";
console.log(`[check-privacy] ✓ ${files.length} 个文件, ${RULES.length} 条规则全过${ruleNote}`);
