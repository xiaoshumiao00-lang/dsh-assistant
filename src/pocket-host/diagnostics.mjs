// 手机端诊断落盘（供 lib/proxy.mjs 的 /.dsh-pocket/diag 使用）。
//
// 目的：手机上取不到 console，也看不到「整页 reload 还是面板抖动」。把三类
// 事实写到固定文件，电脑上直接读：
//   - page     ：HTML 文档请求（整页 reload 的直接证据，含 UA/IP）；
//   - ws-open  ：WebSocket 握手（客户端重连）；
//   - ws-close ：连接关闭（时长、双向字节数、关闭原因）；
//   - client   ：client/orb/diag.ts 的 beacon（启动次数、标题、悬浮球开关）。
//
// 上限：单文件 1 MB；超过后轮转为 diagnostic.jsonl.1（只保留上一代），
// 不会无限增长。读取接口只回最近 200 行。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const MAX_TAIL = 200;

/** $DSH_HOME/dsh-pocket/diagnostic.jsonl（与 uploads 同目录）。 */
export function diagnosticPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-pocket', 'diagnostic.jsonl');
}

function rotate(file) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size <= MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    /* 忽略：轮转失败不应影响代理 */
  }
}

/**
 * 追加一条诊断记录。
 * @param {Record<string, unknown>} record
 */
export function appendDiagnostic(record) {
  try {
    const file = diagnosticPath();
    mkdirSync(dirname(file), { recursive: true });
    rotate(file);
    appendFileSync(file, `${JSON.stringify({ ...record, at: record?.at ?? Date.now() })}\n`, 'utf8');
  } catch {
    /* 诊断永远不能打断业务 */
  }
}

/**
 * 读最近 N 行（解析失败的坏行跳过）。
 * @param {number} [limit]
 * @returns {Array<Record<string, unknown>>}
 */
export function readDiagnosticTail(limit = MAX_TAIL) {
  try {
    const file = diagnosticPath();
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 1000)));
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行/损坏行忽略 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 汇总（给 GET /.dsh-pocket/diag）：最近 N 分钟各类事件计数 + 最近若干条。
 * @param {{ minutes?: number, limit?: number }} [opts]
 */
export function diagnosticSummary({ minutes = 30, limit = 120 } = {}) {
  const since = Date.now() - Math.max(1, minutes) * 60_000;
  const entries = readDiagnosticTail(2000).filter((entry) => Number(entry?.at) >= since);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of entries) {
    const key = String(entry?.ev ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const pages = entries.filter((entry) => entry?.ev === 'page');
  const wsOpen = entries.filter((entry) => entry?.ev === 'ws-open');
  const wsClose = entries.filter((entry) => entry?.ev === 'ws-close');
  return {
    path: diagnosticPath(),
    minutes,
    entries: entries.length,
    counts,
    pages: pages.slice(-50),
    wsOpen: wsOpen.slice(-50),
    wsClose: wsClose.slice(-50),
    tail: entries.slice(-limit),
  };
}
