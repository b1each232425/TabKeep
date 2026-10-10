# 事务隔离级别是怎么实现的？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `2531ded2715a303bbc900e521c982f0d6853a511`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:36+08:00`

## 事务隔离级别是怎么实现的？ | 小林coding

<!-- knowledge-block: block-009-000 -->
- block_id: `block-009-000`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p0`
- keywords: MySQL, 事务, 隔离级别, MVCC, SQL, coding, 事务隔离级别是怎么实现的, 小林

### Evidence

---
source: tabkeep
title: "事务隔离级别是怎么实现的？ | 小林coding"
url: "https://xiaolincoding.com/mysql/transaction/mvcc.html#%E4%BA%8B%E5%8A%A1%E6%9C%89%E5%93%AA%E4%BA%9B%E7%89%B9%E6%80%A7"
saved_at: "2026-09-05T17:05:12+08:00"
mode: "summary"
---

## 事务隔离级别是怎么实现的？ | 小林coding

<!-- knowledge-block: block-009-001 -->
- block_id: `block-009-001`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p1`
- keywords: MySQL, 事务, 隔离级别, MVCC, SQL, coding, 事务隔离级别是怎么实现的, 小林

### Evidence

# 事务隔离级别是怎么实现的？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/transaction/mvcc.html#%E4%BA%8B%E5%8A%A1%E6%9C%89%E5%93%AA%E4%BA%9B%E7%89%B9%E6%80%A7
- 收藏时间：2026-09-05T17:05:12+08:00

---

## 事务隔离级别是怎么实现的？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-009-002 -->
- block_id: `block-009-002`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p2`
- keywords: MySQL, InnoDB, 事务, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, undo log, coding, 事务隔离级别是怎么实现的, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

本文解释 MySQL InnoDB 事务隔离级别如何避免脏读、不可重复读和幻读，并重点说明读提交与可重复读隔离级别中 MVCC、Read View、undo log 版本链的实现机制。文章还对比了四种隔离级别的行为、性能代价，以及快照读和当前读解决幻读的不同方式。

## 事务隔离级别是怎么实现的？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-009-003 -->
- block_id: `block-009-003`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p3`
- keywords: MySQL, InnoDB, 索引, 聚簇索引, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, redo log, undo log, coding, 事务隔离级别是怎么实现的, 小林, 可回看摘要

### Evidence

## 可回看摘要

事务通过原子性、一致性、隔离性和持久性保证数据库操作的可靠性：持久性主要由 redo log 保证，原子性由 undo log 保证，隔离性由 MVCC 或锁机制保证，一致性由前三者共同保证。并发事务可能产生脏读、不可重复读和幻读，SQL 标准提供读未提交、读提交、可重复读和串行化四种隔离级别，隔离级别越高通常并发性能越低。InnoDB 默认使用可重复读。读未提交直接读取最新数据；串行化通过读写锁让事务串行执行；读提交和可重复读通过 Read View 实现，区别在于读提交在每次语句执行前重新创建 Read View，而可重复读通常在事务启动时创建并在整个事务期间复用同一个 Read View。InnoDB 聚簇索引记录包含 trx_id 和 roll_pointer 两个隐藏列，前者记录最近修改该记录的事务，后者指向 undo log 中的旧版本记录。Read View 通过 m_ids、min_trx_id、max_trx_id 和 creator_trx_id 判断某个版本是否可见；不可见时沿 roll_pointer 回溯版本链，找到可见的旧版本。可重复读能保证事务期间普通快照读的一致性；对于幻读，快照读通过 MVCC 避免，当前读如 select ... for update 通过 next-key lock（记录锁加间隙锁）避免，但可重复读并不能在所有场景彻底消除幻读。本文来源：https://xiaolincoding.com/mysql/transaction/mvcc.html#%E4%BA%8B%E5%8A%A1%E6%9C%89%E5%93%AA%E4%BA%9B%E7%89%B9%E6%80%A7。正文末尾存在截断，未覆盖完整后续内容。

