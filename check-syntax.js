const fs = require('fs');
const html = fs.readFileSync('ui/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('No script tag found'); process.exit(1); }
const js = m[1];
fs.writeFileSync('tmp-check.js', js);
