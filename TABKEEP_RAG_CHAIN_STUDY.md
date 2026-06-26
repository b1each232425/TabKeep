# TabKeep RAG 链路学习笔记

这份文档用于从源码角度理解 TabKeep 的本地知识库与 RAG 实现。它覆盖：

- 入口文件和关键函数
- 文档如何入库、切块、建全文索引和向量索引
- 搜索与问答如何执行
- 知识图谱、主题地图如何从同一批文档派生
- 当前技术选型、可替代方案和利弊

相关背景文档：

- `TABKEEP_RAG_TECH_SELECTION.md`
- `TABKEEP_RAG_INTEGRATION_PLAN.md`
- `TABKEEP_TOPIC_MAP_PLAN.md`

## 1. 总体架构

TabKeep 的 RAG 实现是本地优先的混合检索架构：

```text
前端 Knowledge 页面
  |
  v
desktop/src/api.ts
  |
  v
FastAPI /knowledge 路由
  |
  v
services/knowledge/service.py 门面
  |
  +--> indexing.py      文档入库、重建索引、保存笔记自动索引
  +--> retrieval.py     FTS + vector 混合检索
  +--> qa.py            RAG 问答编排、prompt 构造、会话保存
  +--> graph.py         文档/标签/标题/双链知识图谱
  +--> topics.py        主题知识地图、AI 整理、导出 MOC
  +--> siyuan_sync.py   SiYuan 文档同步入库
       |
       v
db.py + vector_store.py + embeddings.py + llm.py
```

数据层分成两部分：

```text
SQLite knowledge.db
  - documents
  - chunks
  - chunk_fts
  - graph_nodes / graph_edges
  - knowledge_topics / topic_documents / evidence / relations
  - rag_sessions / rag_messages

LanceDB knowledge.lance
  - chunks 向量表
```

当前设计重点是：

- SQLite 是 source of truth，保存文档、chunk、全文索引、会话和轻量关系。
- SQLite FTS5 是默认检索能力，embedding 没配置也能用。
- LanceDB 是可选向量层，embedding 配置完整且 LanceDB 可用时启用。
- LLM 只在问答、摘要、主题 AI 整理等场景被调用。

## 2. 文件地图

| 文件 | 关键函数/对象 | 作用 |
| --- | --- | --- |
| `backend/main.py` | `app.include_router(knowledge_router)` | FastAPI 应用入口，注册 `/knowledge/*` 路由。 |
| `backend/routers/knowledge.py` | `ask()`, `search()`, `reindex()`, `topics()` | HTTP API 层，接收前端请求，调用 `service.py`。 |
| `backend/services/knowledge/service.py` | re-export 门面 | 路由层只依赖这个门面，具体逻辑拆到各模块。 |
| `backend/schemas/knowledge.py` | `KnowledgeAskRequest`, `KnowledgeCitation`, `KnowledgeTopic` 等 | Pydantic 请求/响应模型。 |
| `backend/services/knowledge/indexing.py` | `reindex_all()`, `index_document()`, `index_saved_note()` | 文档入库主链路。 |
| `backend/services/knowledge/db.py` | `init_db()`, `upsert_document()`, `search_fts()`, `ensure_session()` | SQLite 存储、FTS、RAG 会话。 |
| `backend/services/knowledge/chunking.py` | `chunk_text()`, `normalize_text()`, `guess_title()` | Markdown 文本清洗和切块。 |
| `backend/services/knowledge/cjk.py` | `segment_for_fts()`, `build_fts_query()` | 中文/CJK FTS 轻量预处理。 |
| `backend/services/knowledge/retrieval.py` | `search_knowledge()`, `rrf_merge()` | FTS + 向量混合召回与融合排序。 |
| `backend/services/knowledge/embeddings.py` | `embed_texts()`, `embedding_config_ready()` | OpenAI-compatible embedding 调用。 |
| `backend/services/knowledge/vector_store.py` | `replace_document()`, `search()`, `availability()` | LanceDB 向量表写入、搜索、可用性检查。 |
| `backend/services/knowledge/qa.py` | `ask_knowledge()`, `build_rag_messages()` | RAG 问答编排和 prompt 构造。 |
| `backend/services/llm.py` | `chat_completion()` | OpenAI-compatible Chat Completion 统一封装。 |
| `backend/services/knowledge/graph.py` | `index_document_graph()`, `rebuild_graph()`, `_extract_tags()` | 从文档生成轻量知识图谱。 |
| `backend/services/knowledge/topics.py` | `rebuild_topics()`, `list_topics()`, `enrich_topics()`, `export_topic()` | 主题知识地图。 |
| `backend/services/knowledge/siyuan_sync.py` | `sync_siyuan_notes()`, `export_notebooks_to_knowledge()` | 从 SiYuan 导出 Markdown 并索引。 |
| `backend/routers/notes.py` | `save_tab()` | 保存 TabKeep 笔记后自动调用 `index_saved_note()`。 |
| `desktop/src/api.ts` | `askKnowledge()`, `searchKnowledge()`, `reindexKnowledge()` | 前端到后端的知识库 API 封装。 |
| `desktop/src/App.tsx` | `KnowledgeSection()`, `TopicMapPanel()` | 知识库页面和主题工作台 UI。 |
| `desktop/src/types.ts` | `Knowledge*` TS 类型 | 与后端 schema 对应的前端类型。 |
| `backend/tests/test_knowledge.py` | 多个知识库单测 | 覆盖索引、检索、图谱、主题、SiYuan 同步。 |
| `backend/tests/test_api.py` | API 集成测试 | 覆盖 `/notes/save` 自动入库、`/knowledge/*` 接口。 |

