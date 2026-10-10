# MySQL 是怎么加锁的？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `2b16dedb1e971660075751e0384865bd55a28bdc`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:39+08:00`

## MySQL 是怎么加锁的？ | 小林coding

<!-- knowledge-block: block-006-000 -->
- block_id: `block-006-000`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p0`
- keywords: MySQL, 锁, SQL, coding, 是怎么加锁的, 小林

### Evidence

---
source: tabkeep
title: "MySQL 是怎么加锁的？ | 小林coding"
url: "https://xiaolincoding.com/mysql/lock/how_to_lock.html"
saved_at: "2026-09-06T08:09:06+08:00"
mode: "summary"
---

## MySQL 是怎么加锁的？ | 小林coding

<!-- knowledge-block: block-006-001 -->
- block_id: `block-006-001`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p1`
- keywords: MySQL, 锁, SQL, coding, 是怎么加锁的, 小林

### Evidence

# MySQL 是怎么加锁的？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/lock/how_to_lock.html
- 收藏时间：2026-09-06T08:09:06+08:00

---

## MySQL 是怎么加锁的？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-006-002 -->
- block_id: `block-006-002`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p2`
- keywords: MySQL, InnoDB, 索引, 锁, 隔离级别, SQL, coding, 是怎么加锁的, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

本文系统解释 InnoDB 在不同 SQL、索引类型、查询条件和隔离级别下如何加行级锁，解决记录锁、间隙锁和 next-key 锁容易混淆的问题。文章还介绍如何通过 performance_schema.data_locks 分析实际加锁范围和锁类型。来源：https://xiaolincoding.com/mysql/lock/how_to_lock.html

## MySQL 是怎么加锁的？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-006-003 -->
- block_id: `block-006-003`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p3`
- keywords: MySQL, InnoDB, 索引, 二级索引, 锁, next-key lock, gap lock, record lock, 幻读, 隔离级别, 快照读, SQL, coding, 是怎么加锁的, 小林, 可回看摘要

### Evidence

## 可回看摘要

本文基于 MySQL 8.0.26、可重复读隔离级别和 InnoDB 引擎，说明普通 SELECT 属于快照读，通常不加行锁；SELECT ... LOCK IN SHARE MODE、SELECT ... FOR UPDATE、UPDATE 和 DELETE 会产生行级锁，其中 UPDATE、DELETE 使用 X 锁。InnoDB 的行级锁包括 Record Lock、Gap Lock 和 Next-Key Lock；加锁对象是索引，基本单位是前开后闭的 next-key lock，但在能够单独防止幻读的场景下会退化为记录锁或间隙锁。唯一索引等值查询中，记录存在时通常退化为记录锁，记录不存在时退化为间隙锁；唯一索引范围查询则根据大于、小于、是否包含等值条件、终止记录是否存在等情况组合使用 next-key 锁、记录锁和间隙锁。对二级索引进行锁定读时，除了锁二级索引项，还会锁查询记录对应的主键索引项。可通过 select * from performance_schema.data_locks\G; 查看 LOCK_TYPE、LOCK_MODE、LOCK_DATA，从而判断锁是 next-key 锁、记录锁还是间隙锁。需要注意，具体加锁规则可能随 MySQL 版本变化，本文实验结论主要基于 MySQL 8.0.26。

## MySQL 是怎么加锁的？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-006-004 -->
- block_id: `block-006-004`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p4`
- keywords: MySQL, 索引, 二级索引, 事务, 锁, next-key lock, gap lock, record lock, 幻读, 隔离级别, MVCC, 快照读, SQL, coding, 是怎么加锁的, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 普通的 select 语句是不会对记录加锁的（除了串行化隔离级别），因为它属于快照读，是通过 MVCC（多版本并发控制）实现的。

> select ... lock in mode;

> select ... for update;

> 除了上面这两条锁定读语句会加行级锁之外，update 和 delete 操作都会加行级锁，且锁的类型都是独占锁(X型锁)。

> Record Lock，记录锁，也就是仅仅把一条记录锁上；Gap Lock，间隙锁，锁定一个范围，但是不包含记录本身；Next-Key Lock：Record Lock + Gap Lock 的组合，锁定一个范围，并且锁定记录本身。

> 间隙锁之间是兼容的，即两个事务可以同时持有包含共同间隙范围的间隙锁，并不存在互斥关系，因为间隙锁的目的是防止插入幻影记录而提出的。

> 加锁的对象是索引，加锁的基本单位是 next-key lock，它是由记录锁和间隙锁组合而成，next-key lock 是前开后闭区间，而间隙锁是前开后开区间。

> 在能使用记录锁或者间隙锁就能避免幻读现象的场景下，next-key lock 就会退化成记录锁或间隙锁。

> 如果 LOCK_MODE 为 X，说明是 next-key 锁；如果 LOCK_MODE 为 X, REC_NOT_GAP，说明是记录锁；如果 LOCK_MODE 为 X, GAP，说明是间隙锁。

> 如果是用二级索引进行锁定读查询的时候，除了会对二级索引项加行级锁，而且还会对查询到的记录的主键索引项上加「记录锁」。

> 当查询的记录是「存在」的，在索引树上定位到这一条记录后，该记录的索引中的 next-key lock 会退化成「记录锁」。

> 当查询的记录是「不存在」的，在索引树找到第一条大于该查询记录的记录后，该记录的索引中的 next-key lock 会退化成「间隙锁」。

> select * from performance_schema.data_locks\G;

> 因此，事务 A 在 id = 5 记录的主键索引上加的是间隙锁，锁住的范围是 (1, 5)。

> 针对「大于等于」条件的唯一索引范围查询的情况下，如果条件值的记录存在于表中，那么由于查询该条件值的记录是包含一个等值查询的操作，所以该记录的索引中的 next-key 锁会退化成记录锁。

> 针对「小于或者小于等于」的唯一索引范围查询，如果条件值的记录不在表中，那么不管是「小于」还是「小于等于」的范围查询，扫描到终止范围查询的记录时，该记录中索引的 next-key 锁会退化成间隙锁，其他扫描的记录，则是在这些记录的索引上加 next-key 锁。

## MySQL 是怎么加锁的？ | 小林coding / 可以怎么用

<!-- knowledge-block: block-006-005 -->
- block_id: `block-006-005`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p5`
- keywords: MySQL, InnoDB, 索引, 二级索引, 事务, 锁, record lock, 幻读, 隔离级别, SQL, coding, 是怎么加锁的, 小林, 可以怎么用

