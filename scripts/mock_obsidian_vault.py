from __future__ import annotations

import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VAULT = ROOT / "tmp" / "mock-obsidian-vault"


NOTES: dict[str, str] = {
    "README.md": """
---
source: tabkeep-mock
type: index
tags: [tabkeep, mock, rag]
---

# TabKeep Mock Obsidian Vault

这个 vault 是给 TabKeep RAG 测试用的假 Obsidian 笔记库。

推荐测试问题：

- TabKeep 为什么选择 Tauri 而不是 Electron？
- 固定区域翻译框和截图 OCR 的区别是什么？
- SiYuan 同步到知识库的流程是什么？
- 没有配置 embedding 时，RAG 会怎么降级？
- LanceDB 在 TabKeep 里承担什么职责？

入口笔记：

- [[Projects/TabKeep/Desktop Companion Roadmap]]
- [[Projects/TabKeep/RAG Knowledge Base Design]]
- [[Research/LanceDB 与 SQLite 混合检索]]
- [[Meetings/2026-06-18 RAG 稳定化复盘]]
""",
    "Projects/TabKeep/Desktop Companion Roadmap.md": """
---
source: tabkeep-mock
project: TabKeep
status: active
tags: [tabkeep, tauri, desktop, translation]
---

# Desktop Companion Roadmap

TabKeep 桌面伴侣选择 Tauri 2，而不是 Electron。主要原因是常驻后台工具需要更低内存、更小包体，并且全局快捷键、OCR、截图、托盘、本地 HTTP 服务都更适合在 Rust 侧实现。

当前桌面端已经形成三类能力：

- 浏览器扩展桥接：通过 `127.0.0.1:38472` 和扩展通信。
- 翻译体验：输入翻译、固定区域 OCR 翻译、任意 App 划词翻译。
- 知识库体验：本地 RAG、Markdown/Obsidian 扫描、SiYuan 同步。

相关笔记：[[Projects/TabKeep/OCR and Region Translation]], [[Projects/TabKeep/Selection Translate MVP]], [[Projects/TabKeep/RAG Knowledge Base Design]]
""",
    "Projects/TabKeep/OCR and Region Translation.md": """
---
source: tabkeep-mock
project: TabKeep
tags: [ocr, translation, region-box]
---

# OCR and Region Translation

固定区域翻译框参考 Gal 翻译器体验。用户打开一个置顶框，框可以拖动和调整大小。点击翻译时，TabKeep 临时隐藏边框，捕获区域内屏幕像素，送到 OCR provider，然后把识别结果交给当前翻译 provider。

它和截图 OCR 的区别：

- 截图 OCR 每次都进入全屏框选流程。
- 固定区域翻译框适合游戏、视频字幕、网页局部内容。
- 固定区域翻译框不会保存截图历史，只覆盖临时 PNG。

首版 provider 包括 Windows OCR 和可选 PaddleOCR-json。
""",
    "Projects/TabKeep/Selection Translate MVP.md": """
---
source: tabkeep-mock
project: TabKeep
tags: [selection-translate, clipboard, hotkey]
---

# Selection Translate MVP

任意 App 划词翻译默认快捷键是 Ctrl+Alt+T。触发后，桌面端会备份剪贴板，模拟复制当前选中文本，读取文本后恢复剪贴板，再调用当前快速翻译 provider。

划词翻译首版不做 UI Automation 直接取词，也不做历史记录。结果窗靠近鼠标显示，展示排版后的译文，支持复制和关闭。

风险点：

- 有些应用会拦截复制。
- 剪贴板中如果是图片或复杂格式，需要完整备份恢复。
- 快捷键注册失败要在桌面端明确提示。
""",
    "Projects/TabKeep/RAG Knowledge Base Design.md": """
---
source: tabkeep-mock
project: TabKeep
tags: [rag, knowledge-base, sqlite, lancedb]
---

# RAG Knowledge Base Design

TabKeep 的 RAG 是自己的本地知识库，不写回 Obsidian 或 SiYuan。笔记软件只是知识来源，TabKeep 负责索引、检索和问答。

数据流：

```text
Obsidian / Markdown / SiYuan / TabKeep 收藏
        -> TabKeep knowledge.db
        -> SQLite FTS5 + LanceDB
        -> LLM grounded answer
```

SQLite 是 source of truth，保存文档、chunk、FTS、RAG 会话和轻量图关系。LanceDB 是可选向量层，只有配置 embedding 后才启用。

未配置 embedding 时，TabKeep 使用 SQLite FTS5 和 LLM 基于引用片段回答。这样即使用户没有向量模型，知识库仍然可用。

相关：[[Research/LanceDB 与 SQLite 混合检索]], [[Projects/TabKeep/SiYuan Sync Flow]]
""",
    "Projects/TabKeep/SiYuan Sync Flow.md": """
---
source: tabkeep-mock
project: TabKeep
tags: [siyuan, sync, rag]
---

# SiYuan Sync Flow

SiYuan 同步是把思源里已有的笔记导入 TabKeep 本地知识库，不会修改思源原始笔记。

同步流程：

1. 使用笔记集成里的 endpoint 和 token。
2. 调用 `lsNotebooks` 读取笔记本。
3. 调用 `listDocsByNotebook` 读取文档树。
4. 对每篇文档调用 `/api/export/exportMdContent` 导出 Markdown。
5. 把 Markdown 切成 chunk，写入 `knowledge.db`。
6. 如果 embedding 可用，再写入 LanceDB。

桌面端有“检查 SiYuan”和“同步 SiYuan”。测试时可以设置同步上限，比如只同步前 10 篇。
""",
    "Research/LanceDB 与 SQLite 混合检索.md": """
---
source: tabkeep-mock
type: research
tags: [lancedb, sqlite, hybrid-search, rrf]
---

# LanceDB 与 SQLite 混合检索

TabKeep 选择 SQLite + LanceDB 的原因：

- SQLite 负责文档元数据、chunk、FTS5、会话和轻量关系。
- LanceDB 负责 embedding 向量召回。
- RRF 负责融合关键词检索和语义检索结果。

这种方案比单独使用向量数据库更稳，因为用户经常搜索项目名、错误码、函数名和命令行。关键词精确查找不能完全交给 embedding。

如果 LanceDB 未安装或 embedding 配置错误，TabKeep 自动退回 FTS 模式。
""",
    "Research/RAG 问答 Prompt 约束.md": """
---
source: tabkeep-mock
type: research
tags: [rag, prompt, citation]
---

# RAG 问答 Prompt 约束

知识库助手必须只基于检索到的来源片段回答。如果来源不足，应该明确说没有足够依据。

回答要求：

- 使用中文。
- 关键结论后标注 `[来源 1]`。
- 不编造来源。
- 不把模型常识伪装成本地笔记内容。

这个约束能减少 RAG 幻觉，让用户知道答案来自哪里。
""",
    "Meetings/2026-06-18 RAG 稳定化复盘.md": """
---
source: tabkeep-mock
type: meeting
tags: [meeting, rag, testing]
---

# 2026-06-18 RAG 稳定化复盘

本次稳定化目标：

- 拆分后端 knowledge 模块。
- 新增 SiYuan 同步预检查。
- 新增打开来源和复制来源。
- 增加后端自动化测试。

发现的问题：

- SQLite 连接如果不显式关闭，Windows 下会导致 `knowledge.db` 文件锁。
- 测试数据不能放在 `.tmp` 目录下，因为知识库扫描会跳过 `.tmp`。
- Plasmo build 成功后仍可能打印在线版本检查失败，这不是构建失败。

下一步建议：

- 提交后端测试。
- 真实验证 SiYuan 同步。
- 在浏览器扩展端接入“查相关笔记”和“问知识库”。
""",
    "Sources/Tauri vs Electron 选型.md": """
---
source: tabkeep-mock
type: source-note
tags: [tauri, electron, desktop]
---

# Tauri vs Electron 选型

TabKeep 桌面端更适合 Tauri：

- 常驻后台时资源占用更低。
- Rust 侧适合做系统能力：全局快捷键、OCR、截图、托盘。
- 包体比 Electron 小。
- 和现有 Pot 类工具的架构思路更接近。

Electron 的优势是纯 JavaScript 迭代快，但长期维护截图、OCR、全局快捷键和剪贴板能力时，还是会依赖 native module。
""",
    "Daily/2026-06-18 Mock Vault 测试记录.md": """
---
source: tabkeep-mock
type: daily
tags: [mock, obsidian, testing]
---

# Mock Vault 测试记录

这篇笔记用于测试 TabKeep 是否能扫描 Obsidian 风格的 Markdown 文件夹。

测试步骤：

1. 在 TabKeep 桌面端打开知识库页面。
2. 把 mock vault 路径加入 Markdown / Obsidian 路径。
3. 点击重建索引。
4. 搜索 “Tauri”, “SiYuan 同步”, “LanceDB”, “固定区域翻译框”。
5. 提问 “没有配置 embedding 时 RAG 会怎么降级？”

预期：搜索结果应该包含对应主题笔记，问答结果应该带引用来源。
""",
    "Glossary/TabKeep Terms.md": """
---
source: tabkeep-mock
type: glossary
tags: [glossary]
---

# TabKeep Terms

- Desktop Companion：TabKeep 的 Tauri 桌面伴侣。
- Knowledge DB：TabKeep 本地 SQLite 知识库。
- LanceDB：可选向量检索层。
- FTS：SQLite Full-Text Search。
- RRF：Reciprocal Rank Fusion，用于融合多个检索结果。
- Region Box：固定区域翻译框。
- Selection Translate：任意 App 划词翻译。
""",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a mock Obsidian vault for TabKeep RAG tests.")
    parser.add_argument("--output", default=str(DEFAULT_VAULT), help="Output vault directory.")
    parser.add_argument("--force", action="store_true", help="Delete the output directory before writing.")
    return parser.parse_args()


def ensure_workspace_path(path: Path) -> None:
    resolved = path.resolve()
    if not str(resolved).startswith(str(ROOT.resolve())):
        raise SystemExit(f"Refusing to write outside TabKeep workspace: {resolved}")


def main() -> None:
    args = parse_args()
    vault = Path(args.output).expanduser().resolve()
    ensure_workspace_path(vault)

    if vault.exists() and args.force:
        shutil.rmtree(vault)
    vault.mkdir(parents=True, exist_ok=True)

    obsidian_dir = vault / ".obsidian"
    obsidian_dir.mkdir(parents=True, exist_ok=True)
    (obsidian_dir / "app.json").write_text('{"legacyEditor": false}\n', encoding="utf-8")

    for relative_path, content in NOTES.items():
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.strip() + "\n", encoding="utf-8")

    print("Mock Obsidian vault generated:")
    print(vault)
    print()
    print("Use this path in TabKeep Desktop -> 知识库 -> Markdown / Obsidian 路径.")


if __name__ == "__main__":
    main()
