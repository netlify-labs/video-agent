// Mock mode (VITE_MOCK=1): realistic data for screenshots and UI tests, built from videos this
// agent actually made (posters and the teaser MP4 in app/web/mock-assets). Never shipped in production builds.
import { looksCatalog } from '../../../server/generated/looks'
import type { Stats, Video } from '../api/client'

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const SITE = window.location.origin

type V = Video['versions'][number]
/** What a HyperFrames version's editor may offer (app/server/domain/engines.ts). */
const hyperframes: V['editing'] = {
  engine: 'hyperframes',
  capabilities: {
    editOps: ['text', 'retime', 'reorder', 'delete', 'color', 'media', 'audio', 'voice'],
    liveDraftPreview: true,
    sound: 'all',
    voiceover: true,
    revoice: true,
    recordedNarration: true,
    scopedRevision: true,
    recording: false,
  },
}
/** A version's look: the catalog's name and hash (app/server/generated/looks.ts, built from app/looks/). */
const lookRef = (id: string): V['look'] => {
  const l = looksCatalog.find((x) => x.id === id)
  if (!l) throw new Error(`no look ${id}`)
  return { id: l.id, name: l.name, hash: l.hash }
}

const files = (id: string, n: number): V['links'] => ({
  video: `/api/v1/videos/${id}/versions/${n}/video`,
  poster: `/api/v1/videos/${id}/versions/${n}/poster`,
  gif: `/api/v1/videos/${id}/versions/${n}/gif`,
  captions: `/api/v1/videos/${id}/versions/${n}/captions`,
  netlifyRun: `https://app.netlify.com/projects/acme-video-agent/agent-runs/6ae5${id.slice(-8)}`,
})
const agent = {
  agent: 'claude',
  model: 'claude-opus-5-5',
  effort: null,
  deployId: '6ae5000000000000000000a1',
  promptTemplateVersion: 1,
}

const previewFiles = (base: string): V['files'] => ({
  poster: `/${base}.jpg`,
  gif: `/${base}.gif`,
  posterSources: (['avif', 'webp'] as const).map((fmt) => ({
    type: `image/${fmt}` as const,
    srcset: `/${base}-poster-480.${fmt} 480w, /${base}-poster-960.${fmt} 960w`,
  })),
  clip: [
    { type: 'video/webm', src: `/${base}-clip.webm` },
    { type: 'video/mp4', src: `/${base}-clip.mp4` },
  ],
  lqip: 'data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAAAQAwCdASoUAAwAPu1iqU2ppaOiMAgBMB2JaQAAW+qmVoQA/vKXwUEy/9fLrcAA',
})

