# Your video agent is deploying

Three things finish the setup. The app's `/setup` page checks each one and links to the setting.

1. **Turn on Identity:** Project configuration → Identity → Enable.
   - If `ALLOWED_EMAIL_DOMAINS` is your company domain: keep registration **Open** and **autoconfirm off**, so people must confirm their email.
   - If it is `invite-only`: set registration to **Invite only** and invite people from the Identity tab.
2. **Make sure Agent Runners is available** for your team (a credit-based plan with AI features and credits): this project should have an **Agent Runs** tab.
3. **Create the first admin account.**
   - Company domains: open `https://<your-site>`, sign up with an address from `ADMIN_EMAILS` and confirm it from the email.
   - Invite-only: invite each `ADMIN_EMAILS` address (including your own) from the Identity tab, then accept the invite from the email.
4. **Open `https://<your-site>/setup`**, fix anything it marks, and make your first video.

Optional: to let OAuth-only MCP clients (Claude and ChatGPT connectors) connect with **Sign in with Netlify** instead of an
API key, create a Netlify OAuth app with the redirect URI `https://<your-site>/oauth/callback` and set
`MCP_OAUTH_PROVIDER=netlify`, `NETLIFY_OAUTH_CLIENT_ID` and `NETLIFY_OAUTH_CLIENT_SECRET` (see the README, "Sign in with
Netlify (OAuth)"). `MCP_OAUTH_ALLOWED_EMAIL_DOMAINS` narrows who can connect; it defaults to `ALLOWED_EMAIL_DOMAINS`.

Instead of Netlify Identity, the web app can use **Sign in with Netlify**, optionally limited to members of your
Netlify team: create the OAuth app as above (the same redirect URI) and set `AUTH_PROVIDER=netlify`,
`NETLIFY_OAUTH_CLIENT_ID`, `NETLIFY_OAUTH_CLIENT_SECRET` and, for the team rule, `NETLIFY_REQUIRED_TEAM` (your team's
slug or id). Skip steps 1 and 3: the first sign-in from an `ADMIN_EMAILS` address becomes an admin. See the README,
"Sign in with Netlify for the web app".

Put your brand guide, logos and fonts in `context/` in the new repo so every video follows them.
