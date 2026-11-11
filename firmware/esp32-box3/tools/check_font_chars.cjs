#!/usr/bin/env node
/**
 * 核对生成的 LVGL 字体 .c 里到底有没有屏上要显示的字符。
 *
 * 用法:  node tools/check_font_chars.cjs
 *
 * 做的事:
 *   1) 从 main/font/tihu_font_20.c、tihu_font_15.c 里解析 cmap 的 unicode 列表;
 *   2) 从 main/ui.c、ui_board.c、ui_progress.c、ui_done.c 里抓出所有 C 字符串字面量
 *      (默认文案/初始文案都在里面) 以及 tools/chars.txt 的全部字符;
 *   3) 报出每个字体缺哪些字符, 缺字则退出码 1 (可用于 CI/烧机前自检)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fonts = ['main/font/tihu_font_20.c', 'main/font/tihu_font_15.c'];
const sources = ['main/ui.c', 'main/ui_board.c', 'main/ui_progress.c', 'main/ui_done.c'];

function parseCmap(file) {
  const text = fs.readFileSync(file, 'utf8');
  // 先收集所有 unicode_list_N 数组
  const lists = {};
  const listRe = /static const uint16_t (unicode_list_\d+)\[\] = \{([\s\S]*?)\};/g;
  let m;
  while ((m = listRe.exec(text)) !== null) {
    lists[m[1]] = m[2]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 16));
  }
  // 再逐个 cmap 块解析 (range_start / range_length / unicode_list)
  const starts = [];
  const blockRe = /\.range_start = (\d+), \.range_length = (\d+),[^}]*?\.unicode_list = ([A-Za-z0-9_]+)/g;
  while ((m = blockRe.exec(text)) !== null) {
    starts.push({ start: Number(m[1]), len: Number(m[2]), list: m[3] });
  }
  const cps = new Set();
  for (const r of starts) {
    const list = r.list === 'NULL' ? null : lists[r.list];
    if (list && list.length > 0) {
      for (const off of list) cps.add(r.start + off);
    } else {
      for (let k = 0; k < r.len; k++) cps.add(r.start + k);
    }
  }
  const glyphCount = (text.match(/\{\.bitmap_index =/g) || []).length;
  const bpp = (text.match(/\.bpp = (\d+)/) || [, '?'])[1];
  const fmt = (text.match(/\.bitmap_format = (\d+)/) || [, '?'])[1];
  return { cps, glyphCount, bpp, fmt, cmaps: starts };
}

function literalChars(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  // 串口日志里的字不上屏，不用进字库（否则会一直误报缺字）。
  // ESP_LOGx 常跨多行，这里用括号配平把整条调用跳过。
  let inLog = false;
  let balance = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!inLog && /ESP_LOG[A-Z]?\s*\(/.test(line)) {
      inLog = true;
      balance = 0;
    }
    if (inLog) {
      for (const ch of line) {
        if (ch === '(') balance++;
        else if (ch === ')') balance--;
      }
      if (balance <= 0) inLog = false;
      continue;
    }
    const re = /"((?:[^"\\\n]|\\.)*)"/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      for (const ch of m[1]) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7e) out.add(ch);
      }
    }
  }
  return out;
}

const required = new Set();
for (const s of sources) {
  if (!fs.existsSync(path.join(root, s))) continue;
  for (const ch of literalChars(path.join(root, s))) required.add(ch);
}
// 用户点名的几屏文案 (首屏/棋盘/进度/完成)
for (const ch of '鹈鹕 BOX-3B连接中按住 CONFIG 说话主页停止重读棋盘进度完成等你在跑排队任务失败没有空取消继续播放暂停第页步共条个秒分时用') {
  required.add(ch);
}
const charsTxt = fs.readFileSync(path.join(root, 'tools/chars.txt'), 'utf8');
const charsOnly = Array.from(new Set(Array.from(charsTxt.replace(/^#.*$/gm, '')).filter((c) => c.codePointAt(0) > 0x7e)));

let bad = false;
for (const f of fonts) {
  const info = parseCmap(path.join(root, f));
  const missing = [...required].filter((ch) => !info.cps.has(ch.codePointAt(0)));
  const missingCharsTxt = charsOnly.filter((ch) => !info.cps.has(ch.codePointAt(0)));
  console.log(
    `${path.basename(f)}: glyphs=${info.glyphCount} bpp=${info.bpp} bitmap_format=${info.fmt} ` +
      `cmaps=${info.cmaps.map((c) => `${c.start}+${c.len}`).join(',')} unicode=${info.cps.size}`
  );
  if (missing.length) {
    bad = true;
    console.log(`  缺屏上字符 (${missing.length}): ${missing.join('')}`);
    console.log(`  码位: ${missing.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ')}`);
  } else {
    console.log('  屏上字符全部命中');
  }
  if (missingCharsTxt.length) {
    console.log(`  chars.txt 里有但字体缺 (${missingCharsTxt.length}): ${missingCharsTxt.join('')}`);
    bad = true;
  }
}
process.exit(bad ? 1 : 0);
