import datetime
import html
import hashlib
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

try:
    import zstandard as zstd
    _ZSTD = zstd.ZstdDecompressor()
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DECRYPTED_DIR = REPO_ROOT / "decrypted"
MESSAGE_DB_PATTERN = re.compile(r"message_\d+\.db$")


def collapse_text(text):
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()


def parse_xml_root(content):
    if not content or not isinstance(content, str):
        return None
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        return None


def parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def truncate_text(text, max_length=60):
    text = collapse_text(text)
    if len(text) <= max_length:
        return text
    return text[:max_length] + "..."


def describe_reference(ref_type, ref_display_name, ref_content):
    ref_display_name = collapse_text(ref_display_name)
    ref_content = collapse_text(ref_content)

    if ref_type == 1:
        if ref_display_name and ref_content:
            return f"{ref_display_name}「{truncate_text(ref_content)}」"
        if ref_display_name:
            return ref_display_name
        if ref_content:
            return f"「{truncate_text(ref_content)}」"
        return "一条消息"

    if ref_type == 3:
        return f"{ref_display_name}发的图片" if ref_display_name else "一张图片"

    if ref_type == 49:
        nested_xml = html.unescape(ref_content)
        nested_root = parse_xml_root(nested_xml)
        if nested_root is not None:
            nested_appmsg = nested_root.find(".//appmsg")
            if nested_appmsg is not None:
                nested_title = collapse_text(nested_appmsg.findtext("title") or "")
                nested_type = parse_int(nested_appmsg.findtext("type"))
                if nested_type == 57 and nested_title:
                    if ref_display_name:
                        return f"{ref_display_name}回复的消息《{truncate_text(nested_title)}》"
                    return f"一条回复消息《{truncate_text(nested_title)}》"
                if nested_title:
                    if ref_display_name:
                        return f"{ref_display_name}分享的《{truncate_text(nested_title)}》"
                    return f"一条分享《{truncate_text(nested_title)}》"
        if ref_display_name:
            return f"{ref_display_name}的一条分享"
        return "一条分享"

    if ref_display_name:
        return ref_display_name
    return "一条消息"


def format_app_message(content):
    root = parse_xml_root(content)
    if root is None:
        return None

    appmsg = root.find(".//appmsg")
    if appmsg is None:
        return None

    title = collapse_text(appmsg.findtext("title") or "")
    app_type = parse_int(appmsg.findtext("type"))

    if app_type == 57:
        refermsg = appmsg.find(".//refermsg")
        ref_type = parse_int(refermsg.findtext("type")) if refermsg is not None else 0
        ref_display_name = refermsg.findtext("displayname") if refermsg is not None else ""
        ref_content = refermsg.findtext("content") if refermsg is not None else ""
        reference = describe_reference(ref_type, ref_display_name, ref_content)
        if title:
            return 0, f"回复 {reference}说：{title}"
        return 0, f"回复 {reference}"

    if title:
        return 0, f"分享链接《{title}》"
    return 99, "[链接/文件]"


def decompress_content(content, compression_type):
    if compression_type == 4 and isinstance(content, bytes) and HAS_ZSTD:
        try:
            return _ZSTD.decompress(content).decode("utf-8", errors="replace")
        except Exception:
            return None
    if isinstance(content, bytes):
        try:
            return content.decode("utf-8", errors="replace")
        except Exception:
            return None
    return content


def normalize_local_type(local_type):
    if local_type is None:
        return 0
    return local_type & 0xFFFFFFFF if local_type > 0xFFFFFFFF else local_type


def parse_datetime_string(value):
    """解析日期或日期时间字符串"""
    formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y%m%d %H:%M:%S",
        "%Y%m%d %H:%M",
        "%Y%m%d",
    )
    for fmt in formats:
        try:
            return datetime.datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError(f"无效日期时间格式: {value}，请使用 YYYY-MM-DD [HH:MM:SS]")


