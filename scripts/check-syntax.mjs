import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const src = path.join(root, 'src')
const extensions = ['.js', '.jsx', '.mjs', '.json']
const importPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g
const errors = []
let checkedFiles = 0

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(?:js|jsx|mjs)$/.test(entry.name)) checkFile(full)
  }
}

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, ...extensions.map((ext) => `${base}${ext}`)]
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    candidates.push(...extensions.map((ext) => path.join(base, `index${ext}`)))
  }
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function checkFile(file) {
  checkedFiles += 1
  const content = fs.readFileSync(file, 'utf8')
  let match
  while ((match = importPattern.exec(content))) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    if (!resolveRelative(file, specifier)) {
      errors.push(`${path.relative(root, file)} -> ${specifier}`)
    }
  }
}

walk(src)

if (errors.length) {
  console.error('Missing relative imports:')
  errors.forEach((error) => console.error(` - ${error}`))
  process.exit(1)
}

console.log(`OK: ${checkedFiles} source files checked; all relative imports resolve.`)
