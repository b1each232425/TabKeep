# 执行一条 select 语句，期间发生了什么？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `4469c35533d24576a2cd571185a2067b62234b10`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:38+08:00`

## 执行一条 select 语句，期间发生了什么？ | 小林coding

<!-- knowledge-block: block-011-000 -->
- block_id: `block-011-000`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p0`
- keywords: MySQL, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林

### Evidence

---
source: tabkeep
title: "执行一条 select 语句，期间发生了什么？ | 小林coding"
url: "https://xiaolincoding.com/mysql/base/how_select.html#mysql-%E6%89%A7%E8%A1%8C%E6%B5%81%E7%A8%8B%E6%98%AF%E6%80%8E%E6%A0%B7%E7%9A%84"
saved_at: "2026-09-05T15:37:56+08:00"
mode: "summary"
---

## 执行一条 select 语句，期间发生了什么？ | 小林coding

<!-- knowledge-block: block-011-001 -->
- block_id: `block-011-001`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p1`
- keywords: MySQL, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林

### Evidence

# 执行一条 select 语句，期间发生了什么？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/base/how_select.html#mysql-%E6%89%A7%E8%A1%8C%E6%B5%81%E7%A8%8B%E6%98%AF%E6%80%8E%E6%A0%B7%E7%9A%84
- 收藏时间：2026-09-05T15:37:56+08:00

---

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-011-002 -->
- block_id: `block-011-002`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p2`
- keywords: MySQL, 索引, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

这篇文章拆解 MySQL 执行一条 SELECT 查询语句时的内部流程，解释 Server 层、存储引擎层及连接器、解析器、预处理器、优化器和执行器分别承担什么职责。重点说明主键索引查询、全表扫描和索引下推时，执行器如何与存储引擎交互。

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-011-003 -->
- block_id: `block-011-003`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p3`
- keywords: MySQL, InnoDB, 索引, 二级索引, 回表, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 可回看摘要

### Evidence

## 可回看摘要

MySQL 架构分为 Server 层和存储引擎层：Server 层负责连接管理、SQL 分析与执行，存储引擎层负责数据存储和读取，InnoDB 默认使用 B+ 树索引。SELECT 的总体流程是：连接器通过 TCP 建立连接并校验身份、读取权限；MySQL 8.0 之前可能检查 Server 层查询缓存，8.0 已移除该模块；解析器进行词法分析、语法分析并构建语法树；执行阶段依次经过 prepare、optimize、execute。预处理器检查表和字段是否存在，并展开 SELECT *；优化器基于成本选择索引和执行计划，可通过 EXPLAIN 查看 key、type、Extra 等信息；执行器按照执行计划逐条从存储引擎读取记录并将结果返回客户端。文章还说明了长连接的内存占用与处理方式、wait_timeout 和 max_connections 参数、覆盖索引，以及 MySQL 5.6 引入的索引下推：将部分条件过滤下推到存储引擎，减少二级索引回表次数。来源：https://xiaolincoding.com/mysql/base/how_select.html#mysql-%E6%89%A7%E8%A1%8C%E6%B5%81%E7%A8%8B%E6%98%AF%E6%80%8E%E6%A0%B7%E7%9A%84

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-011-004 -->
- block_id: `block-011-004`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p4`
- keywords: MySQL, InnoDB, 索引, 二级索引, 回表, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 可以看到， MySQL 的架构共分为两层：Server 层和存储引擎层

> Server 层负责建立连接、分析和执行 SQL。

> 存储引擎层负责数据的存储和提取。

> 现在最常用的存储引擎是 InnoDB，从 MySQL 5.5 版本开始， InnoDB 成为了 MySQL 的默认存储引擎。

> 如果一个用户已经建立了连接，即使管理员中途修改了该用户的权限，也不会影响已经存在连接的权限。修改完成后，只有再新建的连接才会使用新的权限设置。

> MySQL 定义了空闲连接的最大空闲时长，由 wait_timeout 参数控制的，默认值是 8 小时（28800秒），如果空闲连接超过了这个时间，连接器就会自动将它断开。

> MySQL 服务支持的最大连接数由 max_connections 参数控制，比如我的 MySQL 服务默认是 151 个,超过这个值，系统就会拒绝接下来的连接请求，并报错提示“Too many connections”。

> MySQL 8.0 版本直接将查询缓存删掉了，也就是说 MySQL 8.0 开始，执行一条 SQL 查询语句，不会再走到查询缓存这个阶段了。

> 解析器会做如下两件事情。第一件事情，词法分析。第二件事情，语法分析。

> 解析器只负责检查语法和构建语法树，但是不会去查表或者字段存不存在。

> 每条 SELECT 查询语句流程主要可以分为下面这三个阶段：prepare 阶段，也就是预处理阶段；optimize 阶段，也就是优化阶段；execute 阶段，也就是执行阶段；

> 预处理阶段做了什么事情：检查 SQL 查询语句中的表或者字段是否存在；将 select * 中的 * 符号，扩展为表上的所有列；

> 优化器主要负责将 SQL 查询语句的执行方案确定下来，比如在表里面有多个索引的时候，优化器会基于查询成本的考虑，来决定选择使用哪个索引。

> 如果查询语句的执行计划里的 key 为 null 说明没有使用索引，那就会全表扫描（type = ALL），这种查询扫描的方式是效率最低档次的。

> 很显然这条查询语句是覆盖索引，直接在二级索引就能查找到结果（因为二级索引的 B+ 树的叶子节点的数据存储的是主键值），就没必要在主键索引查找了。

> 索引下推能够减少二级索引在查询时的回表操作，提高查询的效率，因为它将 Server 层部分负责的事情，交给存储引擎层去处理了。

> 当你发现执行计划里的 Extra 部分显示了 “Using index condition”，说明使用了索引下推。

> 连接器：建立连接，管理连接、校验用户身份；

> 解析 SQL，通过解析器对 SQL 查询语句进行词法分析、语法分析，然后构建语法树，方便后续模块读取表名、字段、语句类型；

> 执行阶段：根据执行计划执行 SQL 查询语句，从存储引擎读取记录，返回给客户端；

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 以后可复用点

<!-- knowledge-block: block-011-005 -->
- block_id: `block-011-005`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p5`
- keywords: MySQL, InnoDB, 索引, 二级索引, 回表, SQL, Buffer Pool, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 以后可复用点