## 3. API 入口

后端入口在 `backend/routers/knowledge.py`。

主要接口：

```text
GET  /knowledge/config
POST /knowledge/config
GET  /knowledge/stats
POST /knowledge/reindex
GET  /knowledge/sync/siyuan/precheck
POST /knowledge/sync/siyuan
POST /knowledge/search
POST /knowledge/ask
GET  /knowledge/graph
POST /knowledge/graph/rebuild
GET  /knowledge/topics
GET  /knowledge/topics/{topic_id}
POST /knowledge/topics/rebuild
POST /knowledge/topics/enrich
POST /knowledge/topics/{topic_id}/export
GET  /knowledge/sessions
GET  /knowledge/sessions/{session_id}/messages
```

路由层很薄，基本只做请求响应类型声明，然后转发给 `service.py`：

```python
@router.post("/ask", response_model=KnowledgeAskResponse)
async def ask(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    return await service.ask_knowledge(req)
```

`service.py` 是门面层，它把具体函数从 `indexing.py`、`retrieval.py`、`qa.py`、`graph.py`、`topics.py`、`siyuan_sync.py` 重新导出。这样路由文件不需要知道内部模块拆分细节。

## 4. 数据来源链路

TabKeep 当前有三类主要知识来源。

### 4.1 TabKeep 收藏自动入库

入口：

```text
POST /notes/save
-> routers/notes.py::save_tab()
-> adapter.save()
-> services.knowledge.service.index_saved_note()
-> indexing.py::index_saved_note()
-> indexing.py::index_document()
```

关键逻辑：

- 用户保存网页、摘要或链接到笔记系统。
- 保存成功后，`notes.py::save_tab()` 调用 `index_saved_note()`。
- `index_saved_note()` 用 `markdown_note()` 把收藏内容转成 Markdown。
- 然后以 `source_type="tabkeep_note"` 写入知识库。
- 成功后调用 `topics.rebuild_topics()` 更新主题地图。

好处：

- 收藏动作和知识库自动联动。
- 用户不需要手动重建索引才能搜索新收藏。

注意点：

- 这个链路是“尽力而为”，索引失败不会影响收藏保存。
- 失败只写 warning 日志。

### 4.2 Markdown / Obsidian 手动重建

入口：

```text
POST /knowledge/reindex
-> service.reindex_all()
-> indexing.py::reindex_all()
-> discover_markdown_files()
-> index_document()
```

`reindex_all()` 做的事情：

- 读取 `KnowledgeConfig`。
- 如果知识库关闭，直接返回。
- 扫描配置的 `markdownPaths`。
- 如果当前 note adapter 是 Obsidian，也会把 vault 加入扫描范围。
- 如果本地 `storage.DATA_DIR / "notes"` 存在，也会加入扫描范围。
- 跳过 `.git`、`.obsidian`、`.trash`、`.tmp`、`node_modules`、`__pycache__`。
- 跳过超过 `maxFileBytes` 的大文件。
- 对每个 `.md` 文件调用 `index_document()`。
- 全量处理后重建 graph 和 topics。