function ready(
  id: string,
  n: number,
  prompt: string,
  o: {
    at: number
    took: number
    credits: number
    sec: number
    w: number
    h: number
    bytes: number
    title: string
    summary: string
    author: string
    parent?: number
    target?: number | null
    /** Kept despite these (a length far from the one asked for). */
    notices?: string[]
    pub?: string
    editable?: boolean
    /** Preview variants made from app/web/mock-assets/teaser-v2.mp4 (the real render-job output for that file). */
    previews?: boolean
    /** CC BY music it was made with (Openverse), credited on the page and in the embed. */
    music?: V['credits']
    /** Recorded narration: the MP3 and transcript downloads (the mock API answers both). */
    narrated?: boolean
    /** The comments it was asked to incorporate. */
    feedback?: V['feedback']
    /** The plan accepted before it was made. */
    plan?: V['plan']
    /** The look it was made with (app/looks/); none when missing. */
    look?: string
    /** Its scenes (redo a scene); null when not known. */
    beats?: V['beats']
    /** The scenes it redid of its parent. */
    scope?: V['scope']
    /** Background it was made with (a pull request, release notes). */
    context?: V['context']
  },
): V {
  const startedAt = ago(o.at)
  return {
    n,
    status: 'ready',
    prompt,
    authorId: o.author,
    parentN: o.parent ?? null,
    targetDurationSec: o.target ?? null,
    sound: o.music?.length ? 'music' : 'silent',
    voiceover: null,
    captions: o.narrated ? { status: 'ok', policy: 'sidecar', rev: 0 } : null,
    poster: null,
    createdAt: ago(o.at + 0.3),
    plan: o.plan ?? null,
    credits: o.music ?? [],

    verdicts: { approved: 0, changesRequested: 0, mine: null },
    incorporates: o.feedback?.length ?? 0,
    feedback: o.feedback ?? [],
    context: o.context ?? null,
    editable: o.editable ?? false,
    editing: hyperframes,
    look: o.look ? lookRef(o.look) : null,
    beats: o.beats ?? null,
    scope: o.scope ?? null,
    mode: 'author',
    editedFromN: null,

    attempts: 1,
    stage: 'ready',
    latestStep: 'Finished authoring',
    music: null,
    error: null,
    agent,
    usage: { totalCreditsCost: o.credits },
    timings: {
      queuedAt: ago(o.at + 0.3),
      startedAt,
      finishingAt: ago(o.at - o.took + 0.2),
      endedAt: ago(o.at - o.took),
    },
    output: {
      durationSec: o.sec,
      width: o.w,
      height: o.h,
      bytes: o.bytes,
      title: o.title,
      summary: o.summary,
      notices: o.notices ?? [],
    },
    links: o.narrated
      ? {
          ...files(id, n),
          narrationAudio: `/api/v1/videos/${id}/versions/${n}/narration-audio`,
          transcript: `/api/v1/videos/${id}/versions/${n}/transcript`,
        }
      : files(id, n),
    files: o.previews ? previewFiles('teaser-v2') : null,
    publications: o.pub
      ? [
          {
            slug: o.pub,
            versionN: n,
            publishedAt: ago(o.at - o.took - 2),
            unpublishedAt: null,
            urls: {
              page: `${SITE}/v/${o.pub}`,
              mp4: `${SITE}/v/${o.pub}.mp4`,
              poster: `${SITE}/v/${o.pub}.jpg`,
              gif: `${SITE}/v/${o.pub}.gif`,
              captions: `${SITE}/v/${o.pub}.vtt`,
            },
            showTranscript: false,
            embed: embed(o.pub, o.w, o.h, o.music ?? []),
            player: player(o.pub),
          },
        ]
      : [],
    destinations: [],
  }
}

/** What the mock API serves as a narrated version's transcript.txt: a paragraph per caption cue. */
export const MOCK_TRANSCRIPT =
  'Every pull request gets its own URL.\n\nReview the real site, not a screenshot.\n\nMerge with confidence. Book a demo.\n'

export const player = (slug: string) =>
  `<script type="module" src="${SITE}/player.js"></script><video-agent-player src="${SITE}/v/${slug}"></video-agent-player>`

export function embed(slug: string, w: number, h: number, credits: V['credits']) {
  const v = `<video controls playsinline preload="metadata" width="${w}" height="${h}" style="max-width:100%;height:auto" poster="${SITE}/v/${slug}.jpg"><source src="${SITE}/v/${slug}.mp4" type="video/mp4"><track kind="captions" src="${SITE}/v/${slug}.vtt" srclang="en" label="Captions"></video>`
  if (!credits.length) return v
  const line = credits
    .map(
      (c) =>
        `${c.role}: <a href="${c.sourceUrl}" rel="noopener" target="_blank">${c.title}</a> by <a href="${c.creatorUrl}" rel="noopener" target="_blank">${c.creator}</a>, <a href="${c.licenseUrl}" rel="noopener" target="_blank">${c.licenseLabel}</a>`,
    )
    .join('; ')
  return `<figure style="margin:0">${v}<figcaption style="font:12px/1.4 system-ui,sans-serif;opacity:.8">${line}</figcaption></figure>`
}

/** A CC BY track from Openverse, as the server credits it. */
export const mockCredit: V['credits'][number] = {
  mediaId: 'med_mockopenverse',
  kind: 'audio',
  role: 'Music',
  title: 'Morning Light',
  creator: 'Lena Park',
  creatorUrl: 'https://www.jamendo.com/artist/1001',
  license: 'by',
  licenseLabel: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  sourceUrl: 'https://www.jamendo.com/track/2002',
  source: 'openverse',
  text: '"Morning Light" by Lena Park, CC BY 4.0, https://www.jamendo.com/track/2002',
}

