#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
analyze_member.py - 微信群「个人日报」统计分析脚本

读取解密后的微信群聊数据库，统计指定成员当日的发言数据，
生成 member_stats.json（统计数据）与 member_chat.txt（该成员当日发言压缩文本，供 AI 摘要）。

使用方式:
    # 列出群内当天有发言的成员（含 wxid，便于 --member-id 精确匹配，规避终端中文参数编码问题）
    python analyze_member.py --chatroom 12345678901@chatroom --list-members --date 2026-09-02

    # 按昵称关键字定位成员（英文昵称可直接传参）
    python analyze_member.py --chatroom 12345678901@chatroom --member happy --date 2026-09-02

    # 按 wxid 精确定位（推荐，中英文昵称均可覆盖）
    python analyze_member.py --chatroom 12345678901@chatroom --member-id wxid_xxx --date 2026-09-02
"""

import argparse
import datetime
import json
import sys
from collections import Counter

try:
    from scripts.wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, load_chatroom_records
except ModuleNotFoundError:
    from wechat_decrypted_reader import DEFAULT_DECRYPTED_DIR, load_chatroom_records

try:
    import jieba
    JIEBA_AVAILABLE = True
except ImportError:
    JIEBA_AVAILABLE = False

# 消息类型细分（与 wechat_decrypted_reader.map_message_type 的映射对应）
TYPE_NAMES = {
    0: '文本',
    1: '图片',
    2: '语音转文字',
    5: '表情',
    99: '其他',
}
TYPE_COLORS = {
    '文本': '#07C160',
    '图片': '#576B95',
    '表情': '#FA9D3B',
    '语音转文字': '#FFC300',
    '链接分享': '#FA5151',
    '其他': '#B2B2B2',
}
TYPE_ORDER = ['文本', '图片', '表情', '语音转文字', '链接分享', '其他']

STOPWORDS = set([
    '的', '了', '我', '是', '你', '在', '他', '我们', '好', '去', '都', '就', '那', '有', '这', '也', '要', '吗', '啊', '吧', '呢', '哈', '哈哈', '哈哈哈',
    '这个', '可以', '不是', '一下', '什么', '这样', '现在', '需要', '知道', '应该', '已经', '怎么', '这么', '那个', '可能', '比如', '觉得',
    '还有', '然后', '但是', '而且', '因为', '所以', '如果', '虽然', '其实', '还是', '就是', '只是', '或者', '以及',
    '回复', '分享链接', '一条', '一个', '一次', '图片', '表情', '动画表情', '语音', '转文字', '链接', '说',
])


def parse_arguments():
    parser = argparse.ArgumentParser(description="Analyze a single member's daily activity in a WeChat group.")
    parser.add_argument('--decrypted-dir', default=str(DEFAULT_DECRYPTED_DIR), help='Path to decrypted WeChat database directory')
    parser.add_argument('--chatroom', required=True, help='Chatroom display name keyword or chatroom id')
    parser.add_argument('--member', help="Member display name (exact or keyword match, case-insensitive)")
    parser.add_argument('--member-id', help='Member wxid (platformId), precise match, avoids CJK shell encoding issues')
    parser.add_argument('--date', help='Single day filter, format YYYY-MM-DD')
    parser.add_argument('--list-members', action='store_true', help='List members who spoke on the given date, then exit')
    parser.add_argument('--all-members', action='store_true', help='List ALL chatroom members (including silent ones), then exit')
    parser.add_argument('--output-stats', default='member_stats.json', help='Path to output member statistics JSON')
    parser.add_argument('--output-text', default='member_chat.txt', help='Path to output member speech text for AI')
    return parser.parse_args()


def get_display_name(msg):
    """与 analyze_chat.py 保持一致：accountName 优先。"""
    return msg.get('accountName') or msg.get('groupNickname') or 'Unknown'


def resolve_member(messages, members, args):
    """按 --member-id 或 --member 定位成员，返回 (wxid, display_name, avatar)。"""
    if args.member_id:
        for m in messages:
            if m.get('sender') == args.member_id:
                return args.member_id, get_display_name(m), m.get('avatar')
        for member in members:
            if member.get('platformId') == args.member_id:
                return args.member_id, member.get('accountName'), member.get('avatar')
        return args.member_id, args.member_id, None

    if args.member:
        query = args.member.strip().lower()
        by_name = {}
        for m in messages:
            by_name.setdefault(get_display_name(m), m)
        exact = by_name.get(args.member.strip()) or by_name.get(query)
        if exact is None:
            for name, m in by_name.items():
                if query in name.lower():
                    exact = m
                    break
        if exact is not None:
            return exact.get('sender'), get_display_name(exact), exact.get('avatar')
        for member in members:
            name = (member.get('accountName') or '').lower()
            if name == query or query in name:
                return member.get('platformId'), member.get('accountName'), member.get('avatar')
    return None, None, None


def classify_content(msg):
    """将一条消息细分为展示用类型名。"""
    t = msg.get('type')
    content = msg.get('content') or ''
    if t == 0:
        if content.startswith('分享链接'):
            return '链接分享'
        return '文本'
    return TYPE_NAMES.get(t, '其他')


def build_type_distribution(member_msgs):
    counter = Counter(classify_content(m) for m in member_msgs)
    total = sum(counter.values()) or 1
    result = []
    for name in TYPE_ORDER:
        count = counter.get(name, 0)
        if count <= 0:
            continue
        result.append({
            'name': name,
            'count': count,
            'percent': round(count / total * 100),
            'color': TYPE_COLORS.get(name, '#B2B2B2'),
        })
    return result


def build_hourly_activity(member_msgs):
    hours = [0] * 24
    for m in member_msgs:
        hours[datetime.datetime.fromtimestamp(m['timestamp']).hour] += 1
    max_count = max(hours) if hours else 0
    peak_hour = hours.index(max_count) if max_count > 0 else None
    hourly = [{'hour': h, 'count': c} for h, c in enumerate(hours)]
    return hourly, max_count, peak_hour


def build_keywords(member_msgs, top_n=15):
    if not JIEBA_AVAILABLE:
        return []
    combined = ' '.join(
        (m.get('content') or '').replace('\r', '').replace('\n', ' ')
        for m in member_msgs if m.get('type') in (0, 2)
    )
    words = [w for w in jieba.cut(combined) if len(w) > 1 and w not in STOPWORDS and not w.startswith('[')]
    counter = Counter(words)
    return [{'word': w, 'count': c} for w, c in counter.most_common(top_n)]


def _fmt_time(ts):
    return datetime.datetime.fromtimestamp(ts).strftime('%H:%M')


def build_interactions(messages, member_wxid, member_name):
    """扫描全群当天消息，统计与该成员相关的互动。"""
    reply_to_member = []      # 别人回复该成员
    mention_member = []       # 别人 @ 该成员
    reply_by_member = 0       # 该成员回复别人的次数
    mention_by_member = 0     # 该成员 @ 别人的次数

    for m in messages:
        content = m.get('content') or ''
        sender = m.get('sender')
        if sender == member_wxid:
            if content.startswith('回复 '):
                reply_by_member += 1
            if '@' in content:
                mention_by_member += content.count('@')
            continue
        if f'回复 {member_name}' in content:
            reply_to_member.append({
                'who': get_display_name(m),
                'time': _fmt_time(m['timestamp']),
                'content': content[:120],
            })
        elif f'@{member_name}' in content:
            mention_member.append({
                'who': get_display_name(m),
                'time': _fmt_time(m['timestamp']),
                'content': content[:120],
            })

    return {
        'reply_received': reply_to_member,
        'mention_received': mention_member,
        'reply_sent_count': reply_by_member,
        'mention_sent_count': mention_by_member,
    }


def build_quotes(member_msgs, top_n=5, max_len=120):
    """代表性发言：取最长的几条文本消息。"""
    texts = [
        m for m in member_msgs
        if m.get('type') in (0, 2) and (m.get('content') or '').strip()
        and not (m.get('content') or '').startswith('分享链接')
    ]
    texts.sort(key=lambda m: len(m.get('content') or ''), reverse=True)
    quotes = []
    for m in texts[:top_n]:
        content = (m.get('content') or '').replace('\r', '').replace('\n', ' ').strip()
        if len(content) > max_len:
            content = content[:max_len] + '...'
        quotes.append({'time': _fmt_time(m['timestamp']), 'content': content, 'length': len(content)})
    return quotes


def build_simplified_text(member_msgs, meta_info, output_path):
    """按 5 分钟窗口压缩该成员的文本消息，供 AI 摘要。"""
    TIME_WINDOW = 5 * 60
    text_msgs = [m for m in member_msgs if m.get('type') in (0, 2) and (m.get('content') or '').strip()]
    text_msgs.sort(key=lambda m: m['timestamp'])

    lines = [f"=== 成员: {meta_info['member_name']} | 群: {meta_info['chatroom_name']} | 日期: {meta_info['date']} | 发言数: {len(text_msgs)} ==="]

    window_start = None
    group = []
    groups = []
    for m in text_msgs:
        ts = m['timestamp']
        if window_start is None:
            window_start, group = ts, [m]
        elif ts - window_start <= TIME_WINDOW:
            group.append(m)
        else:
            groups.append(group)
            window_start, group = ts, [m]
    if group:
        groups.append(group)

    MAX_CONTENT = 200
    for g in groups:
        t0 = datetime.datetime.fromtimestamp(g[0]['timestamp'])
        t1 = datetime.datetime.fromtimestamp(g[-1]['timestamp'])
        span = t0.strftime('%H:%M') if t0.strftime('%H:%M') == t1.strftime('%H:%M') else f"{t0.strftime('%H:%M')}~{t1.strftime('%H:%M')}"
        segs = []
        for m in g:
            content = m['content']
            if content.startswith('[语音转文字] '):
                content = content[7:]
            content = content.replace('\r', '').replace('\n', ' ').strip()
            if not content:
                continue
            if len(content) > MAX_CONTENT:
                content = content[:MAX_CONTENT] + '...'
            segs.append(content)
        if segs:
            lines.append(f"[{span}] " + ' | '.join(segs))

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return len(lines), output_path


def analyze(args):
    data = load_chatroom_records(
        decrypted_dir=args.decrypted_dir,
        chatroom_query=args.chatroom,
        date=args.date,
    )
    messages = data.get('messages', [])
    members = data.get('members', [])

    # --list-members / --all-members：打印成员列表后退出
    if args.list_members or args.all_members:
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
        if args.all_members:
            listing = [
                {'name': m.get('accountName'), 'wxid': m.get('platformId')}
                for m in members
            ]
        else:
            counter = Counter(get_display_name(m) for m in messages)
            id_by_name = {}
            for m in messages:
                id_by_name.setdefault(get_display_name(m), m.get('sender'))
            listing = [
                {'name': name, 'count': count, 'wxid': id_by_name.get(name)}
                for name, count in counter.most_common()
            ]
        print(json.dumps(listing, ensure_ascii=False, indent=2))
        return

    member_wxid, member_name, member_avatar = resolve_member(messages, members, args)
    if member_name is None:
        raise SystemExit(
            '未找到成员：请先用 --list-members 查看当天有发言的成员，'
            '再通过 --member-id <wxid> 或 --member <昵称> 指定。'
        )

    member_msgs = [m for m in messages if m.get('sender') == member_wxid]
    if not member_msgs:
        # 零发言成员：生成「潜水日报」（互动统计仍然有效）
        print(f"[提示] 成员「{member_name}」当日无发言，将生成「潜水日报」。")

    member_msgs.sort(key=lambda m: m['timestamp'])
    if member_msgs:
        date_str = datetime.datetime.fromtimestamp(member_msgs[0]['timestamp']).strftime('%Y-%m-%d')
    else:
        date_str = args.date or datetime.date.today().strftime('%Y-%m-%d')

    # 全群排名（当天）
    counter = Counter(get_display_name(m) for m in messages)
    ranking = counter.most_common()
    rank = next((i for i, (name, _) in enumerate(ranking, 1) if name == member_name), None)

    total_count = len(member_msgs)
    total_chars = sum(
        len((m.get('content') or '').replace('[语音转文字] ', ''))
        for m in member_msgs if m.get('type') in (0, 2)
    )
    first_ts = member_msgs[0]['timestamp'] if member_msgs else None
    last_ts = member_msgs[-1]['timestamp'] if member_msgs else None
    night_count = sum(
        1 for m in member_msgs
        if datetime.datetime.fromtimestamp(m['timestamp']).hour >= 23
        or datetime.datetime.fromtimestamp(m['timestamp']).hour < 6
    )

    hourly, max_hour_count, peak_hour = build_hourly_activity(member_msgs)
    interactions = build_interactions(messages, member_wxid, member_name)

    meta_info = {
        'chatroom_name': data['meta'].get('name'),
        'chatroom_id': data['meta'].get('groupId'),
        'date': date_str,
        'member_name': member_name,
        'member_wxid': member_wxid,
        'avatar': member_avatar,
        'total_count': total_count,
        'total_chars': total_chars,
        'group_rank': rank,
        'group_speaker_count': len(counter),
        'group_total_messages': len(messages),
        'first_msg_time': _fmt_time(first_ts) if first_ts else '-',
        'last_msg_time': _fmt_time(last_ts) if last_ts else '-',
        'night_messages': night_count,
        'silent': not member_msgs,
    }

    stats = {
        'meta': meta_info,
        'type_distribution': build_type_distribution(member_msgs),
        'hourly_activity': hourly,
        'max_hour_count': max_hour_count,
        'peak_hour': peak_hour,
        'keywords': build_keywords(member_msgs),
        'interactions': interactions,
        'quotes': build_quotes(member_msgs),
    }

    text_lines, text_path = build_simplified_text(member_msgs, meta_info, args.output_text)
    stats['raw_text_paths'] = [text_path]

    with open(args.output_stats, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print('Member analysis complete.')
    print(f"Member: {member_name} ({member_wxid})")
    print(f"Stats saved to: {args.output_stats}")
    print(f"Simplified text saved to: {text_path} ({text_lines} lines)")
    print(f"[AI 指令参考] 请阅读 references/member_prompt.md，结合 member_stats.json 与 {text_path} 生成 {args.output_stats.replace('.json', '')} 同目录的 member_ai_content.json")


if __name__ == '__main__':
    args = parse_arguments()
    analyze(args)
