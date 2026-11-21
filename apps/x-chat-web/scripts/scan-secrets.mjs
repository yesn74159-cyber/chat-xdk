import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = new Set([".js", ".mjs", ".json", ".md", ".html", ".css"]);
const secretPatterns = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\bX_ACCESS_TOKEN\s*[:=]\s*["'`][^"'`\s]+/,
  /\b(?:ghp|github_pat|xox[abprs])_[A-Za-z0-9_-]{16,}/,
];

export function findingsForText(text) {
  const findings = [];
  for (const pattern of secretPatterns) {
    const match = pattern.exec(text);
    if (match) findings.push(text.slice(0, match.index).split("\n").length);
  }
  return findings;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function scan(root) {
  const files = ["README.md", "package.json", "server.mjs"].map((file) => resolve(root, file));
  for (const directory of ["docs", "lib", "public", "scripts", "test"])
    files.push(...(await sourceFiles(resolve(root, directory))));
  const findings = [];
  for (const file of files) {
    for (const line of findingsForText(await readFile(file, "utf8"))) {
      findings.push(`${relative(root, file)}:${line}`);
    }
  }
  return findings;
}

const ownFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const findings = await scan(root);
  if (findings.length) {
    console.error(`Potential secret in ${findings.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Secret guard passed");
  }
}
