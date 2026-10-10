# 图解MySQL介绍 | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:37+08:00`

## 图解MySQL介绍 | 小林coding

<!-- knowledge-block: block-009-000 -->
- block_id: `block-009-000`
- paragraph_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9:p0`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林

### Evidence

---
source: tabkeep
title: "图解MySQL介绍 | 小林coding"
url: "https://xiaolincoding.com/mysql/#%E9%80%82%E5%90%88%E4%BB%80%E4%B9%88%E7%BE%A4%E4%BD%93"
saved_at: "2026-09-05T11:53:12+08:00"
mode: "full"
---

## 图解MySQL介绍 | 小林coding

<!-- knowledge-block: block-009-001 -->
- block_id: `block-009-001`
- paragraph_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9:p1`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林

### Evidence

# 图解MySQL介绍 | 小林coding

- 来源：https://xiaolincoding.com/mysql/#%E9%80%82%E5%90%88%E4%BB%80%E4%B9%88%E7%BE%A4%E4%BD%93
- 收藏时间：2026-09-05T11:53:12+08:00

---

[![](https://cdn.xiaolincoding.com//picgo/564e5be42c5d02d7c7628c6b4c16b302.png)](https://www.xiaolincoding.com/other/sijiao_offer.html)

大家好，我是小林。

我是《 [图解MySQL](https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzUxODAzNDg4NQ==&action=getalbum&album_id=1955634887135199237#wechat_redirect) 》的作者，这是一份 **专注 MySQL 学习与面试的开源资料** ，内容都是整理于我的 [公众号](https://mp.weixin.qq.com/s/FYH1I8CRsuXDSybSGY_AFA) 里的图解MySQL的文章。

简单介绍下《 [图解MySQL](https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzUxODAzNDg4NQ==&action=getalbum&album_id=1955634887135199237#wechat_redirect) 》，整个内容共有 **`20W` 字 + `320` 张图** ，每一篇都自己手绘了很多图，目的也很简单，想通过「说人话+图解」的方式，让你轻松掌握 MySQL 的核心知识。

## 图解MySQL介绍 | 小林coding / 适合什么群体？

<!-- knowledge-block: block-009-002 -->
- block_id: `block-009-002`
- paragraph_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9:p2`
- keywords: MySQL, 索引, 事务, 锁, 幻读, 隔离级别, SQL, redo log, undo log, binlog, coding, 图解, 介绍, 小林, 适合什么群体

### Evidence

## 适合什么群体？

《图解MySQL》写的 MySQL 知识主要是 **面向后端开发和 DBA** 的，因为小林本身也是个后端开发，所以涉及到的知识主要是关于日常开发或者面试的 MySQL 知识。

非常适合有一点 MySQL 基础，但是又不怎么扎实，或者知识点串不起来的同学，说白 **这本图解MySQL就是为了拯救半桶水的同学而出来的** 。

因为小林写的图解MySQL就四个字， **通俗易懂** ！

相信你在看这本图解MySQL的时候，你心里的感受会是：

-   「卧槽，索引原理原来是这样的」
-   「卧槽，事务和锁的关系我终于搞懂了」
-   「卧槽，MySQL 日志我串起来了」
-   「卧槽，相见恨晚」

当然，也适合面试突击 MySQL 知识时拿来看。图解MySQL里的内容基本是面试常见的知识点，比如索引、事务、锁、日志等等，也有很多面试常问的问题，比如：

-   为什么 MySQL 要用 B+ 树作为索引？
-   索引什么时候会失效？
-   事务的隔离级别是怎么实现的？
-   MySQL 可重复读隔离级别完全解决幻读了吗？
-   MySQL 有哪些锁？是怎么加锁的？
-   update 没加索引会锁全表吗？
-   redo log、undo log、binlog 有什么用？
-   ….

不敢说 100 % 涵盖了面试的 MySQL 问题，但是至少 90% 是有的，而且内容的深度应对大厂也是绰绰有余，有非常多的读者跑来感激小林的图解MySQL，帮助他们拿到了国内很多一线大厂的 offer。

## 图解MySQL介绍 | 小林coding / 要怎么阅读？

<!-- knowledge-block: block-009-003 -->
- block_id: `block-009-003`
- paragraph_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9:p3`
- keywords: MySQL, 索引, 事务, 幻读, 隔离级别, MVCC, 分页, SQL, coding, 图解, 介绍, 小林, 要怎么阅读

### Evidence

## 要怎么阅读？

很诚恳的告诉你，《图解MySQL》不是教科书，而是我写的图解MySQL文章的整合，所以肯定是没有教科书那么细致和全面，当然也就不会有很多废话，都是直击重点，不绕弯，而且有的知识点书上看不到。

阅读的顺序可以不用从头读到尾，你可以根据你想要了解的知识点，通过本站的搜索功能，去看哪个章节的内容就好，可以随意阅读任何章节。

《图解MySQL》目录结构如下（别看篇章不多，每一章都是很长很长的文章哦 😆）：

-   **基础篇** 👇
    -   🔥 [执行一条 SQL 查询语句，期间发生了什么？](https://xiaolincoding.com/mysql/base/how_select.html)
    -   [MySQL 一行记录是怎么存储的？](https://xiaolincoding.com/mysql/base/row_format.html)
-   **索引篇** 👇
    -   🔥 [索引常见面试题](https://xiaolincoding.com/mysql/index/index_interview.html)
    -   [从数据页的角度看 B+ 树](https://xiaolincoding.com/mysql/index/page.html)
    -   🔥 [为什么 MySQL 采用 B+ 树作为索引？](https://xiaolincoding.com/mysql/index/why_index_chose_bpuls_tree.html)
    -   [MySQL 单表不要超过 2000W 行，靠谱吗？](https://xiaolincoding.com/mysql/index/2000w.html)
    -   🔥 [索引失效有哪些？](https://xiaolincoding.com/mysql/index/index_lose.html)
    -   [count(\*) 和 count(1) 有什么区别？哪个性能最好？](https://xiaolincoding.com/mysql/index/count.html)
    -   [MySQL 分页有什么性能问题？怎么优化？](https://xiaolincoding.com/mysql/index/limit.html)
-   **事务篇** 👇
    -   🔥 [事务隔离级别是怎么实现的？](https://xiaolincoding.com/mysql/transaction/mvcc.html)
    -   [MySQL 可重复读隔离级别，完全解决幻读了吗？](https://xiaolincoding.com/mysql/transaction/phantom.html)
-   **锁篇** 👇
    -   🔥 [MySQL 有哪些锁？](https://xiaolincoding.com/mysql/lock/mysql_lock.html)
    -   [MySQL 是怎么加锁的？](https://xiaolincoding.com/mysql/lock/how_to_lock.html)
    -   [update 没加索引会锁全表?](https://xiaolincoding.com/mysql/lock/update_index.html)
    -   [MySQL 记录锁+间隙锁可以防止删除操作而导致的幻读吗？](https://xiaolincoding.com/mysql/lock/lock_phantom.html)
    -   [MySQL 死锁了，怎么办？](https://xiaolincoding.com/mysql/lock/deadlock.html)
    -   [字节面试：加了什么锁，导致死锁的？](https://xiaolincoding.com/mysql/lock/show_lock.html)
-   **日志篇** 👇
    -   🔥 [undo log、redo log、binlog 有什么用？](https://xiaolincoding.com/mysql/log/how_update.html)
-   **内存篇** 👇
    -   [揭开 Buffer\_Pool 的面纱](https://xiaolincoding.com/mysql/buffer_pool/buffer_pool.html)
-   **架构篇** 👇
    -   [MySQL的架构是怎样的？](https://xiaolincoding.com/mysql/architecture/mysql_architecture.html)

## 图解MySQL介绍 | 小林coding / 有错误怎么办？

<!-- knowledge-block: block-009-004 -->
- block_id: `block-009-004`
- paragraph_id: `533a18e1258bc8aefa5207ba16974a8087daa2f9:p4`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林, 有错误怎么办

### Evidence

## 有错误怎么办？

小林是个手残党，时常写出错别字。

如果你在学习的过程中， **如果你发现有任何错误或者疑惑的地方，欢迎你通过以下方式给我反馈** ：

-   👍登记飞书表格： [小林图解网站问题反馈登记](https://icnaxnmh86kx.feishu.cn/share/base/form/shrcneQ2yqySZ7s74EfiVKFDdwv) （推荐）

小林抽时间会逐个修正，然后发布新版本的图解MySQL，一起迭代出更好的图解MySQL！

* * *

新的图解文章都在公众号首发，别忘记关注了哦！如果你想加入百人技术交流群，扫码下方二维码回复「加群」。

![](https://cdn.xiaolincoding.com/gh/xiaolincoder/ImageHost3@main/%E5%85%B6%E4%BB%96/%E5%85%AC%E4%BC%97%E5%8F%B7%E4%BB%8B%E7%BB%8D.png)

登录后查看评论
