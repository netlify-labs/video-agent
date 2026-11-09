// Correcting recorded narration's captions without a render (plan 2026-11-02 §2.6): the current revision's cues with
// their timings, text-only edits, saved as a new revision against the one opened (409 when someone saved first).
import { Alert, Button, Card, Group, ScrollArea, Stack, Text, Textarea } from '@mantine/core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { parseVtt, type VttCue } from '../../../server/lib/vtt'
import { $api, errorMessage, type Version } from '../api/client'
import { clockTime, showError } from './bits'

/** m:ss.t, to the nearest tenth. */
const at = (sec: number) => {
  const tenths = Math.round(sec * 10)
  return `${clockTime(Math.floor(tenths / 10))}.${tenths % 10}`
}

export function TranscriptEditor({ videoId, v, canEdit }: { videoId: string; v: Version; canEdit: boolean }) {
  const qc = useQueryClient()
  const captions = v.captions
  const rev = captions?.rev ?? 0
  const [cues, setCues] = useState<VttCue[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const save = $api.useMutation('post', '/api/v1/videos/{id}/versions/{n}/captions', {
    onSuccess: () => {
      setEdits({})
      void qc.invalidateQueries()
    },
    onError: showError,
  })
  useEffect(() => {
    if (!captions) return
    let live = true
    setCues(null)
    setLoadError(null)
    // The API route (it redirects to the revision's signed file), whatever the revision.
    fetch(`/api/v1/videos/${videoId}/versions/${v.n}/captions?rev=${rev}`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const parsed = parseVtt(await r.text())
        if (live) setCues(parsed)
      })
      .catch((e: unknown) => {
        if (live) setLoadError(errorMessage(e))
      })
    return () => {
      live = false
    }
    // Reload when the revision changes (a save, or someone else's).
  }, [videoId, v.n, rev, captions === null])
  if (!captions) return null

  const dirty = Object.entries(edits).some(([id, t]) => cues?.find((c) => c.id === id)?.text !== t)
  return (
    <Card data-testid="transcript-editor">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Transcript</Text>
        {rev ? (
          <Text size="xs" c="var(--va-faint)">
            Corrected ({rev})
          </Text>
        ) : null}
      </Group>
      {captions.policy === 'burned' ? (
        <Text size="sm" c="var(--va-muted)">
          These captions are burned into the picture. Fix them in the editor and render again.
        </Text>
      ) : captions.status !== 'ok' && cues?.length === 0 ? (
        <Text size="sm" c="var(--va-muted)">
          No captions: retry or add them.
        </Text>
      ) : loadError ? (
        <Alert color="red" variant="light">
          Couldn't load the captions: {loadError}
        </Alert>
      ) : !cues ? (
        <Text size="sm" c="var(--va-muted)">
          Loading…
        </Text>
      ) : (
        <>
          <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap={8}>
              {cues.map((c) => (
                <div key={c.id}>
                  <Text size="xs" c="var(--va-faint)" className="num">
                    {at(c.start)} – {at(c.end)}
                  </Text>
                  {canEdit ? (
                    <Textarea
                      aria-label={`Caption at ${at(c.start)}`}
                      autosize
                      minRows={1}
                      maxRows={3}
                      value={edits[c.id] ?? c.text}
                      onChange={(e) => {
                        const text = e.currentTarget.value
                        setEdits((x) => ({ ...x, [c.id]: text }))
                      }}
                    />
                  ) : (
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {c.text}
                    </Text>
                  )}
                </div>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {canEdit ? (
            <Group justify="space-between" mt="sm">
              <Text size="xs" c="var(--va-faint)">
                Fixes change the words only; timings stay. No render needed.
              </Text>
              <Button
                size="xs"
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => {
                  save.mutate({
                    params: { path: { id: videoId, n: v.n } },
                    body: {
                      expectedRev: rev,
                      cues: cues.map((c) => ({
                        id: c.id,
                        start: c.start,
                        end: c.end,
                        text: edits[c.id] ?? c.text,
                      })),
                    },
                  })
                }}
              >
                Save fixes
              </Button>
            </Group>
          ) : null}
        </>
      )}
    </Card>
  )
}
