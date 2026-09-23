// Krystal — 开场画像（Braille 点阵：学 hermes 的画法）
// hermes 的方式：一个 Braille 字符 = 2×4 个点 → 分辨率是普通字符画的 8 倍；
// 每行套一个渐变色（hermes 用 [#hex] 逐行，我们用平台的 256 色蓝）。
// 来源：owner 提供的 Rose.png，程序化点阵转换（块均值 + Floyd–Steinberg 抖动 + 裁剪）。
// 生成脚本见 docs（块均值降采样 → 背景减法 → 抖动 → Braille 码位）。
import { BLUE_LIGHT, bold, chip, dim, fg } from "./ansi.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../deps/pi-tui/dist/index.js";
import { KRYSTAL_GRADIENT, LOGO_ROWS } from "./logo.ts";

/** 完整画像（72×37，点阵 144×148） */
export const ROSE_ART: string[] = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣿⣶⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢀⢀⠂⠀⣰⣿⣿⡯⡿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠩⣼⣿⣿⢿⠱⡱⢩⣻⢿⢦⣤⣦⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⡀⠀⠀⠀⠀⠀⠀⠠⠀⠀⠀⢀⠀⡂⢭⣷⣿⣿⢸⠈⠌⠢⡣⠣⣳⣿⣟⣷⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⣀⡆⠀⠀⠀⠈⠀⢀⠐⡀⢢⡰⣼⣽⣿⣟⡏⢆⠐⡈⠌⡂⢽⢟⢵⡿⣽⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣷⠀⠀⡀⠄⢐⢠⡱⣜⣼⣿⣿⣿⣿⢟⢌⠢⣂⢂⠆⡢⡙⣜⢿⢝⡿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡨⡺⢍⢢⠩⡙⠍⡈⡆⡞⣎⢙⡻⣿⣿⣯⣷⣣⣯⣲⣱⣱⢼⢌⢎⢧⢏⣯⣿⣿⣤⡦⠦⡦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠄⠢⢖⢌⠂⡂⡊⢔⢐⢅⢂⢕⢜⢮⣺⢮⣺⣞⣯⣿⡿⡿⠿⠻⠓⠛⠫⠳⠳⢯⣷⣯⣾⢿⣿⡝⡊⠌⡪⣿⣷⣤⡂⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡐⢠⠡⠑⢔⠐⠁⠄⢌⢢⢱⢸⡢⡳⡽⣽⣾⣽⣿⣿⠟⠩⠚⠒⡀⠀⠀⠀⠀⠀⠀⠀⠌⢻⢞⢯⢏⢇⡢⢡⢅⢓⢿⣿⣿⣶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢔⢑⠬⡢⢃⠅⡘⢌⢌⢐⢕⣕⢧⣿⣵⣿⣿⡿⠿⠛⠋⠠⢀⠁⠀⠀⠀⠀⢀⢀⢀⢠⠐⠈⠀⠀⠀⠈⠊⡯⣿⣶⣕⢬⢫⢯⣷⣿⣿⣿⣶⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⣠⠔⠧⣇⢅⢒⠌⢆⢅⠢⡱⣸⡸⣮⣾⣿⣿⠟⠉⠀⢀⠀⡄⡂⢅⢢⣐⢥⣕⣵⣷⣵⣷⣧⣧⣦⣦⣠⡀⠀⠀⠀⠈⠈⠙⣺⣵⣽⣽⣾⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⢠⣺⡮⡳⡹⣰⢱⢰⠩⡢⡢⡣⣣⣷⣿⡿⠟⠋⡀⡀⣔⢬⣶⣷⣿⣾⣿⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⡀⠀⠀⠐⡙⣾⣿⣿⣿⣿⠟⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⡠⠤⢤⣤⣞⡕⡞⡿⣝⣞⢴⢱⢣⡣⡣⣣⣿⢿⣿⡫⡤⡲⠳⠘⠘⠙⠙⠛⠟⣛⣛⣟⡽⣽⢽⣝⢮⣫⢯⣟⡿⣟⣿⣻⣽⣻⣻⣻⢿⣿⣷⣄⢂⠐⡨⠺⣽⣿⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⢀⡰⣻⢿⣳⣕⢧⣣⡣⡳⡱⢕⢧⣳⣿⠟⠉⠈⢾⢚⠔⠀⠁⠀⠀⢄⣀⣄⣤⣤⣬⣷⣷⣶⣷⣶⣿⣾⣿⢿⡿⣿⣿⣯⣿⣿⣿⣿⣿⣿⣿⣿⣷⣧⡐⡅⡳⡹⣿⣿⣿⣶⣀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠠⣾⡿⣟⢷⡿⣞⣽⡆⡇⠕⠡⣃⠿⠋⠁⠀⠀⡀⢑⠀⣀⣤⣶⣿⡿⡿⢿⢻⠟⠟⡻⠻⠛⠍⢓⠫⢯⣳⣽⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣮⣪⠪⢽⣾⣿⣿⣿⣶⣄⠀⠀⠀⠀⠀⠀",
  "⠀⠈⠉⢘⣾⣿⣟⡷⡕⢂⠁⠁⠀⠀⠀⠀⠀⡂⡪⣴⣿⣿⣿⠟⢕⠁⠊⠈⠠⢁⠡⠠⠁⢁⠤⢶⢾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⢧⡫⡷⡻⡿⣿⣿⣷⣦⡀⠀⠀⠀",
  "⠀⠀⠀⠂⠀⠈⢽⣟⡜⡀⠀⠀⠀⠀⠠⠠⡣⣵⣿⣿⣿⠏⠂⡐⡀⠂⡀⡀⣀⣠⣴⣶⣶⣶⣤⡤⣄⣀⡈⠈⠛⠻⢿⣻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣫⢕⢭⢫⡻⣿⣿⣿⣷⣆⠀",
  "⠀⠀⠀⠀⠀⠀⢮⣾⡕⡂⡂⠀⠀⠠⡡⣳⣿⡟⢽⡿⠃⢀⢰⣕⢧⣷⣾⣿⣿⣿⢯⡙⠌⠂⠂⠡⠑⠑⠉⠇⠳⡰⣄⣁⠩⠫⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣟⣞⢗⣕⢧⢫⢯⣿⣿⣿⣿⣤",
  "⠀⠀⠀⠀⠀⠠⡻⢗⢝⡐⢐⡀⢄⢧⣾⣿⡟⠀⡟⡁⣄⡮⣷⣿⣿⣿⣿⡿⡛⠙⠀⠀⠀⠀⠀⠀⢀⢀⡠⡠⠅⢄⢄⣅⣐⣰⢀⠀⠈⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⣿⡽⣺⢸⢪⡯⣿⣿⣿⠿⠋",
  "⠀⠀⠀⠀⠀⠠⢐⢕⢕⠌⢐⡮⣮⣿⣿⣟⠀⢀⢢⡳⣛⣾⣿⣿⣿⡿⡋⠂⠀⠀⣀⣠⣠⢖⢞⢪⢝⢞⢟⢝⣟⣿⣿⣭⡩⠙⢿⣯⡢⡄⠈⢻⣟⠿⣟⣿⣿⣿⣿⣿⣿⣯⢯⢷⡯⣷⣿⣿⡿⠉⠀⠀",
  "⠀⠀⠀⠀⠀⠀⡜⣞⢆⠂⠀⢻⣿⣿⣿⠣⡨⣪⡞⣼⣿⣿⣿⣿⣿⠁⠀⠀⣠⢞⠊⣪⣴⢗⣾⡶⣗⠮⣤⡡⠑⡛⣿⣿⣿⣦⠀⢻⣿⣬⢳⣄⠘⡌⠻⣾⣿⣿⣿⣿⣳⣿⣯⢯⣿⣿⡿⠋⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⢨⢺⢷⠁⠀⠀⣾⣿⡿⠡⡳⣽⢯⣾⣿⣿⡯⣿⣿⡃⠀⣠⡞⣃⣶⣿⡟⢥⣟⡁⡊⠐⠅⠐⢝⣶⡨⣈⠻⣿⣿⣧⠂⢹⣿⣿⣿⣷⣧⠀⠹⣿⣿⣿⡿⣯⣿⣿⣿⣿⠟⠁⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⢠⢹⣽⣏⠂⠀⠨⣚⣿⠡⣑⣽⠗⣿⣯⣟⢾⡯⣿⣿⠀⣼⡟⣰⣿⢻⢟⠆⣺⡿⡻⣂⣠⣀⣁⢱⣑⢱⡸⡂⠝⢿⣿⡇⢸⣿⣿⣿⣿⣷⠀⠀⠘⢿⣿⣿⢿⣽⣿⣿⠋⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⡰⣿⣟⠎⠀⠀⠈⢄⢻⡬⠿⠫⡀⠽⡷⡧⢙⣽⢽⡗⣼⣟⢾⣿⣿⡀⢰⣾⣿⣿⣿⣿⣿⣿⣿⣶⣍⢿⡿⢰⡄⣂⢻⢹⣸⣿⣿⣿⣿⣿⠀⠀⠀⢸⣿⣿⣟⣾⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⢀⣤⣿⣟⠎⠀⠀⠀⠀⠂⢱⢡⡇⠁⠀⠨⣫⡿⡄⠙⣾⢱⣿⣟⢸⣿⣿⣿⡦⡛⢿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠂⣾⣿⠊⠀⠐⣿⣿⡿⣿⣿⣿⡆⠀⢠⣿⣿⣿⢽⣻⣿⣿⡃⠀⠀⠀⠀⠀⠀⠀",
  "⠀⣼⣿⣻⣽⡞⠅⠀⠀⠀⠀⠀⠄⠅⣿⡠⡀⠁⡐⢽⢆⠀⠘⢽⣿⡇⣿⣿⣿⣿⣿⣿⣷⣷⣿⣿⣿⣿⣿⣿⠏⠂⣼⡿⠃⠀⢰⡆⢿⣿⢏⢸⣿⣿⣷⠠⣿⣿⣿⡺⡝⡷⣿⣿⡃⠀⠀⠀⠀⠀⠀⠀",
  "⢼⣿⢹⢪⡳⣝⡬⡐⢀⠀⠀⠀⠀⠐⡘⢷⡆⡁⠠⢉⢞⡄⠀⠈⢻⣯⣿⣿⣿⣿⣿⣿⣿⡎⢻⣿⣿⣿⣟⣵⣥⣾⠟⠁⠀⠀⣿⣏⣾⠏⢠⢪⣿⣿⡧⣡⣾⡟⡎⡎⢇⢏⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠈⢻⣯⢧⣽⡺⡿⣜⢄⢂⠁⠄⡈⠀⠄⠈⣷⣵⡌⢄⠢⡹⡢⡄⠀⠘⠿⣿⣿⣿⣿⣿⣳⣽⣇⣏⣯⣽⣽⠿⡫⠡⠁⠀⠀⣸⡯⠟⢁⠔⠁⣿⣿⣿⣿⡟⡗⡕⡑⠌⠪⡹⣽⣿⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠙⠙⠘⠌⡫⢯⡳⣕⢄⢕⢀⠂⡐⠀⠰⣙⠻⠷⣌⢆⢏⣿⣄⣀⠀⠈⠉⠟⣿⣿⣿⣷⣯⣯⣫⣹⣬⣪⣤⣵⠬⢚⢊⢃⠌⠔⠈⢀⣼⣿⣿⣿⡳⡝⢌⠢⠨⠠⠁⠌⠻⣿⡇⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠁⠫⠚⡪⣞⢔⢡⠐⢄⠈⡲⣱⠀⠀⠁⠀⠙⡚⣿⣦⣆⡈⠑⠰⠹⢻⢻⢿⢿⣿⣿⡿⣟⢟⢞⢜⠐⠀⠀⠀⢀⣠⣾⣿⣿⣿⠳⡩⠊⠐⠐⠀⠄⠡⡸⡦⠉⠁⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡑⢱⢹⣸⢸⡨⡆⠈⡪⣇⢅⠀⠀⠁⠀⠈⠝⠿⣿⡷⣴⣀⠠⠑⡻⣻⣽⣨⣸⠸⢘⢑⠑⡀⣀⣦⡾⡟⢏⢟⢿⢟⢎⢊⠄⠂⡁⢌⣐⢌⢎⢿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡸⡼⡽⡽⣳⢆⠈⢷⣳⡨⣐⠠⠀⠄⠈⠠⠐⠨⢢⠩⡉⠅⡃⠍⡛⢻⢻⣻⣿⣷⣷⣿⡿⣫⡣⡊⡐⠈⠌⠂⠁⢂⠢⣡⣗⣽⡾⠟⠋⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠁⠀⠿⣿⣿⣿⣮⣇⣆⢅⠌⢄⢁⠢⢑⢕⣕⢔⣔⣼⣢⣷⣿⡿⠟⠏⠯⠛⠍⡊⠄⠠⠐⠈⢔⣼⣔⣽⣿⠟⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠿⠟⢿⣿⡿⣷⣷⣕⡂⡂⢆⢧⣿⣿⡿⣿⣿⣿⣦⡀⠐⠈⠈⠈⡀⠄⢂⢅⢪⢼⣮⡾⠿⠏⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⢿⣿⡿⡭⠗⠘⠬⢟⢋⢄⠱⡑⡟⣿⣿⣿⣦⣤⠐⠠⡠⠰⠰⠑⠁⠝⠿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠈⠪⣆⣪⡢⡪⣞⣾⣿⠟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠛⠿⠽⠿⠝⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
];