## 事务隔离级别是怎么实现的？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-009-004 -->
- block_id: `block-009-004`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p4`
- keywords: MySQL, InnoDB, 索引, 聚簇索引, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, redo log, undo log, coding, 事务隔离级别是怎么实现的, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 事务是由 MySQL 的引擎来实现的，我们常见的 InnoDB 引擎它是支持事务的。

> 持久性是通过 redo log （重做日志）来保证的；原子性是通过 undo log（回滚日志） 来保证的；隔离性是通过 MVCC（多版本并发控制） 或锁机制来保证的；一致性则是通过持久性+原子性+隔离性来保证。

> 如果一个事务「读到」了另一个「未提交事务修改过的数据」，就意味着发生了「脏读」现象。

> 在一个事务内多次读取同一个数据，如果出现前后两次读到的数据不一样的情况，就意味着发生了「不可重复读」现象。

> 在一个事务内多次查询某个符合查询条件的「记录数量」，如果出现前后两次查询到的记录数量不一样的情况，就意味着发生了「幻读」现象。

> MySQL InnoDB 引擎的默认隔离级别。

> 在「读未提交」隔离级别下，可能发生脏读、不可重复读和幻读现象；在「读提交」隔离级别下，可能发生不可重复读和幻读现象，但是不可能发生脏读现象；在「可重复读」隔离级别下，可能发生幻读现象，但是不可能脏读和不可重复读现象；在「串行化」隔离级别下，脏读、不可重复读和幻读现象都不可能会发生。

> MySQL InnoDB 引擎在默认的「可重复读」隔离级别下，已经能在很大程度上避免幻读（通过 MVCC 解决快照读的幻读，通过临键锁 next-key lock 解决当前读的幻读）。

> 对于「读提交」和「可重复读」隔离级别的事务来说，它们是通过 Read View 来实现的，它们的区别在于创建 Read View 的时机不同，大家可以把 Read View 理解成一个数据快照，就像相机拍照那样，定格某一时刻的风景。**「读提交」隔离级别是在「每个语句执行前」都会重新生成一个 Read View，而「可重复读」隔离级别是「启动事务时」生成一个 Read View，然后整个事务期间都在用这个 Read View**。

> 执行了 begin/start transaction 命令后，并不代表事务启动了。只有在执行这个命令后，执行了第一条 select 语句，才是事务真正启动的时机；执行了 start transaction with consistent snapshot 命令，就会马上启动事务。

> Read View 有四个重要的字段：m_ids、min_trx_id、max_trx_id、creator_trx_id。

> trx_id，当一个事务对某条聚簇索引记录进行改动时，就会把该事务的事务 id 记录在 trx_id 隐藏列里；roll_pointer，每次对某条聚簇索引记录进行改动时，都会把旧版本的记录写入到 undo 日志中，然后这个隐藏列是个指针，指向每一个旧版本记录。

> 如果记录的 trx_id 值小于 Read View 中的 min_trx_id 值，表示这个版本的记录是由“创建 Read View 之前就已经提交的事务”生成的，所以该版本对当前事务可见。

> 如果记录的 trx_id 值大于等于 Read View 中的 max_trx_id 值，表示这个版本的记录是由“创建 Read View 之后才启动的事务”生成的，所以该版本对当前事务不可见。

> 如果 trx_id 在 m_ids 列表中，表示生成该版本记录的事务在创建 Read View 的那一刻仍然活跃（尚未提交），所以该版本对当前事务不可见；如果 trx_id 不在 m_ids 列表中，表示该事务虽然 id 已分配，但在创建 Read View 时已经提交，所以该版本对当前事务可见。

> 这种通过「版本链」来控制并发事务访问同一个记录时的行为就叫 MVCC（多版本并发控制）。

> return (!std::binary_search(p， p + m_ids.size()， id));

> 可重复读隔离级别是启动事务时生成一个 Read View，然后整个事务期间都在用这个 Read View。

> 读提交隔离级别是在每次读取数据时，都会生成一个新的 Read View。

> 针对快照读（普通 select 语句），是通过 MVCC 方式解决了幻读；针对当前读（select... for update 等语句），是通过 next-key lock（记录锁+间隙锁）方式解决了幻读。

## 事务隔离级别是怎么实现的？ | 小林coding / 以后可复用点

<!-- knowledge-block: block-009-005 -->
- block_id: `block-009-005`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p5`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, 死锁, SQL, undo log, coding, 事务隔离级别是怎么实现的, 小林, 以后可复用点

