# 索引常见面试题 | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:38+08:00`

## 索引常见面试题 | 小林coding

<!-- knowledge-block: block-013-000 -->
- block_id: `block-013-000`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p0`
- keywords: MySQL, 索引, SQL, coding, 索引常见面试题, 小林

### Evidence

---
source: tabkeep
title: "索引常见面试题 | 小林coding"
url: "https://xiaolincoding.com/mysql/index/index_interview.html#%E4%BB%80%E4%B9%88%E6%98%AF%E7%B4%A2%E5%BC%95"
saved_at: "2026-09-05T16:43:15+08:00"
mode: "summary"
---

## 索引常见面试题 | 小林coding

<!-- knowledge-block: block-013-001 -->
- block_id: `block-013-001`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p1`
- keywords: MySQL, 索引, SQL, coding, 索引常见面试题, 小林

### Evidence

# 索引常见面试题 | 小林coding

- 来源：https://xiaolincoding.com/mysql/index/index_interview.html#%E4%BB%80%E4%B9%88%E6%98%AF%E7%B4%A2%E5%BC%95
- 收藏时间：2026-09-05T16:43:15+08:00

---

## 索引常见面试题 | 小林coding / 这篇解决什么

<!-- knowledge-block: block-013-002 -->
- block_id: `block-013-002`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p2`
- keywords: MySQL, InnoDB, 索引, 二级索引, 回表, SQL, coding, 索引常见面试题, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

本文系统梳理 MySQL 索引的基本概念、分类、InnoDB 使用 B+Tree 的原因，以及主键索引、二级索引、联合索引的查询机制。重点解决联合索引最左匹配、范围查询、索引下推、覆盖索引、回表和索引设计等常见面试问题，并帮助判断什么时候应该或不应该创建索引。

## 索引常见面试题 | 小林coding / 可回看摘要

<!-- knowledge-block: block-013-003 -->
- block_id: `block-013-003`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p3`
- keywords: MySQL, InnoDB, 索引, 聚簇索引, 二级索引, 回表, SQL, TEXT, coding, 索引常见面试题, 小林, 可回看摘要

### Evidence

## 可回看摘要

索引是帮助存储引擎快速获取数据的数据结构，本质上是以空间换时间；索引和数据位于存储引擎中，InnoDB 自 MySQL 5.5 起成为默认存储引擎。索引可按数据结构、物理存储、字段特性和字段个数分类，常见类型包括 B+Tree、Hash、Full-text、聚簇索引、二级索引、主键索引、唯一索引、普通索引、前缀索引、单列索引和联合索引。InnoDB 默认使用 B+Tree：叶子节点存放数据或主键值，非叶子节点只存索引，叶子节点通过双向链表连接，适合高效查询和范围扫描；主键索引叶子节点保存完整记录，二级索引叶子节点保存主键值，使用二级索引查询完整数据时需要回表，若查询列已包含在二级索引中则形成覆盖索引。联合索引遵循最左匹配原则，索引字段按从左到右排序；普通大于、小于范围查询通常会使后续字段无法继续用于索引范围定位，而 >=、<=、BETWEEN 和前缀 LIKE 在特定情况下仍可使用后续字段缩小扫描范围。MySQL 5.6 引入索引下推，可在联合索引遍历期间先过滤索引字段，减少回表次数。联合索引设计应结合查询条件、排序需求和字段区分度，合理利用索引可以避免 filesort；但索引会占用空间、增加创建和维护成本并降低增删改效率，因此不应盲目创建。来源：https://xiaolincoding.com/mysql/index/index_interview.html#%E4%BB%80%E4%B9%88%E6%98%AF%E7%B4%A2%E5%BC%95

## 索引常见面试题 | 小林coding / 关键原文摘录

