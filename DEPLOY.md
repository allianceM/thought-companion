# Deploy To GitHub + Hugging Face Spaces

This project is ready for the same deployment path as the presentation coach.

## 1. GitHub

Create a new GitHub repository, then from this folder:

```bash
git init
git add .
git commit -m "Initial thought companion app"
git branch -M main
git remote add origin https://github.com/allianceM/thought-companion.git
git push -u origin main
```

## 2. Hugging Face Spaces

Create a Docker Space named `thought-companion`, then upload this folder:

```bash
$HOME/Library/Python/3.9/bin/hf upload allianceM/thought-companion . . \
  --repo-type space \
  --exclude ".env" \
  --exclude ".git/*" \
  --exclude ".server.pid" \
  --exclude "logs/*" \
  --exclude "dist/*" \
  --exclude "node_modules/*" \
  --commit-message "Initial Space deployment"
```

In the Space settings, add secrets:

- `OPENAI_API_KEY`
- `ACCESS_CODE`

Then open the Space URL and enter the access code.
