// pull the interface texts out of the renderer sources (string and template literals that look like words for people)
const acorn = require(process.env.ACORN || 'acorn');
const walk = require(process.env.ACORN_WALK || 'acorn-walk');
const fs = require('fs');
const files = process.argv.slice(2);
const out = new Map(); // text → {kind, file, line}
const SKIP_CALLEE = /^(logEvent|console\.\w+|S\.\w+|\$|document\.querySelector(All)?|querySelector(All)?|classList\.\w+|addEventListener|removeEventListener|setAttribute|getAttribute|removeAttribute|closest|matches|require|registerProcessor|postMessage|send|nativeSend|vstCmd|getContext|createElement|natNote|JSON\.\w+|RegExp|Error|fetch|ipcRenderer\.\w+|startsWith|endsWith|includes|split|join|replace|padStart|padEnd|indexOf|localeCompare|toggle|getItem|setItem|toLocaleTimeString|toLocaleDateString|Intl\.\w+)$/;
const looksUI = s => {
  if (!/[A-Za-z]/.test(s)) return false;
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^[a-z][a-zA-Z0-9_-]*$/.test(t)) return false;          // ids, keys, classes
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 1 && !/^[A-Z]{2,}$/.test(t)) return false;
  if (/^(#|\.|\[|@|\/|\\|data:|https?:|blob:|rgba?\(|hsla?\(|var\(|calc\(|translate|scale|rotate|M\d|url\()/.test(t)) return false;
  if (/^[\w-]+\s*:\s*[^;]*;/.test(t) || /[{}]/.test(t) && /:/.test(t) && !/\{\d\}/.test(t)) return false; // css
  if (/^[\w-]+:\s/.test(t) && /px|%|em|#|rgba|var\(/.test(t)) return false;
  if (/^\d/.test(t) && !/[a-z]{3}/i.test(t)) return false;
  if (/^[a-z-]+( [a-z-]+)+$/.test(t) && !/\b(the|a|to|of|on|is|and|in|for|it|this|no|not|with|from|at)\b/.test(t) && t.split(' ').length <= 4 && !/[A-Z]/.test(t)) return false; // class lists
  if (/\.(js|css|html|json|png|mp4|webm|mkv|exe|wav|mp3|txt|log)$/.test(t)) return false;
  if (/^[a-z-]+:[^\s]/.test(t) || /^--/.test(t) || /^[\w-]+:\s*[\w.#(),%-]+(;|$)/.test(t) && !/\s\w+\s/.test(t)) return false; // css
  if (/^(video|audio|image|application|text)\//.test(t)) return false;                     // mime
  if (/^(Ctrl|Alt|Shift)\+|^(Key|Digit|Arrow|Numpad)[A-Z0-9]\w*$/.test(t)) return false;              // keys
  if (/^\w+:$/.test(t) || /^:\w$/.test(t) || /^[a-z]+,[a-z,]+$/i.test(t) || /^(GET|POST|PUT|DELETE)$/.test(t)) return false;
  if (/^(rtmps?|https?):\/\//.test(t) || /^[\w.]+\.(com|org|net)$/.test(t) || /^…?apps\.googleusercontent/.test(t)) return false;
  if (/^(Arial|Calibri|Verdana|Bahnschrift|Georgia|Impact|Consolas|Segoe UI|Tahoma|Times New Roman|NVIDIA|Intel|AMD|SSL|YouTube|Wirecast|OBS|FFmpeg|Windows|Waves)$/.test(t)) return false;
  if (/^(blur|liveBroadcasts|snippet|font-family|cursor)/.test(t)) return false;
  if (/^\{\d\}(px|%|ms|s)?$/.test(t)) return false;
  return true;
};
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
  const add = (s, node, kind) => { if (looksUI(s) && !out.has(s)) out.set(s, { kind, at: `${file.split('/').pop()}:${node.loc.start.line}` }); };
  walk.fullAncestor(ast, (node, state, anc) => {
    if (node.type !== 'Literal' && node.type !== 'TemplateLiteral') return;
    const parent = anc[anc.length - 2];
    if (!parent) return;
    if (parent.type === 'Property' && parent.key === node) return;
    if (parent.type === 'MemberExpression' && parent.property === node) return;
    if (parent.type === 'BinaryExpression' && ['===', '!==', '==', '!=', 'in', 'instanceof'].includes(parent.operator)) return;
    if (parent.type === 'SwitchCase') return;
    if (parent.type === 'ImportDeclaration') return;
    // inside a call we skip (log, selectors, ipc…)
    for (let i = anc.length - 2; i >= 0; i--) {
      const a = anc[i];
      if (a.type === 'CallExpression' || a.type === 'NewExpression') {
        const c = src.slice(a.callee.start, a.callee.end);
        if (SKIP_CALLEE.test(c) || SKIP_CALLEE.test(c.split('.').slice(-1)[0])) return;
        break;
      }
      if (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression' || a.type === 'FunctionDeclaration') break;
    }
    if (node.type === 'Literal') { if (typeof node.value === 'string') add(node.value, node, 'str'); return; }
    // template: quasis joined with {0} {1}…
    const q = node.quasis.map(x => x.value.cooked);
    if (q.length === 1) { add(q[0], node, 'str'); return; }
    const tpl = q.map((x, i) => i < q.length - 1 ? x + `{${i}}` : x).join('');
    if (/[A-Za-z]{2}/.test(q.join(''))) add(tpl, node, 'tpl');
  });
}
const list = [...out].map(([s, v]) => ({ s, ...v }));
fs.writeFileSync(process.env.OUT || 'i18n-found.json', JSON.stringify(list, null, 1));
console.log(list.length, 'strings;', list.filter(x => x.kind === 'tpl').length, 'templates; chars', list.reduce((a, x) => a + x.s.length, 0));
