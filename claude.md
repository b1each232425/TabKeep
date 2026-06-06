# TabKeep 项目规范

## 项目概述

TabKeep 是一个 Chrome 浏览器扩展，用于收集、整理浏览器标签页信息，并将标签按域名自动分组为 Chrome Tab Group。后端使用 FastAPI 提供数据持久化和 API 服务。

## 项目结构

```
TabKeep/
├── extension/                 # Chrome 扩展（Plasmo 框架）
│   ├── src/
│   │   ├── background.ts     # 后台脚本：标签监听、同步、分组、收藏转发
│   │   ├── popup.tsx         # 弹出窗口 UI（含 ☆ / ★ 收藏按钮）
│   │   ├── options.tsx       # 仪表盘 UI（含「笔记集成」Section）
│   │   ├── content/extract.ts  # Plasmo content script：用 Defuddle 提取页面正文
│   │   ├── types/
│   │   │   ├── index.ts      # 类型 re-export
│   │   │   ├── tab.ts        # TabData / GroupedTab / TabCategory 等
│   │   │   ├── model.ts      # ModelConfig
│   │   │   └── note.ts       # NoteAdapterConfig / NotebookInfo / SaveTabResult
│   │   ├── utils/
│   │   │   ├── indexedDB.ts  # IndexedDB 存储工具
│   │   │   └── tabUtils.ts   # 标签分组工具函数
│   │   ├── components/
│   │   │   └── ui/           # shadcn/ui 组件
│   │   │       └── button.tsx
│   │   ├── lib/
│   │   │   └── utils.ts      # 工具函数（cn() 等）
│   │   └── globals.d.ts      # *.css 副作用导入声明（修 Plasmo tsconfig 缺漏）
│   ├── package.json
│   ├── tailwind.config.js
│   └── style.css
│
├── backend/                  # FastAPI 后端
│   ├── routers/              # 路由（按功能模块划分）
│   │   ├── __init__.py
│   │   ├── tabs.py          # 标签相关路由
│   │   ├── classify.py      # 配置同步 + LLM 分类路由
│   │   └── notes.py         # 笔记集成路由（test / notebooks / save）
│   ├── schemas/              # Pydantic 模型（数据格式定义）
│   │   ├── __init__.py
│   │   ├── tab.py           # 标签数据结构
│   │   ├── config.py        # 模型配置 + 分类定义 + 笔记适配器配置
│   │   └── classify.py      # 分类请求/响应模型
│   ├── services/             # 业务逻辑层
│   │   ├── __init__.py
│   │   ├── llm.py           # OpenAI SDK 封装
│   │   ├── classifier.py    # 分类 prompt + 响应解析
│   │   ├── storage.py       # 全局配置 + 内存状态（data/config.json 持久化）
│   │   └── note/            # 笔记适配器（可插拔，Protocol 模式）
│   │       ├── __init__.py
│   │       ├── base.py      # NoteAdapter Protocol + 通用 dataclass
│   │       ├── siyuan.py    # SiYuanAdapter（HTTP @ :6806）
│   │       ├── obsidian.py  # ObsidianAdapter（占位 stub）
│   │       ├── local.py     # LocalFileAdapter（写 data/notes/）
│   │       └── factory.py   # build_note_adapter(config)
│   ├── data/                # 运行时数据（不提交）
│   │   ├── config.json
│   │   └── notes/           # LocalFileAdapter 写入的 markdown（不提交）
│   ├── logger.py            # loguru 中心化配置
│   ├── main.py              # FastAPI 主入口（仅注册路由 + 中间件）
│   └── requirements.txt
│
└── claude.md                # 本规范文档
```

## 代码规范

### 变量命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 常量 | 全大写 + 下划线 | `SYNC_INTERVAL_MINUTES`, `BACKEND_URL` |
| 函数/方法 | 小驼峰，动词优先 | `fetchAllTabs()`, `syncToBackend()` |
| 接口类型 | 大驼峰 PascalCase | `TabData`, `GroupedTab`, `TabGroupStyleOptions` |
| 普通变量 | 小驼峰 | `tabData`, `groupedTabs` |
| 事件监听 | on + 事件名 | `onCreated`, `onAlarm` |

### 文件与代码组织

#### 通用规则
- **注释保留原则**：不要删除已有的注释，除非该功能代码被删除
  - 保留函数/方法的说明注释
  - 保留代码块的功能注释
  - 新增代码应添加适当的注释说明
- **按功能组织**：相关逻辑放在同一文件或临近的文件
- **单一职责**：每个函数只做一件事

#### Backend 规则
- **schemas/ 目录**：存放所有 Pydantic 模型，定义请求/响应的数据结构
  - `schemas/tab.py` → `TabData` 等标签相关模型
  - 按功能模块拆分，一个文件对应一个功能模块
- **routers/ 目录**：存放所有路由，按功能模块划分
  - `routers/tabs.py` → `/tabs` 相关接口
  - 使用 `APIRouter` 分组路由
- **main.py**：只负责注册中间件、注册路由、健康检查，不放业务逻辑

### 类型注解（Python Backend）

**所有 Python 函数（公共 + 私有）必须带完整的参数和返回类型注解**。类型注解不参与运行时，仅用于 IDE 提示和类型检查。

#### 语法规范