### 4.3 SiYuan 同步

入口：

```text
GET  /knowledge/sync/siyuan/precheck
POST /knowledge/sync/siyuan
-> siyuan_sync.py::sync_siyuan_notes()
-> export_notebooks_to_knowledge()
-> adapter.export_markdown()
-> index_document()
```

`siyuan_sync.py` 做的事情：

- 检查知识库是否启用。
- 检查当前 note adapter 是否是 SiYuan。
- 读取 SiYuan 笔记本列表。
- 遍历文档树。
- 通过 SiYuan API 导出 Markdown。
- 给导出的内容加 frontmatter，例如 `source`、`notebook`、`doc_id`、`h_path`。
- 以 `source_type="siyuan"` 调用 `index_document()`。
- 同步结束后重建 topics。

## 5. 文档入库链路

核心函数是 `backend/services/knowledge/indexing.py::index_document()`。

调用链：

```text
index_document()
  |
  +--> normalize_text()
  +--> db.upsert_document()
  |      |
  |      +--> make_document_id()
  |      +--> sha1_text()
  |      +--> chunk_text()
  |      +--> 写 documents
  |      +--> 写 chunks
  |      +--> 写 chunk_fts
  |      +--> upsert_document_node()
  |
  +--> graph.index_document_graph()
  |
  +--> embedding_config_ready()
         |
         +--> vector_store.availability()
         +--> embed_texts()
         +--> vector_store.replace_document()
         +--> db.mark_embedding_status()
```

### 5.1 文本清洗与切块

`chunking.py`：

- `normalize_text()` 统一换行，把过多空行压缩。
- `guess_title()` 优先取第一个 Markdown 标题，否则用文件名。
- `chunk_text()` 默认每块约 `1200` 字符，重叠 `160` 字符。
- `_best_break()` 尽量在段落、标题、句号、问号、感叹号等位置切断。

为什么要切块：

- LLM prompt 有上下文长度限制。
- 检索需要返回局部片段，而不是整篇文档。
- embedding 通常也更适合对片段生成，而不是超长全文。

### 5.2 SQLite 入库

`db.py::upsert_document()` 是入库核心。

它会生成稳定文档 ID：

```python
document_id = make_document_id(source_type, note_id or path or url or title)
```

也就是说，同一个来源类型下，优先用：

```text
note_id -> path -> url -> title
```

作为稳定 key。

然后计算内容 hash：

```python
content_hash = sha1_text(content)
```

如果文档已经存在，并且 hash 没变：

- 不重写 chunks。
- 不重写 FTS。
- 返回 `IndexResult(indexed=False)`。

如果内容变化：

- 删除旧 `chunk_fts`。
- 删除旧 `chunks`。
- upsert `documents`。
- 重新写入所有 chunk。
- 把 title 和 chunk 内容写入 FTS 虚拟表。

### 5.3 FTS 中文处理

SQLite FTS5 对中文没有天然按词分词能力。TabKeep 目前采用轻量 CJK 预处理：

`cjk.py::segment_for_fts()`：

```python
return _CJK_RE.sub(r" \1 ", text or "")
```

它把每个 CJK 字符前后加空格，让 FTS 至少可以按单字 token 匹配。

`cjk.py::build_fts_query()`：

- 从 query 提取 CJK 字符、英文、数字、下划线、点、冒号、横线等 token。
- 最多取 24 个 token。
- 每个 token 包成短语查询。

这不是最强中文分词方案，但优点是：

- 零额外依赖。
- 本地可用。
- 对短中文查询有基本召回能力。

### 5.4 向量索引

如果 embedding 配置完整：

```python
embedding.enabled
embedding.baseURL
embedding.apiKey
embedding.model
```

并且 LanceDB 可用，`index_document()` 会：

```text
chunks content
-> embeddings.py::embed_texts()
-> OpenAI-compatible embeddings API
-> vector_store.replace_document()
-> LanceDB knowledge.lance/chunks
```

写入 LanceDB 的 record 包括：

- `chunk_id`
- `document_id`
- `title`
- `source_type`
- `path`
- `url`
- `content`
- `vector`

随后用 `db.mark_embedding_status()` 标记：

- `ready`
- `vector_unavailable`
- `error`

