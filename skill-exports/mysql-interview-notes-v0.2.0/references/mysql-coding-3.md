# MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `4a6b1731c285d86d9d45989c89704450f61441e7`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:39+08:00`

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding

<!-- knowledge-block: block-005-000 -->
- block_id: `block-005-000`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p0`
- keywords: MySQL, 幻读, 隔离级别, SQL, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林

### Evidence

---
source: tabkeep
title: "MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding"
url: "https://xiaolincoding.com/mysql/transaction/phantom.html#%E4%BB%80%E4%B9%88%E6%98%AF%E5%B9%BB%E8%AF%BB"
saved_at: "2026-09-06T08:08:36+08:00"
mode: "summary"
---

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding

<!-- knowledge-block: block-005-001 -->
- block_id: `block-005-001`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p1`
- keywords: MySQL, 幻读, 隔离级别, SQL, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林

### Evidence

# MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/transaction/phantom.html#%E4%BB%80%E4%B9%88%E6%98%AF%E5%B9%BB%E8%AF%BB
- 收藏时间：2026-09-06T08:08:36+08:00

---

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-005-002 -->
- block_id: `block-005-002`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p2`
- keywords: MySQL, InnoDB, next-key lock, 幻读, 隔离级别, MVCC, SQL, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

文章说明 MySQL InnoDB 默认的可重复读隔离级别如何分别通过 MVCC 和 next-key lock 避免幻读，并回答“可重复读是否完全解决了幻读”这一问题。结论是：可重复读只能在很大程度上避免幻读，仍存在两类特殊场景会产生幻读。来源：https://xiaolincoding.com/mysql/transaction/phantom.html#%E4%BB%80%E4%B9%88%E6%98%AF%E5%B9%BB%E8%AF%BB

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-005-003 -->
- block_id: `block-005-003`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p3`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, undo log, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 可回看摘要

### Evidence

## 可回看摘要

幻读是指同一事务中，同一个查询在不同时间产生不同的结果集，例如第一次查询没有某行，第二次查询却出现了该行。InnoDB 对两类读取采用不同机制：普通 SELECT 属于快照读，在可重复读级别下通过事务首次查询生成的 Read View，结合 MVCC 和 undo log 版本链，保证事务期间读到的数据一致；UPDATE、INSERT、DELETE 以及 SELECT ... FOR UPDATE 属于当前读，会读取最新版本，并通过 next-key lock（记录锁 + 间隙锁）阻止其他事务在锁定范围内插入记录。可重复读并未彻底解决幻读：第一类场景是事务 A 快照读不到某行，事务 B 插入并提交后，事务 A 更新该行，再次快照读时能看到该行；第二类场景是事务 A 先快照读，事务 B 插入并提交，事务 A 后续改用当前读，因此读到更多记录。需要避免第二类场景时，应在开启事务后尽早使用 SELECT ... FOR UPDATE 等当前读语句，让 InnoDB 及时加上 next-key lock。

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-005-004 -->
- block_id: `block-005-004`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p4`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, undo log, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 针对 **快照读** （普通 select 语句），是 **通过 MVCC 方式解决了幻读** ，因为可重复读隔离级别下，事务执行过程中看到的数据，一直跟这个事务启动时看到的数据是一致的，即使中途有其他事务插入了一条数据，是查询不出来这条数据的，所以就很好地避免了幻读问题。

> 针对 **当前读** （select... for update 等语句），是 **通过 next-key lock（记录锁+间隙锁）方式解决了幻读** ，因为当执行 select... for update 语句的时候，会加上 next-key lock，如果有其他事务在 next-key lock 锁范围内插入了一条记录，那么这个插入语句就会被阻塞，无法成功插入，所以就很好地避免了幻读问题。

> The so-called phantom problem occurs within a transaction when the same query produces different sets of rows at different times. For example, if a SELECT is executed twice, but returns a row the second time that was not returned the first time, the row is a “phantom” row.

> 只要 T1 和 T2 时刻执行产生的结果集是不相同的，那就发生了幻读的问题，比如：T1 时间执行的结果是有 5 条行记录，而 T2 时间执行的结果是有 6 条行记录；T1 时间执行的结果是有 5 条行记录，而 T2 时间执行的结果是有 4 条行记录，也是发生了幻读的问题。

> 可重复读隔离级是由 MVCC（多版本并发控制）实现的，实现的方式是开始事务后（执行 begin 语句后），在执行第一个查询语句后，会创建一个 Read View， **后续的查询语句利用这个 Read View，通过这个 Read View 就可以在 undo log 版本链找到事务开始时的数据，所以事务过程中每次查询的数据都是一样的**

> MySQL 里除了普通查询是快照读，其他都是 **当前读** ，比如 update、insert、delete，这些语句执行前都会查询最新版本的数据，然后再做进一步的操作。

> 所以， **Innodb 引擎为了解决「可重复读」隔离级别使用「当前读」而造成的幻读问题，就引出了间隙锁** 。

> 事务 A 执行了这面这条锁定读语句后，就在对表中的记录加上 id 范围为 (2, +∞\] 的 next-key lock（next-key lock 是间隙锁+记录锁的组合）。

> 然后，事务 B 在执行插入语句的时候，判断到插入的位置被事务 A 加了 next-key lock，于是事务 B 会生成一个插入意向锁，同时进入等待状态，直到事务 A 提交了事务。

> mysql> update t_stu set name = '小林coding' where id = 5; Query OK, 1 row affected (0.01 sec) Rows matched: 1 Changed: 1 Warnings: 0 mysql> select * from t_stu where id = 5; +----+--------------+------+ | id | name | age | +----+--------------+------+ | 5 | 小林coding | 18 | +----+--------------+------+ 1 row in set (0.00 sec)

> 因为这种特殊现象的存在，所以我们认为 **MySQL Innodb 中的 MVCC 并不能完全避免幻读现象** 。

> T1 时刻：事务 A 先执行「快照读语句」：select * from t_test where id > 100 得到了 3 条记录；T2 时刻：事务 B 往插入一个 id= 200 的记录并提交；T3 时刻：事务 A 再执行「当前读语句」 select * from t_test where id > 100 for update 就会得到 4 条记录，此时也发生了幻读现象。

> **可重复读隔离级别下虽然很大程度上避免了幻读，但是还是没有能完全解决幻读** 。

> **要避免这类特殊场景下发生幻读的现象的话，就是尽量在开启事务之后，马上执行 select... for update 这类当前读的语句** ，因为它会对记录加 next-key lock，从而避免其他事务插入一条新记录。

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 可以怎么用

<!-- knowledge-block: block-005-005 -->
- block_id: `block-005-005`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p5`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 可以怎么用

