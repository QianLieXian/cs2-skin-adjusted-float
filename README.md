# cs2-skin-adjusted-float

CS2 合成（Trade Up）磨损计算小工具（Python GUI）。

## 公式（按当前社区公认的 CS2 调整后合成逻辑）

对每个输入皮肤先做归一化：

`n_i = (float_i - min_i) / (max_i - min_i)`

再取平均并映射到输出皮肤区间：

`result = output_min + avg(n_i) * (output_max - output_min)`

> 说明：不同皮肤拥有不同磨损上下限，所以仅对原始 float 做平均通常不够准确。

## 运行

```bash
python3 tradeup_calculator_gui.py
```

## 功能

- 支持 5 件或 10 件输入。
- 每件都可填写：当前磨损、该皮肤最小磨损、该皮肤最大磨损。
- 可设置目标输出皮肤的最小/最大磨损。
- 自动显示预测输出磨损与对应磨损品级。
