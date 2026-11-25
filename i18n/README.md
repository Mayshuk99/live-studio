# Interface translations

The interface is written in English in the code. `renderer/i18n.js` swaps every text that appears on screen for its
translation (Settings → Interface → Language). The Russian texts are in `renderer/i18n-ru.js`, generated from:

- `strings.json` — the English texts found in the code (numbered), and `ru-*.tsv` — `number<TAB>Russian`
- `extra.tsv` — `English<TAB>Russian`, for everything added later (use `{0}`, `{1}` for parts that change)

After changing the interface: `node i18n/extract.js renderer/app.js renderer/engine.js renderer/audio.js`,
`node i18n/check.js i18n-found.json` to see what is new, add those to `extra.tsv`, then
`node i18n/build.js renderer/i18n-ru.js`.
