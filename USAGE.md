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

Put your brand guide, logos and fonts in `context/` in the new repo so every video follows them.
