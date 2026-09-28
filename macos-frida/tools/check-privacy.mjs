#!/usr/bin/env node
// ============ 防回归闸门: 文档/源码里不许再出现"具体身份信息" ============
// 为什么有它 (2026-09-29): 仓库是公开的, 而文档和注释天然会长出"具体 mod 名 / 本机路径 /
// 私有渠道 / 会话内编号"这类只对当事人有意义的东西。一次性清理会被下一次提交重新污染,
// 所以跟 check-imports 一个套路: 把规则写死在闸门里, 每次构建把关。
//
// 规则 (改这里就能扩):
//   ① 本机绝对路径     /Users/xxx, /home/xxx, ~/.claude
//   ② 私有分发渠道     群文件 / QQ 群 / discord 邀请
//   ③ 具体 mod 名      (见下; 上游项目署名与测试用 Test* 名字不算 —— 见 ALLOW)
//   ④ 会话内迭代编号   run-25 之类, 对外无意义
// 豁免:
//   · 含 URL 的行 (署名/链接)
//   · 闸门自身 (规则表就是这些词)
//   · README 的致谢区 (上游贡献者署名是有意保留的)
// 用法: node tools/check-privacy.mjs            (退出码非 0 = 有泄漏)
//       ROOT=<目录> node tools/check-privacy.mjs  (对拷贝做自测: 见下)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.ROOT ? resolve(process.env.ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
    { id: "本机绝对路径", re: /\/Users\/[A-Za-z][\w.-]*|\/home\/[a-z][\w.-]*|~\/\.claude/g },
    { id: "私有分发渠道", re: /群文件|QQ\s*群|discord\.gg/gi },
    { id: "具体 mod 名", re: /\b(Gapless|Twilight_TestMod005|Twilight|AsaChiri|Shirohoshi|StarWish|Harumi_mod|BoneWingEma|xsjx|Rewind)\b/g },
    { id: "会话内编号", re: /\brun-2[0-9]\b|\[run-\d+废弃\]/g },
];
const SELF = "tools/check-privacy.mjs";                 // 规则表本身含这些词
const SKIP_LINE = /https?:\/\/|github\.com/;            // 署名/链接行豁免
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

if (found.length) {
    console.error(`[check-privacy] ✗ ${found.length} 处疑似身份信息 (修掉或加豁免, 别让它上 GitHub):`);
    for (const f of found.slice(0, 40)) console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.hits}`);
    if (found.length > 40) console.error(`  … 其余 ${found.length - 40} 处省略`);
    process.exit(1);
}
console.log(`[check-privacy] ✓ ${files.length} 个文件, 无具体 mod 名/本机路径/私有渠道/会话编号`);
