#!/usr/bin/env python3
"""回归: 构建 → 部署 → 跑一次加载器 → 到点杀掉 → 读 modlog.txt 断言 → 给退出码。

为什么要它 (2026-09-25 教训): 那次"图鉴打不开"排查了十几轮, 每轮都是"人重启游戏 → 点图鉴 →
贴日志"。而真正的判据(字典键能不能查到 / 有没有 KeyNotFoundException)其实可以机器判 ——
本脚本就是把那个判据机器化, 让"跑一次命令"代替"人肉点测+肉眼比对"。

它刻意**复刻用户的手动流程**, 而不是自造一条捷径 (两条流程分叉过一次, 见 2026-09-28 复盘):
    用户手动: 在仓库改 src → 构建 repo/dist → cp 到 <游戏>/dist → cd <游戏> && ./run_mod.sh
    本脚本  : 同一顺序, 只是把"到点杀 + 读日志断言"自动化。
所以: ① 它跑的是**游戏目录里的 run_mod.sh**(用户的真实入口), 不是仓库里的那份;
     ② 部署前后都核对 md5 —— 避免"测的不是刚构建的包"(那次白跑的直接原因)。

用法:
    python3 test-tools/regression.py                      # 默认: 构建+部署+跑 90s+断言
    python3 test-tools/regression.py --seconds 240 --require-summary
    python3 test-tools/regression.py --no-build           # 不重建, 用现有 repo 产物
    python3 test-tools/regression.py --no-deploy          # 不 cp (测游戏目录里已有的包)
    python3 test-tools/regression.py --case gapless       # 仅提示文字 (自动驱动剧本尚未落地)
    python3 test-tools/regression.py --check-only --log <modlog.txt>   # 只对现成日志断言
    python3 test-tools/regression.py --save /tmp/run.txt                # 额外存一份终端记录

日志去哪了: **游戏目录的 modlog.txt** 是真正的日志 (每运行截断重开, 崩溃前 flush), 断言读的就是它;
本脚本往终端打的 `  | ...` 只是 run_mod.sh stdout 的镜像, 想留档就用 --save。

硬断言 (失败即退出码 1):
    1) `[SELFTEST] 已启用` 出现        —— 自检真的装上了 (要求 run_mod.sh 支持 MOD_SELFTEST)
    2) 无 `[SELFTEST] FAIL`            —— 字典不变式全部成立 (含 KNF 计数项)
    3) `KeyNotFoundException` 计数 = 0

提示项 (不判): `[SELFTEST] SUMMARY` / `stats` 行 —— 需要你真的进剧本并开一次图鉴才会产生。
    (TODO: 自动驱动 —— 用加载器内已有的 GotoModified.LoadAndPlay + WitchBookUi 调用来免人工,
     见计划文档"步骤 1"; 未落地前, 自动部分只覆盖"启动 + 自检装载"。)
"""
import argparse, hashlib, os, re, shutil, subprocess, sys, time, signal
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def find_game_dir():
    steam = Path.home() / "Library/Application Support/Steam/steamapps/common/manosaba_game"
    if (steam / "manosaba.app").exists():
        return steam
    d = REPO
    while d != d.parent:
        c = d / "manosaba_game_mac"
        if (c / "manosaba.app").exists():
            return c
        d = d.parent
    return None


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def build() -> bool:
    """与 run_mod.sh 的构建块同序: 先静态校验具名导入, 再 frida-compile -S。"""
    checker = REPO / "tools/check-imports.mjs"
    if checker.exists():
        r = subprocess.run(["node", str(checker)], cwd=str(REPO))
        if r.returncode != 0:
            print("[regression] ✗ 具名导入校验未通过, 中止 (这正是 2026-09-25 白跑一轮的那类错)")
            return False
    local = REPO / "node_modules/.bin/frida-compile"
    cmd = ([str(local)] if local.exists()
           else ["npx", "--no-install", "frida-compile"])
    cmd += ["src/entry.js", "-o", "dist/manosabamod.js", "-S"]
    r = subprocess.run(cmd, cwd=str(REPO))
    if r.returncode != 0:
        print("[regression] ✗ frida-compile 构建失败")
        return False
    print(f"[regression] ✓ 构建完成 {md5(REPO / 'dist/manosabamod.js')[:8]} "
          f"({(REPO / 'dist/manosabamod.js').stat().st_size} B)")
    return True


