# GitHub tokens

Ottr uses two kinds of GitHub credentials. The token asked at onboarding (the "Create admin" form) is the board token: it drives the GitHub API and `gh` — PR reviews, CI watch, the hourly Dependabot/PR watch, releases, the expiry probe, and the model-roles editor's commit of `config.yml` to the Alate data repo. The board token also serves the board's own git fetches and pushes on `github.com` itself: the worker image's git credential helper is pinned to `https://github.com` (`Dockerfile.worker`). Git on the configured GitHub host — a `*.ghe.com` Enterprise Cloud host or GitHub Enterprise Server — reuses the board token when **Settings → Other git hosts** has no entry for that host; an entry for the host wins. Git on any other host needs its own per-host token under **Settings → Other git hosts**. That section still offers to store the board token for the configured host: the button only stores after a live test, never on its own.

The server's GitHub API fetches (GitHub App, trending scan, releases watch, branch-rule and auth probes, expiry probe) retry a `429`, a `502`/`503`/`504`, or a `403` that carries `Retry-After` or `x-ratelimit-remaining: 0`. The wait follows `Retry-After` or `x-ratelimit-reset`, capped at 4 seconds, with jittered exponential backoff and 3 attempts at most. Only repeat-safe requests (GET, HEAD) retry; a POST that creates something never retries. A wait above the cap stops, and the caller's next poll handles the error.

The trending scan and the releases watch read public `api.github.com` data on every board. A `github.com` board sends the board token (`GH_TOKEN`). Another host sends only the stored `github.com` token from **Settings → GitHub**: `GH_TOKEN` there is the board host's own token, so it never goes to `api.github.com`. With no stored `github.com` token, the scan's requests share the unauthenticated limit of 60 per hour of the network's IP. The **Trending scout** row in a project's settings shows a hint then, and a failed scan names it in its error. A `403` or `429` whose headers say the limit is used up is reported as a rate limit with its reset time.

### Recommended token

Use a fine-grained personal access token:

| Permission | Why |
| --- | --- |
| Metadata: Read | always granted; expiry probe, repo lookups |
| Contents: Read and write | clone, fetch, merge pushes, releases, and the Alate data-repo `config.yml` commit |
| Pull requests: Read and write | Dependabot/PR watch cards, posting PR reviews |
| Issues: Read and write | Issue watch: reading new issues and adding the `ottr-tracked` label |
| Actions: Read and write | CI watch after merges; **Re-run failed jobs** on a card whose text links a run in the project's own repository |
| Workflows: Read and write | only if tasks may change `.github/workflows` files; without it, a push that touches a workflow file fails |
| Administration: Read and write | only for **Add project → New** with a GitHub repo (`gh repo create`); the repo is created under your user account, not an org |

A classic token also works: the `repo` scope covers everything above, plus the `workflow` scope only if tasks change workflow files.

### Read-only token for turns

Agent turns get their own optional token under **Settings → GitHub → Read-only GitHub token for turns**. A turn uses it to read pull requests, Actions runs, CI logs and private repositories; it never pushes. A fine-grained personal access token with read-only Repository permissions is the supported shape. A classic token cannot be read-only for private repositories (its `repo` scope grants write), so the board checks each saved token against the project repositories, shows a warning for a write-capable token, and uses it only after you confirm.

The weekly trending scout gets no token and no project env values. It reads third-party repository text, so its GitHub reads are public and unauthenticated.

Every turn strips `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` from its environment. `GH_ENTERPRISE_TOKEN` in a `workers/<project>/env.txt` no longer reaches turns: this setting is the only supported delivery. On an Enterprise host the token reaches a turn as `GH_HOST` plus `GH_ENTERPRISE_TOKEN`; on `github.com` as `GH_TOKEN`. Local server-side runs (merge turns) keep the board token and stay unchanged. Spec: [specs/turn-read-token.md](specs/turn-read-token.md).

### Enterprise orgs

- A fine-grained token reaches only the repositories of its resource owner, so for an org repository the token must be owned by (or authorized for) the org. If the org does not allow org-owned fine-grained tokens for members, use a classic token.
- With SAML SSO enforced, authorize the token for the org under **Settings → Developer settings → Tokens (classic) → Configure SSO → Authorize**. Without that step, git shows a bare `403`.
- Git over HTTPS to a `*.ghe.com` host reuses the board token when **Settings → Other git hosts** has no entry for it; an entry for the host wins. With neither, the clone fails with `fatal: could not read Username for 'https://<host>': terminal prompts disabled` — store a token for the host under **Settings → Other git hosts**.

### GitHub App setup

Do these steps once, so posted PR reviews show as `ottr[bot]`:

1. On GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Name the app `Ottr`. When the name is taken, use `Ottr-<owner>`.
3. Leave the webhook off.
4. Set the permissions: **Pull requests: Read and write** and **Metadata: Read**.
5. Generate a private key and download the PEM file.
6. Install the app on the repositories to review.
7. Paste the App ID and the PEM into Ottr under **Settings → GitHub → GitHub App**.

Spec: [specs/github-app.md](specs/github-app.md).

