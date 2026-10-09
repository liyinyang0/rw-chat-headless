import java.io.*;

/** 用真 Java 复刻【原版 RW】g(i)/h(i) 生成黄金值，验证 TS 移植。
 *  与 RWX 反编译版的差异（2026-09 与真实原版客户端抓包对比确认）：
 *  - `7:` 字段：原版 e(7)*18*i（乘法）；RWX 重建版误写为 (e(7)*18)+i
 *  - h(i)：Utility.toHexString(int) = "#%06X"
 */
public class GoldenG {
    static int e(int i) {
        switch (i) {
            case 0: return 4000;
            case 1: return 0;
            case 2: return 1000;
            case 3: return 2000;
            case 4: return 5000;
            case 5: return 10000;
            case 6: return 50000;
            case 7: return 100000;
            case 8: return 200000;
            default: return 999;
        }
    }

    static double teamSelfCredits = 4000.0d;

    static String g(int i) {
        String str = ""
            + "c:" + i
            + "m:" + ((i * 87) + 24)
            + "0:" + (e(0) * 11 * i)
            + "1:" + ((e(1) * 12) + i)
            + "2:" + (e(2) * 13 * i)
            + "3:" + ((e(3) * 14) + i)
            + "4:" + (e(4) * 15 * i)
            + "5:" + ((e(5) * 16) + i)
            + "6:" + (e(6) * 17 * i)
            + "7:" + (e(7) * 18 * i)   // 原版：乘法
            + "8:" + (e(8) * 19 * i)
            + "t1:" + (teamSelfCredits * 11.0d * ((double) i));
        int i2 = 5 * i;
        return str + "d:" + i2;
    }

    static String h(int i) {
        return String.format("#%06X", 16777215 & i);
    }

    public static void main(String[] args) throws Exception {
        int[] seeds = {1, 42, 176, 1234, 12345, 76543, 123456, 500000, 765432, 999999, 1000000, 1234567, 1699999};
        try (PrintWriter out = new PrintWriter(new FileWriter("golden-g.txt"))) {
            for (int seed : seeds) {
                out.println(seed + "\t" + g(seed));
            }
            // h() 黄金值
            int[] salts = {6789, 5882501, 0, 16777215, -1};
            for (int s : salts) {
                out.println("h" + s + "\t" + h(s));
            }
        }
        System.out.println("done");
    }
}