def deploy(game: Path) -> bool:
    """repo/dist → 游戏目录/dist, 并用 md5 复核 (cp 是用户手动流程里的那一步)。"""
    src, dst = REPO / "dist/manosabamod.js", game / "dist/manosabamod.js"
    shutil.copy2(src, dst)
    a, b = md5(src), md5(dst)
    if a != b:
        print(f"[regression] ✗ 部署后 md5 不一致 repo={a} 产线={b}")
        return False
    print(f"[regression] ✓ 已部署 {b[:8]} → {dst}")
    return True


def assert_log(log_path: Path, require_summary: bool, self_proof: bool = False) -> int:
    if not log_path.exists():
        print(f"[regression] ✗ 日志不存在: {log_path}")
        return 1
    text = log_path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    selftest_on = [l for l in lines if "[SELFTEST] 已启用" in l]
    fails = [l for l in lines if "[SELFTEST] FAIL" in l]
    knf = [l for l in lines if "KeyNotFoundException" in l]
    summaries = [l for l in lines if "[SELFTEST] SUMMARY" in l]
    stats = [l for l in lines if "[SELFTEST] stats" in l]

    print(f"[regression] 日志: {log_path} ({len(lines)} 行)")
    print(f"[regression]   自检装载 : {'✓' if selftest_on else '✗ 未出现 [SELFTEST] 已启用'} ({len(selftest_on)})")
    print(f"[regression]   断言 FAIL: {'✓ 0 条' if not fails else '✗ ' + str(len(fails)) + ' 条'} ")
    print(f"[regression]   KNF      : {'✓ 0 条' if not knf else '✗ ' + str(len(knf)) + ' 条'}")
    print(f"[regression]   断言轮次 : {len(summaries)} 条 SUMMARY" + ("" if summaries else "  (提示: 进剧本并开一次图鉴才会产生)"))
    for l in fails[:5]:
        print("      " + l.strip())
    for l in knf[:5]:
        print("      " + l.strip())
    for l in stats[:6]:
        print("      " + l.strip())

    if self_proof:
        # 负对照模式: 期望的恰恰是 FAIL —— 证明哨兵对"实例不匹配"敏感 (不是永远绿)
        proof = [l for l in lines if "[SELFTEST] FAIL 负对照" in l]
        print(f"[regression]   负对照 : {'✓ 哨兵报错 ' + str(len(proof)) + ' 条' if proof else '✗ 哨兵没反应 —— 说明它对实例不匹配不敏感!'}")
        for l in proof[:3]:
            print("      " + l.strip())
        ok = bool(selftest_on) and bool(proof)
        print("[regression] " + ("PASS ✓ (哨兵确实抓得住这个坑)" if ok else "FAIL ✗ (负对照没能触发)"))
        return 0 if ok else 1

    ok = bool(selftest_on) and not fails and not knf and (summaries or not require_summary)
    print("[regression] " + ("PASS ✓" if ok else "FAIL ✗"))
    return 0 if ok else 1