SQLite 仍然保存 chunk 的真实文本与元数据，LanceDB 主要承担向量召回。

## 6. 搜索链路

搜索入口：

```text
POST /knowledge/search
-> retrieval.py::search_knowledge(query, limit)
```

核心流程：

```text
clean query
  |
  +--> db.search_fts(query, limit * 2)
  |
  +--> 如果 embedding 可用:
          embed_texts([query])
          vector_store.search(query_vector, limit * 2)
          vector_rows_to_citations()
  |
  +--> rrf_merge(fts_items, vector_items, limit)
  |
  +--> KnowledgeSearchResponse
```

### 6.1 FTS 检索

`db.py::search_fts()`：

- 调用 `build_fts_query()` 构造 SQLite FTS query。
- 查询 `chunk_fts MATCH ?`。
- join `chunks` 和 `documents` 补全内容与来源。
- 使用 `bm25(chunk_fts)` 排序。
- 转为 `KnowledgeCitation`。

FTS 适合：

- 精确关键词
- 标题
- 函数名
- 错误码
- URL
- 专有名词

### 6.2 向量检索

`retrieval.py::search_knowledge()` 中，向量检索只有在两个条件都满足时启用：

```python
embedding_config_ready(config.embedding) and vector_store.availability()[0]
```

流程：

```text
query
-> embed_texts()
-> vector_store.search()
-> vector_rows_to_citations()
-> db.get_chunks_by_ids()
```

为什么还要回 SQLite：

- LanceDB 搜索返回的是向量记录和距离。
- 最终响应需要稳定的 `KnowledgeCitation`。
- SQLite 是元数据和 chunk 文本的主库。

向量检索适合：

- 同义表达
- 自然语言问题
- 用户 query 和原文措辞不完全一致的场景

### 6.3 RRF 融合排序

`retrieval.py::rrf_merge()` 用 Reciprocal Rank Fusion 合并 FTS 与向量结果。

核心公式：

```python
score += 1 / (60 + rank)
```

特点：

- 不直接混用 FTS 的 BM25 分数和向量距离。
- 只使用各自结果列表里的排名。
- 同一个 chunk 如果同时被 FTS 和 vector 命中，会得到两路加分。
- 最终按融合分数排序，返回前 `limit` 条。

可能的 `sourceMode`：

```text
fts      只使用全文检索
vector   只使用向量检索
hybrid   FTS + 向量都参与
```

如果用户没有配置 embedding，实际就是：

```python
rrf_merge(fts_items, [], limit)
```

## 7. RAG 问答链路

问答入口：

```text
POST /knowledge/ask
-> qa.py::ask_knowledge()
```

完整流程：

```text
question
  |
  +--> 检查 question 是否为空
  +--> 读取 modelConfig
  +--> search_knowledge(question, limit)
  +--> db.ensure_session()
  +--> db.add_message(role="user")
  +--> build_rag_messages(question, citations)
  +--> llm.chat_completion(model_config, messages)
  +--> clean_llm_output()
  +--> db.add_message(role="assistant")
  +--> KnowledgeAskResponse(answer, citations, sessionId, sourceMode)
```

### 7.1 Prompt 构造

`qa.py::build_rag_messages()` 把检索结果拼成两条消息：

```text
system:
  你是 TabKeep 本地知识库助手。
  只能基于用户提供的来源片段回答。
  如果来源片段不足以回答，请明确说没有足够依据。
  回答要用中文，并用 [来源 1] 这样的形式标注来源。

user:
  问题:
  ...

  可用来源:

  [来源 1]
  标题: ...
  位置: ...
  内容:
  ...
```

上下文总量由 `MAX_CONTEXT_CHARS = 14_000` 控制。超过后面的引用片段会被截断或不再加入。

### 7.2 LLM 调用

`services/llm.py::chat_completion()` 使用 OpenAI-compatible Chat Completions：

- `AsyncOpenAI`
- `base_url=config.baseURL`
- `api_key=config.apiKey`
- `model=config.model`
- `temperature=0`
- `extra_body={"thinking": {"type": "adaptive"}}`

`qa.py::clean_llm_output()` 会去掉：

```text
<think>...</think>
```

这说明上游可能使用支持 thinking 输出的模型，但最终 UI 不展示思考块。

### 7.3 会话保存