### Evidence

## 可以怎么用

- 判断事务中的查询是否可能出现幻读时，先区分快照读和当前读：普通 SELECT 通常是快照读，SELECT ... FOR UPDATE 以及 UPDATE、DELETE 等属于当前读。
- 需要在事务期间反复读取同一批历史数据时，使用普通 SELECT，并依赖可重复读级别下的 MVCC Read View；此时其他事务提交的新插入记录通常不会被快照读看到。
- 需要保证某个范围内在事务提交前不能插入新记录时，使用 SELECT ... FOR UPDATE，让 InnoDB 对相关记录和间隙加 next-key lock。
- 事务开启后如果后续既要做快照读又要做当前读，应尽早执行当前读；否则其他事务可能先插入新记录，导致前后两次查询的结果集不同。
- 排查“明明第一次查不到、更新后却查到了”的异常现象时，检查是否发生了：事务 A 先快照读不到记录、事务 B 插入并提交、事务 A 再更新该记录；更新会使记录的 trx_id 变为事务 A，从而被后续查询看到。
- 分析幻读时不能只看隔离级别名称，还要结合读取方式、Read View 创建时机、是否加锁以及事务之间的执行时序。

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 复习问题

<!-- knowledge-block: block-005-006 -->
- block_id: `block-005-006`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p6`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, 幻读, 隔离级别, MVCC, 当前读, 快照读, SQL, undo log, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 复习问题

### Evidence

## 复习问题

- MySQL InnoDB 可重复读隔离级别为什么不能完全解决幻读？
- 快照读和当前读分别是什么，普通 SELECT 与 SELECT ... FOR UPDATE 有什么区别？
- MVCC、Read View 和 undo log 版本链是如何避免快照读幻读的？
- next-key lock、记录锁、间隙锁和插入意向锁如何共同阻止当前读幻读？
- 事务 A 先快照读、事务 B 插入提交、事务 A 再当前读，为什么会发生幻读？
- 事务开启后为什么建议尽早执行 SELECT ... FOR UPDATE？

## MySQL 可重复读隔离级别，完全解决幻读了吗？ | 小林coding / 配图

<!-- knowledge-block: block-005-007 -->
- block_id: `block-005-007`
- paragraph_id: `4a6b1731c285d86d9d45989c89704450f61441e7:p7`
- keywords: MySQL, 幻读, 隔离级别, SQL, coding, 可重复读隔离级别, 完全解决幻读了吗, 小林, 配图

### Evidence

## 配图

![在这里插入图片描述](https://cdn.xiaolincoding.com//mysql/other/e576e047dccc47d5a59636ea342750b8.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/gap%E9%94%81.drawio.png)
![](https://cdn.xiaolincoding.com//mysql/other/3af285a8e70f4d4198318057eb955520.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E5%B9%BB%E8%AF%BB%E5%8F%91%E7%94%9F.drawio.png)