- **用 Python 3.10+ 内置泛型语法**，不要从 `typing` 导入旧写法：
  - ✅ `list[dict]`、`dict[str, int]`、`tuple[int, str]`
  - ❌ `List[Dict]`、`Dict[str, int]`、`Tuple[int, str]`
- **可空类型用 `X | None`**，不要 `Optional[X]`：
  - ✅ `def get_user() -> User | None:`
  - ❌ `def get_user() -> Optional[User]:`
- **异步生成器 / 上下文管理器用 `collections.abc`**：
  - ✅ `async def lifespan(_app: FastAPI) -> AsyncIterator[None]:`
  - ❌ `async def lifespan(_app: FastAPI):`

#### 示例

```python
# routers/tabs.py
@router.post("/", summary="接收 Extension 发送的标签数据")
def receive_tabs(tabs: list[TabData]) -> dict[str, int]:
    tabs_storage.clear()
    tabs_storage.extend(tabs)
    return {"received": len(tabs), "total": len(tabs_storage)}


# services/classifier.py
async def classify_tabs(
    model_config: ModelConfig,
    categories: list[TabCategory],
    tabs: list[TabData],
) -> tuple[dict[int, str], str]:
    messages = build_messages(categories, tabs)
    raw = await chat_completion(model_config, messages)
    return parse_classification(raw), raw
```

#### 适用范围

- ✅ 所有 `def` / `async def` 函数（公共 + `_` 前缀私有）
- ✅ FastAPI 路由处理函数（`@router.get/post` 等）
- ✅ Pydantic 模型字段（已自带类型，不需要重复）
- ❌ 模块级常量、变量不强求
- ❌ 第三方库返回的复杂类型（用 `# type: ignore` 兜底）

#### 不强求的场景

- 配置脚本、单文件 demo
- 类型实在写不出来（如高度动态的代码）
- 第三方库未提供类型 stub

### 接口类型定义（src/types/index.ts）

```typescript
// 标签页数据
interface TabData {
  id: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean
  pinned: boolean
}

// 按域名分组的标签
interface GroupedTab {
  domain: string
  count: number
  tabs: TabData[]
  favIconUrl?: string
  isOther?: boolean
}

// Tab Group 样式选项
interface TabGroupStyleOptions {
  defaultColor: TabGroupColor
  useDomainAsTitle: boolean
  collapsedByDefault: boolean
}

// 可选颜色类型
type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange"
```

### Extension API 端口

| 变量 | 值 | 说明 |
|------|-----|------|
| `BACKEND_URL` | `"http://127.0.0.1:38471"` | FastAPI 后端地址 |
| `SYNC_INTERVAL_MINUTES` | `1` | 定时同步间隔（分钟） |

## Extension 权限说明

```json
"permissions": ["storage", "tabs", "tabGroups", "alarms", "activeTab", "scripting"]
"host_permissions": ["<all_urls>"]
```

- **storage**: 使用 chrome.storage.local 存储配置
- **tabs**: 获取标签页信息
- **tabGroups**: 创建和管理 Tab Group
- **alarms**: 定时任务（同步到后端）
- **activeTab / scripting**: 备用，备用以备以后用 `chrome.scripting.executeScript`
- **`<all_urls>`**: Plasmo content script（`src/content/extract.ts`）需要在所有页面注入以调用 Defuddle 提取正文

### 全文收藏流程

```
popup 点 ★ (SAVE_TAB_FULL)
  → background.ts
    → chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CONTENT" })
    → content/extract.ts (Defuddle 处理 document，返回 markdown + meta)
    → POST /notes/save { title, url, content, excerpt, ... }
  → routers/notes.py
    → SiYuanAdapter.save()  /  LocalFileAdapter.save()
    → 若有 content：
        · SiYuan + 无 target_doc → createDocWithMd (整个 markdown 写入)
        · SiYuan + 有 target_doc → insertBlock (markdown 自动按 \n 切多 block)
        · LocalFile → append 到 data/notes/<target>.md
      若无 content：回退到「仅链接」路径
```

- **大小上限**：200K 字符（`MAX_CONTENT_CHARS`），超出截断 + 末尾标注 `> _(内容已截断)_`
- **Defuddle 输出**：`contentMarkdown` 优先，回退到 `content`（HTML）
- **边界**：chrome:// 内部页 / PDF / 受限页面 `sendMessage` 抛错 → 提示「无法访问 content script」

## 后端 API 设计

### 基础信息
- 端口：`38471`
- 跨域：允许所有来源（开发环境）

### 主要接口

#### POST /tabs
接收 extension 发送的标签数据。

```json
// 请求体
[
  {
    "id": 1,
    "title": "Google",
    "url": "https://www.google.com",
    "favIconUrl": "https://...",
    "active": true,
    "pinned": false
  }
]

// 响应
{
  "received": 10,
  "total": 10
}
```

#### GET /tabs
获取所有已存储的标签数据。

## 开发命令

### Extension
```bash
cd extension
pnpm dev      # 开发模式
pnpm build     # 构建
pnpm package   # 打包发布
```

### Backend
```bash
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 38471
```

## 通用规则

1. **代码即文档**：变量/函数命名清晰，无需额外注释说明"做什么"
2. **注释保留**：不删除已有注释，只在新增/修改时添加必要说明
3. **保持一致**：遵循本文件的命名和规范，已有的代码风格优先于全局规范
4. **先读再改**：修改文件前先 Read 完整内容，确保不会意外覆盖或删除