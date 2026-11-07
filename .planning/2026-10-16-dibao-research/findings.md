# Findings: Dibao

## 来源与范围

- 项目仓库：[Pls-1q43/Dibao](https://github.com/Pls-1q43/Dibao)
- 兴趣算法说明：[profile-algorithm-v0.md](https://github.com/Pls-1q43/Dibao/blob/main/docs/profile-algorithm-v0.md)
- 本文档中的算法细节来自项目文档，后续还需与当前代码核对。

## 兴趣算法初步发现

- 推荐候选只来自用户已订阅的来源；“最新”时间线与“推荐”队列并存。
- 目标强调简单、可解释、可调试；画像保留多个正向和负向兴趣主题，不压成一个平均向量。
- 行为强度分层：曝光和打开默认不算兴趣正反馈；阅读进度、读完、喜欢、收藏、稍后读等才逐渐成为画像证据；隐藏和“不感兴趣”形成负反馈。
- 阅读进度按 25/50/75/完成分档，每篇只取最高档，避免重复累加；快速退出只作弱统计。
- 兴趣主题用增量中心向量更新，不要求逐篇全量匹配，也不是 K-means；低相似度的信号可以暂不归类。
- 排序将内容兴趣、来源偏好、新鲜度、阅读状态、多样性、重复惩罚和负反馈拆开；各部分有上限，来源偏好不能压过内容兴趣。
- 系统为推荐提供理由和诊断信号，例如匹配主题、命中来源、文章新鲜度、证据数量、单一来源占比等。
- 没有 embedding 服务时也保留基础排序：新鲜度、来源和状态信号仍可工作。

## 对 TabKeep 的初步问题

- TabKeep 当前“点击阅读原文”记录 `open_original`，但 Dibao 文档将单纯 open 设为统计信号而非兴趣学习信号；需要评估是否降低其画像权重。
- TabKeep 当前已有资讯订阅、文章和本地 SQLite 行为层；可以先做可信的轻量行为聚合与解释，再考虑模型或向量。

## 产品范围与项目状态

- README 将 Dibao 定位为自托管的 RSS 阅读器和推荐层：用户自己管理订阅源，推荐只在这些来源内排序，不扩展成陌生内容平台。
- 用户流程保留“推荐”和“最新”两种入口，并提供收藏、稍后读、已读/未读、不感兴趣、搜索、OPML、源健康诊断与失败恢复。
- 推荐服务可选 embedding provider；无 provider 时基础阅读和排序仍可运行。推荐目标条数、离线阅读数量、后台任务等也被做成可配置/可诊断能力。
- GitHub README 当前标注 BUSL-1.1、source-available/fair-code；这适合参考产品和算法思想，但任何代码复用都应先核对许可限制。
- 官方 README 当前展示 v0.4.2 容器示例、性能/推荐 smoke 命令和 worker 配置，说明项目不仅是算法草案；具体兴趣算法是否逐项完全落地仍需结合源码核对。
- 来源：[README / 项目功能和许可](https://github.com/Pls-1q43/Dibao)。

## 数据与工程结构

- 工程蓝图明确写明它是技术地图而不是最终实现说明；其中标注了一部分“已实现”能力，也给出了各模块的职责，因此不能把蓝图里所有列出的模块都默认当作当前代码已完成。
- 架构把行为日志、文章状态、画像、排序分数和推荐解释分开：`behavior_events` 是不可变行为日志；`article_states` 放当前已读/收藏/稍后读等状态；`interest_clusters` 放可重建的画像结果；`article_rank_scores` 与 explanation 保存排序投影。
- 这使重新计算画像或排序时不必改写原始行为；阅读器“清账/批量已读”等行政命令与偏好行为也有明确区分，不会误当作喜欢。
- 兴趣算法文档说推荐解释 MVP 是实时生成，而不是把每篇解释永久写入专门表；但数据库 schema 还包含排序解释相关表，反映设计/实现演进，需以当前代码为准。
- 向量 BLOB 是权威数据，sqlite-vec 是可重建索引；provider 可替换，provider 不可用时回落基础排序。这是可恢复性上的工程参考。
- 来源：[工程蓝图](https://github.com/Pls-1q43/Dibao/blob/main/docs/engineering-blueprint.md)、[数据库 Schema](https://github.com/Pls-1q43/Dibao/blob/main/docs/database-schema.md)、[算法说明](https://github.com/Pls-1q43/Dibao/blob/main/docs/profile-algorithm-v0.md)。

## 行为设计上的重要细节

- Dibao 把“看见/打开”与“确实读过/明确喜欢”分开。单纯 open 不更新兴趣簇；阅读到 50% 后才具备画像更新资格，收藏、稍后读、读完和明确负反馈更强。
- 阅读进度被折算成每篇文章的最高档，而不是把 25%、50%、75%、完成四个事件加总，避免同一篇文章被重复放大。
- 冷启动不以“打开过几条”判断画像成熟，而要求多篇文章上的有效强信号，并且有多个正向兴趣簇。
- 对负面行为区分轻重：快速退出先作为统计/来源层弱信号；“不感兴趣”才是强负向。显式用户反馈优先于自动推断。
- 推荐解释说明文章具体为何靠前/靠后（主题、来源、新鲜度、重复、fallback），同时提供画像诊断，检查主题簇是否只由单一来源或少量弱行为支撑。
- 来源偏好有较低上限和置信门槛；若仅有打开事件，来源置信度也极低。这避免“某个来源文章多”被误读为用户更喜欢该来源。
- 来源：[行为权重、画像资格和冷启动](https://github.com/Pls-1q43/Dibao/blob/main/docs/profile-algorithm-v0.md)、[API Contract 的解释结构](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

## 推荐链并非只有兴趣簇

- 当前 API contract 描述了周期性的画像维护：实时接收行为并做延迟任务，15 分钟/小时/每日/每周任务会分别更新 recent intent、keyword profile、重复内容、FTRL 训练、排名及诊断。
- 这说明 Dibao 的推荐链已经从算法 v0 文档里的“正负兴趣簇 + 线性分项”发展成多路信号体系。算法 v0 中关于 cluster 的说明是理解基础，但不能当成当前推荐全貌。
- API contract 还区分推荐诊断状态、透明页、推荐理由、画像标签和合并诊断；有些是只读诊断，有些才会触发 profile/ranking 重算。
- FTRL 模型需要足够的样本才可提升为 active；API contract 示例给出高质量样本不足 100 时不允许 promote。这是一种“先观测、再验证、最后启用”的渐进上线思路，TabKeep 可以借鉴这个治理流程，不必直接采用 FTRL。
- 来源：[Dibao API Contract：维护周期与推荐状态](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

## 画像与排序如何配合

- 文档里的兴趣簇是“多主题表示”：每簇有正/负极性、中心向量、权重、样本数、最近命中时间和标签；新证据只与同极性簇比较。相似度达到合并阈值时更新已有主题，达到创建阈值但不够合并时新建，过低就只保留统计，不强行归类。
- 这不是 K-means 全量分桶；它是有阈值、有上限的增量中心维护。配合诊断字段，可发现小样本簇、来源偏斜和相似主题重复。
- 排序拆分成兴趣匹配、来源偏好、新鲜度、阅读状态、多样性、重复惩罚和负兴趣惩罚。内容兴趣权重上限最大；来源分数封顶；多样性是独立二次重排，不直接反向改画像。
- 新鲜度采用时间衰减，已读/待读状态会影响推荐，但显式反馈仍比“只是点开”强很多。
- 最新时间线独立保留，推荐列表只取 enabled feeds 中的有效文章，过滤隐藏和“不感兴趣”文章；主推荐候选预先计算并分页，避免每次请求重新做完整画像/排序。
- 无 embedding、索引未完成或画像尚未成熟均有 fallback，用户仍能阅读和排序；透明状态说明当前降级原因。
- 来源：[兴趣簇和排序公式](https://github.com/Pls-1q43/Dibao/blob/main/docs/profile-algorithm-v0.md)、[推荐 API 和 fallback contract](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

## 与 TabKeep 当前实现对照

- TabKeep 当前 `local-keywords-v1` 直接按行为权重累加标题/话题词，30 天半衰期，保存前 40 个关键词主题；事件权重包括 `reader_impression=0.7`、`open_original=1.8`、`history_visit=0.55`、订阅新增 `0.65`、明确负反馈 `-2/-3`。
- Dibao 的设计提醒：曝光和打开不应直接形成正向主题画像；有效阅读、收藏/稍后读等更强证据才更新兴趣。TabKeep 的“打开原文”发生在外部浏览器，无法得知阅读进度，因此现在把它当成较强兴趣信号风险偏高；可保留为“有点击意图”的弱统计，后续有更强证据再提高权重。
- 订阅行为可表示“主动选择了来源”，但不等于来源发布的所有主题都喜欢；来源偏好与内容兴趣要拆开。
- TabKeep 的历史记录包含 URL 和标题，Dibao 的主要行为日志围绕文章状态/动作；两边的数据边界不同。导入的浏览历史只有在能规范化 URL 并匹配 TabKeep 资讯条目时，才应成为较可信的资讯兴趣信号；其它历史可以用于探索关键词，但不该与明确阅读行为同权。
- 因此可借鉴其信号分层和分项排序，不能照搬其阅读进度事件：TabKeep 当前外链阅读器与 Dibao 内置文章阅读器可观测性不同。

### 2026-10-17 TabKeep 现状复核与下一步

- 当前 TabKeep 的 `recommended_items()` 已从订阅内容中筛候选，提取兴趣词与文章标题/正文前 1200 字重合度，标题权重 1.5、正文 0.5，再除以候选词数平方根；有正向主题时只返回正分文章，并返回匹配主题作为理由。画像没有正向主题时回退到最新列表。
- 这已具备 Dibao 值得参考的最小骨架：“推荐是已订阅内容的排序视图 + 提供人能读懂的原因 + 冷启动可回退”。当前短板不是再加聚类，而是信号可信度和排序质量：TabKeep 暂时仍给曝光、外链打开、浏览器历史访问较高正权重；没有单独的来源偏好、新鲜度项、同源多样性或明确的推荐状态诊断。
- Dibao 对 TabKeep 最合适的下一步不是照搬 embedding / FTRL / cluster 体系，而是先为现有关键词排序增加轻量的分项解释和冷启动状态：匹配到哪些兴趣词、正负兴趣分别贡献多少、文章新鲜度、信号数量与覆盖来源数；把 `open_original` 明确当作“点击意图”弱信号，订阅新增只影响来源偏好，避免把整条来源的内容都当作用户喜欢。
- 第二步再引入简单的新鲜度衰减和来源多样性重排，并给这些步骤分别保留开关/参数；先与当前排序做本地离线对照，不急着加向量模型。可以用现有 `open_original` / 资讯条目事件做小型时间切分回放：只用某时间点前事件建兴趣，看之后用户实际打开/明确采纳的文章在 top-N 是否提前；必须单独报告样本量和“打开记录由旧排序曝光造成”的偏差，不把它包装成严格因果证明。
- 这给出一个实用顺序：先修正行为权重和来源/内容分离；接着添加推荐理由与画像健康状态；有足够反馈后再试新鲜度/多样性；最后再评估 embedding。每一步都保留“最新”视图和可回退的旧排序。
- 来源：TabKeep 当前实现 `backend/services/news/interest.py`、`backend/routers/news.py`；Dibao API Contract 的推荐说明见 [推荐诊断与维护 contract](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

## 落地与评估参考

- Dibao 同时保留最新列表；推荐只是一种排序视图，不取代用户订阅和时间线。
- 推荐分数会给出少量可读原因，不暴露复杂原始分；状态页可显示 provider、embedding 覆盖率、行为计数、画像主题和 fallback/warning。
- 强行为后异步更新画像/排序；任务入队去重，重算不阻塞阅读请求。维护任务失败有状态，不让排序悄悄停在假正常状态。
- 它把学习过程分阶段：先产生可解释规则基线，维护诊断，运行轻量 replay evaluation；FTRL 虽可训练，也默认不自动 promote，并需要样本门槛。这一“实验先观察、验证后启用”的做法值得借鉴。
- 用户点赞后推荐相近文章、正文下展示相关内容，可作为未来的局部发现能力；但 TabKeep 当前先验证兴趣信号质量更实际，无需先做复杂推荐 UI。
- 来源：[v0.4.0 发布说明](https://github.com/Pls-1q43/Dibao/blob/main/docs/release-notes-v0.4.0.md)、[API Contract](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

## 2026-10-17 继续核对：当前项目与源码级评估入口

- 当前仓库 README 更新到 0.4.2 的安装示例，并仍将产品定位为“在用户自选 RSS 信源内部排序”，清楚区分“最新”和“推荐”；明确说 Provider 缺失时仍可使用基础排序，模型只是增强项。
- README 把推荐可复核性作为产品功能：文章有推荐原因，用户能用收藏、稍后读、已读/未读和“不感兴趣”影响排序；同时提供源健康诊断和失败恢复。
- 当前 README 列出 `npm run perf:recommendation` 与 `npm run smoke:docker-recommendation`，表明项目维护了专门的推荐性能与容器端到端验证入口；具体覆盖的排序维度、样本及断言还需查看这些脚本/测试源码，不能仅凭命令名推断。
- 当前仓库根目录包括 `apps/`、`packages/`、`plugins/official/`、`scripts/`、`tests/e2e/`，项目形态已明显从早期算法文档扩展为多包应用；继续分析时应以这些现行目录和测试为准，而不是只沿用算法 v0 文档。
- 以上依据当前主分支 README/仓库目录；后续待核对推荐 API 及测试脚本的实现细节。
- 来源：[当前 Dibao README 与仓库目录](https://github.com/Pls-1q43/Dibao)。

### 当前 API contract 核对

- 推荐列表明确按 active ranking context 的 `rerank_position` 排序，缺项时回退到已有 score/base score，因此“推荐列表不空”是接口契约层面的显式要求；无 embedding 或画像未就绪时仍可走 baseline。
- 推荐解释类型不只给一个分数，而是返回分类型的原因：interest、source、freshness、state、fallback、negative、penalty、exploration，并标出 positive/negative/neutral 影响；cluster 解释还含标签、关键词、样本数、相似度和最近命中时间。这比单一总分更容易看出推荐为何偏离直觉。
- 推荐状态诊断聚合了行为量、coverage、兴趣簇支撑文章/事件数、跨来源数、强信号比例、最大来源占比、簇相似度、过拟合风险和 warning；普通阅读路径可以请求不含簇明细的轻量诊断，说明他们区分了“用户状态”与“重型排查”。
- `api-contract.md` 的维护周期列有每日 evaluation diagnostic、且周评估默认关闭；但 contract 里 `evaluation` 的状态值包含 `unavailable`、`diagnostic_only`、`lightweight_replay_diagnostic`、`strict_replay`。这提示评估能力分阶段且不一定默认可用，是否有严格回放需要进一步看实现和默认状态。
- 来源：[Dibao API Contract：文章列表、推荐解释和诊断](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。

### 冷启动治理与实现边界

- Dibao 诊断明确区分推荐模式（baseline / personalized / embedding / degraded）和画像是否成熟。`PROFILE_WARMUP` 只看有效强行为，阈值示例为至少 8 个有效信号、5 篇文章、2 个正向兴趣簇；打开、曝光、低进度阅读、标记已读等不会解除冷启动提示。
- 可选算法不是直接上线：`clusterAutoMergeEnabled`、`ftrlAutoPromoteEnabled`、`evaluationAutoRunEnabled` 默认关闭；FTRL 要至少 100 个高质量样本才可手动 promote，且 blend alpha 有上限。值得借鉴的是“状态可见 + shadow/诊断先行 + 明确门槛后启用”的治理方式，不是 FTRL 本身。
- 系统还明确区分只读诊断、仅更新标签元数据、修改画像、触发排序重算这些副作用；例如簇标签重建不会改分数，合并需人工确认。这种副作用边界可以避免推荐调试操作意外改变用户画像。
- Contract 虽列出 `POST /api/recommendation/evaluate` 和多种 evaluation mode，但详细正文没有命中独立 endpoint 章节；因此“完整回放评估”的具体算法、统计量与生产实现状态仍不能单凭这份 contract 确认。对 TabKeep 的建议应落在本地离线 replay / 可解释诊断，不宣称 Dibao 当前已经提供某种严格的因果评估。
- 来源：[Dibao API Contract：画像 warmup、诊断、维护默认值与推荐维护接口](https://github.com/Pls-1q43/Dibao/blob/main/docs/api-contract.md)。
- 根 `package.json` 暴露了独立的 `perf:recommendation`、`smoke:docker-recommendation`、`ops:simulate:interest-profile` 和 `ops:rebuild:profile` 命令；这些是可复用的工程模式：性能基准、端到端 smoke、模拟画像和可运维重建。但脚本名本身不能代替对源码断言的核查。
- 当前主分支 `package.json` 的版本字段仍是 `0.3.1`，而 README 安装示例显示 `0.4.2`；可能是开发分支元数据未同步。后续引用版本能力应以具体 tag/提交为界，不应把 README 的所有当前功能都归入一个明确发布版本。
- 来源：[Dibao 根 package.json](https://raw.githubusercontent.com/Pls-1q43/Dibao/main/package.json)。
- 尝试直接读取 performance、兴趣模拟及 profile rebuild 脚本时，当前网页索引没有这些 raw 文件缓存，精确搜索结果也未命中；因此不能把这些命令当成已审阅的源码实现。本轮只把它们记为待查看的仓库级工程入口。
