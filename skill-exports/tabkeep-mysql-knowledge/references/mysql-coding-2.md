# MySQL 分页有什么性能问题？怎么优化？ | 小林coding

> 本文件由 TabKeep 导出为独立 Skill 参考资料；内容可脱离 TabKeep 使用。

- source_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e`
- source_type: `markdown`
- source_updated_at: `2026-09-06T10:58:35+08:00`

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding

<!-- knowledge-block: block-002-000 -->
- block_id: `block-002-000`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p0`
- keywords: MySQL, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林

### Evidence

---
source: tabkeep
title: "MySQL 分页有什么性能问题？怎么优化？ | 小林coding"
url: "https://xiaolincoding.com/mysql/index/limit.html"
saved_at: "2026-09-05T17:04:39+08:00"
mode: "full"
---

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding

<!-- knowledge-block: block-002-001 -->
- block_id: `block-002-001`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p1`
- keywords: MySQL, 索引, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林

### Evidence

# MySQL 分页有什么性能问题？怎么优化？ | 小林coding

- 来源：https://xiaolincoding.com/mysql/index/limit.html
- 收藏时间：2026-09-05T17:04:39+08:00

---

大家好，我是小林。

最近有同学面试字节三面的时候，被问到：“ **MySQL 分页有什么性能问题？怎么优化？** ”

![](https://cdn.xiaolincoding.com//picgo/d0aa1f97166316667ea484cd51a94eee.jpeg)

今天就主要围绕这个问题跟大家说一下 MySQL 分页问题和优化的思路。

> 原文地址： [字节三面：MySQL 分页怎么优化啊？](https://mp.weixin.qq.com/s/i6FL1iRECiWZ1CCf_juxQQ)

我们刷网站的时候，我们经常会遇到需要分页查询的场景。

比如下图红框里的翻页功能。

![图片](https://cdn.xiaolincoding.com//picgo/361faa6c1f37457a96f6a47131152c02.png)

我们很容易能联想到可以用mysql实现。

假设我们的建表sql是这样的

建表sql大家也不用扣细节，只需要知道 **id是主键，并且在user\_name建了个非主键索引** 就够了，其他都不重要。

为了实现分页。

很容易联想到下面这样的sql语句。

```
select * from page order by id limit offset, size;
```

比如一页有10条数据。

第一页就是下面这样的sql语句。

```
select * from page order by id limit 0, 10;
```

第一百页就是

```
select * from page order by id limit 990, 10;
```

那么问题来了。

用这种方式， **同样都是拿10条数据，查第一页和第一百页的查询速度是一样的吗？为什么？**

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 两种limit的执行过程

<!-- knowledge-block: block-002-002 -->
- block_id: `block-002-002`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p2`
- keywords: MySQL, InnoDB, B+树, 索引, 回表, 分页, SQL, coding, limit, 分页有什么性能问题, 怎么优化, 小林, 两种, 的执行过程

### Evidence

## 两种limit的执行过程

上面的两种查询方式。对应 `limit offset, size` 和 `limit size` 两种方式。

而其实 `limit size` ，相当于 `limit 0, size` 。也就是从0开始取size条数据。

也就是说，两种方式的 **区别在于offset是否为0。**

我们先来看下limit sql的内部执行逻辑。

mysql内部分为 **server层** 和 **存储引擎层** 。一般情况下存储引擎都用innodb。

server层有很多模块，其中需要关注的是 **执行器** 是用于跟存储引擎打交道的组件。

执行器可以通过调用存储引擎提供的接口，将一行行数据取出，当这些数据完全符合要求（比如满足其他where条件），则会放到 **结果集** 中，最后返回给调用mysql的 **客户端（go、java写的应用程序）** 。

我们可以对下面的sql先执行下 `explain` 。

```
explain select * from page order by id limit 0, 10;
```

可以看到，explain中提示 key 那里，执行的是 **PRIMARY** ，也就是走的 **主键索引** 。

