import argparse
import datetime
import random
import os
import subprocess
import sys
from collections import Counter, defaultdict

# 数据源：wechat_decrypted_reader，直接读取 wcdb-key-tool 解密后的 decrypted/
USING_CLI_READER = False
try:
    from scripts.wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, load_chatroom_records
except ModuleNotFoundError:
    from wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, load_chatroom_records

# Try to import jieba, fallback if not available
try:
    import jieba
    import jieba.analyse
    JIEBA_AVAILABLE = True
except ImportError:
    JIEBA_AVAILABLE = False
    print("Warning: 'jieba' module not found. Word cloud will use simple whitespace splitting.")

def parse_arguments():
    parser = argparse.ArgumentParser(description='Analyze WeChat chat records from decrypted database.')
    parser.add_argument('--decrypted-dir', default=str(DEFAULT_DECRYPTED_DIR), help='Path to decrypted WeChat database directory')
    parser.add_argument('--chatroom', required=True, help='Chatroom display name keyword or chatroom id')
    parser.add_argument('--date', help='Single day filter, format YYYY-MM-DD')
    parser.add_argument('--start', help='Start time filter, format YYYY-MM-DD HH:MM:SS')
    parser.add_argument('--end', help='End time filter, format YYYY-MM-DD HH:MM:SS')
    parser.add_argument('--skip-refresh', action='store_true', default=True, help='跳过数据刷新（wechat-cli 模式下默认跳过解密刷新）')
    parser.add_argument('--output-stats', default='stats.json', help='Path to output statistics JSON')
    parser.add_argument('--output-text', default='simplified_chat.txt', help='Path to output simplified text for AI')
    return parser.parse_args()


