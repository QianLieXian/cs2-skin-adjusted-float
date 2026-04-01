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
收藏品	官方中文名	英文名	最小磨损	最大磨损
哈乐昆收藏品	MP9 | 创世蜂鸣	MP9 | Bee-Tron	0.00	0.90
哈乐昆收藏品	R8左轮手枪 | 淡紫旁白	R8 Revolver | Mauve Aside	0.00	0.80
哈乐昆收藏品	CZ75自动型 | 蜜金佩斯利	CZ75-Auto | Honey Paisley	0.00	0.60
哈乐昆收藏品	SG 553 | 狩猎印花	SG 553 | Safari Print	0.00	0.70
哈乐昆收藏品	PP-野牛 | 热气流	PP-Bizon | Thermal Currents	0.00	0.60
哈乐昆收藏品	截短霰弹枪 | 赤红蜡染	Sawed-Off | Crimson Batik	0.00	0.60
哈乐昆收藏品	法玛斯 | 副产品	FAMAS | Byproduct	0.00	0.55
攀升收藏品	Tec-9 | 蓝爆	Tec-9 | Blue Blast	0.00	0.80
攀升收藏品	MP9 | 褪色蓝痕	MP9 | Buff Blue	0.00	0.70
攀升收藏品	R8左轮手枪 | 钴蓝握把	R8 Revolver | Cobalt Grip	0.00	0.80
攀升收藏品	P90 | 海蓝战术	P90 | Blue Tac	0.00	0.60
攀升收藏品	截短霰弹枪 | 径流	Sawed-Off | Runoff	0.00	0.78
攀升收藏品	SG 553 | 暗夜迷彩	SG 553 | Night Camo	0.00	0.80
攀升收藏品	MAC-10 | 风暴迷彩	MAC-10 | Storm Camo	0.00	0.64
攀升收藏品	加利尔AR | 灰色烟幕	Galil AR | Grey Smoke	0.00	0.60
攀升收藏品	P250 | 绛络	P250 | Plum Netting	0.00	0.60
攀升收藏品	MP5-SD | 青柠蜂巢	MP5-SD | Lime Hex	0.00	0.64
攀升收藏品	SSG 08 | 灰色烟幕	SSG 08 | Grey Smoke	0.00	0.60
寒带收藏品	内格夫 | 生瓷	Negev | Raw Ceramic	0.00	0.75
寒带收藏品	SSG 08 | 绿陶	SSG 08 | Green Ceramic	0.00	0.75
寒带收藏品	法玛斯 | 棕榈色	FAMAS | Palm	0.00	0.75
寒带收藏品	Tec-9 | 生瓷	Tec-9 | Raw Ceramic	0.00	0.75
寒带收藏品	P250 | 氧化铜	P250 | Copper Oxide	0.00	0.65
寒带收藏品	MP9 | 松	MP9 | Pine	0.00	0.70
寒带收藏品	AUG | 特种兵连	AUG | Commando Company	0.00	0.65
寒带收藏品	UMP-45 | 碧漩	UMP-45 | Green Swirl	0.00	0.70
寒带收藏品	G3SG1 | 绿色细胞	G3SG1 | Green Cell	0.00	0.65
寒带收藏品	M249 | 鼠尾草迷彩	M249 | Sage Camo	0.00	0.60
寒带收藏品	MAG-7 | 氧化铜	MAG-7 | Copper Oxide	0.00	0.65
寒带收藏品	宙斯x27电击枪 | 沼泽DDPAT	Zeus x27 | Swamp DDPAT	0.00	0.60
热辐射收藏品	MP7 | 赭石短调	MP7 | Short Ochre	0.00	0.75
热辐射收藏品	MAC-10 | 古铜	MAC-10 | Bronzer	0.00	0.80
热辐射收藏品	双持贝瑞塔 | 第二边界	Dual Berettas | BorDeux	0.00	0.80
热辐射收藏品	MP9 | 多地形迷彩	MP9 | Multi-Terrain	0.00	0.60
热辐射收藏品	SCAR-20 | 赭石短调	SCAR-20 | Short Ochre	0.00	0.75
热辐射收藏品	CZ75自动型 | 粉玑	CZ75-Auto | Pink Pearl	0.00	0.70
热辐射收藏品	FN57 | 秋日灌木	Five-SeveN | Autumn Thicket	0.00	0.64
热辐射收藏品	XM1014 | 画布云斑	XM1014 | Canvas Cloud	0.00	0.60
热辐射收藏品	新星 | 沼泽草	Nova | Marsh Grass	0.00	0.55
热辐射收藏品	P90 | 沙漠半调	P90 | Desert Halftone	0.00	0.65
热辐射收藏品	G3SG1 | 红碧玉	G3SG1 | Red Jasper	0.00	0.64
热辐射收藏品	PP-野牛 | 木纹迷彩	PP-Bizon | Wood Block Camo	0.00	0.60
墨彩收藏品	P250 | 冻雨	P250 | Sleet	0.00	0.70
墨彩收藏品	M249 | 冻雨	M249 | Sleet	0.00	0.70
墨彩收藏品	双持贝瑞塔 | 银流	Dual Berettas | Silver Pour	0.00	0.68
墨彩收藏品	新星 | 气流	Nova | Currents	0.00	0.65
墨彩收藏品	MP9 | 眩晕	MP9 | Dizzy	0.00	0.65
墨彩收藏品	SSG 08 | 无漫风格	SSG 08 | Sans Comic	0.00	0.50
墨彩收藏品	SCAR-20 | Zinc	SCAR-20 | Zinc	0.00	0.60
墨彩收藏品	PP-野牛 | 变焦	PP-Bizon | Bizoom	0.00	0.58
<img width="624" height="1050" alt="image" src="https://github.com/user-attachments/assets/4b10c697-8305-4a6b-b72f-408d8696e3a2" />
