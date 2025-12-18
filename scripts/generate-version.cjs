const { execSync } = require('child_process');
const { mkdirSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const runGitCommand = (command, fallback) => {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
};

const shortHash = runGitCommand('git rev-parse --short HEAD', 'unknown');
const isDirty = runGitCommand('git status --porcelain', '').length > 0;
const version = `${shortHash}${isDirty ? '-dirty' : ''}`;
const buildTime = new Date().toISOString();

const outDir = resolve(__dirname, '../src/generated');
mkdirSync(outDir, { recursive: true });

const content = `// This file is generated during build/dev.\nexport const APP_VERSION = '${version}';\nexport const BUILD_TIME_ISO = '${buildTime}';\n`;
writeFileSync(resolve(outDir, 'version.ts'), content, 'utf8');

console.log(`Generated version.ts => v ${version} @ ${buildTime}`);