RAG 会话存储在 SQLite：

- `rag_sessions`
- `rag_messages`

相关函数：

- `db.ensure_session(session_id, title)`
- `db.add_message(session_id, role, content)`
- `db.list_sessions()`
- `db.list_messages(session_id)`

目前 `qa.py` 的问答 prompt 没有把历史消息重新塞回 LLM 上下文。也就是说，会话主要用于记录和展示，不是多轮上下文推理。

## 8. 知识图谱链路

知识图谱在 `backend/services/knowledge/graph.py`。

入口：

```text
index_document()
-> graph.index_document_graph()

或者:

POST /knowledge/graph/rebuild
-> graph.rebuild_graph()
```

每篇文档会生成：

```text
document node
source node
tag nodes
heading nodes
concept nodes
document-document links
```

### 8.1 标签

标签只从 Markdown frontmatter 的 `tags` 字段提取：

```md
---
tags: [rag, graph]
---
```

或：

```md
---
tags:
  - rag
  - graph
---
```

当前不提取正文里的 `#tag`。

### 8.2 标题

`_extract_headings()` 提取 Markdown H1 到 H4：

```md
# H1
## H2
### H3
#### H4
```

每个 heading 会变成一个 heading 节点。

### 8.3 双链

`_extract_wikilinks()` 提取 Obsidian 风格双链：

```md
[[RAG]]
[[RAG|显示文字]]
[[RAG#某标题]]
```

提取时只保留目标：

```text
RAG
```

然后尝试匹配已有文档：

- 能匹配到文档：创建 `links_to_document`。
- 匹配不到文档：创建 `mentions_concept`。

匹配依据包括：

- 文档标题
- 完整 path
- 文件名
- 去掉 `.md` 的文件名
- 去掉 `.md` 的路径

## 9. 主题地图链路

主题地图在 `backend/services/knowledge/topics.py`。

入口：

```text
POST /knowledge/topics/rebuild
-> topics.rebuild_topics()

GET /knowledge/topics
-> topics.list_topics()

GET /knowledge/topics/{topic_id}
-> topics.get_topic_detail()

POST /knowledge/topics/enrich
-> topics.enrich_topics()

POST /knowledge/topics/{topic_id}/export
-> topics.export_topic()
```

主题地图不是问答必需链路，但它使用同一批索引数据帮助用户理解知识库结构。

### 9.1 主题如何生成

`rebuild_topics()`：

```text
_load_documents()
-> _build_topic_drafts()
-> _build_topic_relations()
-> 清空旧 topic 表
-> 写入 topics / topic_documents / evidence / relations
```

`_build_topic_drafts()` 使用几类信号：

| 信号 | 类型 | 权重 | 说明 |
| --- | --- | --- | --- |
| frontmatter tags | `tag` | 4 | 最强显式主题信号。 |
| `[[wikilink]]` | `concept` | 3 | 概念或文档关联。 |
| Markdown headings | `heading` | 1.4 | 标题线索。 |
| 文件路径目录 | `path` | 2 | 目录分组。 |
| embedding 相似 | `similar` | 约 2.2 + 相似度 | 语义相近文档聚类。 |
| 兜底标题/来源 | `fallback` | 1 | 没有显式信号时使用。 |

### 9.2 embedding 相似主题

如果 LanceDB 可用，`_build_embedding_topics()` 会：

- 从 `vector_store.list_records()` 读取 chunk vectors。
- 按 document 聚合。
- 对每篇文档取平均向量。
- 两两计算 cosine 相似度。
- 相似度 `>= 0.82` 的文档连边。
- 用 `_connected_components()` 找相似文档集合。
- 生成 `similar` 类型主题。

### 9.3 主题关系如何生成

`_build_topic_relations()` 不做复杂语义推理，只看共享文档：

```python
overlap = set(left.document_scores) & set(right.document_scores)
```

如果两个主题有共同文档，就生成：

```text
kind = shared_documents
label = 共享 N 篇笔记
weight = N
```

这是一种简单、可解释、稳定的关系模型。

### 9.4 AI 整理主题

`enrich_topics()` 会调用 LLM，让它基于当前主题详情整理：

- title
- summary
- keywords
- questions

LLM 不负责凭空生成主题关系，只对已有证据做命名和摘要增强。

`_save_enrichment()` 会写回：

