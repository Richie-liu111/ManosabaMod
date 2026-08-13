#!/usr/bin/env python3
"""
Manosaba mod 音频规范化脚本 (macOS Frida 版专用)。

游戏原装 WavToAudioClipConverter 只支持 PCM16 / 44100Hz / 立体声 wav:
  - .ogg 无法被资源定位 (Representations 只含 .wav)
  - 非 44100 采样率 (48kHz/32kHz) 音高偏移
  - 单声道数据按立体声解码, 直接乱套

检测用纯 Python 读 WAV 文件头 (RIFF/fmt chunk), 毫秒级全量扫描, 不依赖
ffprobe; 只有实际转换才调用 ffmpeg。规范化后的音频在 macOS 与 Windows 版
(任意采样率都接受) 均能播放 —— 标准格式是两个平台的"最大公约数"。

设计原则: 只检测、不擅自动文件。批量转换是"改文件"操作 (会覆盖原 wav,
删除 ogg 源), 必须由用户明确确认。run_mod.sh 在启动前调用 --check, 发现
非标音频时列出清单并在终端询问 y/N; 也可手动执行 --apply。

用法:
  python3 normalize_audio.py --check [root]   # 检测: 列出非标文件; 退出码 0=全合规 1=有非标
  python3 normalize_audio.py --apply [root]   # 批量转换 (列表确认后执行, ogg 源会被删除)
  python3 normalize_audio.py [root]           # 等同 --check
"""
import argparse
import os
import struct
import subprocess
import sys

TARGET_RATE = 44100
TARGET_CH = 2
TARGET_BITS = 16

DEFAULT_ROOT = os.path.expanduser(
    "~/Library/Application Support/Steam/steamapps/common/manosaba_game/ManosabaMod"
)
AUDIO_EXT = {".wav", ".ogg"}


def check_wav(path):
    """读 WAV 文件头判断是否 PCM16/44100Hz/立体声。返回原因字符串, None=合规。"""
    try:
        with open(path, "rb") as f:
            hdr = f.read(4096)
    except OSError as e:
        return f"读取失败 ({e})"
    if len(hdr) < 12 or hdr[:4] != b"RIFF" or hdr[8:12] != b"WAVE":
        return "非 RIFF/WAVE 结构"
    pos = 12
    while pos + 8 <= len(hdr):
        cid = hdr[pos:pos + 4]
        size = struct.unpack("<I", hdr[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            if size < 16 or pos + 8 + size > len(hdr):
                return "fmt chunk 不完整"
            fmt = hdr[pos + 8:pos + 8 + size]
            audio_format = struct.unpack("<H", fmt[0:2])[0]
            ch = struct.unpack("<H", fmt[2:4])[0]
            rate = struct.unpack("<I", fmt[4:8])[0]
            bits = struct.unpack("<H", fmt[14:16])[0]
            if audio_format == 0xFFFE:  # WAVE_FORMAT_EXTENSIBLE → SubFormat GUID 前 2 字节是真实格式
                if size >= 40:
                    audio_format = struct.unpack("<H", fmt[24:26])[0]
            if audio_format != 1:
                return f"编码 {audio_format} (非 PCM)"
            if rate != TARGET_RATE:
                return f"{rate}Hz (需 {TARGET_RATE})"
            if ch != TARGET_CH:
                return f"{ch} 声道 (需 {TARGET_CH})"
            if bits != TARGET_BITS:
                return f"{bits}bit (需 {TARGET_BITS})"
            return None
        pos += 8 + size + (size & 1)  # chunk 数据 2 字节对齐
    return "未找到 fmt chunk"


def check(path):
    """返回原因字符串, None=合规。"""
    if path.lower().endswith(".ogg"):
        return "ogg(无法资源定位)"
    return check_wav(path)


def scan(root):
    """递归收集所有音频文件路径。"""
    result = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                result.append(os.path.join(dirpath, name))
    return result


def find_nonstandard(root):
    """返回 [(路径, 原因)], 全部合规时为空。"""
    bad = []
    for path in scan(root):
        reason = check(path)
        if reason is not None:
            bad.append((path, reason))
    return bad


def convert(path, keep_ogg):
    """转码为同名 .wav (临时文件原子替换)。成功返回 True。"""
    target = os.path.splitext(path)[0] + ".wav"
    tmp = target + ".tmp"
    is_ogg = path.lower().endswith(".ogg")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-ar", str(TARGET_RATE), "-ac", str(TARGET_CH),
             "-sample_fmt", "s16", "-f", "wav", tmp],
            capture_output=True, check=True)
        os.replace(tmp, target)
        if is_ogg and not keep_ogg and os.path.abspath(path) != os.path.abspath(target):
            os.remove(path)
        return True
    except (subprocess.CalledProcessError, OSError) as e:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        print(f"  转换失败: {path}\n    {e}")
        return False


def warn(text):
    """警告文字: TTY 时黄色加粗, 非 TTY (重定向/管道) 时纯文本。"""
    if sys.stdout.isatty():
        return f"\033[33m{text}\033[0m"
    return text


def cmd_check(root):
    bad = find_nonstandard(root)
    if not bad:
        return 0
    print(f"检测到 {len(bad)} 个非标音频 (游戏原装转换器只支持 PCM16/44100Hz/立体声 wav):")
    for path, reason in bad:
        print(f"  [{reason}] {path}")
    print("转换后这些音频在 macOS 与 Windows 版均能正常播放; 不转换则照常启动,")
    print("但非标音频可能无声/音高偏移 (ogg 剧本加载时会报错)。")
    print(warn("注意: 转换会覆盖同名 .wav, ogg 源文件将被删除, 建议先备份!"))
    return 1


def cmd_apply(root, keep_ogg):
    bad = find_nonstandard(root)
    if not bad:
        print("全部音频已合规 (PCM16/44100Hz/立体声), 无需转换。")
        return 0
    print(f"将转换 {len(bad)} 个非标音频:")
    for path, reason in bad:
        print(f"  [{reason}] {path}")
    print(warn("注意: 会覆盖同名 .wav, ogg 源文件将被删除!"))
    ok = 0
    for path, _ in bad:
        if convert(path, keep_ogg):
            ok += 1
    print(f"转换完成: 成功 {ok}/{len(bad)}。")
    return 0 if ok == len(bad) else 1


def main():
    ap = argparse.ArgumentParser(description="Manosaba mod 音频规范化 (PCM16/44100Hz/立体声)")
    ap.add_argument("root", nargs="?", default=DEFAULT_ROOT,
                    help=f"mod 根目录 (默认 {DEFAULT_ROOT})")
    ap.add_argument("--check", action="store_true",
                    help="检测模式: 列出非标音频, 退出码 0=全合规 1=有非标 (run_mod.sh 用)")
    ap.add_argument("--apply", action="store_true",
                    help="批量转换模式: 列出清单后执行转换 (会改文件!)")
    ap.add_argument("--keep-ogg", action="store_true",
                    help="转换 ogg 后保留原 ogg 文件 (默认删除, 避免同名文件歧义)")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        if args.check:
            return 0  # mod 目录还不存在 (首次运行), 静默通过
        print(f"目录不存在: {args.root}")
        sys.exit(1)

    if args.apply:
        sys.exit(cmd_apply(args.root, args.keep_ogg))
    sys.exit(cmd_check(args.root))  # 默认 --check


if __name__ == "__main__":
    main()