def run_and_check(args) -> int:
    game = find_game_dir()
    if not game:
        print("[regression] ✗ 找不到游戏目录 (用 GAME_DIR=... 指定)")
        return 2
    runner = game / "run_mod.sh"
    if not runner.exists():
        print(f"[regression] ✗ 游戏目录里没有 run_mod.sh: {runner}")
        return 2
    # 自检开关由 run_mod.sh 透传: 游戏目录那份必须是支持 MOD_SELFTEST 的版本, 否则下面会断言失败
    runner_txt = runner.read_text(encoding="utf-8", errors="replace")
    if "MOD_SELFTEST" not in runner_txt or (args.self_proof and "MOD_SELFTEST_BREAK" not in runner_txt):
        print(f"[regression] ✗ {runner} 不认识 MOD_SELFTEST (旧版?) —— 先把仓库的 run_mod.sh 同步过去")
        return 2
    if not args.no_build and not build():
        return 2
    if not args.no_deploy and not deploy(game):
        return 2
    if args.no_build and args.no_deploy:
        print(f"[regression] 跳过构建与部署; 直接测 {game / 'dist/manosabamod.js'} "
              f"({md5(game / 'dist/manosabamod.js')[:8]})")

    # 环境变量净化 (2026-09-28 实测踩到): run_mod.sh 会读父进程的 GAME / GAME_DIR / MOD_ROOT /
    # MOD_LOG —— 手动调试时留在 shell 里的那几个变量会让**这次回归跑到另一个游戏副本上**
    # (实测: 16:13 那次跑去了工作区的 manosaba_game_mac, 那个副本连 dist 都没有)。
    # 原则同"诊断不许静默": 要么明确指定, 要么清掉, 绝不悄悄继承。
    LEAKY = ["GAME", "GAME_DIR", "MOD_ROOT", "MOD_LOG", "MOD_DEBUG", "MOD_SELFTEST", "PROBE",
             "NO_UPDATE_HOOK", "NORMALIZE_AUDIO"]
    leaked = [k for k in LEAKY if os.environ.get(k)]
    env = dict(os.environ)
    for k in LEAKY:
        env.pop(k, None)
    if leaked:
        print(f"[regression] 已清掉从 shell 继承的 {', '.join(leaked)} (否则可能跑到别的游戏副本上)")
    env["MOD_SELFTEST"] = "1"
    if args.self_proof:
        env["MOD_SELFTEST_BREAK"] = "1"
    if args.game_dir:
        env["GAME_DIR"] = args.game_dir
    log_path = Path(args.log) if args.log else (game / "modlog.txt")
    env["MOD_LOG"] = str(log_path)          # 钉死日志路径 → 下面断言的一定是本次这次运行
    if args.save:
        save_path = Path(args.save)
    print(f"[regression] 启动 {runner} (MOD_SELFTEST=1) 跑 {args.seconds}s; 日志 {log_path}")
    if args.case:
        print(f"[regression] 用例提示: 请进入「{args.case}」剧本并点开一次魔女图鉴 (自动驱动尚未落地)")
    proc = subprocess.Popen([str(runner)], cwd=str(game), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    game_pid = None
    tee = open(save_path, "w", encoding="utf-8") if args.save else None
    if tee:
        print(f"[regression] 终端记录另存: {save_path}")
    deadline = time.time() + args.seconds
    try:                                        # 边跑边读, 抓 run_mod.sh 打印的游戏 PID
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            sys.stdout.write("  | " + line)
            if tee:
                tee.write(line)                 # 原样存 (不带 "  | " 前缀, 好 grep)
            m = re.search(r"游戏已启动 \(PID=(\d+)\)", line)
            if m:
                game_pid = int(m.group(1))
    except KeyboardInterrupt:
        pass
    finally:
        if game_pid:
            print(f"[regression] 到点, 结束游戏进程 PID={game_pid}")
            try:
                os.kill(game_pid, signal.SIGTERM); time.sleep(2)
                os.kill(game_pid, signal.SIGKILL)     # 游戏对 SIGTERM 常不响应 (项目既有结论)
            except ProcessLookupError:
                pass
            except Exception as e:
                print(f"[regression] 结束游戏失败: {e}")
        try:
            proc.terminate(); time.sleep(0.5); proc.kill()
        except Exception:
            pass
        if tee:
            try: tee.close()
            except Exception: pass
    time.sleep(1)
    return assert_log(log_path, args.require_summary, args.self_proof)


def main():
    ap = argparse.ArgumentParser(description="WitchBook 回归: MOD_SELFTEST 断言 + 退出码")
    ap.add_argument("--seconds", type=int, default=90, help="跑多久 (默认 90s)")
    ap.add_argument("--case", default="", help="用例提示 (gapless / twilight), 仅打印")
    ap.add_argument("--log", default="", help="日志路径 (默认 <游戏目录>/modlog.txt)")
    ap.add_argument("--game-dir", default="", help="游戏目录, 透传给 run_mod.sh 的 GAME_DIR")
    ap.add_argument("--no-build", action="store_true", help="跳过构建 (用现有 repo 产物)")
    ap.add_argument("--no-deploy", action="store_true", help="跳过 cp 到游戏目录")
    ap.add_argument("--self-proof", action="store_true",
                    help="负对照: 让哨兵改用等价但不同实例的键 → 必须报 FAIL (证明它抓得住 2026-09-25 那类坑)")
    ap.add_argument("--save", default="", help="把 run_mod.sh 的终端输出另存一份 (modlog.txt 之外的记录)")
    ap.add_argument("--require-summary", action="store_true", help="必须出现断言轮次 (要你手动进剧本+开图鉴)")
    ap.add_argument("--check-only", action="store_true", help="不启动游戏, 只对 --log 现成日志做断言")
    args = ap.parse_args()
    if args.check_only:
        if not args.log:
            print("[regression] --check-only 需要 --log <路径>"); return 2
        return assert_log(Path(args.log), args.require_summary, args.self_proof)
    return run_and_check(args)


if __name__ == "__main__":
    sys.exit(main())
