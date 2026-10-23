#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generate_member_report.py - 微信群「个人日报」渲染脚本

将 analyze_member.py 产出的 member_stats.json 与 AI 生成的 member_ai_content.json
渲染为个人日报 HTML，并转换为长图 PNG。

使用方式:
    python generate_member_report.py \
        --stats member_stats.json \
        --ai-content member_ai_content.json \
        --output member_report.png \
        --clean-temp

输出:
    - member_report.png（长图）
    - member_report.html（与图片同名，--clean-temp 时保留）
"""

import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from jinja2 import Environment, FileSystemLoader
except ImportError:
    print("Error: 'jinja2' module not found. Please install it with: pip install jinja2")
    sys.exit(1)

# 复用群日报渲染器的截图与清理工具（含超长图分段拼接）
from generate_report import html_to_image, cleanup_temp_files, load_json


def parse_arguments():
    parser = argparse.ArgumentParser(description='Generate WeChat member daily report.')
    parser.add_argument('--stats', required=True, help='Path to member_stats.json from analyze_member.py')
    parser.add_argument('--ai-content', required=False, default=None, help='Path to AI-generated member_ai_content.json (optional)')
    parser.add_argument('--template', default=None, help='Path to Jinja2 HTML template')
    parser.add_argument('--output', default='member_report.png', help='Output file path (.html or .png/.jpg)')
    parser.add_argument('--clean-temp', action='store_true', help='Delete temporary data files after report generation')
    return parser.parse_args()


def main():
    args = parse_arguments()

    stats = load_json(args.stats)
    ai_content = load_json(args.ai_content) if args.ai_content else {}

    if not stats:
        print(f"Error: stats file not found or empty: {args.stats}")
        sys.exit(1)

    # 模板路径
    if args.template:
        template_dir = os.path.dirname(args.template)
        template_name = os.path.basename(args.template)
    else:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        template_dir = os.path.join(script_dir, '..', 'assets')
        template_name = 'member_report_template.html'

    env = Environment(loader=FileSystemLoader(template_dir))
    template = env.get_template(template_name)

    context = {
        'meta': stats.get('meta', {}),
        'type_distribution': stats.get('type_distribution', []),
        'hourly_activity': stats.get('hourly_activity', []),
        'max_hour_count': stats.get('max_hour_count', 0),
        'peak_hour': stats.get('peak_hour'),
        'keywords': stats.get('keywords', []),
        'interactions': stats.get('interactions', {}),
        'quotes': stats.get('quotes', []),
        'ai': ai_content,
        'generated_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    }

    html_output = template.render(**context)

    output_ext = os.path.splitext(args.output)[1].lower()

    if output_ext in ['.png', '.jpg', '.jpeg']:
        # 先生成 HTML（作为渲染产物保留），再转图片
        html_path = args.output.rsplit('.', 1)[0] + '.html'
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html_output)
        print(f"HTML generated: {html_path}")

        html_to_image(html_path, args.output)

        if args.clean_temp:
            # 保留渲染出的 HTML，仅清理中间数据文件
            temp_files = [args.stats]
            if args.ai_content:
                temp_files.append(args.ai_content)
            temp_files += stats.get('raw_text_paths', [])
            cleanup_temp_files(temp_files)
    else:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(html_output)
        print(f"Report generated: {args.output}")

        if args.clean_temp:
            temp_files = [args.stats]
            if args.ai_content:
                temp_files.append(args.ai_content)
            temp_files += stats.get('raw_text_paths', [])
            cleanup_temp_files(temp_files)


if __name__ == '__main__':
    main()
