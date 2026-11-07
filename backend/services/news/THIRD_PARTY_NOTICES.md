# 第三方声明

中文分词由 [`fxsjy/jieba`](https://github.com/fxsjy/jieba) 提供，采用 MIT License。TabKeep 仅调用其分词接口，没有复制或修改其实现。

```text
The MIT License (MIT)

Copyright (c) 2013 Sun Junyi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

`xiaoheihe.py` 中的 HKey 签名算法参考了 [`huandu/heybox-url`](https://github.com/huandu/heybox-url) 的 MIT 许可实现，并按 TabKeep 的 Python 代码结构独立整理。

小黑盒登录和话题接口使用的 Web 客户端 HKey 算法位于 `xiaoheihe_auth_signing.py`。TabKeep 按 AstrBot 小黑盒适配器的公开实现进行独立适配；该实现声明其算法来自 MIT 许可的 `XiaHouSheng/heybox-core`。TabKeep 不依赖 AstrBot 插件运行。

- AstrBot 插件：[674537331/astrbot_plugin_xiaoheihe_adapter](https://github.com/674537331/astrbot_plugin_xiaoheihe_adapter)
- AstrBot 插件版权：(c) 2026 RyanVaderAn，MIT License
- 算法来源：[XiaHouSheng/heybox-core](https://github.com/XiaHouSheng/heybox-core)，修订 `2fd1bbed98c4f82a99d432048e6d2f25bfaeb0a9`
- 算法来源版权：(c) 2026 XiaHouSheng，MIT License

以下 MIT 许可声明适用于上面列出的组件：

```text
MIT License

Copyright (c) 2026 RyanVaderAn
Copyright (c) 2026 XiaHouSheng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

小黑盒登录和话题目录接口按 [`AstrBot 小黑盒适配器公开的接口契约`](https://github.com/674537331/astrbot_plugin_xiaoheihe_adapter/blob/main/docs/xiaoheihe-api-contract.md) 独立实现，没有复制该项目的源代码。小黑盒没有承诺这些客户端接口稳定；平台升级后可能需要调整适配器。

```text
MIT License

Copyright (c) 2023 Huan Du

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
