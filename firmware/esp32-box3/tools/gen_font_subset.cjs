#!/usr/bin/env node
/**
 * 用 lv_font_conv 的 JS API 生成两个 LVGL 字体。
 *
 * 为什么不直接在 PowerShell 里调 lv_font_conv CLI：
 *   Windows 上 npx.cmd 会经过 cmd.exe，中文 --symbols 会被按 ANSI 代码页重编码，
 *   生成的字模和注释都会变成乱码（本项目实际踩过）。这里由 Node 直接读 UTF-8
 *   的 chars.txt，字符不经过命令行参数。
 *
 * 参数（PowerShell 脚本会传）：
 *   argv[2] 字体路径
 *   argv[3] 输出目录
 *   argv[4] 字号列表，如 "20,15"
 * 环境变量：
 *   LV_FONT_CONV_CLI  lv_font_conv.js 的绝对路径
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cliPath = process.env.LV_FONT_CONV_CLI;
if (!cliPath || !fs.existsSync(cliPath)) {
  console.error('LV_FONT_CONV_CLI 未设置或文件不存在: ' + cliPath);
  process.exit(1);
}

const convert = require(path.join(path.dirname(cliPath), 'lib', 'convert'));

const fontPath = process.argv[2];
const outDir = process.argv[3];
const sizes = String(process.argv[4] || '20,15')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

if (!fontPath || !fs.existsSync(fontPath)) {
  console.error('字体文件不存在: ' + fontPath);
  process.exit(1);
}
if (!outDir) {
  console.error('缺少输出目录');
  process.exit(1);
}
if (sizes.length === 0) {
  console.error('没有有效字号');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const charsPath = path.join(__dirname, 'chars.txt');
const raw = fs.readFileSync(charsPath, 'utf8');

// 去掉 # 开头的说明行和所有空白；按码点去重（不能按 UTF-16 code unit 切）。
const body = raw
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('')
  .replace(/\s+/gu, '');
const symbols = Array.from(new Set(Array.from(body))).join('');

if (Array.from(symbols).length < 100) {
  console.error('chars.txt 里的唯一字符太少: ' + Array.from(symbols).length);
  process.exit(1);
}

console.log(`字体     : ${fontPath}`);
console.log(`字符表   : ${charsPath}`);
console.log(`唯一字符 : ${Array.from(symbols).length}`);
console.log(`输出目录 : ${outDir}`);

(async () => {
  for (const size of sizes) {
    const name = `tihu_font_${size}`;
    const output = path.join(outDir, `${name}.c`);
    console.log(`生成 ${name} (${size}px, 4bpp) -> ${output}`);

    const files = await convert({
      font: [
        {
          source_path: fontPath,
          // 与 CLI 一样把字体二进制读进来；convert() 不会自己读文件。
          source_bin: fs.readFileSync(fontPath),
          ranges: [
            { range: [0x20, 0x7e, 0x20] },
            { symbols },
          ],
        },
      ],
      size,
      bpp: 4,
      format: 'lvgl',
      lv_include: 'lvgl.h',
      lv_font_name: name,
      force_fast_kern_format: true,
      output,
      // 关键：不压缩位图（等价 CLI 的 --no-compress）。
      // lv_font_conv 默认会把 4bpp 位图压成 RLE 变体并写 .bitmap_format = 1，
      // 而 .bitmap_format = 1 只有开了 LV_USE_FONT_COMPRESSED 的固件才解得开；
      // 没开时 lv_font_get_bitmap_fmt_txt 直接返回 NULL，LVGL 就按「缺字形」
      // 在屏上画 1px 空心方框（2026-11-11 真机中文全方框就是这个）。
      no_compress: true,
      // 只影响生成的注释行，保持 ASCII 便于排查。
      opts_string: `--size ${size} --bpp 4 --format lvgl --no-compress --symbols <chars.txt>`,
    });

    for (const [filename, data] of Object.entries(files)) {
      fs.writeFileSync(filename, data);
    }
  }
  console.log('\n完成。重新编译: idf.py build');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
