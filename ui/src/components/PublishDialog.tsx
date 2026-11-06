// Publishing a version. One with a recorded narration's transcript asks first whether the share page shows it
// (plan 2026-11-02 §6.7, §12.5): a separate consent from publishing the audio, off by default, with a preview of what
// would be shown, and the choice remembered per person in this browser.
import { COSMETIC_NOTE, uncheckedAgentAreas } from './recording/HiddenList'
import { Button, Group, Modal, ScrollArea, Stack, Switch, Text } from '@mantine/core'
import { useEffect, useState } from 'react'
import type { Version } from '../api/client'

const KEY = (userId: string) => `va.publish.showTranscript.${userId}`

/** The person's last choice; off when there is none (or storage is unavailable). */
export function rememberedShowTranscript(userId: string): boolean {
  try {
    return localStorage.getItem(KEY(userId)) === '1'
  } catch {
    return false
  }
}

function remember(userId: string, show: boolean) {
  try {
    localStorage.setItem(KEY(userId), show ? '1' : '0')
  } catch {
    // storage unavailable: the choice applies to this publish only
  }
}

export function PublishButton({
  v,
  userId,
  loading,
  onPublish,
}: {
  v: Version
  userId: string
  loading: boolean
  onPublish: (opts: { showTranscript?: boolean }) => void
}) {
  const [open, setOpen] = useState(false)
  const transcriptUrl = v.links.transcript
  // A demo: the dialog says what Video Agent hid that nobody has checked, and that hiding is cosmetic.
  const demo = v.recording ? { unchecked: uncheckedAgentAreas(v).length } : null
  return (
    <>
      <Button
        loading={loading}
        onClick={() => {
          if (transcriptUrl || demo) setOpen(true)
          else onPublish({})
        }}
      >
        Publish v{v.n}
      </Button>
      {transcriptUrl || demo ? (
        <Modal opened={open} onClose={() => setOpen(false)} title={`Publish v${v.n}`} centered>
          <Stack gap="md">
            {demo ? (
              <Stack gap={4} data-testid="publish-demo-note">
                {demo.unchecked ? (
                  <Text size="sm" fw={500}>
                    Video Agent hid {demo.unchecked} {demo.unchecked === 1 ? 'thing' : 'things'} it thought
                    were private. Check them in the Hidden list before you publish.
                  </Text>
                ) : null}
                <Text size="sm" c="var(--va-muted)">
                  {COSMETIC_NOTE}
                </Text>
              </Stack>
            ) : null}
            {transcriptUrl ? (
              <PublishForm
                transcriptUrl={transcriptUrl}
                userId={userId}
                onCancel={() => setOpen(false)}
                onPublish={(show) => {
                  remember(userId, show)
                  setOpen(false)
                  onPublish({ showTranscript: show })
                }}
              />
            ) : (
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setOpen(false)
                    onPublish({})
                  }}
                >
                  Publish
                </Button>
              </Group>
            )}
          </Stack>
        </Modal>
      ) : null}
    </>
  )
}

function PublishForm({
  transcriptUrl,
  userId,
  onCancel,
  onPublish,
}: {
  transcriptUrl: string
  userId: string
  onCancel: () => void
  onPublish: (show: boolean) => void
}) {
  const [show, setShow] = useState(() => rememberedShowTranscript(userId))
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetch(transcriptUrl, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        const t = await r.text()
        if (live) setText(t)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [transcriptUrl])
  const paragraphs = (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  return (
    <Stack gap="md">
      <Text size="sm">Anyone with the link can watch it and download the narration audio.</Text>
      <Switch
        checked={show}
        onChange={(e) => setShow(e.currentTarget.checked)}
        label="Show transcript on the share page"
        description="The narration's words, under the video. You can change this by publishing again."
      />
      <div aria-label="Transcript preview" data-transcript-preview>
        <Text size="xs" c="var(--va-faint)" mb={4}>
          {show ? 'The share page will show:' : 'Not shown. Preview:'}
        </Text>
        <ScrollArea.Autosize mah={180} type="auto">
          <Stack gap={6} style={{ opacity: show ? 1 : 0.55 }}>
            {failed ? (
              <Text size="sm" c="var(--va-muted)">
                Couldn't load the transcript.
              </Text>
            ) : text === null ? (
              <Text size="sm" c="var(--va-muted)">
                Loading…
              </Text>
            ) : paragraphs.length ? (
              paragraphs.map((p, i) => (
                <Text key={i} size="sm">
                  {p}
                </Text>
              ))
            ) : (
              <Text size="sm" c="var(--va-muted)">
                The transcript is empty.
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
      </div>
      <Group justify="flex-end" gap="sm">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onPublish(show)}>Publish</Button>
      </Group>
    </Stack>
  )
}
