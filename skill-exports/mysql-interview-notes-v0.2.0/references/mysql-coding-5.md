# MySQL 有哪些锁？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:39+08:00`

## MySQL 有哪些锁？ | 小林coding

<!-- knowledge-block: block-007-000 -->
- block_id: `block-007-000`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p0`
- keywords: MySQL, 锁, SQL, coding, 有哪些锁, 小林

### Evidence

---
source: tabkeep
title: "MySQL 有哪些锁？ | 小林coding"
url: "https://xiaolincoding.com/mysql/lock/mysql_lock.html#%E5%85%A8%E5%B1%80%E9%94%81"
saved_at: "2026-09-06T08:13:38+08:00"
mode: "summary"
---

## MySQL 有哪些锁？ | 小林coding

<!-- knowledge-block: block-007-001 -->
- block_id: `block-007-001`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p1`
- keywords: MySQL, 锁, SQL, coding, 有哪些锁, 小林

### Evidence

# MySQL 有哪些锁？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/lock/mysql_lock.html#%E5%85%A8%E5%B1%80%E9%94%81
- 收藏时间：2026-09-06T08:13:38+08:00

---

## MySQL 有哪些锁？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-007-002 -->
- block_id: `block-007-002`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p2`
- keywords: MySQL, InnoDB, 锁, SQL, coding, 有哪些锁, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

本文系统梳理 MySQL 按加锁范围划分的全局锁、表级锁和行级锁，说明各类锁的使用方式、冲突关系、释放时机及适用场景。重点解决全库备份如何保证一致性、MDL 导致的阻塞、InnoDB 行锁与间隙锁如何防止并发问题，以及 AUTO_INCREMENT 在主从复制中的一致性风险。来源：https://xiaolincoding.com/mysql/lock/mysql_lock.html#%E5%85%A8%E5%B1%80%E9%94%81

## MySQL 有哪些锁？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-007-003 -->
- block_id: `block-007-003`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p3`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, gap lock, record lock, MVCC, 快照读, 死锁, SQL, binlog, coding, 有哪些锁, 小林, 可回看摘要

### Evidence

## 可回看摘要

MySQL 的锁按范围分为全局锁、表级锁和行级锁。全局锁通过 flush tables with read lock 将整个数据库置为只读，适合不支持事务的存储引擎进行全库逻辑备份，但会阻塞业务写入；支持可重复读和 MVCC 的 InnoDB 更适合使用 mysqldump --single-transaction，通过事务创建 Read View 实现备份期间的一致性读。表级锁包括普通表锁、MDL、意向锁和 AUTO-INC 锁：表锁粒度大，会降低并发；MDL 在 CRUD 和表结构变更时自动加锁，并通常在事务提交后释放，长事务可能导致 DDL 阻塞并进一步阻塞后续查询；意向锁用于快速判断表内是否存在行锁；AUTO-INC 锁用于生成自增值，innodb_autoinc_lock_mode=2 并配合 binlog_format=row 可兼顾并发性能和主从一致性。InnoDB 支持行级锁，普通 SELECT 通常是无锁的 MVCC 快照读，SELECT ... FOR UPDATE 和 SELECT ... LOCK IN SHARE MODE 属于锁定读。行锁包括 Record Lock、Gap Lock 和 Next-Key Lock，分别用于锁定记录、阻止范围内插入以及同时保护记录和间隙；插入意向锁是等待插入时产生的特殊行级间隙锁。使用锁定读时必须注意事务边界、长事务、锁等待和死锁风险。

