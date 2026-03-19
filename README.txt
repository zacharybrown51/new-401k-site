# 401k Tool - Netlify Version

This package is ready for a GitHub -> Netlify deploy.

## What changed
- `index.html` no longer calls Anthropic directly from the browser.
- A Netlify Function at `/.netlify/functions/analyze` now makes the Anthropic API call.
- Your Anthropic API key should be stored in Netlify as an environment variable named `ANTHROPIC_API_KEY`.

## Folder structure
- `index.html`
- `netlify/functions/analyze.js`
- `netlify.toml`

## Deploy steps
1. Create a new GitHub repo.
2. Upload all files in this folder to the repo.
3. In Netlify, choose **Add new project** -> **Import an existing project** -> GitHub.
4. Select the repo and deploy.
5. In Netlify, go to:
   - Site configuration / Project configuration
   - Environment variables
   - Add `ANTHROPIC_API_KEY`
6. Paste your Anthropic API key as the value.
7. Trigger a redeploy.

## Test
After deploy, open:
- `https://YOUR-SITE.netlify.app/.netlify/functions/analyze`

A GET request should return a method error. That means the function exists.

Then open the site and test the Filing Analyzer with a PDF.