def build_timestamp_range(date=None, start=None, end=None):
    if date and (start or end):
        raise ValueError("--date 不能与 --start / --end 同时使用")

    if date:
        # 如果是单日模式，默认从该日 00:00:00 到 23:59:59
        target_dt = parse_datetime_string(date)
        start_dt = datetime.datetime.combine(target_dt.date(), datetime.time.min)
        end_dt = start_dt + datetime.timedelta(days=1)
        return int(start_dt.timestamp()), int(end_dt.timestamp())

    start_ts = None
    end_ts = None
    if start:
        start_dt = parse_datetime_string(start)
        start_ts = int(start_dt.timestamp())
    if end:
        end_dt = parse_datetime_string(end)
        # 如果 end 只有日期部分（00:00:00），且输入字符串长度较短，则视作包含该日全天
        if len(end) <= 10 and end_dt.time() == datetime.time.min:
            end_dt = datetime.datetime.combine(end_dt.date(), datetime.time.min) + datetime.timedelta(days=1)
        end_ts = int(end_dt.timestamp())
    return start_ts, end_ts


def ensure_decrypted_dir(decrypted_dir):
    path = Path(decrypted_dir).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"解密目录不存在: {path}")
    return path


def load_contacts(decrypted_dir):
    contact_db = Path(decrypted_dir) / "contact" / "contact.db"
    if not contact_db.exists():
        raise FileNotFoundError(f"找不到联系人数据库: {contact_db}")

    contacts = {}
    conn = sqlite3.connect(str(contact_db))
    try:
        rows = conn.execute(
            "SELECT username, nick_name, remark, big_head_url, small_head_url FROM contact"
        ).fetchall()
    finally:
        conn.close()

    for username, nick_name, remark, big_head_url, small_head_url in rows:
        if not username:
            continue
        contacts[username] = {
            "username": username,
            "nick_name": nick_name or "",
            "remark": remark or "",
            "display_name": nick_name or remark or username,
            "avatar": small_head_url or big_head_url or "",
        }
    return contacts


def iter_message_dbs(decrypted_dir):
    message_dir = Path(decrypted_dir) / "message"
    if not message_dir.exists():
        raise FileNotFoundError(f"找不到消息目录: {message_dir}")
    for file_path in sorted(message_dir.iterdir()):
        if file_path.is_file() and MESSAGE_DB_PATTERN.match(file_path.name):
            yield file_path


def get_table_name(username):
    return f"Msg_{hashlib.md5(username.encode('utf-8')).hexdigest()}"


def list_chatrooms(decrypted_dir):
    decrypted_dir = ensure_decrypted_dir(decrypted_dir)
    contacts = load_contacts(decrypted_dir)
    chatrooms = [
        {
            "username": username,
            "display_name": info["display_name"],
            "nick_name": info["nick_name"],
            "remark": info["remark"],
            "message_count": 0,
        }
        for username, info in contacts.items()
        if username.endswith("@chatroom")
    ]

    if not chatrooms:
        return []

    chatroom_index = {item["username"]: item for item in chatrooms}
    for db_path in iter_message_dbs(decrypted_dir):
        conn = sqlite3.connect(str(db_path))
        try:
            for username in chatroom_index:
                table_name = get_table_name(username)
                try:
                    count = conn.execute(f"SELECT COUNT(*) FROM [{table_name}]").fetchone()[0]
                except sqlite3.OperationalError:
                    continue
                chatroom_index[username]["message_count"] += count
        finally:
            conn.close()

    chatrooms = [item for item in chatrooms if item["message_count"] > 0]
    chatrooms.sort(key=lambda item: item["message_count"], reverse=True)
    return chatrooms


def resolve_chatroom_username(query, contacts):
    normalized_query = query.strip().lower()
    if query in contacts and query.endswith("@chatroom"):
        return query

    for username, info in contacts.items():
        if username.endswith("@chatroom") and normalized_query == info["display_name"].lower():
            return username

    for username, info in contacts.items():
        if not username.endswith("@chatroom"):
            continue
        display_name = info["display_name"].lower()
        if normalized_query in display_name or normalized_query in username.lower():
            return username

    raise KeyError(f"找不到群聊: {query}")


def load_name2id_map(conn):
    mapping = {}
    try:
        rows = conn.execute("SELECT rowid, user_name FROM Name2Id").fetchall()
    except sqlite3.OperationalError:
        return mapping

    for rowid, username in rows:
        if username:
            mapping[rowid] = username
    return mapping


def extract_sender_from_group_content(content, contacts):
    if not isinstance(content, str) or ":\n" not in content:
        return None, content

    sender_candidate, body = content.split(":\n", 1)
    sender_candidate = sender_candidate.strip()
    if not sender_candidate:
        return None, body

    if sender_candidate in contacts or sender_candidate.endswith("@openim"):
        return sender_candidate, body

    return None, content