- `title`
- `summary`
- `keywords_json`
- `ai_enhanced = 1`
- `updated_at`

### 9.5 导出 MOC

`export_topic()` 会把主题详情导出成 Markdown 目录页：

```text
主题摘要
代表笔记
为什么归类
相关主题
关键词
```

它会根据 note adapter 生成不同链接：

- SiYuan：`siyuan://blocks/{note_id}`
- Obsidian：`[[path#heading|title]]` 或 `obsidian://open?...`
- Local：普通 Markdown 文件路径或本地笔记

## 10. 前端链路

前端 API 封装在 `desktop/src/api.ts`。

主要函数：

- `getKnowledgeConfig()`
- `setKnowledgeConfig()`
- `getKnowledgeStats()`
- `reindexKnowledge()`
- `precheckSiyuanKnowledge()`
- `syncSiyuanKnowledge()`
- `searchKnowledge()`
- `askKnowledge()`
- `getKnowledgeGraph()`
- `rebuildKnowledgeGraph()`
- `getKnowledgeTopics()`
- `getKnowledgeTopicDetail()`
- `rebuildKnowledgeTopics()`
- `enrichKnowledgeTopics()`
- `exportKnowledgeTopic()`

UI 在 `desktop/src/App.tsx`：

- `KnowledgeSection()`：配置、重建索引、搜索、知识库问答。
- `TopicMapPanel()`：主题列表、主题详情、AI 整理、导出、围绕主题提问。

前端通过 Tauri `invoke("backend_request", ...)` 转发到本地后端，而不是直接写死 fetch 后端端口。

## 11. 技术选型

### 11.1 FastAPI

用途：

- 提供本地 HTTP API。
- 用 Pydantic schema 做请求/响应结构化。
- 支持 async，适合调用 LLM、embedding、SiYuan API。

优点：

- Python 生态适合文本处理、LLM SDK、SQLite/LanceDB。
- 类型声明清晰。
- 测试方便，可以用 `TestClient`。

缺点：

- 桌面应用需要维护一个本地后端进程。
- Python 依赖和环境管理比纯前端方案重。

### 11.2 SQLite + FTS5

用途：

- 主数据存储。
- 文档、chunk、会话、图谱、主题全部落 SQLite。
- FTS5 提供默认全文检索。

优点：

- 本地嵌入式，无服务依赖。
- 对桌面应用友好。
- 事务简单。
- 精确关键词检索强。
- embedding 未启用时仍可用。

缺点：

- 中文分词能力有限，目前靠 CJK 单字预处理。
- 大规模全文检索能力不如 Elasticsearch/OpenSearch。
- 并发写能力有限，但对单用户桌面应用足够。

### 11.3 LanceDB

用途：

- 可选向量数据库。
- 保存 chunk embedding。
- 做语义相似搜索。

优点：

- 嵌入式、本地文件存储。
- 不需要单独启动服务。
- 与 Python 集成简单。
- 比自己在 SQLite 里手写向量搜索可靠。

缺点：

- 多一个依赖。
- 元数据一致性需要靠代码维护。
- 高级过滤、复杂混合查询能力不如专门服务化向量数据库或 PostgreSQL pgvector。

### 11.4 OpenAI-compatible API

用途：

- `llm.py` 调 chat completion。
- `embeddings.py` 调 embeddings。

优点：

- 可接 OpenAI、DeepSeek、MiniMax、兼容服务或本地代理。
- 配置模型、BaseURL、API Key 即可切换供应商。
- 代码简单。

缺点：

- 不同供应商对 `extra_body`、thinking、embedding 维度等支持不完全一致。
- 需要用户自己配置模型。
- 私有笔记片段会发送给用户配置的 LLM 服务。

### 11.5 RRF 混合排序

用途：

- 合并 FTS 和 vector 两路召回。

优点：

- 简单稳定。
- 不需要校准 BM25 分数和向量距离。
- 两路都命中的内容自然靠前。

缺点：

- 没有学习排序能力。
- 固定参数 `60` 不一定对所有数据集最优。
- 不考虑引用质量、时间、新旧、来源可信度等额外特征。

## 12. 可替代方案对比

### 12.1 只用 SQLite FTS

方案：

```text
SQLite documents/chunks/chunk_fts
不做 embedding
不引入 LanceDB
```

优点：