![](https://cdn.xiaolincoding.com//picgo/3053b90d0d6ac66e32309af0d0fcf8e7.png)

主键索引本质是一棵B+树，它是放在innodb中的一个数据结构。

我们可以回忆下，B+树大概长这样。

![](https://cdn.xiaolincoding.com//picgo/6a7feb26fedf7326fba4384efd8aca18.png)

在这个树状结构里，我们需要关注的是，最下面一层节点，也就是 **叶子结点** 。而这个叶子结点里放的信息会根据当前的索引是 **主键还是非主键** 有所不同。

-   如果是 **主键索引** ，它的叶子节点会存放完整的行数据信息。
-   如果是 **非主键索引** ，那它的叶子节点则会存放主键，如果想获得行数据信息，则需要再跑到主键索引去拿一次数据，这叫 **回表** 。

比如执行

```
select * from page where user_name = "小白10";
```

会通过非主键索引去查询 **user\_name** 为" **小白10** "的数据，然后在叶子结点里找到" **小白10** "的数据对应的 **主键为10** 。

此时回表到 **主键索引** 中做查询，最后定位到 **主键为10的行数据** 。

![](https://cdn.xiaolincoding.com//picgo/2b24b0c5a5fcf1513df1e63676f6671b.png)

但不管是主键还是非主键索引，他们的叶子结点数据都是 **有序的** 。比如在主键索引中，这些数据是根据主键id的大小，从小到大，进行排序的。

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 两种limit的执行过程 / 基于主键索引的limit执行过程

<!-- knowledge-block: block-002-003 -->
- block_id: `block-002-003`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p3`
- keywords: MySQL, InnoDB, 索引, 分页, SQL, coding, limit, 分页有什么性能问题, 怎么优化, 小林, 两种, 的执行过程, 基于主键索引的, 执行过程

### Evidence

### 基于主键索引的limit执行过程

那么回到文章开头的问题里。

当我们去掉explain，执行这条sql。

```
select * from page order by id limit 0, 10;
```

上面select后面带的是 **星号** \*，也就是要求获得行数据的 **所有字段信息。**

server层会调用innodb的接口，在innodb里的主键索引中获取到第0到10条 **完整行数据** ，依次返回给server层，并放到server层的结果集中，返回给客户端。

而当我们把offset搞离谱点，比如执行的是

```
select * from page order by id limit 6000000, 10;
```

server层会调用innodb的接口，由于这次的offset=6000000，会在innodb里的主键索引中获取到第0到（6000000 + 10）条 **完整行数据** ， **返回给server层之后根据offset的值挨个抛弃，最后只留下最后面的size条** ，也就是10条数据，放到server层的结果集中，返回给客户端。

可以看出，当offset非0时，server层会从引擎层获取到 **很多无用的数据** ，而获取的这些无用数据都是要耗时的。

因此，我们就知道了文章开头的问题的答案， **mysql查询中 limit 1000,10 会比 limit 10 更慢。原因是 limit 1000,10 会取出1000+10条数据，并抛弃前1000条，这部分耗时更大**

**那这种case有办法优化吗？**

可以看出，当offset非0时，server层会从引擎层获取到很多无用的数据，而当select后面是\*号时，就需要拷贝完整的行信息， **拷贝完整数据** 跟 **只拷贝行数据里的其中一两个列字段** 耗时是不同的，这就让原本就耗时的操作变得更加离谱。

因为前面的offset条数据最后都是不要的，就算将完整字段都拷贝来了又有什么用呢，所以我们可以将sql语句修改成下面这样。

```
select * from page  where id >=(select id from page  order by id limit 6000000, 1) order by id limit 10;
```

上面这条sql语句，里面先执行子查询 `select id from page order by id limit 6000000, 1`, 这个操作，其实也是将在innodb中的主键索引中获取到 `6000000+1` 条数据，然后server层会抛弃前6000000条，只保留最后一条数据的id。

但不同的地方在于，在返回server层的过程中，只会拷贝数据行内的id这一列，而不会拷贝数据行的所有列，当数据量较大时，这部分的耗时还是比较明显的。

在拿到了上面的id之后，假设这个id正好等于6000000，那sql就变成了

```
select * from page  where id >=(6000000) order by id limit 10;
```

这样innodb再走一次 **主键索引** ，通过B+树快速定位到id=6000000的行数据，时间复杂度是lg(n)，然后向后取10条数据。

这样性能确实是提升了，亲测能快一倍左右，属于那种耗时从3s变成1.5s的操作。

这······

属实有些杯水车薪，有点搓，属于没办法中的办法。

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 两种limit的执行过程 / 基于非主键索引的limit执行过程

<!-- knowledge-block: block-002-004 -->
- block_id: `block-002-004`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p4`
- keywords: MySQL, InnoDB, 索引, 回表, 分页, SQL, coding, limit, 分页有什么性能问题, 怎么优化, 小林, 两种, 的执行过程, 基于非主键索引的, 执行过程

### Evidence

### 基于非主键索引的limit执行过程

上面提到的是主键索引的执行过程，我们再来看下基于 **非主键索引** 的limit执行过程。

比如下面的sql语句

```
select * from page order by user_name  limit 0, 10;
```

server层会调用innodb的接口，在innodb里的非主键索引中获取到第0条数据对应的主键id后， **回表** 到主键索引中找到对应的完整行数据，然后返回给server层，server层将其放到结果集中，返回给客户端。

而当offset>0时，且offset的值较小时，逻辑也类似，区别在于，offset>0时会丢弃前面的offset条数据。

也就是说 **非主键索引的limit过程，比主键索引的limit过程，多了个回表的消耗。**

但当offset变得非常大时，比如600万，此时执行explain。

![](https://cdn.xiaolincoding.com//picgo/5f6ac7ea812c6ed8962351a20eba1cea.png)

可以看到type那一栏显示的是ALL，也就是 **全表扫描** 。

这是因为server层的 **优化器** ，会在执行器执行sql语句前，判断下哪种执行计划的代价更小。

很明显，优化器在看到非主键索引的600w次回表之后，摇了摇头，还不如全表一条条记录去判断算了，于是选择了全表扫描。

因此， **当limit offset过大时，非主键索引查询非常容易变成全表扫描。是真·性能杀手** 。

这种情况也能通过一些方式去优化。比如

```
select * from page t1, (select id from page order by user_name limit 6000000, 100) t2  WHERE t1.id = t2.id;
```

通过 `select id from page order by user_name limit 6000000, 100` 。先走innodb层的user\_name非主键索引取出id，因为只拿主键id， **不需要回表** ，所以这块性能会稍微快点，在返回server层之后，同样抛弃前600w条数据，保留最后的100个id。然后再用这100个id去跟t1表做id匹配，此时走的是主键索引，将匹配到的100条行数据返回。这样就绕开了之前的600w条数据的回表。

当然，跟上面的case一样，还是没有解决要白拿600w条数据然后抛弃的问题，这也是非常挫的优化。

像这种，当offset变得超大时，比如到了百万千万的量级，问题就突然变得严肃了。

这里就产生了个专门的术语，叫 **深度分页** 。

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 深度分页问题

<!-- knowledge-block: block-002-005 -->
- block_id: `block-002-005`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p5`
- keywords: MySQL, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林, 深度分页问题

### Evidence

## 深度分页问题

深度分页问题，是个很恶心的问题，恶心就恶心在，这个问题，它其实 **无解** 。

不管你是用mysql还是es，你都只能通过一些手段去"减缓"问题的严重性。

遇到这个问题，我们就该回过头来想想。

为什么我们的代码会产生深度分页问题？

**它背后的原始需求是什么** ，我们可以根据这个做一些规避。

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 深度分页问题 / 如果你是想取出全表的数据

<!-- knowledge-block: block-002-006 -->
- block_id: `block-002-006`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p6`
- keywords: MySQL, 索引, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林, 深度分页问题, 如果你是想取出全表的数据

### Evidence

### 如果你是想取出全表的数据

有些需求是这样的，我们有一张数据库表，但我们希望将这个数据库表里的所有数据取出，异构到es，或者hive里，这时候如果直接执行

```
select * from page;
```

这个sql一执行，狗看了都摇头。

因为数据量较大，mysql根本没办法一次性获取到全部数据，妥妥 **超时报错** 。

于是不少mysql小白会通过 `limit offset size` 分页的形式去分批获取，刚开始都是好的，等慢慢地，哪天数据表变得奇大无比，就有可能出现前面提到的 **深度分页** 问题。

这种场景是最好解决的。

我们可以将所有的数据 **根据id主键进行排序** ，然后分批次取，将当前批次的最大id作为下次筛选的条件进行查询。

可以看下伪代码

![](https://cdn.xiaolincoding.com//picgo/318663c9592dc46cf81e3e784e0ebc52.png)

这个操作，可以通过主键索引，每次定位到id在哪，然后往后遍历100个数据，这样不管是多少万的数据，查询性能都很稳定。

![](https://cdn.xiaolincoding.com//picgo/db2daf80158d5dad21238770853af399.png)

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 深度分页问题 / 如果是给用户做分页展示

<!-- knowledge-block: block-002-007 -->
- block_id: `block-002-007`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p7`
- keywords: MySQL, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林, 深度分页问题, 如果是给用户做分页展示

### Evidence

### 如果是给用户做分页展示

如果深度分页背后的原始需求只是产品经理希望做一个展示页的功能，比如商品展示页，那么我们就应该好好跟产品经理battle一下了。

什么样的翻页，需要翻到10多万以后，这明显是不合理的需求。

是不是可以改一下需求，让它更接近用户的使用行为？

比如，我们在使用谷歌搜索时看到的翻页功能。

![](https://cdn.xiaolincoding.com//picgo/31e10317db937beccdedcf79a7d03f47.png)

一般来说，谷歌搜索基本上都在20页以内，作为一个用户，我就很少会翻到第10页之后。

作为参考。

如果我们要做搜索或筛选类的页面的话，就别用mysql了，用es，并且也需要控制展示的结果数，比如一万以内，这样不至于让分页过深。

如果因为各种原因，必须使用mysql。那同样，也需要控制下返回结果数量，比如数量1k以内。

这样就能勉强支持各种翻页，跳页（比如突然跳到第6页然后再跳到第106页）。

但如果能从产品的形式上就做成不支持跳页会更好，比如 **只支持上一页或下一页** 。

![](https://cdn.xiaolincoding.com//picgo/7cc01cdc245a2777d4c766649ab439ae.png)

**这样我们就可以使用上面提到的start\_id方式，采用分批获取，每批数据以start\_id为起始位置。这个解法最大的好处是不管翻到多少页，查询速度永远稳定。**

听起来很挫？

怎么会呢，把这个功能包装一下。

变成像抖音那样只能上划或下划，专业点，叫 **瀑布流** 。

是不是就不挫了？

![](https://cdn.xiaolincoding.com//picgo/3e1d7768f0fddd4efd99467bc1250d90.png) 图片

## MySQL 分页有什么性能问题？怎么优化？ | 小林coding / 深度分页问题 / 总结

<!-- knowledge-block: block-002-008 -->
- block_id: `block-002-008`
- paragraph_id: `94e067cc8d75a1ce80eeb4fa5236e1793821bd5e:p8`
- keywords: MySQL, 事务, 隔离级别, MVCC, 分页, SQL, coding, 分页有什么性能问题, 怎么优化, 小林, 深度分页问题, 总结

### Evidence

### 总结

-   `limit offset, size` 比 `limit size` 要慢，且offset的值越大，sql的执行速度越慢。
-   当offset过大，会引发 **深度分页** 问题，目前不管是mysql还是es都没有很好的方法去解决这个问题。只能通过限制查询数量或分批获取的方式进行规避。
-   遇到深度分页的问题，多思考其原始需求，大部分时候是不应该出现深度分页的场景的，必要时多去影响产品经理。
-   如果数据量很少，比如1k的量级，且长期不太可能有巨大的增长，还是用 `limit offset, size` 的方案吧，整挺好，能用就行。

← [count(\*) 和 count(1) 有什么区别？哪个性能最好？](https://xiaolincoding.com/mysql/index/count.html) [事务隔离级别是怎么实现的？](https://xiaolincoding.com/mysql/transaction/mvcc.html) →

登录后查看评论
