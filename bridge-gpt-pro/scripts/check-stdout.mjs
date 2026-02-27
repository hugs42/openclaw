import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGETS = ["index.ts", "src"];
const FORBIDDEN = /console\.log\s*\(/;

async function collectTsFiles(targetPath) {
  const absolutePath = path.join(ROOT, targetPath);
  const stat = await fs.stat(absolutePath);

  if (stat.isFile()) {
    return [absolutePath];
  }

  const files = [];
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(path.relative(ROOT, fullPath))));
      continue;
    }

    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function findViolations(filePath, content) {
  const lines = content.split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (FORBIDDEN.test(lines[i])) {
      violations.push({ line: i + 1, text: lines[i].trim() });
    }
  }

  return violations;
}

async function main() {
  const allFiles = [];

  for (const target of TARGETS) {
    allFiles.push(...(await collectTsFiles(target)));
  }

  const violations = [];

  for (const filePath of allFiles) {
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = findViolations(filePath, content);

    for (const violation of fileViolations) {
      violations.push({ filePath, ...violation });
    }
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  for (const violation of violations) {
    const relativePath = path.relative(ROOT, violation.filePath);
    process.stderr.write(`${relativePath}:${violation.line}: forbidden console.log -> ${violation.text}\n`);
  }

  process.stderr.write("console.log is forbidden\n");
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`check-stdout failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