### Evidence

## 以后可复用点

- 排查一条 SELECT 查询的性能时，按“连接器→解析/预处理→优化器→执行器→存储引擎”的链路定位问题，避免只关注 SQL 文本。
- 使用 EXPLAIN 检查执行计划：重点查看 key 是否命中索引、type 是否为 ALL，以及 Extra 是否出现 Using index 或 Using index condition。
- 遇到 MySQL 8.0 及以上版本时，不要再把 Server 层 Query Cache 作为查询加速方案；区分 Query Cache 与 InnoDB Buffer Pool。
- 设计联合索引和分析范围查询时，注意联合索引遇到范围条件后后续列通常不能继续用于索引定位，但可以借助索引下推减少回表。
- 对二级索引查询进行优化时，判断是否能够形成覆盖索引；如果查询所需列已包含在索引中，可以避免回表。
- 管理连接池时，结合 wait_timeout、max_connections 和长连接内存占用设置连接生命周期；执行大型操作后可考虑定期断开连接或调用 mysql_reset_connection() 重置连接。
- 遇到表不存在或字段不存在的错误时，应将检查范围定位到预处理阶段，而不是简单归因于 SQL 解析器。
- 复习 MySQL 查询执行流程时，可使用文章原始链接作为流程图和概念对照材料：https://xiaolincoding.com/mysql/base/how_select.html#mysql-%E6%89%A7%E8%A1%8C%E6%B5%81%E7%A8%8B%E6%98%AF%E6%80%8E%E6%A0%B7%E7%9A%84

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 复习问题

<!-- knowledge-block: block-011-006 -->
- block_id: `block-011-006`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p6`
- keywords: MySQL, InnoDB, 索引, 回表, SQL, Buffer Pool, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 复习问题

### Evidence

## 复习问题

- MySQL 执行一条 SELECT 语句的完整流程是什么？Server 层和存储引擎层分别负责什么？
- MySQL 连接器如何建立 TCP 连接、校验用户名密码并处理用户权限？wait_timeout 和 max_connections 分别有什么作用？
- MySQL 8.0 为什么移除 Server 层查询缓存？查询缓存与 InnoDB Buffer Pool 有什么区别？
- MySQL 解析器、预处理器、优化器和执行器分别负责哪些工作？表不存在和字段不存在在哪个阶段检查？
- 如何通过 EXPLAIN 的 key、type 和 Extra 判断是否使用索引、覆盖索引和全表扫描？
- MySQL 索引下推是什么？联合索引 age、reward 在 age > 20 and reward = 100000 查询中如何减少回表操作？

## 执行一条 select 语句，期间发生了什么？ | 小林coding / 配图

<!-- knowledge-block: block-011-007 -->
- block_id: `block-011-007`
- paragraph_id: `4469c35533d24576a2cd571185a2067b62234b10:p7`
- keywords: MySQL, 索引, SQL, select, coding, 执行一条, 语句, 期间发生了什么, 小林, 配图

### Evidence

## 配图

![查询语句执行流程](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/sql%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B/mysql%E6%9F%A5%E8%AF%A2%E6%B5%81%E7%A8%8B.png)
![执行计划](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/sql%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B/%E6%89%A7%E8%A1%8C%E8%AE%A1%E5%88%92.png)
![选择索引](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/sql%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B/%E9%80%89%E6%8B%A9%E7%B4%A2%E5%BC%95.png)
![索引下推执行计划](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/sql%E6%89%A7%E8%A1%8C%E8%BF%87%E7%A8%8B/%E7%B4%A2%E5%BC%95%E4%B8%8B%E6%8E%A8%E6%89%A7%E8%A1%8C%E8%AE%A1%E5%88%92.png)