function video(
  id: string,
  title: string,
  aspect: Video['aspect'],
  owner: { id: string; name: string; email: string },
  versions: V[],
  extra: Partial<Video> = {},
): Video {
  const dims = {
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
  }[aspect]
  const latest = versions[0] as V
  return {
    id,
    title,
    aspect,
    dimensions: dims,
    status: latest.status,
    owner,
    latestVersion: latest.n,
    createdAt: versions.at(-1)?.createdAt ?? ago(1),
    updatedAt: latest.createdAt,
    etag: `"${id}-${versions.length}"`,
    versions,
    published: versions.some((v) => v.publications.some((p) => !p.unpublishedAt)),
    private: false,
    language: 'en',
    comments: { count: 0, unread: 0 },
    isRemix: false,
    remixOf: null,
    favorite: false,
    externalRef: null,
    externalUrl: null,
    tags: [],
    links: { self: `/api/v1/videos/${id}` },
    ...extra,
  }
}

export const people = {
  sam: { id: 'u_sam', name: 'Sam Rivera', email: 'sam@acme.com' },
  priya: { id: 'u_priya', name: 'Priya Shah', email: 'priya@acme.com' },
  marco: { id: 'u_marco', name: 'Marco Ruiz', email: 'marco@acme.com' },
  ada: { id: 'u_ada', name: 'Ada Okafor', email: 'ada@acme.com' },
}