- 最简单。
- 完全本地。
- 无 embedding 成本。
- 对函数名、文件名、错误信息非常可靠。

缺点：

- 不懂语义相似。
- 用户提自然语言问题时召回可能弱。
- “意思相近但措辞不同”的内容不容易找出来。

适合：

- 首版最小可用。
- 代码/日志/命令搜索。
- 不希望配置任何模型的用户。

### 12.2 当前方案：SQLite FTS + LanceDB 向量

方案：

```text
SQLite 做主库和 FTS
LanceDB 做可选向量检索
RRF 融合
```

优点：

- 精确检索和语义检索互补。
- embedding 不可用时自动降级。
- 本地桌面部署简单。
- 数据职责清晰。

缺点：

- 两套索引需要保持一致。
- 索引链路更复杂。
- 用户需要配置 embedding 才能得到完整 hybrid 能力。

适合：

- TabKeep 当前目标：本地优先、轻依赖、可降级的知识库 RAG。

### 12.3 ChromaDB / Qdrant / Milvus 等向量库

优点：

- 向量检索能力成熟。
- 支持更丰富的过滤、集合管理、索引配置。
- Qdrant/Milvus 更适合服务端和大规模场景。

缺点：

- 通常需要额外服务或更复杂的持久化管理。
- 桌面用户安装门槛更高。
- 仍然需要关系型存储保存会话、主题、图谱等结构化数据。

适合：

- 多用户服务端。
- 大规模向量数据。
- 需要高级向量过滤和运维能力。

### 12.4 PostgreSQL + pgvector

优点：

- 关系数据、全文检索、向量可以放在一个数据库里。
- SQL 能力强。
- 适合服务端应用。

缺点：

- 对桌面应用太重。
- 用户需要安装/运行 PostgreSQL。
- 本地零配置体验不如 SQLite + LanceDB。

适合：

- TabKeep 未来如果变成服务端或团队版。

### 12.5 Elasticsearch / OpenSearch

优点：

- 全文检索强。
- 中文分词插件、BM25、高亮、过滤、聚合都成熟。
- 支持大规模搜索。

缺点：

- 运行成本高。
- 本地桌面部署不友好。
- 对当前个人知识库需求过重。

适合：

- 企业搜索。
- 大规模文档检索。

### 12.6 Neo4j / 专门图数据库

优点：

- 图查询、路径发现、关系推理能力强。
- 适合复杂实体关系网络。

缺点：

- 新增服务依赖。
- 数据建模成本高。
- 当前主题关系主要是共享文档，SQLite 表已经够用。

适合：

- 未来如果 TabKeep 需要复杂知识图谱推理、跨主题路径查询、实体关系挖掘。

### 12.7 LLM rerank / Cross-encoder rerank

方案：

```text
FTS/vector 先召回 20-50 条
再用 LLM 或 reranker 模型重排
```

优点：

- 相关性可能更高。
- 能理解问题和 chunk 的细粒度关系。

缺点：

- 增加延迟和成本。
- 多一次模型调用。
- 本地离线能力下降。
- 需要更复杂的失败降级。

适合：

- 用户对回答质量要求更高，且可以接受额外模型成本。

## 13. 当前实现的降级策略

| 场景 | 行为 |
| --- | --- |
| 知识库关闭 | reindex/sync 返回明确错误或提示。 |
| embedding 未配置 | 只用 FTS，搜索和问答仍可用。 |
| LanceDB 不可用 | `vector_store.availability()` 返回错误信息，检索回退 FTS。 |
| embedding 生成失败 | chunk 标记 `error`，索引流程返回错误信息。 |
| vector search 失败 | 记录 warning，搜索回退 FTS。 |
| LLM 未配置 | `/knowledge/ask` 返回 `modelConfig` 不完整，搜索仍可用。 |
| 搜索不到来源 | `/knowledge/ask` 返回“没有检索到相关内容”。 |
| 主题 AI 整理无模型 | 基础主题地图仍可用，AI 整理接口返回明确错误。 |

## 14. 当前实现的限制