<!-- knowledge-block: block-013-004 -->
- block_id: `block-013-004`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p4`
- keywords: InnoDB, 索引, 聚簇索引, 二级索引, 回表, TEXT, coding, 索引常见面试题, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 索引是以空间换时间的设计思想。

> 那换到数据库中，索引的定义就是帮助存储引擎快速获取数据的一种数据结构，形象的说就是 索引是数据的目录 。

> 我们可以按照四个角度来分类索引。按「数据结构」分类： B+tree索引、Hash索引、Full-text索引。按「物理存储」分类： 聚簇索引（主键索引）、二级索引（辅助索引）。按「字段特性」分类： 主键索引、唯一索引、普通索引、前缀索引。按「字段个数」分类： 单列索引、联合索引。

> 如果有主键，默认会使用主键作为聚簇索引的索引键（key）；如果没有主键，就选择第一个不包含 NULL 值的唯一列作为聚簇索引的索引键（key）；在上面两个都没有的情况下，InnoDB 将自动生成一个隐式自增 id 列作为聚簇索引的索引键（key）。

> B+Tree 是一种多叉树，叶子节点才存放数据，非叶子节点只存放索引，而且每个节点里的数据是按主键顺序存放的。每一层父节点的索引值都会出现在下层子节点的索引值中，因此在叶子节点中，包括了所有的索引值信息，并且每一个叶子节点都有两个指针，分别指向下一个叶子节点和上一个叶子节点，形成一个双向链表。

> B+Tree 存储千万级的数据只需要 3-4 层高度就可以满足，这意味着从千万级的表查询目标数据最多需要 3-4 次磁盘 I/O。

> 主键索引的 B+Tree 的叶子节点存放的是实际数据，所有完整的用户记录都存放在主键索引的 B+Tree 的叶子节点里；二级索引的 B+Tree 的叶子节点存放的是主键值，而不是实际数据。

> 这个过程叫「回表」，也就是说要查两个 B+Tree 才能查到数据。

> 这种在二级索引的 B+Tree 就能查询到结果的过程就叫作「覆盖索引」，也就是只需要查一个 B+Tree 就能找到数据。

> B+Tree 只在叶子节点存储数据，而 B 树 的非叶子节点也要存储数据，所以 B+Tree 的单个节点的数据量更小，在相同的磁盘 I/O 次数下，就能查询更多的节点。

> Hash 在做等值查询的时候效率贼快，搜索复杂度为 O(1)。但是 Hash 表不适合做范围查询，它更适合做等值的查询。

> 联合索引查询的 B+Tree 是先按 product_no 进行排序，然后再 product_no 相同的情况再按 name 字段排序。因此，使用联合索引时，存在最左匹配原则。

> 如果创建了一个 `(a, b, c)` 联合索引，如果查询条件是 `where a=1`、`where a=1 and b=2 and c=3`、`where a=1 and b=2`，就可以匹配上联合索引。

> 联合索引的最左匹配原则会一直向右匹配直到遇到「范围查询」就会停止匹配。也就是范围查询的字段可以用到联合索引，但是在范围查询字段的后面的字段无法用到联合索引。

> 对于 `>=`、`<=`、`BETWEEN`、`like` 前缀匹配的范围查询，并不会停止匹配。

> 而 MySQL 5.6 引入的索引下推优化（index condition pushdown)，可以在联合索引遍历过程中，对联合索引中包含的字段先做判断，直接过滤掉不满足条件的记录，减少回表次数。

> 建立联合索引时，要把区分度大的字段排在前面，这样区分度大的字段越有可能被更多的 SQL 使用到。

> 因为在查询时，如果只用到 status 的索引，但是这条语句还要对 create_time 排序，这时就要用文件排序 filesort；所以，要利用索引的有序性，在 status 和 create_time 列建立联合索引。

> 索引最大的好处是提高查询速度，但是索引也是有缺点的，比如：需要占用物理空间；创建索引和维护索引要耗费时间；会降低表的增删改的效率。

## 索引常见面试题 | 小林coding / 以后可复用点

<!-- knowledge-block: block-013-005 -->
- block_id: `block-013-005`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p5`
- keywords: MySQL, 索引, 聚簇索引, 二级索引, 回表, SQL, coding, 索引常见面试题, 小林, 以后可复用点