def map_message_type(local_type, raw_content):
    local_type = normalize_local_type(local_type)
    content = raw_content or ""

    if local_type == 1:
        return 0, content.strip()
    if local_type == 3:
        return 1, "[图片]"
    if local_type == 34:
        content = content.strip()
        if content.startswith("[语音转文字]"):
            return 2, content
        return 99, "[语音消息]"
    if local_type == 42:
        return 99, "[名片]"
    if local_type == 43:
        return 99, "[视频]"
    if local_type == 47:
        return 5, "[表情]"
    if local_type == 48:
        return 99, "[位置]"
    if local_type == 49:
        formatted = format_app_message(content)
        if formatted is not None:
            return formatted
        return 99, "[链接/文件]"
    if local_type == 50:
        return 99, "[通话]"
    if local_type == 10002:
        return 99, "[撤回了一条消息]"
    if local_type == 10000:
        return 99, content.strip() or "[系统消息]"

    return 99, content.strip() or f"[未知消息类型 {local_type}]"


def message_in_range(timestamp, start_ts, end_ts):
    if start_ts is not None and timestamp < start_ts:
        return False
    if end_ts is not None and timestamp >= end_ts:
        return False
    return True


def load_chatroom_records(decrypted_dir, chatroom_query, date=None, start=None, end=None):
    decrypted_dir = ensure_decrypted_dir(decrypted_dir)
    contacts = load_contacts(decrypted_dir)
    chatroom_username = resolve_chatroom_username(chatroom_query, contacts)
    chatroom_info = contacts[chatroom_username]
    start_ts, end_ts = build_timestamp_range(date=date, start=start, end=end)
    table_name = get_table_name(chatroom_username)

    messages = []
    member_ids = set()

    for db_path in iter_message_dbs(decrypted_dir):
        conn = sqlite3.connect(str(db_path))
        try:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table_name,),
            ).fetchone()
            if not exists:
                continue

            id_to_username = load_name2id_map(conn)
            rows = conn.execute(
                f"""
                SELECT local_id, local_type, create_time, real_sender_id,
                       message_content, WCDB_CT_message_content
                FROM [{table_name}]
                ORDER BY create_time ASC
                """
            ).fetchall()

            for _, local_type, timestamp, real_sender_id, content, compression_type in rows:
                if timestamp is None or not message_in_range(timestamp, start_ts, end_ts):
                    continue

                decoded_content = decompress_content(content, compression_type)
                sender_username = id_to_username.get(real_sender_id)
                fallback_sender, decoded_content = extract_sender_from_group_content(decoded_content, contacts)
                if not sender_username:
                    sender_username = fallback_sender

                message_type, display_content = map_message_type(local_type, decoded_content)
                if message_type == 0 and not display_content:
                    continue

                sender_username = sender_username or "unknown_sender"
                sender_info = contacts.get(sender_username, {"display_name": sender_username})
                # 网名优先级最高：nick_name > remark > username
                account_name = sender_info.get("nick_name") or sender_info.get("remark") or sender_username
                # groupNickname 存储群昵称（如有），目前暂用 display_name 兜底
                group_nickname = sender_info.get("display_name") or account_name
                avatar = sender_info.get("avatar") or None

                messages.append(
                    {
                        "sender": sender_username,
                        "accountName": account_name,
                        "groupNickname": group_nickname,
                        "timestamp": timestamp,
                        "type": message_type,
                        "content": display_content,
                        "avatar": avatar,
                    }
                )
                if sender_username != "unknown_sender":
                    member_ids.add(sender_username)
        finally:
            conn.close()

    messages.sort(key=lambda item: item["timestamp"])

    members = []
    for username in sorted(member_ids):
        info = contacts.get(username, {"display_name": username})
        members.append(
            {
                "platformId": username,
                "accountName": info["display_name"],
                "avatar": info.get("avatar") or None,
            }
        )

    return {
        "meta": {
            "name": chatroom_info["display_name"],
            "platform": "wechat",
            "type": "group",
            "groupId": chatroom_username,
            "source": "wechat-decrypted-db",
            "decrypted_dir": str(decrypted_dir),
        },
        "members": members,
        "messages": messages,
    }
