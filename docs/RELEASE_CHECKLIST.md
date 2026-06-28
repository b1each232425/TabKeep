# 发布前检查清单

这份清单用于准备一次可演示或可打包的 TabKeep 版本。它不等同于正式商业发布流程，当前重点是保证本地功能、构建和隐私边界可靠。

## 1. 工作区检查

```powershell
cd TabKeep
git status --short --branch
```

确认：

- 没有误提交 `backend/data/`、`backend/logs/`、`tmp/`、截图、OCR 文本或 API Key。
- 文档、配置和源码改动已经按功能分批提交。
- 当前分支已经同步到远端，或明确知道本地还有哪些未推送提交。

## 2. 后端检查

```powershell
cd TabKeep
pnpm test:backend
```

手动确认：

- `python backend/main.py` 能启动在 `127.0.0.1:38471`。
- `/` 健康检查返回 `TabKeep API Running`。
- 开发环境如需跳过本地 token 校验，显式设置 `TABKEEP_DISABLE_AUTH=1`。
- 生产或演示环境不要默认关闭 token 校验。

## 3. 桌面端检查

```powershell
cd TabKeep\desktop
pnpm build
```

手动确认：

- 主窗口能启动。
- 后端连接状态显示正确。
- 设置页能保存模型 API、分组和笔记集成配置。
- 知识库能同步来源、检查索引健康、搜索和问答。
- 知识图谱能打开，并且节点详情不展示内部 ID。
- OCR、翻译和区域翻译在目标 Windows 环境中可用。

## 4. 扩展端检查

```powershell
cd TabKeep\extension
pnpm build
```

Plasmo 构建时可能尝试联网检查自身版本。离线环境下即使看到 package information fetch 失败，只要命令退出码为 0 且 `extension/build/` 正常生成，就不视为构建阻塞。

手动确认：

- popup 能打开。
- 标签页同步不报错。
- 收藏网页能发送到后端。
- 扩展设置入口不再和桌面端配置重复。
- 浏览器受限页面、PDF 或 chrome:// 页面失败时有合理提示。

## 5. RAG 与知识库检查

建议使用 mock vault 和一份真实笔记库各跑一次：

```powershell
cd TabKeep
pnpm mock:obsidian
pnpm dev:eval
```

确认：

- 同步来源保存后能统一触发同步。
- paragraph/chunk 数量合理。
- SQLite、FTS、LanceDB 状态一致。
- hybrid 检索、rerank 和 RAG 回答都可用。
- 评估台能显示 Recall@10、Top1、MRR、答案样本和问题 case。

## 6. 打包

桌面端：

```powershell
cd TabKeep\desktop
pnpm tauri:build
```

扩展端：

```powershell
cd TabKeep\extension
pnpm package
```

打包后检查：

- 版本号是否需要同步更新：`desktop/src-tauri/tauri.conf.json`、`desktop/package.json`、`extension/package.json`。
- 桌面端图标、窗口标题、应用名正确。
- 扩展 manifest 名称、权限和版本正确。
- 安装包或 zip 中没有测试数据和密钥。

## 7. 发布说明

发布说明建议包含：

- 本次新增能力。
- 已知限制。
- 升级注意事项。
- 数据和隐私提醒。
- 验证过的平台。
- 回滚方式或重新索引方式。

## 8. 当前已知注意点

- 根目录脚本默认依赖本机 `tabkeep` conda 环境，新机器需要调整 Python 环境。
- 后端不会自动加载 `.env`，环境变量需要由 shell 或脚本注入。
- SiYuan 不可用时同步会部分失败，但不应阻塞其他来源。
- RAG 评估结果可能受测试集难度影响，高分不代表真实复杂问题一定稳定。
- Tauri 打包需要本机 Rust/MSVC/Tauri 环境完整。
