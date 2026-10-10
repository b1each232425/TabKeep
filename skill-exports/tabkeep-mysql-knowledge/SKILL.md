---
name: tabkeep-mysql-knowledge
description: 基于个人 MySQL 知识笔记回答索引、事务、锁和存储引擎等问题，并保留可核验的来源证据。
---

# MySQL 个人知识 Skill

## 能力

- 基于导出的知识证据回答相关问题
- 在已有知识不足时明确说明，不把模型常识伪装成个人笔记结论。

## 触发条件

- 根据问题语义匹配本 Skill 的知识范围

## 使用流程

1. 先读取同目录的 `index.json`，根据问题关键词和主题选择相关知识块。
2. 只读取候选知识块对应的 `references/*.md`，避免把整个知识包一次性放入上下文。
3. 优先依据知识块的 `Evidence` 内容组织答案；复杂问题需要同时核对适用条件和例外情况。
4. 在答案末尾列出使用到的 `block_id`、来源标题和段落标识。
5. 如果没有找到足够依据，明确回答“当前 Skill 资料不足”，并指出还缺少什么信息。

## 回答规范

- 区分笔记中的明确结论、笔记中的推断和模型的一般解释。
- 不编造不存在的来源、段落或实验结果。
- 遇到不同知识块结论不一致时，保留差异并分别标明来源。
- 不引用原始电脑绝对路径；使用包内相对文件和 `block_id`。

## 版本

- Skill version: `0.1.0`
- Knowledge generated at: `2026-09-20T18:46:37+08:00`
- Exported documents: `10`
- Exported knowledge blocks: `82`
- 详细哈希和来源清单见 `manifest.json`、`index.json`。

## 兼容性

本 Skill 不依赖 TabKeep、MCP、HTTP 服务、API Key 或特定运行时。支持 Skill 文件夹的客户端可直接加载；只支持单文件的客户端可将本文件与需要的 `references/*.md` 一并提供。