/** 小画像（38×20，点阵 76×80）——矮屏/窄屏用 */
export const ROSE_ART_SMALL: string[] = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣿⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠰⡄⠀⠀⠀⠀⠀⠀⠁⢵⣿⠏⡊⡟⣧⣶⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣤⠀⠀⠀⢄⢰⣜⣿⣟⢐⠠⢡⢻⣞⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⢟⢐⢒⢡⢭⢛⢿⣿⣶⣕⣥⢧⡱⡳⣿⡧⠤⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⡠⠊⢅⠨⡐⣔⡜⣼⣺⣽⡟⠫⠅⠁⠀⠁⠉⠿⢻⢫⡐⡹⡿⣧⣄⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⢀⢔⢕⢘⠌⢔⣢⣳⣷⠿⠛⠉⡁⡄⣄⣤⣤⣦⣪⣀⡀⠀⠉⠻⢮⣺⣿⣿⣿⡄⠀⠀⠀⠀",
  "⠀⣀⣀⡴⡯⣇⢇⢎⢎⣾⡾⡋⡅⠴⠼⠿⢿⢿⣻⣻⣻⢿⣿⣿⡿⣿⣦⣄⠈⡻⣿⣯⡁⠀⠀⠀⠀⠀",
  "⢠⣼⣻⢮⡺⡸⢸⡵⠏⠁⡙⢀⣠⣤⣤⡶⡾⡷⠷⢷⢿⣻⣯⣷⣿⣿⣿⣿⣷⣦⢱⣻⣿⣦⡀⠀⠀⠀",
  "⠈⠈⠾⢿⢕⠀⠂⠀⢀⢔⣼⡿⠋⡂⠐⠐⣐⣀⠪⠺⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣮⡟⡻⣿⣦⣄⠀",
  "⠀⠀⠀⣺⡕⡀⠀⣄⣷⢿⠟⢠⣵⣶⣷⡿⠫⠉⠉⠉⠒⠢⠬⠙⠻⢿⣿⣿⣿⣿⣿⣿⣽⡪⡮⣿⣿⣧",
  "⠀⠀⠀⢌⢎⠰⣕⣿⠇⣐⢼⣽⣿⡟⠑⢀⡠⢤⢒⠮⡺⣺⣾⣚⢳⡤⡙⢻⢿⣿⣿⣿⣷⣫⣾⣿⠋⠁",
  "⠀⠀⠀⣮⠃⢀⣿⢟⢼⣪⣿⣿⡿⢀⠴⣱⡾⣹⡋⠋⠲⣔⠹⣿⣆⠽⣾⣶⡔⢻⣿⣯⣿⣾⡟⠁⠀⠀",
  "⠀⠀⣸⢾⠁⠀⡻⢴⠋⡿⡝⡾⣇⣾⣽⡏⣱⣽⣵⣶⣮⡲⣇⡊⡻⢼⣿⣿⡇⠀⢹⣿⣽⣯⠀⠀⠀⠀",
  "⢀⣴⡿⡁⠀⠀⠈⢧⠀⡘⣇⠙⣽⣇⣿⣿⣮⣿⣿⣿⣿⡟⣰⠟⢀⢽⡟⢿⣷⢠⣿⢿⢽⣿⠀⠀⠀⠀",
  "⢺⡳⣝⣦⢀⠀⡀⠘⢧⣀⢊⢆⠐⢻⣿⣿⣿⣧⡻⣿⣯⡶⠋⠀⣾⠝⡡⣿⣿⡼⡫⠱⣹⣏⠀⠀⠀⠀",
  "⠀⠙⠑⠱⡳⣅⡢⠐⠈⡝⠲⠌⢧⣄⠈⡙⡿⣷⣿⣽⣦⡶⡜⠨⠐⠈⣴⣿⡟⡪⠨⠐⡈⠿⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠐⢕⣕⡥⢘⣆⢀⠀⠙⠻⠦⢆⡑⠽⣯⣱⣉⣢⣠⡖⠟⡻⠫⢂⢂⢄⣆⠿⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠁⠉⠁⢾⣶⣵⣄⡂⡡⢑⢔⣅⣮⣺⠿⠛⠗⠍⠂⢠⢡⣲⡟⠋⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⢻⢿⠲⠨⡟⡋⡟⣿⣦⡈⢀⠄⠇⠽⠏⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⢼⠽⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
];

