# Your video agent is deploying

Three things finish the setup. The app's `/setup` page checks each one and links to the setting.

1. **Check that Identity is on:** Project configuration → Identity. The first deploy turns it on when `RUNNER_API_TOKEN` is set; if you skipped the token, add it and redeploy, or choose Enable there.
   - If `ALLOWED_EMAIL_DOMAINS` is your company domain: keep registration **Open** and **autoconfirm off**, so people must confirm their email.
   - If it is `invite-only`: set registration to **Invite only** and invite people from the Identity tab.
2. **Make sure Agent Runners is available** for your team (a credit-based plan with AI features and credits): this project should have an **Agent Runs** tab.
3. **Open `https://<your-site>/setup`.** The first time it loads, it emails an invite to each `ADMIN_EMAILS` address. Fix anything the page marks.
4. **Create the first admin account:** open the invite email and set a password. No email? Invite the address from the Identity tab, or (with company domains) sign up at `https://<your-site>` and confirm the address.

Optional: to let OAuth-only MCP clients (Claude and ChatGPT connectors) connect with **Sign in with Netlify** instead of an
API key, create a Netlify OAuth app with the redirect URI `https://<your-site>/oauth/callback` and set
`MCP_OAUTH_PROVIDER=netlify`, `NETLIFY_OAUTH_CLIENT_ID` and `NETLIFY_OAUTH_CLIENT_SECRET` (see
"Sign in with Netlify (OAuth)" in `docs/guides/ai-tools.md` in your new repo). `MCP_OAUTH_ALLOWED_EMAIL_DOMAINS` narrows who can connect; it defaults to `ALLOWED_EMAIL_DOMAINS`.

Instead of Netlify Identity, the web app can use **Sign in with Netlify**, optionally limited to members of your
Netlify team: create the OAuth app as above (the same redirect URI) and set `AUTH_PROVIDER=netlify`,
`NETLIFY_OAUTH_CLIENT_ID`, `NETLIFY_OAUTH_CLIENT_SECRET` and, for the team rule, `NETLIFY_REQUIRED_TEAM` (your team's
slug or id). Skip steps 1 and 3: the first sign-in from an `ADMIN_EMAILS` address becomes an admin. See
"Sign in with Netlify for the web app" in `docs/guides/deploy.md`.

Optional: **Find music** on the Media page searches Openverse for CC0 and CC BY tracks (CC BY ones are credited on the
video, its share page and the embed automatically). It works anonymously; for steady use, register an Openverse app
with `npm run setup:openverse -- --site <your project> --deploy` (it sets `OPENVERSE_CLIENT_ID` and
`OPENVERSE_CLIENT_SECRET` for you), then click the verification link Openverse emails you.

Put your brand guide, logos and fonts in `context/` in the new repo so every video follows them.
