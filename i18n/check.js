// lists interface texts in the code that have no Russian translation yet:
//   node i18n/extract.js renderer/app.js renderer/engine.js renderer/audio.js   (writes i18n-found.json; needs acorn + acorn-walk)
//   node i18n/check.js i18n-found.json
// then add "English<TAB>Russian" lines to i18n/extra.tsv and run: node i18n/build.js renderer/i18n-ru.js
global.window = global;
require('../renderer/i18n-ru.js');
const found = require(require('path').resolve(process.argv[2] || 'i18n-found.json'));
const { exact, tpl } = window.I18N_RU;
const have = new Set([...Object.keys(exact), ...tpl.map(t => t[0])]);
const miss = found.filter(x => !have.has(x.s.trim()));
for (const x of miss) console.log(`${x.at}\t${JSON.stringify(x.s)}`);
console.log(`${miss.length} of ${found.length} texts have no translation (some are names, units or code — those can stay)`);
