#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generate_report.py - 微信群聊日报生成脚本

整合脚本统计数据和 AI 生成内容，使用 Jinja2 渲染 HTML 报告，并转换为图片。

使用方式:
    python generate_report.py --stats stats.json --ai-content ai_content.json --output report.png
    
输出格式：
    - .html 后缀：仅生成 HTML
    - .png/.jpg 后缀：生成 HTML 并转换为图片（需要 playwright）
"""

import json
import argparse
import datetime
import os
import sys

try:
    from jinja2 import Environment, FileSystemLoader
except ImportError:
    print("Error: 'jinja2' module not found. Please install it with: pip install jinja2")
    sys.exit(1)


# iPhone 14 Pro Max 视口尺寸
VIEWPORT_WIDTH = 430
VIEWPORT_HEIGHT = 932
# 注：playwright/Chromium full_page 截图的最大像素高度限制约为 16384。
# 高清 (device_scale_factor=3) 时实际像素 = 视口像素 × 3，长图容易超限被截断。
# 这里用 1 倍像素密度以确保长图完整截取（页面宽度仍按 430 设计）。
DEVICE_SCALE_FACTOR = 1
# Chromium 单张截图的像素高度上限，超过后 full_page 截图会被静默截断
MAX_SCREENSHOT_HEIGHT = 16384
# 分段截图时的单段高度（留足余量，避免边界截断）
SEGMENT_HEIGHT = 8000


def parse_arguments():
    parser = argparse.ArgumentParser(description='Generate WeChat daily report.')
    parser.add_argument('--stats', required=True, help='Path to statistics JSON from analyze_chat.py')
    parser.add_argument('--ai-content', required=False, default=None, help='Path to AI-generated content JSON (optional)')
    parser.add_argument('--template', default=None, help='Path to Jinja2 HTML template')
    parser.add_argument('--output', default='report.png', help='Output file path (.html or .png/.jpg)')
    parser.add_argument('--clean-temp', action='store_true', help='Delete temporary files after report generation')
    return parser.parse_args()


def cleanup_temp_files(file_paths):
    """删除临时文件"""
    for path in file_paths:
        if path and os.path.exists(path):
            try:
                os.remove(path)
                print(f"Deleted temp file: {path}")
            except OSError as e:
                print(f"Warning: Failed to delete {path}: {e}")


def load_json(file_path):
    if not file_path or not os.path.exists(file_path):
        return {}
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def get_display_name(msg):
    return msg.get('groupNickname') or msg.get('accountName') or ''


def build_name_avatar_map_from_chat(chat_json_path):
    data = load_json(chat_json_path)
    if not data:
        return {}

    members = data.get('members', [])
    messages = data.get('messages', [])

    sender_avatar_map = {}
    name_avatar_map = {}

    for member in members:
        sender = member.get('platformId')
        name = member.get('accountName')
        avatar = member.get('avatar')
        if sender and avatar:
            sender_avatar_map[sender] = avatar
        if name and avatar and name not in name_avatar_map:
            name_avatar_map[name] = avatar

    for msg in messages:
        sender = msg.get('sender')
        display_name = get_display_name(msg)
        avatar = sender_avatar_map.get(sender)
        if display_name and avatar and display_name not in name_avatar_map:
            name_avatar_map[display_name] = avatar

    return name_avatar_map


def load_name_avatar_map(stats, stats_path):
    avatar_map = {}

    # 兼容旧版 stats：若已内嵌映射，继续支持
    legacy_map = stats.get('name_avatar_map', {})
    if isinstance(legacy_map, dict):
        avatar_map.update(legacy_map)

    source_chat_path = stats.get('meta', {}).get('source_chat_path')
    if source_chat_path:
        if not os.path.isabs(source_chat_path):
            base_dir = os.path.dirname(os.path.abspath(stats_path))
            source_chat_path = os.path.normpath(os.path.join(base_dir, source_chat_path))
        if os.path.isfile(source_chat_path):
            avatar_map.update(build_name_avatar_map_from_chat(source_chat_path))

    return avatar_map


def get_name_avatar(name, name_avatar_map):
    if not isinstance(name, str):
        return None
    clean_name = name.strip()
    if not clean_name:
        return None
    return name_avatar_map.get(clean_name)


def normalize_topic_heat(ai_content):
    """兼容两种 topic_heat 格式：label/value 或 name/count/percent。"""
    heats = ai_content.get('topic_heat', [])
    if not heats:
        return

    normalized = []
    # 先统一收集数值
    entries = []
    for h in heats:
        if not isinstance(h, dict):
            continue
        # 已符合模板格式
        if 'name' in h and 'count' in h and 'percent' in h:
            entries.append(h)
            continue
        # label/value 格式
        if 'label' in h and 'value' in h:
            entries.append({
                'name': h.get('label'),
                'count': h.get('value'),
                'percent': h.get('value'),
                'color': h.get('color', 'var(--wx-green)')
            })
            continue
        # 兜底：取第一个非空键作为名称，第二个作为数值
        keys = [k for k in h.keys() if h[k] is not None]
        if len(keys) >= 2:
            entries.append({
                'name': h.get(keys[0]),
                'count': h.get(keys[1]),
                'percent': h.get(keys[1]),
                'color': h.get('color', 'var(--wx-green)')
            })

    if not entries:
        return

    # 归一化 percent，以最大值作为 100%
    try:
        max_count = max(int(e.get('count') or 0) for e in entries)
    except (ValueError, TypeError):
        max_count = 0
    if max_count <= 0:
        max_count = 1

    for e in entries:
        count = e.get('count')
        try:
            percent = int(int(count or 0) / max_count * 100)
        except (ValueError, TypeError):
            percent = 0
        normalized.append({
            'name': e.get('name', ''),
            'count': count,
            'percent': percent,
            'color': e.get('color', 'var(--wx-green)')
        })

    ai_content['topic_heat'] = normalized


def fill_ai_content_avatars(ai_content, name_avatar_map):
    # 资源分享：按 sharer 补头像
    for res in ai_content.get('resources', []):
        if not res.get('avatar'):
            avatar = get_name_avatar(res.get('sharer'), name_avatar_map)
            if avatar:
                res['avatar'] = avatar

    # 重要消息：按 sender 补头像
    for msg in ai_content.get('important_messages', []):
        if not msg.get('avatar'):
            avatar = get_name_avatar(msg.get('sender'), name_avatar_map)
            if avatar:
                msg['avatar'] = avatar

    # 对话：按 name 补头像
    for dialogue in ai_content.get('dialogues', []):
        for msg in dialogue.get('messages', []):
            if not msg.get('avatar'):
                avatar = get_name_avatar(msg.get('name'), name_avatar_map)
                if avatar:
                    msg['avatar'] = avatar

    # 问答：分别补提问者/回答者头像
    for qa in ai_content.get('qas', []):
        if not qa.get('questioner_avatar'):
            avatar = get_name_avatar(qa.get('questioner'), name_avatar_map)
            if avatar:
                qa['questioner_avatar'] = avatar
        if not qa.get('answerer_avatar'):
            avatar = get_name_avatar(qa.get('answerer'), name_avatar_map)
            if avatar:
                qa['answerer_avatar'] = avatar


def _launch_browser(p):
    """优先使用系统已安装的 Chrome/Edge（避免下载 playwright 自带 chromium）。"""
    # 系统浏览器常见路径
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return p.chromium.launch(executable_path=path)
            except Exception:
                continue
    # 兜底：playwright channel 方式或默认 chromium
    for channel in ("chrome", "msedge"):
        try:
            return p.chromium.launch(channel=channel)
        except Exception:
            continue
    return p.chromium.launch()


def _stitch_segments(segment_paths, output_path, width, total_height):
    """将分段截图垂直拼接为完整长图。"""
    try:
        from PIL import Image
    except ImportError:
        raise RuntimeError(
            "长图高度超过单次截图上限，需要 Pillow 分段拼接，请先执行: pip install pillow"
        )

    canvas = Image.new('RGB', (width, max(total_height, 1)), '#ffffff')
    offset = 0
    for seg_path in segment_paths:
        with Image.open(seg_path) as img:
            canvas.paste(img.convert('RGB'), (0, offset))
            offset += img.height

    canvas.save(output_path)


def html_to_image(html_path, output_path):
    """使用 Playwright 将 HTML 转换为长图。

    页面高度超过 Chromium 单次截图上限（16384px）时，自动改为分段截图 + 垂直拼接，
    避免 full_page 截图被静默截断导致长图内容缺失。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Error: 'playwright' module not found.")
        print("Please install it with: pip install playwright && playwright install chromium")
        sys.exit(1)

    file_url = f'file:///{os.path.abspath(html_path)}'

    with sync_playwright() as p:
        browser = _launch_browser(p)

        def open_page(viewport_height):
            """打开页面并预加载资源（滚动到底再回顶，触发懒加载与头像加载）。"""
            page = browser.new_page(
                viewport={'width': VIEWPORT_WIDTH, 'height': viewport_height},
                device_scale_factor=DEVICE_SCALE_FACTOR
            )
            page.goto(file_url)
            page.wait_for_load_state('networkidle')

            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(500)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(200)

            # 头像为外链资源，额外等待图片加载/失败回退完成，超时则继续截图
            try:
                page.wait_for_function(
                    "() => Array.from(document.images).every(img => img.complete)",
                    timeout=8000
                )
            except Exception:
                pass
            return page

        page = open_page(VIEWPORT_HEIGHT)
        total_height = int(page.evaluate("Math.ceil(document.body.scrollHeight)"))

        if total_height <= MAX_SCREENSHOT_HEIGHT:
            page.screenshot(path=output_path, full_page=True)
            page.close()
            browser.close()
            print(f"Image generated: {output_path}")
            return

        # 超出单次截图上限：分段截图后拼接
        print(
            f"[长图] 页面高度 {total_height}px 超过单次截图上限 {MAX_SCREENSHOT_HEIGHT}px，"
            f"改用分段截图拼接"
        )
        page.close()

        seg_page = open_page(SEGMENT_HEIGHT)
        total_height = int(seg_page.evaluate("Math.ceil(document.body.scrollHeight)"))
        max_scroll = max(0, total_height - SEGMENT_HEIGHT)

        segment_paths = []
        y = 0
        idx = 0
        while y < total_height:
            height = min(SEGMENT_HEIGHT, total_height - y)
            # 滚动位置受文档底部限制，超出部分换算成视口内偏移
            scroll_to = max(0, min(y, max_scroll))
            offset_in_viewport = y - scroll_to

            seg_path = f"{output_path}.part{idx}.png"
            seg_page.evaluate(f"window.scrollTo(0, {scroll_to})")
            seg_page.wait_for_timeout(120)
            seg_page.screenshot(
                path=seg_path,
                clip={
                    'x': 0,
                    'y': offset_in_viewport,
                    'width': VIEWPORT_WIDTH,
                    'height': height,
                }
            )
            segment_paths.append(seg_path)
            y += height
            idx += 1

        print(f"[长图] 共 {len(segment_paths)} 段，正在拼接...")
        _stitch_segments(segment_paths, output_path, VIEWPORT_WIDTH, total_height)

        for seg_path in segment_paths:
            try:
                os.remove(seg_path)
            except OSError:
                pass

        seg_page.close()
        browser.close()

    print(f"Image generated: {output_path}")


