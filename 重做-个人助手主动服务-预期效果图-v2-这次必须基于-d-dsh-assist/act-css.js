const want = ['7gxqk', 'brmue', '1pq26', '9lTDKa', '2H3hWW', '3Oyx4a', '7tt59G', 'hIlkoa', 'BynINW', '6O3mZG', '9YPp_G', '8-fInG', '1rdzk', 'jADiJW', 'k7ery'];
const out = [];
for (const sheet of document.styleSheets) {
  let rules;
  try { rules = sheet.cssRules; } catch { continue; }
  if (!rules) continue;
  for (const r of rules) {
    const sel = r.selectorText || '';
    if (!sel) continue;
    if (!want.some((k) => sel.includes(k))) continue;
    const decl = r.style ? [...r.style].map((p) => `${p}:${r.style.getPropertyValue(p)}`).join('; ') : '';
    if (!decl) continue;
    out.push(`${sel} { ${decl} }`);
    if (out.length > 140) break;
  }
  if (out.length > 140) break;
}
return out;