export const videos: Video[] = [
  video('vid_making', 'Deploy rollbacks in one click', '16:9', people.priya, [
    {
      n: 1,
      status: 'running',
      prompt:
        'A 20-second changelog clip: "Roll back any deploy in one click." Show the deploy list, the rollback button, and end on "Live in seconds".',
      authorId: people.priya.id,
      parentN: null,
      targetDurationSec: 20,
      sound: 'silent',
      voiceover: null,
      captions: null,
      poster: null,
      createdAt: ago(2.6),
      plan: null,

      verdicts: { approved: 0, changesRequested: 0, mine: null },
      incorporates: 0,
      feedback: [],
      context: null,
      editable: false,
      editing: hyperframes,
      look: null,
      beats: null,
      scope: null,
      mode: 'author',
      editedFromN: null,

      attempts: 1,
      stage: 'running',
      latestStep: 'Run `npx hyperframes check` in video/',
      music: null,
      error: null,
      agent,
      usage: null,
      timings: { queuedAt: ago(2.6), startedAt: ago(2.4), finishingAt: null, endedAt: null },
      output: null,
      links: files('vid_making', 1),
      files: null,
      publications: [],
      destinations: [],
      credits: [],
    },
  ]),
  video('vid_queued', 'Edge functions explainer, vertical', '9:16', people.marco, [
    {
      n: 1,
      status: 'queued',
      prompt:
        'A vertical 30-second explainer of edge functions for a developer audience: one code snippet, one diagram of a request at the edge, end card "Deploy to the edge".',
      authorId: people.marco.id,
      parentN: null,
      targetDurationSec: 30,
      sound: 'silent',
      voiceover: null,
      captions: null,
      poster: null,
      createdAt: ago(0.8),
      plan: null,

      verdicts: { approved: 0, changesRequested: 0, mine: null },
      incorporates: 0,
      feedback: [],
      context: null,
      editable: false,
      editing: hyperframes,
      look: null,
      beats: null,
      scope: null,
      mode: 'author',
      editedFromN: null,

      attempts: 1,
      stage: 'queued',
      latestStep: null,
      music: null,
      error: null,
      agent,
      usage: null,
      timings: { queuedAt: ago(0.8), startedAt: null, finishingAt: null, endedAt: null },
      output: null,
      links: files('vid_queued', 1),
      files: null,
      publications: [],
      destinations: [],
      credits: [],
    },
  ]),
  video(
    'vid_teaser',
    'Ship faster with preview deploys',
    '16:9',
    people.sam,
    [
      ready('vid_teaser', 2, 'Keep everything, but make the end card text "Start free today".', {
        at: 64,
        took: 2.9,
        credits: 88,
        sec: 8,
        w: 1920,
        h: 1080,
        bytes: 188228,
        title: 'Ship faster with preview deploys',
        author: people.sam.id,
        parent: 1,
        target: 8,
        pub: 'q4czcinsu9',
        context: null,
        editable: true,
        // Its scenes (redo a scene): an 8 s teaser in four.
        beats: [
          { id: 'hook', label: 'Hook', start: 0, duration: 2 },
          { id: 'problem', label: 'Problem', start: 2, duration: 2 },
          { id: 'demo', label: 'Demo', start: 4, duration: 2.5 },
          { id: 'end', label: 'End card', start: 6.5, duration: 1.5 },
        ],
        previews: true,
        feedback: [
          {
            author: 'Ada Okafor',
            body: 'The end card should say "Start free today".',
            timeSec: 6.5,
            spot: true,
          },
        ],
        summary:
          'An 8-second, calm product teaser on a dark background. "Ship faster" fades in with a teal accent line, then "with preview deploys", and the film ends on a card that reads "Start free today".',
      }),
      ready(
        'vid_teaser',
        1,
        'A short product teaser: the words "Ship faster" appear, then "with preview deploys", then an end card that says "Try it today". Calm, modern, dark background.',
        {
          at: 68,
          took: 2.6,
          credits: 91,
          sec: 8,
          w: 1920,
          h: 1080,
          bytes: 181877,
          title: 'Ship faster with preview deploys',
          author: people.sam.id,
          target: 8,
          notices: ['Asked for about 6 s; this video is 8.0 s.'],
          plan: {
            planId: 'plan_teaser',
            brief: {
              goal: 'Tease preview deploys in a few seconds',
              audience: 'Developers who ship web apps',
              keyMessage: 'Every change gets its own live preview',
              beats: [
                { text: '"Ship faster" fades in', seconds: 3 },
                { text: '"with preview deploys"', seconds: 3 },
                { text: 'End card: "Try it today"', seconds: 2 },
              ],
              tone: 'Calm, modern',
              callToAction: 'Try it today',
              mustInclude: ['A dark background'],
              avoid: ['Stock footage'],
            },
            answers: [{ question: 'Who is it for?', answer: 'Developers' }],
          },
          summary:
            'An 8-second, calm product teaser on a dark background with three beats and an end card that reads "Try it today".',
        },
      ),
    ],
    { tags: ['launch'] },
  ),
  video(
    'vid_webhooks',
    'Org webhooks launch',
    '16:9',
    people.ada,
    [
      ready(
        'vid_webhooks',
        1,
        'A launch video announcing Org webhooks: teams can now subscribe to events across every project in their organization from one place.',
        {
          at: 190,
          took: 7.4,
          credits: 206,
          sec: 22.5,
          w: 1920,
          h: 1080,
          bytes: 1424311,
          title: 'Org webhooks',
          author: people.ada.id,
          pub: 'h7m2q9xwka',
          context: {
            source: 'github_pr',
            label: 'GitHub PR #123',
            url: 'https://github.com/acme/web/pull/123',
            text: 'Title: Org webhooks\nDescription:\nTeams can subscribe to events across every project in their organization from one place.',
          },
          music: [mockCredit],
          look: 'kinetic',
          summary:
            'A 22.5-second before-and-after story: twelve project tiles collapse into one organization webhook, then events from nine projects arrive at one endpoint. Ends on an end card pointing to Organization settings → Webhooks.',
        },
      ),
    ],
    {
      externalRef: 'github:acme/web#pr-123',
      externalUrl: 'https://github.com/acme/web/pull/123',
      tags: ['demo'],
    },
  ),
  video(
    'vid_sales',
    'Deploy previews for every pull request',
    '9:16',
    people.priya,
    [
      ready(
        'vid_sales',
        1,
        'A vertical social clip for the sales team: "Deploy previews for every pull request". Three short beats and an end card with "Book a demo".',
        {
          at: 300,
          took: 3.2,
          credits: 92,
          sec: 15,
          w: 1080,
          h: 1920,
          bytes: 1017831,
          title: 'Deploy previews for every pull request',
          author: people.priya.id,
          target: 15,
          narrated: true,
          summary:
            'A 15-second vertical clip in three beats: every pull request gets its own URL, review the real site, merge with confidence. Ends on "Book a demo".',
        },
      ),
    ],
    { externalRef: 'github:acme/web@v2.4.0' },
  ),
  video('vid_docs', 'Add an environment variable, then redeploy', '1:1', people.marco, [
    ready(
      'vid_docs',
      1,
      'A one-minute docs tutorial explaining in three steps how to add an environment variable to a project and redeploy it.',
      {
        at: 1500,
        took: 6.8,
        credits: 192,
        sec: 60,
        w: 1080,
        h: 1080,
        bytes: 1507203,
        title: 'Add an environment variable, then redeploy',
        author: people.marco.id,
        target: 60,
        summary:
          'A 60-second square tutorial with a neutral dashboard mock-up and a cursor walking through Settings → Environment variables, adding API_BASE_URL, and redeploying.',
      },
    ),
  ]),
  video('vid_failed', 'Pricing page walkthrough', '16:9', people.ada, [
    {
      n: 1,
      status: 'failed',
      prompt: 'Walk through the pricing page.',
      authorId: people.ada.id,
      parentN: null,
      targetDurationSec: null,
      sound: 'silent',
      voiceover: null,
      captions: null,
      poster: null,
      createdAt: ago(2900),
      plan: null,

      verdicts: { approved: 0, changesRequested: 0, mine: null },
      incorporates: 0,
      feedback: [],
      context: null,
      editable: false,
      editing: hyperframes,
      look: null,
      beats: null,
      scope: null,
      mode: 'author',
      editedFromN: null,

      attempts: 1,
      stage: 'failed',
      latestStep: 'Asked: which plans should the walkthrough cover?',
      music: null,
      error: {
        category: 'needs_input',
        message: 'The agent stopped to ask a question. Make the request more specific and try again.',
      },
      agent,
      usage: { totalCreditsCost: 31 },
      timings: { queuedAt: ago(2900), startedAt: ago(2899.7), finishingAt: null, endedAt: ago(2896) },
      output: null,
      links: files('vid_failed', 1),
      files: null,
      publications: [],
      destinations: [],
      credits: [],
    },
  ]),
]

