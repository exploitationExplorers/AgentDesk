"""
decrypt_wechat.py - 跨平台微信数据库解密入口（wcdb-key-tool 版）

职责：
  - Windows: 用 wcdb-key-tool（wcdb_key_tool_windows.py）从微信进程内存提取密钥并解密数据库
  - macOS:  用 wcdb-key-tool（wcdb_key_tool_macos.py）提取密钥并解密数据库
  - 微信 4.1+ 不再在内存缓存明文密钥，因此统一通过 wcdb-key-tool 的 Config.Cipher 扫描 + HMAC 校验提取密钥

数据流向：
  密钥（all_keys.json）---> 解密全部数据库 ---> skill 根目录 decrypted/
  analyze_chat.py 通过 wechat_decrypted_reader 直接读取 decrypted/
"""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WCDB_TOOL_DIR = REPO_ROOT / "vendor" / "wcdb-key-tool"
KEYS_FILE = REPO_ROOT / "decrypted" / "all_keys.json"
DECRYPTED_DIR = REPO_ROOT / "decrypted"


def _wcdb_script():
    """返回对应平台的 wcdb-key-tool 脚本路径。"""
    if platform.system().lower() == "darwin":
        return WCDB_TOOL_DIR / "wcdb_key_tool_macos.py"
    return WCDB_TOOL_DIR / "wcdb_key_tool_windows.py"


def run_command(cmd, cwd, check=True):
    result = subprocess.run(cmd, cwd=str(cwd))
    if check and result.returncode != 0:
        raise RuntimeError(f"命令执行失败: {' '.join(cmd)}")
    return result.returncode


def ensure_tool_exists():
    script = _wcdb_script()
    if not script.exists():
        raise RuntimeError(f"未找到 wcdb-key-tool: {script}，请先执行 setup_check.py")


def load_existing_keys():
    if not KEYS_FILE.exists():
        return {}
    try:
        with KEYS_FILE.open(encoding="utf-8") as file_obj:
            keys = json.load(file_obj)
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    return {
        name: value
        for name, value in keys.items()
        if not str(name).startswith("_")
    }


def run_extract_flow():
    """用 wcdb-key-tool 提取密钥并解密到 skill 根目录 decrypted/。"""
    existing_keys = load_existing_keys()
    script = _wcdb_script()
    keys_arg = str(KEYS_FILE)
    DECRYPTED_DIR.mkdir(parents=True, exist_ok=True)

    if existing_keys:
        print(f"[*] 检测到现有数据库密钥 {len(existing_keys)} 个，跳过重复提取。")
    else:
        print("[*] 运行 wcdb-key-tool 提取数据库密钥（需微信已登录运行，Windows 需管理员权限）...")
        # extract 直接在 decrypted/ 下生成 all_keys.json
        run_command(
            [sys.executable, str(script), "extract", "--output", keys_arg],
            cwd=WCDB_TOOL_DIR,
        )
        print(f"[*] 密钥已保存到 {KEYS_FILE}")

    print(f"[*] 开始解密全部数据库到 {DECRYPTED_DIR} ...")
    run_command(
        [sys.executable, str(script), "decrypt",
         "--keys", keys_arg,
         "--output", str(DECRYPTED_DIR)],
        cwd=WCDB_TOOL_DIR,
    )
    print("[*] 解密完成。")


def main():
    ensure_tool_exists()
    run_extract_flow()


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"[!] {exc}", file=sys.stderr)
        sys.exit(1)
