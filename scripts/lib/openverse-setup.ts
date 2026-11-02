// Registers an Openverse API application for a deployment and stores its credentials on the site, so music search
// gets a registered app's rate limits instead of the anonymous ones Netlify Functions share by outbound address.
// Openverse emails a verification link; until it's clicked the app has anonymous limits.
import { setSiteVars, type Site } from './netlify-setup.js'

export const OPENVERSE_REGISTER = 'https://api.openverse.org/v1/auth_tokens/register/'

/** App names must be unique across every Openverse application, so the deployment's host is part of it. */
export const defaultAppName = (site: Site) => `Video Agent (${new URL(site.ssl_url).host})`

export const defaultDescription = (site: Site) =>
  `Netlify Video Agent at ${site.ssl_url}: lets a team search CC0 and CC BY music on Openverse and import a track into ` +
  `its video library. Attribution for CC BY tracks is shown on published videos. Searches go through the ` +
  `deployment's server, a few per person per session.`

export class OpenverseSetupError extends Error {}

/**
 * Registers the app and sets OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET (secret) on the site. Returns the app
 * name; the secret is never returned or printed (Openverse can't show it again, so it goes straight to the site).
 */
export async function registerOpenverse(o: {
  netlifyToken: string
  site: Site
  name: string
  description: string
  email: string
  fetchImpl?: typeof fetch
}): Promise<{ name: string }> {
  const fetchImpl = o.fetchImpl ?? fetch
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email))
    throw new OpenverseSetupError('Enter a valid email address.')
  const res = await fetchImpl(OPENVERSE_REGISTER, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'netlify-video-agent-setup',
    },
    body: JSON.stringify({ name: o.name.slice(0, 150), description: o.description, email: o.email }),
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.status === 429)
    throw new OpenverseSetupError('Openverse is rate limiting registrations. Try again later.')
  if (res.status !== 201 || typeof body?.client_id !== 'string' || typeof body.client_secret !== 'string') {
    const why = body ? JSON.stringify(body).slice(0, 300) : `HTTP ${res.status}`
    throw new OpenverseSetupError(
      /name/i.test(why) && /exist|unique|taken/i.test(why)
        ? `An Openverse app called "${o.name}" already exists. Pass --name with another name.`
        : `Openverse didn't register the app: ${why}`,
    )
  }
  await setSiteVars(
    o.netlifyToken,
    o.site,
    [
      { key: 'OPENVERSE_CLIENT_ID', value: body.client_id },
      { key: 'OPENVERSE_CLIENT_SECRET', value: body.client_secret, secret: true },
    ],
    fetchImpl,
  )
  return { name: typeof body.name === 'string' ? body.name : o.name }
}