### Evidence

## 以后可复用点

- 遇到 MySQL 索引面试题时，可以按“定义与作用—索引分类—B+Tree 原理—主键索引与二级索引—联合索引—失效场景—优化方法—索引代价”的顺序组织回答。
- 分析二级索引查询性能时，先判断查询列是否被索引覆盖：只读取索引中已有的列可避免回表，读取其他列则需要根据主键再次访问聚簇索引。
- 设计联合索引时，应优先分析高频 WHERE、JOIN、GROUP BY 和 ORDER BY 条件，并结合最左匹配原则决定字段顺序。
- 排查联合索引是否真正使用了多个字段时，可以结合 EXPLAIN 的 key、key_len 和 Extra 判断；key_len 可帮助确认形成扫描区间的索引字段数量，Using index condition 表示使用了索引下推。
- 针对 `WHERE status = 1 ORDER BY create_time ASC` 一类查询，可考虑建立 `(status, create_time)` 联合索引，以利用索引有序性并减少 filesort。
- 对区分度低、重复值多、查询中很少使用或数据量很小的字段，通常不应盲目建索引；索引选择还要权衡查询收益与写入维护成本。
- 复习和引用本文时保留原始来源链接：https://xiaolincoding.com/mysql/index/index_interview.html#%E4%BB%80%E4%B9%88%E6%98%AF%E7%B4%A2%E5%BC%95

## 索引常见面试题 | 小林coding / 复习问题

<!-- knowledge-block: block-013-006 -->
- block_id: `block-013-006`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p6`
- keywords: MySQL, InnoDB, 索引, 聚簇索引, 二级索引, 回表, SQL, coding, 索引常见面试题, 小林, 复习问题

### Evidence

## 复习问题

- 什么是 MySQL 索引？为什么说索引是以空间换时间？
- InnoDB 为什么选择 B+Tree 作为索引结构？B+Tree 与 B 树、二叉树、Hash 索引有什么区别？
- InnoDB 聚簇索引和二级索引的叶子节点分别存储什么？什么是回表和覆盖索引？
- 联合索引 `(a, b, c)` 的最左匹配原则是什么？`where b=2` 为什么无法有效使用该索引？
- 联合索引中 `a > 1 and b = 2`、`a >= 1 and b = 2`、`a BETWEEN 2 AND 8 AND b = 2` 分别有多少字段用于索引范围定位？
- 什么是 MySQL 索引下推？`EXPLAIN` 中出现 `Using index condition` 说明了什么？

## 索引常见面试题 | 小林coding / 配图

<!-- knowledge-block: block-013-007 -->
- block_id: `block-013-007`
- paragraph_id: `7825c2bb8661ea047fc85893dcfdef35ce2d4790:p7`
- keywords: MySQL, 索引, 二级索引, 回表, SQL, coding, 索引常见面试题, 小林, 配图

### Evidence

## 配图

![索引提纲](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/%E7%B4%A2%E5%BC%95%E6%8F%90%E7%BA%B2.png)
![主键索引 B+Tree](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/btree.drawio.png)
![二级索引 B+Tree](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/%E4%BA%8C%E7%BA%A7%E7%B4%A2%E5%BC%95btree.drawio.png)
![回表](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/%E5%9B%9E%E8%A1%A8.drawio.png)
![联合索引](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/%E8%81%94%E5%90%88%E7%B4%A2%E5%BC%95.drawio.png)
![区分度计算公式](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/%E5%8C%BA%E5%88%86%E5%BA%A6.png)
![Q1 执行计划](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/q1.png)
![Q2 执行计划](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E7%B4%A2%E5%BC%95/q2.png)
