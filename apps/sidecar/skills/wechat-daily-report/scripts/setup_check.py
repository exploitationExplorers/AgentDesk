"""
setup_check.py - 微信数据库解密前的环境检查

职责：
  - 校验 Python 版本
  - 检查 vendor/wcdb-key-tool 是否存在（微信 4.1+ 密钥提取/解密工具）
  - 检查 decrypted/ 解密库与密钥文件是否就绪
  - 检查微信是否正在运行（Windows / macOS）
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DECRYPTOR_DIR = REPO_ROOT / "vendor" / "wcdb-key-tool"
DECRYPTED_DIR = REPO_ROOT / "decrypted"
KEYS_FILE = DECRYPTED_DIR / "all_keys.json"
SUPPORTED_PLATFORMS = {"win32": "Windows", "darwin": "macOS"}


def run_command(cmd, cwd=None):
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        errors="replace",
    )


def ensure_python_version():
    return sys.version_info >= (3, 9)


def detect_platform():
    return SUPPORTED_PLATFORMS.get(sys.platform, sys.platform)


def build_notes():
    if sys.platform == "win32":
        return [
            "请用管理员权限启动终端和微信。",
            "若解密时报 Access Denied，请重新以管理员身份运行。",
        ]
    if sys.platform == "darwin":
        return [
            "请确认微信已启动并处于登录状态。",
            "若解密失败，请检查终端是否已获得所需系统权限。",
        ]
    return [
        "当前仓库仅正式支持 Windows 和 macOS。",
    ]


def ensure_decryptor(decryptor_dir):
    """wcdb-key-tool 已随 skill 预置在 vendor/ 下，无需 clone。"""
    if decryptor_dir.exists():
        return {"changed": False, "message": "wcdb-key-tool 已存在"}
    raise RuntimeError("未找到 vendor/wcdb-key-tool，请确认 skill 目录完整")


def install_dependencies():
    return {"changed": False, "message": "wcdb-key-tool 依赖为系统内置（Windows bcrypt.dll），无需额外安装"}


def check_wechat_process():
    if sys.platform == "win32":
        result = run_command(["tasklist"])
        if result.returncode != 0:
            return False, [], "无法执行 tasklist 检查微信进程"
        matches = [line.strip() for line in result.stdout.splitlines() if "wechat" in line.lower()]
        return bool(matches), matches[:10], ""

    if sys.platform == "darwin":
        matches = []
        for pattern in ("WeChat", "微信", "wechat"):
            result = run_command(["pgrep", "-ifl", pattern])
            if result.returncode not in (0, 1):
                return False, [], f"无法执行 pgrep 检查微信进程: {result.stderr.strip()}"
            for line in result.stdout.splitlines():
                line = line.strip()
                if line and line not in matches:
                    matches.append(line)
        return bool(matches), matches[:10], ""

    return False, [], "当前平台未实现微信进程检测"


def main():
    parser = argparse.ArgumentParser(description="检查微信群聊日报解密运行环境")
    parser.add_argument(
        "--ensure-decryptor",
        action="store_true",
        help="检查 wcdb-key-tool 是否就绪（已随 skill 预置）",
    )
    parser.add_argument(
        "--decryptor-dir",
        default=str(DEFAULT_DECRYPTOR_DIR),
        help="wcdb-key-tool 目录",
    )
    args = parser.parse_args()

    decryptor_dir = Path(args.decryptor_dir).expanduser().resolve()
    report = {
        "status": "ok",
        "platform": detect_platform(),
        "python_executable": sys.executable,
        "python_version": ".".join(map(str, sys.version_info[:3])),
        "decryptor_dir": str(decryptor_dir),
        "decryptor_present": decryptor_dir.exists(),
        "decrypted_dir": str(DECRYPTED_DIR),
        "decrypted_present": DECRYPTED_DIR.exists(),
        "keys_present": KEYS_FILE.exists(),
        "wechat_running": False,
        "wechat_processes": [],
        "notes": build_notes(),
        "actions": [],
    }

    if sys.platform not in SUPPORTED_PLATFORMS:
        report["status"] = "error"
        report["error"] = f"当前平台 {detect_platform()} 暂未正式支持"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    if not ensure_python_version():
        report["status"] = "error"
        report["error"] = "需要 Python 3.9 或更高版本"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    try:
        if args.ensure_decryptor:
            if not decryptor_dir.exists():
                report["actions"].append(ensure_decryptor(decryptor_dir))
                report["decryptor_present"] = True
            report["actions"].append(install_dependencies())
    except RuntimeError as exc:
        report["status"] = "error"
        report["error"] = str(exc)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    running, processes, error = check_wechat_process()
    report["wechat_running"] = running
    report["wechat_processes"] = processes
    if error:
        report["status"] = "error"
        report["error"] = error
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    if not running:
        report["status"] = "error"
        report["error"] = "请先打开微信并登录，然后重新运行"
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(1)

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
