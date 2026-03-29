import tkinter as tk
from tkinter import ttk, messagebox


class TradeUpCalculatorApp:
    RESULT_DECIMALS = 12
    NORMALIZED_DECIMALS = 10

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("CS2 合成磨损计算器（5/10件）")
        self.root.geometry("760x680")

        self.item_count_var = tk.IntVar(value=10)
        self.output_min_var = tk.StringVar(value="0.00")
        self.output_max_var = tk.StringVar(value="1.00")

        self.float_vars: list[tk.StringVar] = []
        self.in_min_vars: list[tk.StringVar] = []
        self.in_max_vars: list[tk.StringVar] = []

        self._build_ui()
        self._rebuild_rows()

    def _build_ui(self):
        header = ttk.Label(
            self.root,
            text=(
                "CS2 最新合成磨损计算（支持10件常规合成 / 5件红升金）\n"
                "公式：输出磨损 = 输出最小值 + 平均归一化输入磨损 × (输出最大值 - 输出最小值)"
            ),
            justify="left",
        )
        header.pack(anchor="w", padx=12, pady=(12, 8))

        top = ttk.Frame(self.root)
        top.pack(fill="x", padx=12, pady=6)

        ttk.Label(top, text="输入件数:").grid(row=0, column=0, sticky="w")
        count_combo = ttk.Combobox(
            top,
            textvariable=self.item_count_var,
            values=[5, 10],
            width=6,
            state="readonly",
        )
        count_combo.grid(row=0, column=1, padx=(8, 18), sticky="w")
        count_combo.bind("<<ComboboxSelected>>", lambda _e: self._rebuild_rows())

        ttk.Label(top, text="输出皮肤最小磨损:").grid(row=0, column=2, sticky="w")
        ttk.Entry(top, textvariable=self.output_min_var, width=10).grid(
            row=0, column=3, padx=(8, 18), sticky="w"
        )

        ttk.Label(top, text="输出皮肤最大磨损:").grid(row=0, column=4, sticky="w")
        ttk.Entry(top, textvariable=self.output_max_var, width=10).grid(
            row=0, column=5, padx=(8, 0), sticky="w"
        )

        self.table_frame = ttk.Frame(self.root)
        self.table_frame.pack(fill="both", expand=True, padx=12, pady=(6, 10))

        button_bar = ttk.Frame(self.root)
        button_bar.pack(fill="x", padx=12, pady=(0, 10))

        ttk.Button(button_bar, text="计算结果", command=self.calculate).pack(
            side="left", padx=(0, 8)
        )
        ttk.Button(button_bar, text="填充示例", command=self.fill_demo).pack(side="left")

        self.result_var = tk.StringVar(value="请先输入数据后点击“计算结果”。")
        result_label = ttk.Label(
            self.root,
            textvariable=self.result_var,
            justify="left",
            foreground="#0b5394",
            font=("Arial", 11, "bold"),
        )
        result_label.pack(anchor="w", padx=12, pady=(0, 14))

    def _rebuild_rows(self):
        for child in self.table_frame.winfo_children():
            child.destroy()

        self.float_vars = []
        self.in_min_vars = []
        self.in_max_vars = []

        headers = ["序号", "输入皮肤磨损", "该皮肤最小磨损", "该皮肤最大磨损", "归一化值"]
        for col, text in enumerate(headers):
            ttk.Label(self.table_frame, text=text).grid(
                row=0, column=col, padx=6, pady=4, sticky="w"
            )

        for i in range(self.item_count_var.get()):
            float_var = tk.StringVar(value="")
            min_var = tk.StringVar(value="0.00")
            max_var = tk.StringVar(value="1.00")

            self.float_vars.append(float_var)
            self.in_min_vars.append(min_var)
            self.in_max_vars.append(max_var)

            ttk.Label(self.table_frame, text=f"#{i + 1}").grid(
                row=i + 1, column=0, padx=6, pady=3, sticky="w"
            )
            ttk.Entry(self.table_frame, textvariable=float_var, width=16).grid(
                row=i + 1, column=1, padx=6, pady=3
            )
            ttk.Entry(self.table_frame, textvariable=min_var, width=16).grid(
                row=i + 1, column=2, padx=6, pady=3
            )
            ttk.Entry(self.table_frame, textvariable=max_var, width=16).grid(
                row=i + 1, column=3, padx=6, pady=3
            )
            ttk.Label(self.table_frame, text="-").grid(
                row=i + 1, column=4, padx=6, pady=3, sticky="w"
            )

    @staticmethod
    def _parse_float(value: str, name: str) -> float:
        try:
            return float(value)
        except ValueError as exc:
            raise ValueError(f"{name} 不是有效数字：{value}") from exc

    def fill_demo(self):
        for i in range(self.item_count_var.get()):
            self.float_vars[i].set(f"{0.02 + i * 0.005:.3f}")
            self.in_min_vars[i].set("0.00")
            self.in_max_vars[i].set("0.70")

        self.output_min_var.set("0.00")
        self.output_max_var.set("0.08")
        self.result_var.set("示例数据已填充，点击“计算结果”查看。")

    def calculate(self):
        try:
            output_min = self._parse_float(self.output_min_var.get(), "输出最小磨损")
            output_max = self._parse_float(self.output_max_var.get(), "输出最大磨损")

            if output_min < 0 or output_max > 1 or output_min >= output_max:
                raise ValueError("输出磨损范围不合法：需要满足 0 <= 最小 < 最大 <= 1")

            normalized_values = []
            detail_lines = []

            for i in range(self.item_count_var.get()):
                f = self._parse_float(self.float_vars[i].get(), f"第{i + 1}件输入磨损")
                in_min = self._parse_float(self.in_min_vars[i].get(), f"第{i + 1}件最小磨损")
                in_max = self._parse_float(self.in_max_vars[i].get(), f"第{i + 1}件最大磨损")

                if not (0 <= f <= 1 and 0 <= in_min < in_max <= 1):
                    raise ValueError(
                        f"第{i + 1}件参数不合法：需满足 0<=磨损<=1 且 0<=最小<最大<=1"
                    )
                if not (in_min <= f <= in_max):
                    raise ValueError(
                        f"第{i + 1}件磨损 {f:.10f} 不在该皮肤范围 [{in_min:.10f}, {in_max:.10f}] 内"
                    )

                normalized = (f - in_min) / (in_max - in_min)
                normalized_values.append(normalized)
                detail_lines.append(
                    f"#{i + 1}: {normalized:.{self.NORMALIZED_DECIMALS}f}"
                )

            avg_normalized = sum(normalized_values) / len(normalized_values)
            output_float = output_min + avg_normalized * (output_max - output_min)

            quality = self._float_to_wear(output_float)
            result_text = (
                f"平均归一化输入磨损: {avg_normalized:.{self.RESULT_DECIMALS}f}\n"
                f"预测输出磨损: {output_float:.{self.RESULT_DECIMALS}f}\n"
                f"对应品级: {quality}\n"
                f"\n每件归一化值:\n" + "\n".join(detail_lines)
            )
            self.result_var.set(result_text)

            for i, n in enumerate(normalized_values):
                label = self.table_frame.grid_slaves(row=i + 1, column=4)
                if label:
                    label[0].configure(text=f"{n:.{self.NORMALIZED_DECIMALS}f}")

        except ValueError as err:
            messagebox.showerror("输入错误", str(err))

    @staticmethod
    def _float_to_wear(value: float) -> str:
        if value < 0.07:
            return "崭新出厂 (Factory New)"
        if value < 0.15:
            return "略有磨损 (Minimal Wear)"
        if value < 0.38:
            return "久经沙场 (Field-Tested)"
        if value < 0.45:
            return "破损不堪 (Well-Worn)"
        return "战痕累累 (Battle-Scarred)"


if __name__ == "__main__":
    root = tk.Tk()
    app = TradeUpCalculatorApp(root)
    root.mainloop()
