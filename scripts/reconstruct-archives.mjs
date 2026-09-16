import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function reconstruct(sourceDir, prefix, target) {
  const dir = path.join(root, sourceDir)
  const parts = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.includes('.part'))
    .sort()

  if (!parts.length) throw new Error(`No archive parts found for ${prefix}`)

  const content = parts
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('')

  const output = path.join(root, target)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, content)
  console.log(`Reconstructed ${target} from ${parts.length} parts (${content.length} chars)`)
}

reconstruct('.archive/legacy', 'restaurant_app.html.part', 'legacy/restaurant_app.html')
reconstruct('.archive/supabase', '0001_restos_baseline.sql.part', 'supabase/migrations/0001_restos_baseline.sql')