/** 迷你画像（28×14）——并排时的默认档（owner 反馈：38×20 偏大） */
export const ROSE_ART_MINI: string[] = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡀⣼⡗⣤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠱⣀⠀⠀⢀⢠⣺⡯⢈⢊⢿⢷⠀⠀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⢀⠀⢎⢂⢆⡳⣻⣿⡵⡵⢜⣜⣿⡧⠤⣄⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⡀⢆⠅⢅⣪⣲⡵⠿⠋⠌⡀⣀⡀⡀⠙⠸⣼⢸⣿⣦⡄⠀⠀⠀",
  "⢀⢀⡔⣧⢫⡢⣕⣷⢛⠅⠖⠾⡾⣟⢿⢿⣿⣿⣶⣦⣀⠻⢿⣏⠁⠀⠀⠀",
  "⠰⢟⣽⡊⠪⠚⠁⣈⣤⠶⠲⢓⠛⣋⣟⣿⣷⣿⣿⣿⣿⣷⣭⣻⣷⣤⠀⠀",
  "⠀⠀⢹⡆⠀⡠⡞⡿⢁⣥⣦⡶⠓⠒⠂⠍⠝⠻⠿⣿⣿⣿⣿⣾⡪⡽⣿⣦",
  "⠀⠀⢱⡈⢮⣾⢃⢮⣿⡿⠉⡠⣔⡦⣓⢝⢾⣝⢲⣉⡛⢿⣿⣿⣽⣾⠟⠁",
  "⠀⢀⡾⠀⢺⢣⢟⣟⢿⣣⢮⠾⣱⣧⣤⡱⣕⠻⣎⣿⣿⠈⢻⣯⣿⠁⠀⠀",
  "⣠⢾⠅⠀⠈⢪⠀⢳⠙⢾⣽⣿⣽⣿⣿⡟⣱⠃⣜⡟⣿⡤⣿⢻⣿⠀⠀⠀",
  "⠱⠯⢳⢅⠄⡈⠳⣔⢱⡈⠛⢿⣿⣮⢯⣛⡁⢔⠋⣰⣿⢟⠜⠘⢾⠀⠀⠀",
  "⠀⠀⠀⠁⠫⣢⡌⢆⡀⠉⠳⠮⡈⡻⣏⣏⣊⣤⠲⠻⠝⢠⣐⡬⠃⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠈⠘⠿⢮⣦⢌⢒⡶⣾⡞⠋⠑⠡⣰⡪⠗⠁⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠀⠉⠢⡵⠿⠃⠁⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀",
];

