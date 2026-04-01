# CS2 Skin Adjusted Float Calculator

一个用于 **CS2 Trade Up 合成磨损预测** 的轻量工具（Python GUI）。

该工具基于社区当前普遍采用的“先归一化、再映射”的计算方式，适合在合成前快速评估输出磨损区间与品级。

---

## 功能概览

- 支持 **5 件** 或 **10 件** 输入皮肤。
- 每件输入可独立设置：
  - 当前磨损（Float）
  - 该皮肤最小磨损（Min Float）
  - 该皮肤最大磨损（Max Float）
- 可设置目标输出皮肤的最小/最大磨损。
- 自动计算预测输出磨损，并显示对应磨损品级。

---

## 计算公式

对每个输入皮肤先做归一化：

\[
n_i = \frac{float_i - min_i}{max_i - min_i}
\]

然后取归一化结果平均值并映射到目标皮肤磨损区间：

\[
result = output\_min + avg(n_i) \times (output\_max - output\_min)
\]

说明：
- 不同皮肤的磨损上下限不同，直接对原始 Float 求平均会产生偏差。
- 该工具的核心目标是减少这种偏差，给出更贴近实际合成逻辑的结果。

---

## 快速开始

### 环境要求

- Python 3.9+
- Tkinter（多数 Python 发行版已内置）

### 运行方式

```bash
python3 tradeup_calculator_gui.py
```

---

## 使用说明

1. 选择输入数量（5 件或 10 件）。
2. 为每件皮肤填写 `Float / Min / Max`。
3. 填写目标输出皮肤的 `Output Min / Output Max`。
4. 点击计算，查看：
   - 预测输出磨损值
   - 对应磨损品级（Factory New / Minimal Wear / Field-Tested / Well-Worn / Battle-Scarred）

---

## 项目结构

```text
.
├── tradeup_calculator_gui.py   # Python GUI 主程序
├── steam-tradeup-web/          # Web 版本（独立子项目）
└── README.md
```

---

## 结果说明与边界

- 本工具用于计算与决策辅助，不构成收益承诺。
- 合成结果仍受输入池构成、目标池概率与游戏内机制影响。
- 若后续 CS2 合成规则发生调整，建议同步更新计算逻辑。