### Evidence

## 可以怎么用

- 排查 SELECT ... FOR UPDATE 或 UPDATE、DELETE 的阻塞时，先确认表使用 InnoDB，再在事务未提交期间执行 select * from performance_schema.data_locks\G;，结合 LOCK_TYPE、LOCK_MODE 和 LOCK_DATA 判断实际锁型与范围。
- 分析唯一索引等值查询时，先判断目标记录是否存在：存在通常只锁记录本身，不存在则锁住目标值所在的索引间隙，阻止其他事务插入该值。
- 设计需要防止幻读的范围更新或锁定读时，应同时考虑记录本身和记录前面的间隙，不能只依据返回结果判断锁范围。
- 使用二级索引进行锁定读时，要同时检查二级索引和主键索引上的锁，否则可能低估锁数量、锁冲突和并发影响。
- 判断 LOCK_MODE 时，将 X 视为 next-key 锁、X, REC_NOT_GAP 视为记录锁、X, GAP 视为间隙锁；LOCK_TYPE=RECORD 表示索引记录相关的行级锁，不等同于一定是 Record Lock。
- 遇到范围查询加锁异常时，分别判断查询方向（大于或小于）、是否包含等号、边界记录是否存在，以及扫描是否到达 supremum pseudo-record。
- 通过事务实验验证锁行为时，使用 begin 开启事务，并在观察完锁冲突后执行 commit 或 rollback 释放锁；否则锁会持续到事务结束。
- 将本文结论用于生产排障前，应核对实际 MySQL 版本和隔离级别，因为不同版本的加锁规则可能存在差异。

## MySQL 是怎么加锁的？ | 小林coding / 复习问题

<!-- knowledge-block: block-006-006 -->
- block_id: `block-006-006`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p6`
- keywords: MySQL, InnoDB, 索引, 二级索引, 锁, next-key lock, gap lock, record lock, SQL, coding, 是怎么加锁的, 小林, 复习问题

### Evidence

## 复习问题

- InnoDB 中 Record Lock、Gap Lock 和 Next-Key Lock 分别锁定什么范围？
- 为什么唯一索引等值查询记录存在时 next-key lock 会退化为记录锁？
- 为什么唯一索引等值查询记录不存在时会对第一条大于目标值的记录加间隙锁？
- 如何通过 performance_schema.data_locks 的 LOCK_MODE 判断是 next-key 锁、记录锁还是间隙锁？
- 对二级索引执行 SELECT ... FOR UPDATE 时，为什么二级索引和主键索引都可能加锁？
- 唯一索引范围查询中，id > 15、id >= 15、id < 5 和 id <= 5 的加锁范围有什么区别？

## MySQL 是怎么加锁的？ | 小林coding / 配图

<!-- knowledge-block: block-006-007 -->
- block_id: `block-006-007`
- paragraph_id: `2b16dedb1e971660075751e0384865bd55a28bdc:p7`
- keywords: MySQL, 锁, SQL, coding, 是怎么加锁的, 小林, 配图

### Evidence

## 配图

![img](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E8%AE%B0%E5%BD%95%E9%94%81.drawio.png)
![img](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E5%94%AF%E4%B8%80%E7%B4%A2%E5%BC%95%E8%AE%B0%E5%BD%95%E9%94%81.drawio.png)
![img](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E5%94%AF%E4%B8%80%E7%B4%A2%E5%BC%95%E9%97%B4%E9%9A%99%E9%94%81.drawio.png)
![img](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E5%94%AF%E4%B8%80%E7%B4%A2%E5%BC%95%E8%8C%83%E5%9B%B4%E6%9F%A5%E8%AF%A2%E5%A4%A7%E4%BA%8E15.drawio.png)
![img](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E5%94%AF%E4%B8%80%E7%B4%A2%E5%BC%95%E8%8C%83%E5%9B%B4%E6%9F%A5%E8%AF%A2%E5%B0%8F%E4%BA%8E%E7%AD%89%E4%BA%8E5.drawio.png)
