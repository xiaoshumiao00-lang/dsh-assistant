const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grab = (el, keys) => {
  if (!el) return null;
  const s = getComputedStyle(el);
  const o = { cls: String(el.className).split(' ')[0].slice(0, 40), tag: el.tagName };
  for (const k of keys) o[k] = s[k];
  return o;
};
const K = ['backgroundColor', 'color', 'borderRadius', 'border', 'padding', 'height', 'width', 'fontSize', 'fontWeight', 'boxShadow'];
const tuoguan = document.querySelector('[data-tuoguan-toggle]');
const sendBtn = [...document.querySelectorAll('button')].find((b) => /发送|新会话/.test(b.textContent) || b.getAttribute('aria-label') === '发送');
const pillMore = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '加载更早');
const tabs = [...document.querySelectorAll('[class*="_tab"]')].slice(0, 3).map((t) => grab(t, K));
const inlineCode = document.querySelector('code, [class*="inlineCode"], [class*="codeInline"]');
const titleRow = document.querySelector('[class*="titleRow"], [class*="header"]');
const card = document.querySelector('[data-composer-card="true"]');
const avatarImg = document.querySelector('[class*="avatar"] img, img[alt=""]');
return {
  tuoguan: grab(tuoguan, K),
  send: grab(sendBtn, K),
  more: grab(pillMore, K),
  tabs,
  code: grab(inlineCode, K),
  card: grab(card, K),
  title: grab(titleRow, ['backgroundColor', 'color', 'fontSize', 'fontWeight', 'padding', 'borderBottom']),
  computedVarBusiness: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-state-business-primary') || null,
  bodyStart: document.body.innerText.slice(0, 90).replace(/\n/g, ' | '),
  bgProbe: [...document.querySelectorAll('div')].map((e) => ({ cls: String(e.className).split(' ')[0].slice(0, 34), bg: getComputedStyle(e).backgroundColor })).filter((x) => x.bg !== 'rgba(0, 0, 0, 0)').slice(0, 18),
};
