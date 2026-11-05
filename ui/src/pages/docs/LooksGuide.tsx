// /docs/looks (plan 2026-11-04-looks §6): every look in this deployment's catalog, and how to use looks from the API and
// MCP. The SDK and CLI sections are added with their looks commands (beads va-nifa.5.1, 5.2), so this page never
// documents a command that doesn't exist yet.
import { Anchor, Code, Text } from '@mantine/core'
import { useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/bits'
import { CodeBlock } from '../../components/CodeBlock'
import { useLooks } from '../../components/LookPicker'
import '../../components/look-picker.css'
import { aspectNote, type Look } from '../../lib/looks'
import { DocSections } from './DocsLayout'

const REPO_LOOKS = 'https://github.com/netlify-labs/video-agent/blob/main/looks/README.md'

/** A look's poster; its clip plays while hovered or focused. */
function LookFigure({ look }: { look: Look }) {
  const [play, setPlay] = useState(false)
  const note = aspectNote(look)
  return (
    <figure
      className="va-look-card va-raised"
      style={{ margin: 0, paddingBottom: 10 }}
      tabIndex={0}
      data-look={look.id}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setPlay(true)
      }}
      onPointerLeave={() => {
        setPlay(false)
      }}
      onFocus={() => {
        setPlay(true)
      }}
      onBlur={() => {
        setPlay(false)
      }}
    >
      <div className="va-look-frame" style={{ borderRadius: 'inherit' }}>
        {look.preview.poster ? <img src={look.preview.poster} alt="" loading="lazy" /> : null}
        {play && look.preview.mp4 ? (
          <video src={look.preview.mp4} preload="none" muted loop playsInline autoPlay />
        ) : null}
      </div>
      <figcaption className="va-look-text">
        <Text size="sm" fw={600}>
          {look.name} <Code>{look.id}</Code>
          {look.enabled ? null : <span className="va-look-mark">Turned off here</span>}
        </Text>
        <Text size="xs" c="var(--va-muted)">
          {look.description}
        </Text>
        {look.bestFor.length ? (
          <Text size="xs" c="var(--va-faint)" mt={4}>
            Best for: {look.bestFor.join(', ')}
          </Text>
        ) : null}
        {note ? (
          <Text size="xs" c="var(--va-faint)" mt={4}>
            {note}
          </Text>
        ) : null}
      </figcaption>
    </figure>
  )
}

export default function LooksGuidePage() {
  const looks = useLooks()
  const origin = window.location.origin
  return (
    <>
      <PageHeader
        title="Looks"
        sub={
          <>
            A look is a style for a video: its type, colour roles, motion and layout rules. Pick one when you
            make a video, or restyle a video into another. With no look, the agent decides, as before.
          </>
        }
      />
      <DocSections
        sections={[
          {
            id: 'catalog',
            title: 'The looks here',
            description: looks?.default ? (
              <>
                New videos get <Code>{looks.default}</Code> unless the person picks another (an admin
                setting).
              </>
            ) : (
              'New videos get no look unless the person picks one.'
            ),
            children: looks ? (
              <div className="va-look-grid" data-testid="looks-catalog">
                {looks.looks.map((l) => (
                  <LookFigure key={l.id} look={l} />
                ))}
              </div>
            ) : (
              <div className="va-empty">This deployment has no looks.</div>
            ),
          },
          {
            id: 'api',
            title: 'From the API',
            description: (
              <>
                <Code>GET /api/v1/looks</Code> lists them. Create, revise and remix take <Code>look</Code>: an
                id, or <Code>null</Code> for none. Left out, a revision keeps its version&apos;s look, a remix
                keeps the source&apos;s, and a new video gets the admin default. A revision with another look
                is a restyle: a full run that keeps the story and changes the style.
              </>
            ),
            children: (
              <CodeBlock
                lang="http"
                code={`POST ${origin}/api/v1/videos
authorization: Bearer <your API key>
content-type: application/json

{ "prompt": "A 20-second launch video for org webhooks", "look": "kinetic" }`}
              />
            ),
          },
          {
            id: 'mcp',
            title: 'From AI tools (MCP)',
            description: (
              <>
                <Code>list_looks</Code> lists them; <Code>create_video</Code>, <Code>revise_video</Code> and{' '}
                <Code>remix_video</Code> take <Code>look</Code>. Connect as shown under{' '}
                <Anchor component={Link} to="/docs/mcp#connect" c="var(--va-text)" inherit>
                  MCP for AI tools
                </Anchor>
                .
              </>
            ),
            children: (
              <Text size="sm" c="var(--va-muted)">
                For example: “Make a launch video for org webhooks in the Kinetic type look.”
              </Text>
            ),
          },
          {
            id: 'contribute',
            title: 'Add a look',
            description: (
              <>
                A look is a folder in <Code>looks/</Code>: its rules, an example composition and a preview.
                Looks are instructions to the agent, like <Code>context/</Code>, so only people who can change
                the repo add them. See{' '}
                <Anchor href={REPO_LOOKS} c="var(--va-text)" inherit>
                  looks/README.md
                </Anchor>
                .
              </>
            ),
            children: null,
          },
        ]}
      />
    </>
  )
}
