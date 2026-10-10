# MySQL 一行记录是怎么存储的？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `aaf7f494785c1a50184273ab8286570d0009429b`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:35+08:00`

## MySQL 一行记录是怎么存储的？ | 小林coding

<!-- knowledge-block: block-001-000 -->
- block_id: `block-001-000`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p0`
- keywords: MySQL, SQL, coding, 一行记录是怎么存储的, 小林

### Evidence

---
source: tabkeep
title: "MySQL 一行记录是怎么存储的？ | 小林coding"
url: "https://xiaolincoding.com/mysql/base/row_format.html#mysql-%E7%9A%84%E6%95%B0%E6%8D%AE%E5%AD%98%E6%94%BE%E5%9C%A8%E5%93%AA%E4%B8%AA%E6%96%87%E4%BB%B6"
saved_at: "2026-09-05T15:38:10+08:00"
mode: "summary"
---

## MySQL 一行记录是怎么存储的？ | 小林coding

<!-- knowledge-block: block-001-001 -->
- block_id: `block-001-001`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p1`
- keywords: MySQL, SQL, coding, 一行记录是怎么存储的, 小林

### Evidence

# MySQL 一行记录是怎么存储的？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/base/row_format.html#mysql-%E7%9A%84%E6%95%B0%E6%8D%AE%E5%AD%98%E6%94%BE%E5%9C%A8%E5%93%AA%E4%B8%AA%E6%96%87%E4%BB%B6
- 收藏时间：2026-09-05T15:38:10+08:00

---

## MySQL 一行记录是怎么存储的？ | 小林coding / 这篇解决什么

<!-- knowledge-block: block-001-002 -->
- block_id: `block-001-002`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p2`
- keywords: MySQL, InnoDB, SQL, VARCHA, coding, 一行记录是怎么存储的, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

文章解释 InnoDB 中一行记录如何从数据库文件、表空间、页、区、段逐层组织，并重点拆解 Compact 行格式的存储结构。通过这些结构，回答 NULL 值如何存储、varchar(n) 如何计算实际空间、varchar(n) 的最大取值以及行溢出后的处理方式。来源：https://xiaolincoding.com/mysql/base/row_format.html#mysql-%E7%9A%84%E6%95%B0%E6%8D%AE%E5%AD%98%E6%94%BE%E5%9C%A8%E5%93%AA%E4%B8%AA%E6%96%87%E4%BB%B6

## MySQL 一行记录是怎么存储的？ | 小林coding / 可回看摘要

<!-- knowledge-block: block-001-003 -->
- block_id: `block-001-003`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p3`
- keywords: MySQL, InnoDB, SQL, VARCHA, TEXT, BLOB, coding, 一行记录是怎么存储的, 小林, 可回看摘要

### Evidence

## 可回看摘要

以 InnoDB 为例，MySQL 数据目录可通过 SHOW VARIABLES LIKE 'datadir' 查询；表数据通常位于表名.ibd 独占表空间文件中，表空间由段、区、页、行组成。InnoDB 默认以 16KB 的页作为磁盘读写和管理的最小单位；区大小为 1MB，通常由连续 64 个 16KB 页组成，用于改善 B+ 树范围扫描的顺序 I/O。InnoDB 有 Redundant、Compact、Dynamic、Compressed 四种行格式，文章重点介绍 Compact。Compact 一行记录由记录额外信息和记录真实数据组成：额外信息包括变长字段长度列表、NULL 值列表和记录头信息；真实数据除用户字段外，还可能包含 row_id、trx_id、roll_pointer 三个隐藏字段。变长字段长度列表记录 VARCHAR、TEXT、BLOB 等字段实际占用的字节数，并按列顺序逆序存储；NULL 值通过 NULL 值列表的 bit 标记，不进入真实数据部分。若所有字段都是 NOT NULL，则可省略 NULL 值列表；若没有变长字段，则可省略变长字段长度列表。除 TEXT、BLOB 等大对象类型外，一行记录的字段长度、变长字段长度列表和 NULL 值列表总和不能超过 65535 字节。单个允许 NULL 的 ascii 字符集 VARCHAR 字段最大可定义为 VARCHAR(65532)，计算为 65535 - 2 字节变长字段长度列表 - 1 字节 NULL 值列表。记录超过数据页容纳能力时会发生行溢出：Compact 会在行内保留部分数据并用 20 字节指针指向溢出页；Dynamic 和 Compressed 则只在行内保存 20 字节指针，实际列数据全部放到溢出页。