// Remotion (localStorage.mockEngines starts with 'remotion', render-engines plan §7): a ready Remotion video, made with
// music and not editable, so the tag, the not-editable message and the limited revise form can be seen.
const remotionEditing: V['editing'] = {
  engine: 'remotion',
  capabilities: {
    editOps: [],
    liveDraftPreview: false,
    sound: 'music',
    voiceover: false,
    revoice: false,
    recordedNarration: false,
    scopedRevision: false,
    recording: false,
  },
}
export const mockRemotion = (() => {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('mockEngines')?.startsWith('remotion') === true
    )
  } catch {
    return false
  }
})()
if (mockRemotion) {
  const copy = structuredClone(videos.find((v) => v.id === 'vid_docs') as Video)
  copy.id = 'vid_remotion'
  copy.title = 'Org webhooks in 20 seconds (Remotion)'
  copy.versions = copy.versions.map((v) => ({
    ...v,
    editable: false,
    sound: 'music',
    voiceover: null,
    beats: null,
    editing: remotionEditing,
    links: files('vid_remotion', v.n),
  }))
  videos.push(copy)
}

// Redo a scene (localStorage.mockRedo=1): the teaser gets v3, which redid its demo and ends on a held frame under
// recorded narration, and v4, a scoped run of v3 that was refused for touching a frozen scene. The webhooks launch
// (Ada's) gets its scenes too; the mock API adds pinned comments on all three (server.ts).
export const mockRedo = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('mockRedo') === '1'
  } catch {
    return false
  }
})()
if (mockRedo) {
  const teaser = videos.find((v) => v.id === 'vid_teaser') as Video
  const v3 = ready('vid_teaser', 3, 'Make the demo scene show the deploy preview URL.', {
    at: 30,
    took: 2.2,
    credits: 58,
    sec: 9,
    w: 1920,
    h: 1080,
    bytes: 190112,
    title: 'Ship faster with preview deploys',
    author: people.sam.id,
    parent: 2,
    editable: true,
    narrated: true,
    beats: [
      { id: 'hook', label: 'Hook', start: 0, duration: 2 },
      { id: 'problem', label: 'Problem', start: 2, duration: 2 },
      { id: 'demo', label: 'Demo', start: 4, duration: 2 },
      { id: 'proof', label: 'Proof', start: 6, duration: 1.5 },
      { id: 'end', label: 'End card', start: 7.5, duration: 1 },
      { id: 'va-hold', label: null, start: 8.5, duration: 1 },
    ],
    scope: { beats: [{ id: 'demo', label: 'Demo' }] },
    summary: 'The demo scene now shows the preview URL; everything else is v2 as it was.',
  })
  const v4: V = {
    ...ready('vid_teaser', 4, 'Make the problem scene darker.', {
      at: 10,
      took: 1.4,
      credits: 31,
      sec: 9,
      w: 1920,
      h: 1080,
      bytes: 0,
      title: 'Ship faster with preview deploys',
      author: people.sam.id,
      parent: 3,
      summary: '',
    }),
    status: 'failed',
    stage: 'failed',
    latestStep: 'Checked the scenes it was asked to leave alone',
    scope: { beats: [{ id: 'problem', label: 'Problem' }] },
    output: null,
    files: null,
    error: {
      category: 'invalid_output',
      message:
        'This run changed parts of the video outside the scenes it was asked to redo: the hook title. Try again, or revise the whole video.',
    },
  }
  teaser.versions.unshift(v4, v3)
  Object.assign(teaser, {
    status: 'failed',
    latestVersion: 4,
    etag: '"vid_teaser-4"',
    updatedAt: v4.createdAt,
  })
  const hooks = videos.find((v) => v.id === 'vid_webhooks')?.versions[0] as V
  Object.assign(hooks, {
    editable: true,
    beats: [
      { id: 'before', label: 'Before', start: 0, duration: 8 },
      { id: 'after', label: 'After', start: 8, duration: 9 },
      { id: 'end', label: 'End card', start: 17, duration: 5.5 },
    ],
  })
}