def main():
    args = parse_arguments()
    
    # Load data
    stats = load_json(args.stats)
    ai_content = load_json(args.ai_content) if args.ai_content else {}
    
    # Determine template path
    if args.template:
        template_dir = os.path.dirname(args.template)
        template_name = os.path.basename(args.template)
    else:
        # Default: look in assets/ relative to this script
        script_dir = os.path.dirname(os.path.abspath(__file__))
        template_dir = os.path.join(script_dir, '..', 'assets')
        template_name = 'report_template.html'
    
    # Setup Jinja2
    env = Environment(loader=FileSystemLoader(template_dir))
    template = env.get_template(template_name)
    
    # Merge AI-generated traits into top_talkers
    top_talkers = stats.get('top_talkers', [])
    all_members_ranking = stats.get('all_members_ranking', [])  # 新增：获取完整榜单
    name_avatar_map = load_name_avatar_map(stats, args.stats)
    talker_profiles = ai_content.get('talker_profiles', {})
    for talker in top_talkers:
        name = talker.get('name')
        if name and name in talker_profiles:
            profile = talker_profiles[name]
            if 'traits' in profile:
                talker['traits'] = profile['traits']
        if not talker.get('avatar'):
            avatar = get_name_avatar(name, name_avatar_map)
            if avatar:
                talker['avatar'] = avatar

    night_owl = stats.get('night_owl')
    if isinstance(night_owl, dict) and not night_owl.get('avatar'):
        avatar = get_name_avatar(night_owl.get('name'), name_avatar_map)
        if avatar:
            night_owl['avatar'] = avatar

    # Fill avatars for AI blocks
    normalize_topic_heat(ai_content)
    fill_ai_content_avatars(ai_content, name_avatar_map)
    
    # Prepare template context
    top_talkers_dict = {t.get('name'): t for t in top_talkers}
    context = {
        'meta': stats.get('meta', {}),
        'top_talkers': top_talkers,
        'top_talkers_dict': top_talkers_dict,
        'all_members_ranking': all_members_ranking,  # 新增：传递完整榜单
        'night_owl': night_owl,
        'word_cloud': stats.get('word_cloud', []),
        'ai_content': ai_content,
        'generated_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }
    
    # Render HTML
    html_output = template.render(**context)
    
    # Determine output format
    output_ext = os.path.splitext(args.output)[1].lower()
    
    if output_ext in ['.png', '.jpg', '.jpeg']:
        # 先生成 HTML（作为渲染产物保留，便于查看与二次编辑），再转图片
        html_path = args.output.rsplit('.', 1)[0] + '.html'
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html_output)
        print(f"HTML generated: {html_path}")
        
        # 转换为图片
        html_to_image(html_path, args.output)
        
        # 清理临时文件
        if args.clean_temp:
            # 获取 simplified_chat.txt 路径（兼容新旧格式）
            text_paths = stats.get('raw_text_paths', [])
            if not text_paths:
                legacy = stats.get('raw_text_path')
                if legacy:
                    text_paths = [legacy]
            # 保留渲染出的 HTML（与图片同名，便于直接查看/二次编辑），
            # 仅清理中间数据文件，避免 stats.json 等残留在工作区
            temp_files = [
                args.stats,          # stats.json
                args.ai_content,     # ai_content.json
            ] + text_paths           # simplified_chat 文件（可能多个）
            cleanup_temp_files(temp_files)
    else:
        # 仅生成 HTML
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(html_output)
        print(f"Report generated: {args.output}")
        
        # 清理临时文件（HTML 输出时不删除 HTML 本身）
        if args.clean_temp:
            text_paths = stats.get('raw_text_paths', [])
            if not text_paths:
                legacy = stats.get('raw_text_path')
                if legacy:
                    text_paths = [legacy]
            temp_files = [
                args.stats,          # stats.json
                args.ai_content,     # ai_content.json
            ] + text_paths           # simplified_chat 文件（可能多个）
            cleanup_temp_files(temp_files)


if __name__ == "__main__":
    main()