## MySQL 一行记录是怎么存储的？ | 小林coding / 关键原文摘录

<!-- knowledge-block: block-001-004 -->
- block_id: `block-001-004`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p4`
- keywords: MySQL, InnoDB, B+树, SQL, VARCHA, TEXT, BLOB, coding, 一行记录是怎么存储的, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 表空间由段（segment）、区（extent）、页（page）、行（row）组成

> InnoDB 的数据是按「页」为单位来读写的

> 默认每个页的大小为 16KB

> 每个区的大小为 1MB，对于 16KB 的页来说，连续的 64 个页会被划为一个区，这样就使得链表中相邻的页的物理位置也相邻，就能使用顺序 I/O 了

> InnoDB 提供了 4 种行格式，分别是 Redundant、Compact、Dynamic和 Compressed 行格式

> 可以看到，一条完整的记录分为「记录的额外信息」和「记录的真实数据」两个部分。

> 记录的额外信息包含 3 个部分：变长字段长度列表、NULL 值列表、记录头信息。

> 这些变长字段的真实数据占用的字节数会按照列的顺序逆序存放

> NULL 是不会存放在行格式中记录的真实数据部分里的，所以「变长字段长度列表」里不需要保存值为 NULL 的变长字段的长度。

> 当数据表没有变长字段的时候，比如全部都是 int 类型的字段，这时候表里的行格式就不会有「变长字段长度列表」了

> 如果存在允许 NULL 值的列，则每个列对应一个二进制位（bit），二进制位按照列的顺序逆序排列。

> 二进制位的值为 `1` 时，代表该列的值为NULL；二进制位的值为 `0` 时，代表该列的值不为NULL。

> 当数据表的字段都定义成 NOT NULL 的时候，这时候表里的行格式就不会有 NULL 值列表了

> delete_mask ：标识此条数据是否被删除。从这里可以知道，我们执行 detele 删除记录的时候，并不会真正的删除记录，只是将这个记录的 delete_mask 标记为 1。

> next_record：下一条记录的位置。从这里可以知道，记录与记录之间是通过链表组织的。

> record_type：表示当前记录的类型，0表示普通记录，1表示B+树非叶子节点记录，2表示最小记录，3表示最大记录

> row_id不是必需的，占用 6 个字节。trx_id是必需的，占用 6 个字节。roll_pointer 是必需的，占用 7 个字节。

> MySQL 规定除了 TEXT、BLOBs 这种大对象类型之外，其他所有的列（不包括隐藏列和记录头信息）占用的字节长度加起来不能超过 65535 个字节。

> 如果一张表只有一个 varchar(n) 字段，且允许为 NULL，字符集为 ascii。varchar(n) 中 n 最大取值为 65532。

> 计算公式：65535 - 变长字段字节数列表所占用的字节数 - NULL值列表所占用的字节数 = 65535 - 2 - 1 = 65532。

> 如果一个数据页存不了一条记录，InnoDB 存储引擎会自动将溢出的数据存放到「溢出页」中。

> Compressed 和 Dynamic 这两种格式采用完全的行溢出方式，记录的真实数据处不会存储该列的一部分数据，只存储 20 个字节的指针来指向溢出页。

## MySQL 一行记录是怎么存储的？ | 小林coding / 以后可复用点

<!-- knowledge-block: block-001-005 -->
- block_id: `block-001-005`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p5`
- keywords: MySQL, InnoDB, MVCC, SQL, VARCHA, TEXT, BLOB, coding, 一行记录是怎么存储的, 小林, 以后可复用点