## MySQL 有哪些锁？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-007-004 -->
- block_id: `block-007-004`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p4`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, gap lock, record lock, 幻读, 隔离级别, MVCC, SQL, binlog, coding, 有哪些锁, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 在 MySQL 里，根据加锁的范围，可以分为全局锁、表级锁和行锁三类。

> flush tables with read lock

> 执行后，整个数据库就处于只读状态了

> 全局锁主要应用于做全库逻辑备份，这样在备份数据库期间，不会因为数据或表结构的更新，而出现备份文件的数据与预期的不一样。

> 如果数据库的引擎支持的事务支持可重复读的隔离级别，那么在备份数据库之前先开启事务，会先创建 Read View，然后整个事务执行期间都在用这个 Read View，而且由于 MVCC 的支持，备份期间业务依然可以对数据进行更新操作。

> 在使用 mysqldump 时加上 `–single-transaction` 参数的时候，就会在备份数据库之前先开启事务。

> 这种方法只适用于支持「可重复读隔离级别的事务」的存储引擎。

> MySQL 里面表级别的锁有这几种：表锁；元数据锁（MDL）；意向锁；AUTO-INC 锁；

> 对一张表进行 CRUD 操作时，加的是 MDL 读锁；对一张表做结构变更操作的时候，加的是 MDL 写锁；

> MDL 是在事务提交后才会释放，这意味着事务执行期间，MDL 是一直持有的。

> 申请 MDL 锁的操作会形成一个队列，队列中写锁获取优先级高于读锁，一旦出现 MDL 写锁等待，会阻塞后续该表的所有 CRUD 操作。

> 所以，意向锁的目的是为了快速判断表里是否有记录被加锁。

> 当 innodb_autoinc_lock_mode = 2 时，并且 binlog_format = row，既能提升并发性，又不会出现数据一致性问题。

> 普通的 select 语句是利用 MVCC 实现一致性读，是无锁的。

> select ... lock in mode; select ... for update;

> 行级锁的类型主要有三类：Record Lock，记录锁，也就是仅仅把一条记录锁上；Gap Lock，间隙锁，锁定一个范围，但是不包含记录本身；Next-Key Lock：Record Lock + Gap Lock 的组合，锁定一个范围，并且锁定记录本身。

> Gap Lock 称为间隙锁，存在于可重复读隔离级别和串行化隔离级别，目的是为了解决可重复读隔离级别下幻读的现象。

> 间隙锁之间是兼容的，即两个事务可以同时持有包含共同间隙范围的间隙锁，并不存在互斥关系，因为间隙锁的目的是防止插入幻影记录而提出的。

> 插入意向锁名字虽然有意向锁，但是它并不是意向锁，它是一种特殊的间隙锁，属于行级别锁。

## MySQL 有哪些锁？ | 小林coding / 可以怎么用

<!-- knowledge-block: block-007-005 -->
- block_id: `block-007-005`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p5`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, gap lock, record lock, 幻读, MVCC, SQL, binlog, coding, 有哪些锁, 小林, 可以怎么用

### Evidence

## 可以怎么用

- 使用 InnoDB 做全库逻辑备份时，优先使用 mysqldump --single-transaction，利用可重复读和 MVCC 避免长时间阻塞业务写入；如果是 MyISAM 等不支持事务的引擎，则需要考虑全局锁。
- 执行 ALTER TABLE、DROP TABLE 等 DDL 前，先排查并处理长事务，因为长事务持有的 MDL 读锁可能阻塞 DDL，并由于写锁优先级更高而进一步阻塞后续查询。
- 在 InnoDB 表上尽量避免手动使用大粒度表锁，优先依赖行级锁，以减少并发事务之间的相互阻塞。
- 需要读取后继续修改某些记录时，在事务中使用 SELECT ... FOR UPDATE；只需要并发共享读取时可使用 SELECT ... LOCK IN SHARE MODE，并在事务提交前完成后续操作。
- 分析范围查询的幻读和插入阻塞时，区分 Record Lock、Gap Lock 和 Next-Key Lock：只保护记录用记录锁，阻止范围插入用间隙锁，同时保护记录和前置间隙用临键锁。
- 配置 innodb_autoinc_lock_mode=2 提升批量插入并发性时，应同时使用 binlog_format=row，避免 statement 格式在主从并行插入场景下产生自增值不一致。
- 排查锁等待时，要区分真正持有的锁和等待中的锁：MySQL 可能先生成锁结构，再将状态设置为等待，等待状态不代表事务已经成功获取锁。
- 设计事务时应缩短事务持续时间，及时提交或回滚，避免长期持有 MDL、行锁或间隙锁，造成连接堆积和业务雪崩。

## MySQL 有哪些锁？ | 小林coding / 复习问题

<!-- knowledge-block: block-007-006 -->
- block_id: `block-007-006`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p6`
- keywords: MySQL, InnoDB, 事务, 锁, next-key lock, gap lock, record lock, 幻读, SQL, binlog, coding, 有哪些锁, 小林, 复习问题

### Evidence

## 复习问题

- MySQL 全局锁 flush tables with read lock 如何保证全库逻辑备份一致性？
- mysqldump --single-transaction 为什么能在备份期间不阻塞 InnoDB 的业务更新？
- MySQL MDL 读锁和写锁分别在什么操作中产生，为什么长事务会导致后续查询阻塞？
- InnoDB 意向共享锁和意向独占锁的作用是什么，为什么可以避免遍历整张表检查行锁？
- Record Lock、Gap Lock 和 Next-Key Lock 有什么区别，间隙锁如何防止可重复读下的幻读？
- innodb_autoinc_lock_mode=2 配合 binlog_format=statement 为什么会导致主从数据不一致，如何解决？

## MySQL 有哪些锁？ | 小林coding / 配图

<!-- knowledge-block: block-007-007 -->
- block_id: `block-007-007`
- paragraph_id: `f3638ecba090ec006d06e18facb1d65e7c5ce810:p7`
- keywords: MySQL, InnoDB, 锁, SQL, coding, 有哪些锁, 小林, 配图

### Evidence

## 配图

![](https://cdn.xiaolincoding.com//mysql/other/1e37f6994ef44714aba03b8046b1ace2.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/innodb_autoinc_lock_mode=2.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/x%E9%94%81%E5%92%8Cs%E9%94%81.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/gap%E9%94%81.drawio.png)
![](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/%E9%94%81/%E4%B8%B4%E9%94%AE%E9%94%81.drawio.png)