def refresh_decrypted_data(decrypted_dir):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    decrypt_script = os.path.join(script_dir, 'decrypt_wechat.py')
    result = subprocess.run(
        [sys.executable, decrypt_script],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    if result.returncode != 0:
        raise RuntimeError(
            "刷新微信解密数据失败:\n"
            f"{result.stdout}\n{result.stderr}".strip()
        )

def format_timestamp(ts):
    dt = datetime.datetime.fromtimestamp(ts)
    return dt.strftime('%Y-%m-%d %H:%M:%S'), dt

def get_message_hour(ts):
    return datetime.datetime.fromtimestamp(ts).hour

def get_display_name(msg):
    """获取用户显示名称，优先使用 accountName（网名）"""
    return msg.get('accountName') or msg.get('groupNickname') or 'Unknown'


def build_avatar_maps(data, messages):
    members = data.get('members', [])

    # platformId -> avatar，用于 sender 精确映射
    sender_avatar_map = {}
    # accountName/groupNickname -> avatar，用于渲染层按名字兜底映射
    name_avatar_map = {}

    for member in members:
        sender = member.get('platformId')
        name = member.get('accountName')
        avatar = member.get('avatar')
        if sender and avatar:
            sender_avatar_map[sender] = avatar
        if name and avatar and name not in name_avatar_map:
            name_avatar_map[name] = avatar

    # 补充 groupNickname 名称映射（当群昵称与 accountName 不一致时）
    for msg in messages:
        sender = msg.get('sender')
        display_name = get_display_name(msg)
        avatar = sender_avatar_map.get(sender)
        if display_name and avatar and display_name not in name_avatar_map:
            name_avatar_map[display_name] = avatar

    return sender_avatar_map, name_avatar_map


def resolve_avatar_for_name(name, name_sender_counter, sender_avatar_map, fallback_name_avatar_map):
    counter = name_sender_counter.get(name)
    if counter:
        for sender, _ in counter.most_common():
            avatar = sender_avatar_map.get(sender)
            if avatar:
                return avatar
    return fallback_name_avatar_map.get(name)


def is_night_time(hour):
    # 23:00 - 06:00
    return hour >= 23 or hour < 6

def generate_word_cloud_data(text_messages, top_n=60):
    words = []
    stopwords = set([
        # 助词/代词/常见词
        '的', '了', '我', '是', '你', '在', '他', '我们', '好', '去', '都', '就', '那', '有', '这', '也', '要', '吗', '啊', '吧', '呢', '哈', '哈哈', '哈哈哈', '哈哈哈哈哈',
        # 常见高频无意义词
        '这个', '可以', '不是', '一下', '什么', '这样', '现在', '需要', '知道', '应该', '已经', '怎么', '这么', '那个', '可能', '比如', '觉得', '应该',
        '还有', '应该', '过来', '回去', '然后', '但是', '而且', '因为', '所以', '如果', '虽然', '其实', '还是',
        '就是', '只是', '就是', '比如', '或者', '以及',
        '上传', '下载', '设置', '安装', '使用', '完成', '开始', '结束', '问题', '解决', '使用', '进行', '没有',
        '起来', '出来', '进去', '下来', '过来', '回去', '出去',
        '不是', '可以', '不能', '一定', '一起', '一定', '应该', '准备', '先不', '再', '然后',
        # 微信消息元数据
        '图片', '表情', '动画表情', '语音', '转文字', '语音转文字', '链接', '分享', '回复',
        # 量词
        '一条', '一张', '一个', '一次', '一直', '一定', '一起',
        # 短词
        '说', '做', '给', '跟', '让', '把', '被', '用', '在',
        # 表情/语气词
        '哈哈', '呵呵', '嘻嘻', '啦啦', '嗯', '啊', '哦', '唉', '嘿', '喂', '咦', '耶', '啦', '啰', '哇', '嗷',
    ])
    
    # 合并文本时去除 [语音转文字] 前缀
    contents = []
    for m in text_messages:
        content = m['content']
        if content.startswith('[语音转文字] '):
            content = content[7:]
        contents.append(content)
    combined_text = " ".join(contents)
    
    if JIEBA_AVAILABLE:
        # Use simple tag extraction or cut
        seg_list = jieba.cut(combined_text)
        for word in seg_list:
            if len(word) > 1 and word not in stopwords:
                words.append(word)
    else:
        # Fallback: simple split by non-alphanumeric (for English/mixed) or just char by char for Chinese? 
        # Simple whitespace/punctuation split is not good for Chinese. 
        # Using regex to find 2+ char words if possible, or just skip if no jieba.
        # For this script's robustness, let's assume if no jieba, we stick to basic heuristic
        pass

    word_counts = Counter(words)
    common_words = word_counts.most_common(top_n)
    
    cloud_data = []
    # Simple layout simulation
    # In a real scenario, this implementation would need a complex packing algorithm.
    # Here we randomize positions within a safe area (container is ~800px wide, cloud area ~320px height)
    # We will generate relative positions (%) to keep it responsive-ish
    
    colors = ["#07C160", "#576B95", "#FA5151", "#FFD200", "#333333", "#888888", "#1AAD19", "#2782D7"]
    
    for word, count in common_words:
        size = min(40, max(12, 10 + (count / common_words[0][1]) * 30)) if common_words else 12
        item = {
            "text": word,
            "count": count,
            "size": int(size),
            "color": random.choice(colors),
            "left": random.randint(5, 85), # Percentage
            "top": random.randint(10, 280), # Pixels (height is 320)
            "rotate": random.randint(-20, 20),
            "weight": "bold" if count > common_words[0][1] * 0.5 else "normal"
        }
        cloud_data.append(item)
        
    return cloud_data

def analyze(args):
    if not args.skip_refresh:
        if USING_CLI_READER:
            print("[wechat-cli 模式] 密钥已持久化在 ~/.wechat-cli/，无需解密刷新，跳过 decrypt_wechat.py")
        else:
            refresh_decrypted_data(args.decrypted_dir)

    data = load_chatroom_records(
        decrypted_dir=args.decrypted_dir,
        chatroom_query=args.chatroom,
        date=args.date,
        start=args.start,
        end=args.end,
    )
    messages = data.get('messages', [])
    sender_avatar_map, name_avatar_map = build_avatar_maps(data, messages)
    
    # Basic Stats
    total_messages = len(messages)
    
    # Filter text messages (type 0: 纯文本, type 2: 语音转文字)
    text_messages = [m for m in messages if m['type'] in (0, 2)]
    
    # Active Users (优先使用 groupNickname)
    active_users = set(get_display_name(m) for m in messages)
    
    # Time Range
    timestamps = [m['timestamp'] for m in messages]
    if timestamps:
        start_time, start_dt = format_timestamp(min(timestamps))
        end_time, end_dt = format_timestamp(max(timestamps))
        date_str = start_dt.strftime('%Y-%m-%d')
    else:
        start_time = end_time = "N/A"
        start_dt = end_dt = datetime.datetime.now()
        date_str = datetime.datetime.now().strftime('%Y-%m-%d')

    # --- Talkative List (All Members + Top 3) ---
    user_msg_counts = Counter(get_display_name(m) for m in messages)
    all_members_tuple = user_msg_counts.most_common()  # 获取所有成员
    top_talkers_tuple = user_msg_counts.most_common(3)  # 保留前3名用于兼容

    name_sender_counter = defaultdict(Counter)
    for m in messages:
        sender = m.get('sender')
        if sender:
            name_sender_counter[get_display_name(m)][sender] += 1

    # 收集所有成员的文本消息（用于常用词统计）
    talker_all_text = defaultdict(list)
    for m in text_messages:
        name = get_display_name(m)
        talker_all_text[name].append(m['content'])

    stopwords = set(['的', '了', '我', '是', '你', '在', '他', '我们', '好', '去', '都', '就', '那', '有', '这', '也', '要', '吗', '啊', '吧', '呢', '哈', '哈哈', '哈哈哈', '图片', '表情', '动画表情', '一个', '这个', '那个', '什么', '怎么', '可以', '就是', '不是', '没有', '还有', '但是', '现在', '知道', '真的', '感觉', '觉得', '可能', '应该', '已经', '还是', '一下', '链接', '分享', '回复', '一条', '一张', '发的', '说'])

    # 统计所有成员的排名和常用词
    all_members_ranking = []
    for rank, (name, count) in enumerate(all_members_tuple, 1):
        common_words = []
        if JIEBA_AVAILABLE and name in talker_all_text:
            combined = " ".join(talker_all_text[name])
            words = [w for w in jieba.cut(combined) if len(w) > 1 and w not in stopwords]
            word_counts = Counter(words)
            common_words = [w for w, _ in word_counts.most_common(5)]

        all_members_ranking.append({
            "rank": rank,
            "name": name,
            "count": count,
            "common_words": common_words,
            "avatar": resolve_avatar_for_name(
                name=name,
                name_sender_counter=name_sender_counter,
                sender_avatar_map=sender_avatar_map,
                fallback_name_avatar_map=name_avatar_map
            )
        })

    # 生成前3名列表（兼容现有渲染逻辑）
    top_talkers = all_members_ranking[:3]

    # --- Night Owl Champion ---
    # 23:00 - 06:00, Find the user who spoke latest (closest to 06:00 from the left or right?)
    # Usually "Night Owl" means staying up late. So we look for messages in 23:00-05:59.
    # The "Champion" is the one who spoke latest in that window (e.g. at 04:30 is later than 01:00).
    candidates = []
    
    for m in messages:
        ts = m['timestamp']
        dt = datetime.datetime.fromtimestamp(ts)
        h = dt.hour
        if is_night_time(h):
            # Calculate "lateness"
            # 23:00 -> 0, 00:00 -> 60, ... 05:59 -> highest
            minutes_from_23 = (h - 23 if h >= 23 else h + 1) * 60 + dt.minute
            candidates.append({
                "name": get_display_name(m),
                "time": dt.strftime('%H:%M'),
                "lateness": minutes_from_23,
                "content": m.get('content', ''),
                "raw_ts": ts
            })

    night_owl = None
    if candidates:
        # Sort by lateness descending
        candidates.sort(key=lambda x: x['lateness'], reverse=True)
        champion = candidates[0]
        
        # Count late night messages for this user
        champ_name = champion['name']
        count = sum(1 for c in candidates if c['name'] == champ_name)
        
        night_owl = {
            "name": champ_name,
            "last_time": champion['time'],
            "msg_count": count,
            "last_msg": champion['content'] if champion['content'] else "[非文本消息]",
            "title": "熬夜冠军",
            "avatar": resolve_avatar_for_name(
                name=champ_name,
                name_sender_counter=name_sender_counter,
                sender_avatar_map=sender_avatar_map,
                fallback_name_avatar_map=name_avatar_map
            )
        }

    # --- Word Cloud ---
    word_cloud_data = generate_word_cloud_data(text_messages)

    # --- Simplified Text Generation for AI ---
    # 压缩格式：按时间窗口（5分钟）分组，同窗口消息用 | 分隔放同一行
    # 分块：压缩后仍超过 MAX_LINES_PER_CHUNK 行则拆分为多个文件
    TIME_WINDOW_SECONDS = 5 * 60  # 5 分钟
    MAX_LINES_PER_CHUNK = 1800
    MAX_LINE_LENGTH = 1600  # 单行上限（Read 工具 2000 字符截断，留余量给长用户名）

    # 按时间窗口分组
    groups = []
    current_group = []
    window_start_ts = None

    for m in text_messages:
        ts = m['timestamp']
        if window_start_ts is None:
            window_start_ts = ts
            current_group = [m]
        elif ts - window_start_ts <= TIME_WINDOW_SECONDS:
            current_group.append(m)
        else:
            groups.append(current_group)
            current_group = [m]
            window_start_ts = ts

    if current_group:
        groups.append(current_group)

    # 生成压缩行
    summary_header = f"=== 群名称: {data['meta'].get('name', 'Unknown')} | 日期: {date_str} | 消息总数: {total_messages} ==="
    simplified_lines = [summary_header]

    for group in groups:
        start_dt_g = datetime.datetime.fromtimestamp(group[0]['timestamp'])
        end_dt_g = datetime.datetime.fromtimestamp(group[-1]['timestamp'])
        time_range_str = start_dt_g.strftime('%H:%M')
        if start_dt_g.strftime('%H:%M') != end_dt_g.strftime('%H:%M'):
            time_range_str += f"~{end_dt_g.strftime('%H:%M')}"

        # 构建消息片段
        # 1. 去除内容换行  2. 合并连续同一发言人  3. 截断超长单条
        MAX_CONTENT_LENGTH = 200  # 单条消息内容上限
        segments = []
        prev_name = None
        for m in group:
            content = m['content']
            if content.startswith('[语音转文字] '):
                content = content[7:]
            content = content.replace('\r', '').replace('\n', ' ').strip()
            if not content:
                continue
            if len(content) > MAX_CONTENT_LENGTH:
                content = content[:MAX_CONTENT_LENGTH] + '...'
            name = get_display_name(m)
            if name == prev_name and segments:
                # 同一发言人连续消息，用 / 合并到上一条
                segments[-1] += '/' + content
            else:
                segments.append(f"{name}:{content}")
                prev_name = name

        # 截断合并后过长的片段（同一人连发多条拼接后可能很长）
        MAX_SEGMENT_LENGTH = 500
        segments = [s[:MAX_SEGMENT_LENGTH] + '...' if len(s) > MAX_SEGMENT_LENGTH else s for s in segments]

        # 合并为一行，超长则拆分
        prefix = f"[{time_range_str}] "
        current_line = prefix
        for seg in segments:
            if current_line == prefix:
                # 当前行为空（仅有前缀），直接追加
                current_line += seg
            elif len(current_line) + 3 + len(seg) > MAX_LINE_LENGTH:
                # 加入此消息会超长，另起一行
                simplified_lines.append(current_line)
                current_line = prefix + seg
            else:
                current_line += ' | ' + seg

        if current_line != prefix:
            simplified_lines.append(current_line)

    # 分块逻辑
    chunk_paths = []
    if len(simplified_lines) <= MAX_LINES_PER_CHUNK:
        # 单文件即可
        with open(args.output_text, 'w', encoding='utf-8') as f:
            f.write("\n".join(simplified_lines))
        chunk_paths.append(args.output_text)
    else:
        # 拆分为多个 chunk 文件
        base, ext = os.path.splitext(args.output_text)
        chunk_idx = 1
        total_chunks = (len(simplified_lines) + MAX_LINES_PER_CHUNK - 1) // MAX_LINES_PER_CHUNK
        for i in range(0, len(simplified_lines), MAX_LINES_PER_CHUNK):
            chunk_lines = simplified_lines[i:i + MAX_LINES_PER_CHUNK]
            # 非首块添加头信息
            if i > 0:
                chunk_lines.insert(0, f"{summary_header} (第{chunk_idx}/{total_chunks}部分)")
            path = f"{base}_{chunk_idx}{ext}"
            with open(path, 'w', encoding='utf-8') as f:
                f.write("\n".join(chunk_lines))
            chunk_paths.append(path)
            chunk_idx += 1

    print(f"Simplified text: {len(simplified_lines)} lines -> {len(chunk_paths)} file(s)")

    # --- Output ---
    stats = {
        "meta": {
            "name": data['meta'].get('name'),
            "source_chat_path": data['meta'].get('decrypted_dir'),
            "source_chatroom": data['meta'].get('groupId'),
            "date": date_str,
            "total_count": total_messages,
            "active_user_count": len(active_users),
            "time_range": f"{start_dt.strftime('%H:%M')} 至 {end_dt.strftime('%H:%M')}"
        },
        "top_talkers": top_talkers,
        "all_members_ranking": all_members_ranking,  # 新增：完整榜单
        "night_owl": night_owl,
        "word_cloud": word_cloud_data,
        "name_avatar_map": name_avatar_map,
        "raw_text_paths": chunk_paths
    }

    with open(args.output_stats, 'w', encoding='utf-8') as f:
        import json
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print(f"Analysis complete.")
    print(f"Stats saved to: {args.output_stats}")
    print(f"Simplified text saved to: {', '.join(chunk_paths)}")

    # 打印 AI 指令参考，帮助 AI 识别话痨
    names = [t['name'] for t in top_talkers]
    print(f"\n[AI 指令参考] 请根据 stats.json 为以下前 3 名话痨生成画像特点：{names}")
    print(f"[新增] 完整话痨榜单：共统计 {len(all_members_ranking)} 位成员")

if __name__ == "__main__":
    args = parse_arguments()
    analyze(args)