### Evidence

## 以后可复用点

- 排查 MySQL 数据文件位置时，先执行 SHOW VARIABLES LIKE 'datadir';，再根据数据库目录和表名定位表空间文件。
- 解释 InnoDB 存储层次时，可以按“表空间 → 段 → 区 → 页 → 行”的顺序展开，并强调默认页大小 16KB、区大小 1MB。
- 分析 Compact 行记录时，按“变长字段长度列表 → NULL 值列表 → 记录头信息 → 隐藏字段和用户字段”的顺序检查。
- 计算 VARCHAR(n) 的上限时，不要只看字符数；需要结合字符集的最大字节数，并扣除变长字段长度列表和 NULL 值列表的空间。
- 设计表结构时，若业务允许，应将字段定义为 NOT NULL，以省略 NULL 值列表并减少至少 1 字节的行存储开销。
- 遇到大 VARCHAR、TEXT 或 BLOB 导致行溢出时，应区分 Compact 与 Dynamic/Compressed 的溢出策略，并关注额外溢出页访问成本。
- 面试回答 MySQL NULL、varchar(n) 上限、行溢出和一行记录结构问题时，可以用同一个核心知识点——InnoDB 行格式——串联回答。
- 复习 MVCC 时，可将 trx_id 和 roll_pointer 与回滚段、历史版本链结合起来理解。

## MySQL 一行记录是怎么存储的？ | 小林coding / 复习问题

<!-- knowledge-block: block-001-006 -->
- block_id: `block-001-006`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p6`
- keywords: MySQL, InnoDB, SQL, VARCHA, coding, 一行记录是怎么存储的, 小林, 复习问题

### Evidence

## 复习问题

- InnoDB 表空间由段、区、页、行如何组成？默认页大小和区大小分别是多少？
- Compact 行格式的一条记录由哪些部分组成？变长字段长度列表、NULL 值列表和记录头信息分别有什么作用？
- MySQL Compact 行格式如何存储 NULL 值？为什么 NOT NULL 字段可以省略 NULL 值列表？
- 为什么变长字段长度列表和 NULL 值列表要按照列顺序逆序存放？
- varchar(n) 中 n 的最大取值如何根据 65535 字节限制、字符集、变长字段长度列表和 NULL 值列表计算？为什么 ascii 单字段允许 NULL 的例子中最大值是 65532？
- Compact、Dynamic 和 Compressed 行格式发生行溢出时分别如何处理？20 字节指针指向什么？

## MySQL 一行记录是怎么存储的？ | 小林coding / 配图

<!-- knowledge-block: block-001-007 -->
- block_id: `block-001-007`
- paragraph_id: `aaf7f494785c1a50184273ab8286570d0009429b:p7`
- keywords: MySQL, SQL, coding, 一行记录是怎么存储的, 小林, 配图

### Evidence

## 配图

![表空间结构](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/row_format/%E8%A1%A8%E7%A9%BA%E9%97%B4%E7%BB%93%E6%9E%84.drawio.png)
![COMPACT 行格式](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/row_format/COMPACT.drawio.png)
![记录的真实数据](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/row_format/%E8%AE%B0%E5%BD%95%E7%9A%84%E7%9C%9F%E5%AE%9E%E6%95%B0%E6%8D%AE.png)
![行溢出](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/row_format/%E8%A1%8C%E6%BA%A2%E5%87%BA.png)
![Dynamic 和 Compressed 行溢出](https://cdn.xiaolincoding.com/gh/xiaolincoder/mysql/row_format/%E8%A1%8C%E6%BA%A2%E5%87%BA2.png)
