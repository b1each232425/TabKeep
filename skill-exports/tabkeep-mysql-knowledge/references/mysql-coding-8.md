# 图解MySQL介绍 | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `a2d54c99bd712227397f9f01df84d01014b577ff`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:37+08:00`

## 图解MySQL介绍 | 小林coding

<!-- knowledge-block: block-010-000 -->
- block_id: `block-010-000`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p0`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林

### Evidence

---
source: tabkeep
title: "图解MySQL介绍 | 小林coding"
url: "https://xiaolincoding.com/mysql/#%E9%80%82%E5%90%88%E4%BB%80%E4%B9%88%E7%BE%A4%E4%BD%93"
saved_at: "2026-09-05T12:08:31+08:00"
mode: "summary"
---

## 图解MySQL介绍 | 小林coding

<!-- knowledge-block: block-010-001 -->
- block_id: `block-010-001`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p1`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林

### Evidence

# 图解MySQL介绍 | 小林coding

- 来源：https://xiaolincoding.com/mysql/#%E9%80%82%E5%90%88%E4%BB%80%E4%B9%88%E7%BE%A4%E4%BD%93
- 收藏时间：2026-09-05T12:08:31+08:00

---

## 图解MySQL介绍 | 小林coding / 这篇解决什么

<!-- knowledge-block: block-010-002 -->
- block_id: `block-010-002`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p2`
- keywords: MySQL, SQL, coding, 图解, 介绍, 小林, 这篇解决什么

### Evidence

## 这篇解决什么

这篇文章介绍《图解MySQL》这套面向后端开发和 DBA 的开源学习资料，解决 MySQL 基础不扎实、知识点难以串联以及面试复习缺少重点的问题。文章同时说明了资料的适用人群、阅读方式、内容目录和反馈渠道。

## 图解MySQL介绍 | 小林coding / 可回看摘要

<!-- knowledge-block: block-010-003 -->
- block_id: `block-010-003`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p3`
- keywords: MySQL, 索引, 事务, 锁, 幻读, 隔离级别, 死锁, SQL, Buffer Pool, redo log, undo log, binlog, coding, 图解, 介绍, 小林, 可回看摘要

### Evidence

## 可回看摘要

《图解MySQL》是小林整理自公众号文章的 MySQL 学习与面试资料，共 20W 字、320 张图，强调通过“说人话+图解”的方式讲解核心知识。内容主要面向后端开发和 DBA，适合有一定 MySQL 基础但掌握不扎实、需要系统串联知识点或进行面试突击的人群，覆盖 SQL 执行、行存储、索引、事务、锁、日志、Buffer Pool 和架构等主题。资料不是教科书，强调直击重点、少绕弯，支持通过站内搜索按需阅读，不必从头到尾学习。文章列出的问题包括 B+ 树索引原理、索引失效、事务隔离级别、幻读、锁、死锁以及 undo log、redo log、binlog 等。作者也说明资料并非 100% 覆盖所有面试问题，并欢迎读者反馈错误。来源 URL：https://xiaolincoding.com/mysql/#%E9%80%82%E5%90%88%E4%BB%80%E4%B9%88%E7%BE%A4%E4%BD%93

## 图解MySQL介绍 | 小林coding / 关键原文摘录

<!-- knowledge-block: block-010-004 -->
- block_id: `block-010-004`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p4`
- keywords: MySQL, 索引, 事务, 锁, 幻读, 隔离级别, SQL, redo log, undo log, binlog, coding, 图解, 介绍, 小林, 关键原文摘录

### Evidence

## 关键原文摘录

> 这是一份 **专注 MySQL 学习与面试的开源资料**

> 整个内容共有 **`20W` 字 + `320` 张图**，每一篇都自己手绘了很多图，目的也很简单，想通过「说人话+图解」的方式，让你轻松掌握 MySQL 的核心知识。

> 《图解MySQL》写的 MySQL 知识主要是 **面向后端开发和 DBA** 的

> 非常适合有一点 MySQL 基础，但是又不怎么扎实，或者知识点串不起来的同学，说白 **这本图解MySQL就是为了拯救半桶水的同学而出来的**。

> 当然，也适合面试突击 MySQL 知识时拿来看。图解MySQL里的内容基本是面试常见的知识点，比如索引、事务、锁、日志等等

> 为什么 MySQL 要用 B+ 树作为索引？

> 索引什么时候会失效？

> 事务的隔离级别是怎么实现的？

> MySQL 可重复读隔离级别完全解决幻读了吗？

> MySQL 有哪些锁？是怎么加锁的？

> update 没加索引会锁全表吗？

> redo log、undo log、binlog 有什么用？

> 不敢说 100 % 涵盖了面试的 MySQL 问题，但是至少 90% 是有的，而且内容的深度应对大厂也是绰绰有余

> 《图解MySQL》不是教科书，而是我写的图解MySQL文章的整合，所以肯定是没有教科书那么细致和全面，当然也就不会有很多废话，都是直击重点，不绕弯，而且有的知识点书上看不到。

> 阅读的顺序可以不用从头读到尾，你可以根据你想要了解的知识点，通过本站的搜索功能，去看哪个章节的内容就好，可以随意阅读任何章节。

## 图解MySQL介绍 | 小林coding / 以后可复用点

<!-- knowledge-block: block-010-005 -->
- block_id: `block-010-005`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p5`
- keywords: MySQL, 索引, 事务, 锁, 幻读, 隔离级别, SQL, Buffer Pool, coding, 图解, 介绍, 小林, 以后可复用点

### Evidence

## 以后可复用点

- 将《图解MySQL》作为 MySQL 面试复习索引，优先检索索引、事务、锁、日志等高频主题。
- 基础薄弱时，可按“SQL 执行流程 → 行记录存储 → 索引 → 事务 → 锁 → 日志 → Buffer Pool → 架构”建立知识地图。
- 遇到具体问题时采用按主题搜索、按需阅读的方式，不必线性读完整套资料。
- 用“B+ 树为什么适合作为索引、索引何时失效、隔离级别如何实现、幻读是否完全解决、update 是否锁全表、三种日志分别做什么”等问题作为 MySQL 面试自测清单。
- 将文章中的图解与源码、实验和 SQL 示例结合，用于补足教科书之外的直观理解；同时注意该资料不是完整教科书，不能替代系统性文档。
- 发现内容错误或疑惑时，可通过作者提供的反馈表提交问题，关注后续修订版本。

## 图解MySQL介绍 | 小林coding / 复习问题

<!-- knowledge-block: block-010-006 -->
- block_id: `block-010-006`
- paragraph_id: `a2d54c99bd712227397f9f01df84d01014b577ff:p6`
- keywords: MySQL, 索引, 事务, 锁, 幻读, 隔离级别, MVCC, SQL, redo log, undo log, binlog, coding, 图解, 介绍, 小林, 复习问题

### Evidence

## 复习问题

- 为什么 MySQL 采用 B+ 树作为索引？
- MySQL 索引失效有哪些常见场景？
- MySQL 事务隔离级别是如何通过 MVCC 实现的？
- MySQL 可重复读隔离级别是否完全解决了幻读？
- MySQL 有哪些锁，update 没加索引时是否会锁全表？
- undo log、redo log、binlog 分别有什么作用？
