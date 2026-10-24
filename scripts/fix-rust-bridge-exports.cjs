// Baileys >= 7.0.0-rc10 imports `whatsapp-rust-bridge`, whose package.json exports only an "import" entry. This app
// is CommonJS under tsx, so resolution uses "require" conditions and fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
// Node >= 22.12 can require() ESM natively, so exposing the same file under "require" is enough. Runs on postinstall.
// (patch-package cannot generate this patch here because its temp install is blocked by npm's install-script gating.)
const fs = require('fs')
const path = require('path')
const pkgPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-rust-bridge', 'package.json')
if (!fs.existsSync(pkgPath)) process.exit(0)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const root = pkg.exports && pkg.exports['.']
if (!root || typeof root !== 'object' || root.require) process.exit(0)
pkg.exports['.'] = { types: root.types, import: root.import, require: root.import, default: root.import }
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('[postinstall] whatsapp-rust-bridge: added "require" export for CommonJS consumers')