- 中文 FTS 是轻量单字切分，不是完整中文分词。
- RAG 问答不会把历史会话作为上下文再次传给 LLM。
- RAG prompt 使用固定模板，没有 query rewrite、rerank、答案校验。
- FTS 与向量融合只用 RRF，没有来源权重、时间权重或质量权重。
- SQLite 与 LanceDB 是双写结构，需要靠 `index_document()` 保持一致。
- 删除外部 Markdown 文件后，当前 reindex 主要更新已发现文档，不一定清理已经不存在的旧文档。
- 主题关系是“共享文档”推导，不是语义实体关系推理。
- frontmatter 只提取 `tags`，正文 `#tag` 当前不会成为标签。

## 15. 建议阅读顺序

如果你想从源码学习，推荐顺序：

1. `backend/routers/knowledge.py`
   - 看所有知识库 API 是怎么暴露的。

2. `backend/services/knowledge/service.py`
   - 理解门面层如何组织模块。

3. `backend/services/knowledge/qa.py`
   - 先看问答主链路，理解 RAG 最终怎么回答。

4. `backend/services/knowledge/retrieval.py`
   - 看 FTS、vector、RRF 怎么组合。

5. `backend/services/knowledge/db.py`
   - 看表结构、入库、FTS 查询、会话存储。

6. `backend/services/knowledge/indexing.py`
   - 回头看文档如何进入数据库和向量库。

7. `backend/services/knowledge/chunking.py` 和 `cjk.py`
   - 理解切块和中文全文检索预处理。

8. `backend/services/knowledge/vector_store.py` 和 `embeddings.py`
   - 理解向量层。

9. `backend/services/llm.py`
   - 理解 OpenAI-compatible LLM 调用。

10. `backend/services/knowledge/graph.py`
    - 理解标签、标题、双链如何变成图谱节点和边。

11. `backend/services/knowledge/topics.py`
    - 理解主题地图如何从图谱信号、路径、embedding 相似中构建。

12. `desktop/src/api.ts` 和 `desktop/src/App.tsx`
    - 看前端如何触发这些能力。

13. `backend/tests/test_knowledge.py` 和 `backend/tests/test_api.py`
    - 用测试反推预期行为。

## 16. 一条完整链路示例

用户保存一条网页摘要，然后提问：

```text
1. 前端保存笔记
   desktop UI
   -> POST /notes/save

2. 后端保存到笔记系统
   routers/notes.py::save_tab()
   -> adapter.save()

3. 自动入知识库
   -> indexing.py::index_saved_note()
   -> indexing.py::index_document()
   -> db.py::upsert_document()
   -> graph.py::index_document_graph()
   -> embeddings.py::embed_texts()       可选
   -> vector_store.py::replace_document() 可选
   -> topics.py::rebuild_topics()

4. 用户在知识库页面提问
   desktop/src/api.ts::askKnowledge()
   -> POST /knowledge/ask
   -> routers/knowledge.py::ask()
   -> service.ask_knowledge()
   -> qa.py::ask_knowledge()

5. 先检索资料
   -> retrieval.py::search_knowledge()
   -> db.py::search_fts()
   -> embeddings.py::embed_texts()        可选
   -> vector_store.py::search()           可选
   -> retrieval.py::rrf_merge()

6. 构造 prompt 并调用模型
   -> qa.py::build_rag_messages()
   -> llm.py::chat_completion()
   -> qa.py::clean_llm_output()

7. 保存会话并返回
   -> db.py::add_message(user)
   -> db.py::add_message(assistant)
   -> KnowledgeAskResponse(answer, citations, sourceMode, sessionId)
```

## 17. 学习重点总结

TabKeep 的 RAG 不是一个单点函数，而是一条工程链：

```text
采集内容
-> 规范化 Markdown
-> 切块
-> SQLite 元数据和 FTS
-> 可选 embedding 和 LanceDB
-> FTS/vector 混合检索
-> RRF 融合排序
-> prompt 拼接
-> LLM grounded answer
-> 引用和会话记录
-> 图谱/主题地图作为知识组织层
```

最值得重点理解的四个文件：

- `indexing.py`：内容如何进入知识库。
- `db.py`：本地知识库怎么存。
- `retrieval.py`：RAG 的 Retrieval 怎么做。
- `qa.py`：Retrieval 结果如何变成 LLM 问答。

如果要继续优化，优先考虑：

- 更好的中文分词或 tokenizer。
- query rewrite。
- rerank。
- 会话历史参与上下文。
- 删除文件后的索引清理。
- 对 topic/graph 做更强的实体抽取。
