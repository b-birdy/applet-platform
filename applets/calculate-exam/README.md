# 🧮 心算训练（calculate-exam）

训练心算能力的小程序，含五档难度与每档独立 TOP10 排行榜。

## 目录结构

```
calculate-exam/
├─ applet.json        # 清单（id / name / icon / entry / version / display / tables）
├─ index.html         # 入口页面（引入 /app-runtime.js）
└─ assets/
   ├─ style.css       # 卡通活力主题，消费平台设计变量
   ├─ core.js         # DOM 助手、卡通音效（Web Audio 合成）、格式化
   ├─ questions.js    # 五档难度的随机出题器
   ├─ store.js        # 成绩与排行榜，统一走 window.applet.data('records')
   └─ ui.js           # 排行榜渲染、Banner 轮播、庆祝特效、轻提示
   └─ app.js          # 主流程：首页 → 设置 → 答题 → 结算
```

## 难度设计

| 级别 | 名称 | 规则 |
|---|---|---|
| 1 | 🐣 菜鸟 | 两个两位数以内整数的四则混合，除法能整除 |
| 2 | 🐰 学徒 | 三个两位数以内整数的四则混合，可带括号，除法能整除 |
| 3 | 🦊 高手 | 两个两位数以内整数 + 平方 / 立方，除法能整除 |
| 4 | 🦉 精英 | 三个两位数以内整数 + 平方 / 立方，可带括号 |
| 5 | 🐲 大神 | 三个三位数以内整数 + 平方 / 立方，可带括号 |

每次测试固定随机 100 道题。

## 计分规则

- 正确分：答对 +3 分，答错 −2 分
- 速度分：`100000 ÷ 用时秒数`（向下取整）
- 总分 = 正确分 + 速度分

## 数据表

`records`：player(text) / level(integer) / score(integer) / time_ms(integer) /
accuracy(integer) / correct_count(integer) / answered_at(text)

数据读写全部通过平台运行时 `window.applet.data('records')`，不做任何绕行存储。
