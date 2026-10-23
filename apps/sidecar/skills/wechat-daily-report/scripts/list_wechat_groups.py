import argparse
import json

try:
    from scripts.wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, list_chatrooms
except ModuleNotFoundError:
    from wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, list_chatrooms


def parse_args():
    parser = argparse.ArgumentParser(description="列出解密后的微信数据库中的群聊")
    parser.add_argument(
        "--decrypted-dir",
        default=str(DEFAULT_DECRYPTED_DIR),
        help="解密数据库目录，默认 skill 根目录 decrypted",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    groups = list_chatrooms(args.decrypted_dir)
    print(json.dumps(groups, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
