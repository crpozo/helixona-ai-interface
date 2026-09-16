#!/usr/bin/env node
/**
 * Builds the HIPAA documents for the clinic from the content under `content/`:
 *   - Word files (.docx) into packages/web/public/docs/ (served at /docs/<file> for download)
 *   - JSON trees into packages/web/src/docs/ (rendered by the app's Documentation page)
 * Run `npm install` once in this folder, then `node build.js`.
 */
const fs = require("fs");
const path = require("path");
const { renderDocx } = require("./render-docx");

const docs = ["risk", "policies", "training"].map((name) => require(`./content/${name}`));
const webRoot = path.resolve(__dirname, "../../packages/web");
const docxDir = path.join(webRoot, "public/docs");
const jsonDir = path.join(webRoot, "src/docs");

(async () => {
  fs.mkdirSync(docxDir, { recursive: true });
  fs.mkdirSync(jsonDir, { recursive: true });
  for (const doc of docs) {
    const docxPath = path.join(docxDir, doc.docx);
    fs.writeFileSync(docxPath, await renderDocx(doc));
    const jsonPath = path.join(jsonDir, `${doc.slug}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(doc) + "\n");
    console.log(`${doc.title}: ${path.relative(process.cwd(), docxPath)}, ${path.relative(process.cwd(), jsonPath)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
