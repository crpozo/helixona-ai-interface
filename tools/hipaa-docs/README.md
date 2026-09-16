# HIPAA documents generator

Source of the three documents the clinic keeps for the Helixona Assistant: the security risk
analysis, the policies and procedures, and the workforce training. One content tree per document
lives under `content/`; `build.js` renders each one twice:

- a Word file in `packages/web/public/docs/` (downloadable at `https://ai.helixona.com/docs/<file>.docx`), and
- a JSON tree in `packages/web/src/docs/`, which the app's Documentation page (`/documentation`) renders on screen.

To change a document, edit the content file, then run:

```bash
cd tools/hipaa-docs
npm install
node build.js
```

Commit the regenerated `.docx` and `.json` files together with the content change. This folder is
not part of the npm workspaces, so the root install and the CI pipeline never touch it.