### Evidence

## 以后可复用点

- 排查 MySQL 脏读、不可重复读和幻读问题时，先确认事务隔离级别，再区分普通快照读与 select ... for update 等当前读。
- 解释 RC 与 RR 的核心差异时，可直接使用“RC 每次语句生成新的 Read View，RR 事务启动时生成并复用 Read View”的判断框架。
- 分析 MVCC 可见性时，依次检查 creator_trx_id、min_trx_id、max_trx_id 和 m_ids，再沿 roll_pointer 回溯 undo log 版本链。
- 阅读 InnoDB 源码时，可将 Read View 概念字段映射到源码字段：m_up_limit_id 对应 min_trx_id，m_low_limit_id 对应 max_trx_id，m_creator_trx_id 对应 creator_trx_id。
- 优化高并发事务时，不要简单通过升级到串行化解决幻读；应评估锁等待、死锁和吞吐量，并根据场景选择 MVCC、next-key lock 或更细粒度的事务设计。
- 讲解事务启动时机时，要区分 begin/start transaction 与 start transaction with consistent snapshot，前者通常在第一次一致性读时真正启动，后者会立即建立事务快照。
- 需要引用本文时保留来源链接：https://xiaolincoding.com/mysql/transaction/mvcc.html#%E4%BA%8B%E5%8A%A1%E6%9C%89%E5%93%AA%E4%BA%9B%E7%89%B9%E6%80%A7

## 事务隔离级别是怎么实现的？ | 小林coding / 复习问题

<!-- knowledge-block: block-009-006 -->
- block_id: `block-009-006`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p6`
- keywords: MySQL, InnoDB, 索引, 聚簇索引, 事务, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, undo log, coding, 事务隔离级别是怎么实现的, 小林, 复习问题

### Evidence

## 复习问题

- MySQL InnoDB 的四种事务隔离级别分别是什么？各自可能出现哪些脏读、不可重复读和幻读问题？
- 读提交和可重复读隔离级别创建 Read View 的时机有什么不同？为什么 RC 会出现不可重复读而 RR 通常不会？
- Read View 中 m_ids、min_trx_id、max_trx_id、creator_trx_id 分别表示什么？
- InnoDB 聚簇索引记录中的 trx_id 和 roll_pointer 如何配合 undo log 版本链实现 MVCC？
- MySQL InnoDB 如何根据 trx_id 判断记录版本是否对当前 Read View 可见？
- 快照读和当前读分别如何通过 MVCC 与 next-key lock 避免幻读？为什么可重复读并不能在所有场景彻底解决幻读？

## 事务隔离级别是怎么实现的？ | 小林coding / 配图

<!-- knowledge-block: block-009-007 -->
- block_id: `block-009-007`
- paragraph_id: `2531ded2715a303bbc900e521c982f0d6853a511:p7`
- keywords: MySQL, 事务, 隔离级别, SQL, coding, 事务隔离级别是怎么实现的, 小林, 配图

### Evidence

## 配图

![图片](https://cdn.xiaolincoding.com//mysql/other/bc8fe6de0e9e466671cd7d335c116de3.png)
![](https://cdn.xiaolincoding.com//gh/xiaolincoder/ImageHost4@main/mysql/%E4%BA%8B%E5%8A%A1%E9%9A%94%E7%A6%BB/readview%E7%BB%93%E6%9E%84.drawio.png)
![图片](https://cdn.xiaolincoding.com//mysql/other/f595d13450878acd04affa82731f76c5.png)
![](https://cdn.xiaolincoding.com//picgo/b552ebbbf5028c7fdaeea4333af36a13.png)
![](https://cdn.xiaolincoding.com//picgo/3589374aec7bcac5a3fb79f72626334d.png)