// A remix (docs/plans/2026-11-03-remix.md): the docs video was remixed from the webhooks launch.
Object.assign(videos.find((v) => v.id === 'vid_docs') as Video, {
  isRemix: true,
  remixOf: { id: 'vid_webhooks', n: 1, title: 'Org webhooks launch' },
})

export const stats: Stats = {
  inFlight: [
    {
      attemptId: 'a_making',
      jobId: 'vid_making',
      title: 'Deploy rollbacks in one click',
      versionN: 1,
      stage: 'running',
      startedAt: ago(2.4),
      runUrl: 'https://app.netlify.com/projects/acme-video-agent/agent-runs/6ae5making',
    },
  ],
  queued: 1,
  oldestQueuedAt: ago(0.8),
  unresolved: [],
  failuresThisWeek: [{ category: 'needs_input', count: 1 }],
  usage: [
    {
      userId: people.sam.id,
      email: people.sam.email,
      week: '2026-10-26',
      credits: 179,
      videos: 2,
      planningCredits: 0,
      planningUnknown: 0,
    },
    {
      userId: people.ada.id,
      email: people.ada.email,
      week: '2026-10-26',
      credits: 237,
      videos: 2,
      planningCredits: 0,
      planningUnknown: 0,
    },
    {
      userId: people.priya.id,
      email: people.priya.email,
      week: '2026-10-26',
      credits: 92,
      videos: 2,
      planningCredits: 0,
      planningUnknown: 0,
    },
    {
      userId: people.marco.id,
      email: people.marco.email,
      week: '2026-10-26',
      credits: 192,
      videos: 2,
      planningCredits: 0,
      planningUnknown: 0,
    },
  ],
  maxActiveRuns: 3,
  queuePausedReason: null,
}
