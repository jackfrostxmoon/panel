import { readdirSync, readFileSync, statSync } from "fs"
import { join, extname } from "path"

const ROOT = import.meta.dir + "/.."
const EXCLUDE = ["node_modules", "dist", ".git", "data"]
const EXTENSIONS = ["ts", "tsx", "js", "jsx", "css", "scss", "json", "sql", "md", "sh"]

function walk(dir: string, ext: string): number {
  let count = 0
  for (const e of readdirSync(dir)) {
    if (EXCLUDE.includes(e)) continue
    const full = join(dir, e)
    const s = statSync(full)
    if (s.isDirectory()) {
      count += walk(full, ext)
    } else if (extname(e) === `.${ext}`) {
      count += readFileSync(full, "utf8").split("\n").length
    }
  }
  return count
}

console.info("=== Lines of Code by Extension ===\n")

let total = 0
for (const ext of EXTENSIONS) {
  const count = walk(ROOT, ext)
  console.info(`  .${ext.padEnd(5)} ${String(count).padStart(7)} lines`)
  total += count
}

console.info("  ------------------------")
console.info(`  TOTAL ${String(total).padStart(7)} lines`)
