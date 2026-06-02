# TabKeep 项目规范

## 项目概述

TabKeep 是一个 Chrome 浏览器扩展，用于收集、整理浏览器标签页信息，并将标签按域名自动分组为 Chrome Tab Group。后端使用 FastAPI 提供数据持久化和 API 服务。

## 项目结构

```
TabKeep/
├── extension/                 # Chrome 扩展（Plasmo 框架）
│   ├── src/
│   │   ├── background.ts     # 后台脚本：标签监听、同步、分组
│   │   ├── popup.tsx         # 弹出窗口 UI
│   │   ├── types/
│   │   │   └── index.ts      # 类型定义
│   │   ├── utils/
│   │   │   ├── indexedDB.ts  # IndexedDB 存储工具
│   │   │   └── tabUtils.ts   # 标签分组工具函数
│   │   ├── components/
│   │   │   └── ui/           # shadcn/ui 组件
│   │   │       └── button.tsx
│   │   └── lib/
│   │       └── utils.ts      # 工具函数（cn() 等）
│   ├── package.json
│   ├── tailwind.config.js
│   └── style.css
│
├── backend/                  # FastAPI 后端
│   ├── routers/              # 路由（按功能模块划分）
│   │   ├── __init__.py
│   │   └── tabs.py          # 标签相关路由
│   ├── schemas/              # Pydantic 模型（数据格式定义）
│   │   ├── __init__.py
│   │   └── tab.py           # 标签数据结构
│   ├── models/               # 数据库模型（如使用 ORM）
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
"permissions": ["storage", "tabs", "tabGroups", "alarms"]
```

- **storage**: 使用 chrome.storage.local 存储配置
- **tabs**: 获取标签页信息
- **tabGroups**: 创建和管理 Tab Group
- **alarms**: 定时任务（同步到后端）

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