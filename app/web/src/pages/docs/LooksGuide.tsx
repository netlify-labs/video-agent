// /docs/looks (plan 2026-11-04-looks §6): every look in this deployment's catalog, and how to use looks from the API,
// the SDK, the CLI and MCP.
import { Anchor, Code, Text } from '@mantine/core'
import { useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '../../components/bits'
import { CodeBlock } from '../../components/CodeBlock'
import { useLooks } from '../../components/LookPicker'
import '../../components/look-picker.css'
import { aspectNote, type Look } from '../../lib/looks'
import { DocSections } from './DocsLayout'

const REPO_LOOKS = 'https://github.com/netlify-labs/video-agent/blob/main/app/looks/README.md'

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
            A look is a style for a video. It sets the type, color roles, motion, and layout rules. Choose a
            look when you make a video, or restyle an existing video with a different look. If you don&apos;t
            choose a look, the agent decides the style.
          </>
        }
      />
      <DocSections
        sections={[
          {
            id: 'catalog',
            title: 'Looks in this deployment',
            description: looks?.default ? (
              <>
                New videos use the <Code>{looks.default}</Code> look unless you choose another one. An admin
                sets this default.
              </>
            ) : (
              'New videos have no look unless you choose one.'
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
            title: 'Use looks from the API',
            description: (
              <>
                To list the looks, call <Code>GET /api/v1/looks</Code>. The create, revise, and remix requests
                take a <Code>look</Code> field. Set it to a look ID, or to <Code>null</Code> for no look. If
                you leave out <Code>look</Code>, a revision keeps the look of its version, a remix keeps the
                look of its source video, and a new video gets the admin default. A revision that sets a
                different look is a restyle. A restyle is a full run that keeps the story and changes the
                style.
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
            id: 'sdk',
            title: 'Use looks from the SDK',
            description: (
              <>
                To list the looks, call <Code>va.looks.list()</Code>. To choose one, pass <Code>look</Code> to{' '}
                <Code>videos.create</Code>, <Code>revise</Code>, or <Code>remix</Code>. For more, see{' '}
                <Anchor component={Link} to="/docs/sdk#looks" c="var(--va-text)" inherit>
                  TypeScript SDK
                </Anchor>
                .
              </>
            ),
            children: (
              <CodeBlock
                lang="ts"
                code={`const { looks } = await va.looks.list()
await va.videos.create({ prompt: 'A 20-second launch video for org webhooks', look: 'kinetic' })`}
              />
            ),
          },
          {
            id: 'cli',
            title: 'Use looks from the command line',
            description: (
              <>
                To list the looks, run <Code>video-agent looks</Code>. To choose one, add <Code>--look</Code>{' '}
                to <Code>create</Code>, <Code>revise</Code>, or <Code>remix</Code>. Use{' '}
                <Code>--look none</Code> for no look. To make the next version of a video with a different
                look, run <Code>video-agent restyle</Code>. To try a look on your own computer before it
                reaches a deployment, run <Code>video-agent local --look</Code>. This also works with a look
                folder that you&apos;re still writing.
              </>
            ),
            children: (
              <CodeBlock
                lang="http"
                code={`video-agent looks
video-agent create "A 20-second launch video for org webhooks" --look kinetic --wait
video-agent restyle vid_01… terminal --wait
video-agent local --look ./looks/my-look "A 20-second launch video for org webhooks"`}
              />
            ),
          },
          {
            id: 'mcp',
            title: 'Use looks from AI tools (MCP)',
            description: (
              <>
                The <Code>list_looks</Code> tool lists the looks. The <Code>create_video</Code>,{' '}
                <Code>revise_video</Code>, and <Code>remix_video</Code> tools take a <Code>look</Code>{' '}
                argument. To connect your AI tool, see{' '}
                <Anchor component={Link} to="/docs/mcp#connect" c="var(--va-text)" inherit>
                  MCP for AI tools
                </Anchor>
                .
              </>
            ),
            children: (
              <Text size="sm" c="var(--va-muted)">
                For example, ask: “Make a launch video for org webhooks in the Kinetic type look.”
              </Text>
            ),
          },
          {
            id: 'contribute',
            title: 'Add a look',
            description: (
              <>
                A look is a folder in <Code>app/looks/</Code>. The folder holds the look&apos;s rules, an
                example composition, and a preview. Looks are instructions to the agent, like the files in{' '}
                <Code>context/</Code>, so only people who can change the repository can add one. For the
                steps, see{' '}
                <Anchor href={REPO_LOOKS} c="var(--va-text)" inherit>
                  app/looks/README.md
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
