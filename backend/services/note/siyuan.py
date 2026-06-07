"""
SiYuan 笔记适配器。

通过 HTTP @ http://127.0.0.1:6806 操作思源笔记,需要 Authorization Token。

按职能:
  1. __init__ / _headers / _post        — 基础设施
  2. test_connection                    — 验证 token
  3. list_notebooks                     — 列笔记本
  4. list_docs                          — 列笔记本内文档树(扁平转嵌套)
  5. save                               — 主入口:3 路分支(无 target / 有 target+full / 有 target+link)
  6. _create_doc / _create_doc_with_content / _append_to_doc — save 内部辅助
  7. _resolve_doc_id                    — 解析 doc 路径成 block id
  8. _safe_name / _truncate             — 字符串辅助
"""
from datetime import date
from typing import Any

import httpx
from loguru import logger

from schemas.config import NoteAdapterConfig
from services.note.base import DocNode, NotebookInfo, SaveRequest, SaveResult


# ─────────────────────────────────────────────────────────────
# 1. 基础设施
# ─────────────────────────────────────────────────────────────
class SiYuanAdapter:
    name = "siyuan"

    def __init__(self, config: NoteAdapterConfig) -> None:
        self.config = config
        # endpoint 兜底 127.0.0.1:6806,末尾 / 去掉
        self.endpoint = (config.endpoint or "http://127.0.0.1:6806").rstrip("/")
        self.token = config.token or ""
        logger.info(
            f"siyuan adapter init: endpoint={self.endpoint} "
            f"token={'<empty>' if not self.token else f'{len(self.token)} chars'} "
            f"defaultNotebook={config.defaultNotebook!r} defaultTargetDoc={config.defaultTargetDoc!r}"
        )

    def _headers(self) -> dict[str, str]:
        """SiYuan 要求所有请求带 Authorization: Token xxx。"""
        return {"Authorization": f"Token {self.token}"}

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """通用 POST:把网络错误 / 401 / 404 / 非 JSON 响应都包成可读错误 raise 出去。"""
        url = f"{self.endpoint}{path}"
        logger.debug(f"siyuan POST {url} payload={_truncate(payload)}")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload, headers=self._headers())
        except httpx.ConnectError as e:
            logger.error(f"siyuan 连接失败 {url}: {e}")
            raise
        except httpx.TimeoutException as e:
            logger.error(f"siyuan 超时 {url}: {e}")
            raise
        except httpx.HTTPError as e:
            logger.error(f"siyuan HTTP 错误 {url}: {e}")
            raise

        logger.debug(f"siyuan POST {url} -> status={resp.status_code} body={_truncate(resp.text)}")
        # 401 单独抛一个可读 message(让人知道是 token 问题)
        if resp.status_code == 401:
            raise RuntimeError("401 Unauthorized:SiYuan 拒绝请求,Token 无效或未填")
        if resp.status_code == 404:
            raise RuntimeError(f"404 Not Found:路径不存在 {url}(检查 endpoint 是否正确)")
        resp.raise_for_status()

        try:
            data = resp.json()
        except ValueError as e:
            logger.error(f"siyuan 响应不是 JSON: {resp.text[:200]}")
            raise RuntimeError(f"响应不是合法 JSON: {e}") from e
        return data

    # ─────────────────────────────────────────────────────────
    # 2. 连通性测试
    # ─────────────────────────────────────────────────────────
    async def test_connection(self) -> tuple[bool, str | None]:
        """
        POST /api/notebook/lsNotebooks 试探。
        返回 (ok, error_message)。前端"测试连接"按钮的回调。
        """
        logger.info(f"siyuan test_connection -> {self.endpoint}/api/notebook/lsNotebooks")
        if not self.token:
            err = "Token 为空,请在仪表盘填写"
            logger.warning(f"siyuan test fail: {err}")
            return False, err
        try:
            data = await self._post("/api/notebook/lsNotebooks", {})
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            err = f"无法连接 {self.endpoint}:{e}"
            logger.warning(f"siyuan test fail: {err}")
            return False, err
        except RuntimeError as e:
            err = str(e)
            logger.warning(f"siyuan test fail: {err}")
            return False, err
        except httpx.HTTPError as e:
            err = f"HTTP 错误:{e}"
            logger.warning(f"siyuan test fail: {err}")
            return False, err
        except Exception as e:
            err = f"未知错误:{type(e).__name__}:{e}"
            logger.exception(f"siyuan test 异常: {e}")
            return False, err

        if data.get("code") != 0:
            err = f"SiYuan 返回错误 code={data.get('code')} msg={data.get('msg')!r}"
            logger.warning(f"siyuan test fail: {err}")
            return False, err

        nb_count = len(data.get("data", {}).get("notebooks", []))
        logger.info(f"siyuan test ok: {nb_count} 个笔记本")
        return True, None

    # ─────────────────────────────────────────────────────────
    # 3. 笔记本列表
    # ─────────────────────────────────────────────────────────
    async def list_notebooks(self) -> list[NotebookInfo]:
        """POST /api/notebook/lsNotebooks → 扁平 id/name 列表。"""
        logger.info("siyuan list_notebooks")
        data = await self._post("/api/notebook/lsNotebooks", {})
        if data.get("code") != 0:
            raise RuntimeError(f"siyuan lsNotebooks 失败: code={data.get('code')} msg={data.get('msg')!r}")
        notebooks = data.get("data", {}).get("notebooks", [])
        logger.info(f"siyuan list_notebooks ok: {len(notebooks)} 个")
        return [NotebookInfo(id=nb["id"], name=nb["name"]) for nb in notebooks]

    # ─────────────────────────────────────────────────────────
    # 5. 主入口:保存一条 tab(3 路分支)
    # ─────────────────────────────────────────────────────────
    async def save(self, req: SaveRequest) -> SaveResult:
        """
        三路分支:
          - 无 target_doc + 有 content  → 在笔记本根新建 doc,内容是全文 markdown
          - 无 target_doc + 无 content  → 在笔记本根新建 doc,只放链接行
          - 有 target_doc + 有 content  → append 全文到现有 doc 末尾
          - 有 target_doc + 无 content  → append 单行链接到现有 doc 末尾
        """
        notebook_id = req.notebook_id or (self.config.defaultNotebook or "")
        if not notebook_id:
            err = "未指定 notebook_id(请在仪表盘设置默认笔记本)"
            logger.warning(f"siyuan save 拒绝: {err}")
            return SaveResult(ok=False, error=err)
        target_doc = req.target_doc or self.config.defaultTargetDoc
        has_full = bool(req.content and req.content.strip())
        content_len = len(req.content) if req.content else 0
        logger.info(
            f"siyuan save url={req.url} full={has_full} content_len={content_len} "
            f"notebook_id={notebook_id!r} target_doc={target_doc!r}"
        )

        try:
            if not target_doc:
                # 笔记本根:在该笔记本下新建一个 doc(全文内容已包含在 doc body)
                if has_full:
                    doc_id = await self._create_doc_with_content(notebook_id, req.title, req.url, req.content or "")
                else:
                    doc_id = await self._create_doc(notebook_id, req.title, req.url)
            elif has_full:
                doc_id = await self._append_to_doc(target_doc, req.content or "")
            else:
                doc_id = await self._append_to_doc(target_doc, f"- [{req.title}]({req.url})\n")
        except (httpx.HTTPError, RuntimeError, OSError) as e:
            logger.exception(f"siyuan save 失败: {e}")
            return SaveResult(ok=False, error=str(e))
        logger.info(f"siyuan save ok url={req.url} full={has_full} doc={doc_id}")
        return SaveResult(ok=True, note_id=doc_id)

    # ─────────────────────────────────────────────────────────
    # 4. 笔记本内文档树(供前端弹窗用)
    # ─────────────────────────────────────────────────────────
    async def list_docs(self, notebook_id: str) -> list[DocNode]:
        """
        列笔记本内的文档树。SiYuan /api/filetree/listDocsByNotebook 是**扁平**返回
        (按 path 排序),由 _build_doc_tree 按 path 拼嵌套树。
        """
        logger.info(f"siyuan list_docs notebook={notebook_id}")
        data = await self._post("/api/filetree/listDocsByNotebook", {"notebook": notebook_id})
        if data.get("code") != 0:
            raise RuntimeError(
                f"siyuan listDocsByNotebook 失败: code={data.get('code')} msg={data.get('msg')!r}"
            )
        flat = data.get("data", {}).get("files", [])
        tree = self._build_doc_tree(flat)
        logger.info(f"siyuan list_docs ok: {len(flat)} 个文档,拼出 {len(tree)} 个根节点")
        return tree

    @staticmethod
    def _build_doc_tree(flat: list[dict]) -> list[DocNode]:
        """
        SiYuan 扁平 path → 嵌套 DocNode 树。
        算法:先把所有节点按 path 索引,然后看每个节点的父路径(去掉最后一段)是否在索引里,
        在就挂上去,不在就是 root。
        """
        by_path: dict[str, DocNode] = {}
        for f in flat:
            by_path[f["path"]] = DocNode(
                id=f["id"],
                name=f["name"],
                path=f["path"],
                type=f.get("type", "Page"),
                children=[],
            )
        roots: list[DocNode] = []
        for f in flat:
            node = by_path[f["path"]]
            parent_path = "/".join(f["path"].split("/")[:-1])
            if parent_path and parent_path in by_path:
                by_path[parent_path].children.append(node)
            else:
                roots.append(node)
        return roots

    # ─────────────────────────────────────────────────────────
    # 6. save 的内部辅助:三种写入方式
    # ─────────────────────────────────────────────────────────
    async def _create_doc_with_content(self, notebook_id: str, title: str, url: str, content: str) -> str:
        """新建 doc,正文里放全文 + 头部元数据(标题/来源/时间/分隔线)。"""
        doc_name = f"{_safe_name(title)[:50]}-{date.today().isoformat()}"
        md = (
            f"# {title}\n\n"
            f"- 来源:{url}\n"
            f"- 收藏时间:{date.today().isoformat()}\n\n"
            f"---\n\n"
            f"{content}\n"
        )
        logger.info(f"siyuan createDocWithContent doc={doc_name} notebook={notebook_id} md_len={len(md)}")
        data = await self._post(
            "/api/filetree/createDocWithMd",
            {"notebook": notebook_id, "path": doc_name, "markdown": md},
        )
        if data.get("code") != 0:
            raise RuntimeError(f"createDocWithMd 失败: code={data.get('code')} msg={data.get('msg')!r}")
        doc_id = data.get("data", "")
        logger.info(f"siyuan createDocWithContent ok doc_id={doc_id}")
        return doc_id

    async def _create_doc(self, notebook_id: str, title: str, url: str) -> str:
        """新建 doc,只放元数据(链接行),正文交给用户后续编辑。"""
        doc_name = f"{_safe_name(title)[:50]}-{date.today().isoformat()}"
        md = f"# {title}\n\n- 来源:{url}\n- 收藏时间:{date.today().isoformat()}\n\n"
        logger.info(f"siyuan createDoc doc={doc_name} notebook={notebook_id}")
        data = await self._post(
            "/api/filetree/createDocWithMd",
            {"notebook": notebook_id, "path": doc_name, "markdown": md},
        )
        if data.get("code") != 0:
            raise RuntimeError(f"createDocWithMd 失败: code={data.get('code')} msg={data.get('msg')!r}")
        doc_id = data.get("data", "")
        logger.info(f"siyuan createDoc ok doc_id={doc_id}")
        return doc_id

    async def _append_to_doc(self, doc_path: str, markdown: str) -> str:
        """
        追加 markdown 到现有 doc 末尾。
        SiYuan insertBlock 按 \\n 切多 block,所以单行直接传,多行会被自动分块。
        """
        resolved = await self._resolve_doc_id(doc_path)
        if not resolved:
            err = (
                f"找不到文档: {doc_path!r}\n"
                f"  提示:1) 在 SiYuan 里手动建这个文档;2) 填 block id(20+ 字符);"
                f"3) 填 'notebook_id/路径' 这种相对路径"
            )
            logger.warning(f"siyuan append fail: {err}")
            raise RuntimeError(err)
        logger.info(f"siyuan insertBlock parent_id={resolved} md_len={len(markdown)}")
        data = await self._post(
            "/api/block/insertBlock",
            {"dataType": "markdown", "data": markdown, "parentID": resolved},
        )
        if data.get("code") != 0:
            raise RuntimeError(f"insertBlock 失败: code={data.get('code')} msg={data.get('msg')!r}")
        return resolved

    # ─────────────────────────────────────────────────────────
    # 7. 解析 doc 路径 → block id
    # ─────────────────────────────────────────────────────────
    async def _resolve_doc_id(self, doc_path: str) -> str:
        """
        doc_path 可以是:
        - block id(20+ 字符,不含 /)→ 直接用
        - 名称 / 路径 → 用 SQL 查 id
        失败返回空字符串(让 _append_to_doc 报错)。
        """
        # 长度 20+ 且不含 / → 当作 block id 直接用
        if "/" not in doc_path and len(doc_path) >= 20:
            logger.info(f"siyuan resolve: doc_path={doc_path!r} 视为 block id 直接使用")
            return doc_path

        safe_name = _safe_name(doc_path).replace("'", "''")
        sql = (
            f"SELECT id FROM blocks "
            f"WHERE path = '{safe_name}' OR name = '{safe_name}' "
            f"LIMIT 1"
        )
        logger.info(f"siyuan resolve: doc_path={doc_path!r} sql 查询")
        try:
            data = await self._post("/api/query/sql", {"stmt": sql})
        except (httpx.HTTPError, OSError, RuntimeError) as e:
            logger.warning(f"siyuan 查询 doc_id 失败: {e}")
            return ""
        if data.get("code") != 0:
            logger.warning(f"siyuan SQL 失败: code={data.get('code')} msg={data.get('msg')!r}")
            return ""
        rows = data.get("data", [])
        if not rows:
            logger.warning(f"siyuan resolve: 没找到 {doc_path!r}")
            return ""
        resolved = rows[0].get("id", "")
        logger.info(f"siyuan resolve: {doc_path!r} -> {resolved}")
        return resolved


# ─────────────────────────────────────────────────────────────
# 8. 字符串辅助
# ─────────────────────────────────────────────────────────────
def _safe_name(text: str) -> str:
    """把任意文本转成"只能含字母数字/-_"的文件名安全字符串(其他字符替成 _)。"""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in text.strip()) or "tab"


def _truncate(obj: Any, limit: int = 200) -> str:
    """debug 日志里长对象截断,避免刷屏。"""
    s = str(obj)
    if len(s) > limit:
        return s[:limit] + f"... (truncated, total {len(s)} chars)"
    return s