export interface PortraitInfo {
  name: string;
  model: string;
  tier: string;
  cwd: string;
  sessionId: string;
  memories?: number;
}

/** 逐行渐变（与 logo 同源：51→45→39→33→27→26，循环铺满行数） */
const centerIn = (t: string, w: number) => {
  const pad = Math.max(0, w - visibleWidth(t));
  const left = pad >> 1;
  return " ".repeat(left) + t + " ".repeat(pad - left);
};

const rowColor = (i: number) => KRYSTAL_GRADIENT[i % KRYSTAL_GRADIENT.length]!;
const TAGLINE = "棱镜之间，诸神显形";

/**
 * 开场画像（响应式分层，照 pi/hermes 的思路）：
 *   宽 < 34                        → 一行名字
 *   能放下完整画像（宽≥74 且 高≥art+8） → 完整 Braille 画像 + 会话卡
 *   能放下小画像（宽≥40 且 高≥small+8） → 小画像 + 会话卡
 *   否则                            → 横幅（名字 + 标语）+ 会话卡
 */
export function renderPortrait(width: number, height: number, info: PortraitInfo): string[] {
  const wOf = (rows: string[]) => Math.max(...rows.map((r) => [...r].length));
  const logoW = wOf(LOGO_ROWS);
  const fullW = wOf(ROSE_ART);
  const smallW = wOf(ROSE_ART_SMALL);
  const GAP = 4;
  const RIGHT_MIN = 42; // 右侧介绍列最小宽度（够放信息卡）

  if (width < 34) return [` ${bold(info.name)} ${dim("· 原生成员")}`];

  // 右侧介绍列（hermes Panel 的形状：section 标题 + 「标签 padEnd(20) 灰 + 值」行）
  const rightCol = (rw: number): string[] => {
    const w = Math.max(24, rw);
    const rows: string[] = [];
    rows.push(...wrapTextWithAnsi("Krystal 平台的原生成员：与团队共用一套协议（身份 / 派工 / 白板 / 汇报），可查文件、跑只读命令、记住跨会话的事实。", w).map((l) => dim(l)));
    rows.push("");
    rows.push(bold(fg(BLUE_LIGHT, "命令")));
    rows.push(dim("/resume 回溯历史 · /memory 记忆图 · /new 新会话 · /help"));
    rows.push("");
    rows.push(bold(fg(BLUE_LIGHT, "工具")));
    rows.push(dim("list_dir · read_file · run_command · memory"));
    rows.push("");
    rows.push(bold(fg(BLUE_LIGHT, "会话")));
    for (const [k, v] of [
      ["模型", info.model],
      ["档位", info.tier],
      ["目录", info.cwd],
      ["会话", info.sessionId],
      ["记忆", `${info.memories ?? 0} 条事实`],
    ] as [string, string][]) {
      const room = Math.max(6, w - 20);
      rows.push(dim(k.padEnd(20)) + (v.length > room ? `${v.slice(0, room - 1)}…` : v));
    }
    // 出口统一按列宽截断（防止固定长行溢出 → 框线错位）
    return rows.map((r) => truncateToWidth(r, w, "…"));
  };

  const logo = LOGO_ROWS.map((r, i) => fg(KRYSTAL_GRADIENT[i % KRYSTAL_GRADIENT.length]!, r));
  const out: string[] = width >= logoW + 2 ? [...logo] : [` ${bold(info.name)} ${dim("· 原生成员")}`];

  // 在「宽」允许时优先并排：玫瑰在左、介绍在右（放得下完整画像就用完整）
  // 并排时的画像档位：默认迷你；宽裕（还多出 40 列）才升到小图/完整
  const miniW = wOf(ROSE_ART_MINI);
  const useFull = width >= fullW + GAP + RIGHT_MIN + 40;
  const useSmall = width >= smallW + GAP + RIGHT_MIN + 40;
  const useMini = width >= miniW + GAP + RIGHT_MIN;
  if (useFull || useSmall || useMini) {
    const art = useFull ? ROSE_ART : useSmall ? ROSE_ART_SMALL : ROSE_ART_MINI;
    const artW = wOf(art);
    const PAD_X = 2;
    const PAD_Y = 1;
    const BORDER = 2; // 左右各一条框线
    // 宽度：先给右列理想宽度，再按终端宽度收缩；放不下就退化
    const avail = width - BORDER - PAD_X * 2;
    let rightW = Math.min(58, Math.max(40, avail - artW - GAP));
    if (artW + GAP + rightW > avail) rightW = avail - artW - GAP;
    if (rightW < 28) return stacked(); // 右列太窄 → 上下排
    const innerW = artW + GAP + rightW;

    const right = rightCol(rightW);
    const rows: string[] = [];
    rows.push(centerIn(bold(info.name), innerW));
    rows.push(centerIn(fg(BLUE_LIGHT, TAGLINE), innerW));
    rows.push("");
    for (let i = 0; i < Math.max(art.length, right.length); i++) {
      const left = art[i] ? fg(rowColor(i), art[i]!.padEnd(artW)) : " ".repeat(artW);
      const r = truncateToWidth(right[i] ?? "", rightW, "…");
      rows.push(left + " ".repeat(GAP) + r + " ".repeat(Math.max(0, rightW - visibleWidth(r))));
    }

    const row = (t: string) => {
      const bodyText = truncateToWidth(t, innerW, "…");
      return dim("│") + " ".repeat(PAD_X) + bodyText + " ".repeat(Math.max(0, innerW - visibleWidth(bodyText)) + PAD_X) + dim("│");
    };
    const rule = (l: string, r: string) => dim(l + "─".repeat(innerW + PAD_X * 2) + r);
    out.push("");
    out.push(rule("╭", "╮"));
    for (let i = 0; i < PAD_Y; i++) out.push(row(""));
    for (const t of rows) out.push(row(t));
    for (let i = 0; i < PAD_Y; i++) out.push(row(""));
    out.push(rule("╰", "╯"));
    return out;
  }

  function stacked(): string[] {
    const logoH = width >= logoW + 2 ? LOGO_ROWS.length : 1;
    const fitsFull2 = width >= fullW && height >= logoH + ROSE_ART.length + 7;
    const fitsSmall2 = width >= smallW && height >= logoH + ROSE_ART_SMALL.length + 7;
    if (fitsFull2 || fitsSmall2 || width >= miniW) {
      const art = fitsFull2 ? ROSE_ART : fitsSmall2 ? ROSE_ART_SMALL : ROSE_ART_MINI;
      out.push("");
      for (let i = 0; i < art.length; i++) out.push(fg(rowColor(i), art[i]!));
      out.push("");
      out.push(...rightCol(width));
      return out;
    }
    const inner = Math.max(10, width - 4);
    out.push(dim("╭" + "─".repeat(inner) + "╮"));
    out.push(`${dim("│")} ${bold(fg(BLUE_LIGHT, info.name))} ${dim(`· ${TAGLINE}`)}`.padEnd(inner + 2) + dim("│"));
    out.push(dim("╰" + "─".repeat(inner) + "╯"));
    out.push("");
    out.push(...rightCol(width));
    return out;
  }

  // 窄屏：玫瑰整幅在下、介绍再往下（放得下完整画像就用完整）
  const fitsFull = width >= fullW && height >= LOGO_ROWS.length + ROSE_ART.length + 7;
  const fitsSmall = width >= smallW && height >= LOGO_ROWS.length + ROSE_ART_SMALL.length + 7;
  if (fitsFull || fitsSmall || width >= miniW) {
    const art = fitsFull ? ROSE_ART : fitsSmall ? ROSE_ART_SMALL : ROSE_ART_MINI;
    out.push("");
    for (let i = 0; i < art.length; i++) out.push(fg(rowColor(i), art[i]!));
    out.push("");
    out.push(...rightCol(width));
    return out;
  }

  const inner = Math.max(10, width - 4);
  out.push(dim("╭" + "─".repeat(inner) + "╮"));
  out.push(`${dim("│")} ${bold(fg(BLUE_LIGHT, info.name))} ${dim(`· ${TAGLINE}`)}`.padEnd(inner + 2) + dim("│"));
  out.push(dim("╰" + "─".repeat(inner) + "╯"));
  out.push("");
  out.push(...sessionCard(width, info));
  return out;
}

/** 会话信息卡（pi 的 SessionPanel 形状：胶囊标签 + 值） */
export function sessionCard(width: number, info: PortraitInfo): string[] {
  const rows: [string, string][] = [
    ["模型", info.model],
    ["档位", info.tier],
    ["目录", info.cwd],
    ["会话", info.sessionId],
    ["记忆", `${info.memories ?? 0} 条事实（/memory 看图）`],
  ];
  return rows.map(([k, v]) => {
    const label = chip(` ${k} `, "48;5;24", "38;5;255");
    const room = Math.max(8, width - 10);
    return `  ${label} ${v.length > room ? `${v.slice(0, room - 1)}…` : v}`;
  });
}
