// Before an upload: what the library already has. The same file (identical bytes) isn't uploaded again; a different
// file with a name already in the library asks whether to replace it, keep both or skip it.
import { Button, Group, SegmentedControl, Stack, Text } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { useState } from 'react'
import { fetchClient } from '../api/client'
import type { paths } from '../api/schema'
import { fileSha256 } from '../lib/upload'

type Media = paths['/api/v1/media/{id}']['get']['responses'][200]['content']['application/json']
export type Choice = 'replace' | 'keep' | 'skip'
/** A file to upload, and the library item it replaces once it's in. */
export interface PlannedUpload {
  file: File
  replaces: Media | null
}

function NameClashes(props: {
  clashes: { file: File; existing: Media }[]
  onDone: (choices: Choice[] | null) => void
}) {
  const [choices, setChoices] = useState<Choice[]>(props.clashes.map(() => 'replace'))
  return (
    <Stack gap="md">
      <Text size="sm" c="var(--va-muted)">
        {props.clashes.length === 1
          ? 'A different file with this name is already in the library.'
          : 'Different files with these names are already in the library.'}{' '}
        Replacing removes the old one from the library; videos already made with it keep their copy.
      </Text>
      {props.clashes.map((c, i) => (
        <Group key={c.file.name + String(i)} justify="space-between" wrap="nowrap" gap="md">
          <Text size="sm" fw={500} truncate>
            {c.file.name}
          </Text>
          <SegmentedControl
            size="xs"
            aria-label={`What to do with ${c.file.name}`}
            value={choices[i] ?? 'replace'}
            onChange={(v) => {
              setChoices((cs) => cs.map((x, j) => (j === i ? v : x)))
            }}
            data={[
              { value: 'replace', label: 'Replace' },
              { value: 'keep', label: 'Keep both' },
              { value: 'skip', label: 'Skip' },
            ]}
          />
        </Group>
      ))}
      <Group justify="flex-end" gap="sm">
        <Button
          variant="default"
          onClick={() => {
            props.onDone(null)
          }}
        >
          Cancel
        </Button>
        <Button
          onClick={() => {
            props.onDone(choices)
          }}
        >
          Continue
        </Button>
      </Group>
    </Stack>
  )
}

const ask = (clashes: { file: File; existing: Media }[]) =>
  new Promise<Choice[] | null>((resolve) => {
    let settled = false
    const done = (c: Choice[] | null) => {
      if (settled) return
      settled = true
      modals.close(id)
      resolve(c)
    }
    const id = modals.open({
      title: clashes.length === 1 ? 'Replace the file in the library?' : 'Replace files in the library?',
      size: 'lg',
      onClose: () => {
        done(null)
      },
      children: <NameClashes clashes={clashes} onDone={done} />,
    })
  })

/**
 * Which files to upload. Files already in the library are left out (and said so); for a name already in the
 * library, the person chooses. `existing` are the library items for files that were already there. If the check
 * itself fails, everything uploads as before.
 */
export async function planUploads(files: File[]): Promise<{ uploads: PlannedUpload[]; existing: Media[] }> {
  if (!files.length) return { uploads: [], existing: [] }
  let found
  try {
    const shas = await Promise.all(files.map(fileSha256))
    const { data } = await fetchClient.POST('/api/v1/media/check', {
      body: { files: files.slice(0, 50).map((f, i) => ({ filename: f.name, sha256: shas[i] ?? '' })) },
    })
    found = data?.files
  } catch {
    found = undefined
  }
  if (!found) return { uploads: files.map((file) => ({ file, replaces: null })), existing: [] }
  const same = files.filter((_, i) => found[i]?.sameFile)
  if (same.length)
    notifications.show({
      message:
        same.length === 1
          ? `${same[0]?.name ?? 'That file'} is already in the library, so it wasn't uploaded again.`
          : `${same.length} files are already in the library, so they weren't uploaded again.`,
    })
  const rest = files.map((file, i) => ({ file, hit: found[i] })).filter((x) => !x.hit?.sameFile)
  const clashes = rest.flatMap((x) => (x.hit?.sameName ? [{ file: x.file, existing: x.hit.sameName }] : []))
  const existing = found.flatMap((f) => (f.sameFile ? [f.sameFile] : []))
  const choices = clashes.length ? await ask(clashes) : []
  if (choices === null) return { uploads: [], existing }
  const uploads = rest.flatMap((x): PlannedUpload[] => {
    const at = clashes.findIndex((c) => c.file === x.file)
    if (at < 0) return [{ file: x.file, replaces: null }]
    const choice = choices[at] ?? 'keep'
    if (choice === 'skip') return []
    return [{ file: x.file, replaces: choice === 'replace' ? (clashes[at]?.existing ?? null) : null }]
  })
  return { uploads, existing }
}

/** After a replacing upload is in: the old item leaves the library. Only its uploader or an admin may remove it. */
export async function retireReplaced(old: Media) {
  const { response } = await fetchClient.DELETE('/api/v1/media/{id}', { params: { path: { id: old.id } } })
  if (!response.ok)
    notifications.show({
      message: `Kept both copies of ${old.filename}: only its uploader or an admin can replace it.`,
    })
}
